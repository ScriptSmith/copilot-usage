#!/usr/bin/env node
'use strict';

/*
 * copilot-usage-collector -- a tiny local OpenTelemetry (OTLP/HTTP) receiver that
 * captures GitHub Copilot CLI usage *live*, before the session.shutdown event.
 *
 * Copilot exports per-LLM-call and per-turn spans when OTel is enabled
 * (OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318). Each `chat` span carries
 * the AIC for that call as the span attribute `github.copilot.nano_aiu`, and the
 * `invoke_agent` span carries `github.copilot.cost` (premium requests). Every span
 * is tagged with `gen_ai.conversation.id` == the Copilot session id, so we can
 * accumulate a running per-session total that exists while the session is still
 * open -- something the on-disk logs only record at shutdown.
 *
 * This server:
 *   - accepts OTLP/HTTP JSON on POST /v1/traces (also 200s /v1/metrics, /v1/logs)
 *   - stores one row per span in SQLite (dedup by span id; safe on OTLP retries)
 *   - serves GET /sessions  -> live per-session aggregates as JSON
 *            GET /healthz   -> { ok: true }
 *
 * No npm dependencies: Node >= 22.5 builtins only (node:sqlite, http, zlib).
 * Designed to run under systemd socket activation (listens on fd 3 when handed
 * one), or standalone on HOST:PORT.
 *
 *   AIC = nano_aiu / 1e9
 */

const http = require('http');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const HOST = process.env.COPILOT_COLLECTOR_HOST || '127.0.0.1';
const PORT = parseInt(process.env.COPILOT_COLLECTOR_PORT || '4318', 10);
const NANO_PER_AIC = 1e9;
const SD_LISTEN_FDS_START = 3;

const DATA_DIR = process.env.COPILOT_COLLECTOR_DB_DIR || path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'copilot-usage-collector');
const DB_PATH = process.env.COPILOT_COLLECTOR_DB || path.join(DATA_DIR, 'usage.db');

// --------------------------------------------------------------------------
// Storage
// --------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 2000;
  CREATE TABLE IF NOT EXISTS spans (
    span_id            TEXT PRIMARY KEY,
    trace_id           TEXT,
    session_id         TEXT NOT NULL,
    kind               TEXT NOT NULL,         -- 'chat' (per-call) | 'agent' (per-turn)
    model              TEXT,
    initiator          TEXT,
    nano_aiu           INTEGER NOT NULL DEFAULT 0,
    cost               REAL NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
    start_ms           INTEGER,
    end_ms             INTEGER,
    received_ms        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spans_session ON spans (session_id);
`);

// INSERT OR REPLACE so a re-delivered span (OTLP retries) updates in place
// instead of double-counting.
const upsert = db.prepare(`
  INSERT OR REPLACE INTO spans
    (span_id, trace_id, session_id, kind, model, initiator, nano_aiu, cost,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     reasoning_tokens, start_ms, end_ms, received_ms)
  VALUES
    (:span_id, :trace_id, :session_id, :kind, :model, :initiator, :nano_aiu, :cost,
     :input_tokens, :output_tokens, :cache_read_tokens, :cache_write_tokens,
     :reasoning_tokens, :start_ms, :end_ms, :received_ms)
`);

// Per-session aggregate. nano_aiu/tokens come from the per-call `chat` spans
// (summing those is unambiguous regardless of how turn spans nest); cost comes
// from the `agent` turn spans (the chat spans carry no cost).
const aggregateStmt = db.prepare(`
  SELECT
    session_id                                                   AS id,
    COALESCE(SUM(CASE WHEN kind='chat'  THEN nano_aiu END), 0)   AS nano_aiu,
    COALESCE(SUM(CASE WHEN kind='agent' THEN cost     END), 0)   AS cost,
    SUM(CASE WHEN kind='chat' THEN 1 ELSE 0 END)                 AS calls,
    COALESCE(SUM(CASE WHEN kind='chat' THEN input_tokens END),0) AS input_tokens,
    COALESCE(SUM(CASE WHEN kind='chat' THEN output_tokens END),0) AS output_tokens,
    COALESCE(SUM(CASE WHEN kind='chat' THEN cache_read_tokens END),0)  AS cache_read_tokens,
    COALESCE(SUM(CASE WHEN kind='chat' THEN cache_write_tokens END),0) AS cache_write_tokens,
    COALESCE(SUM(CASE WHEN kind='chat' THEN reasoning_tokens END),0)   AS reasoning_tokens,
    MIN(start_ms)                                                AS first_ms,
    MAX(end_ms)                                                  AS last_ms
  FROM spans
  GROUP BY session_id
`);

const modelStmt = db.prepare(`
  SELECT session_id AS id, model,
         COALESCE(SUM(nano_aiu),0) AS nano_aiu,
         COUNT(*) AS calls
  FROM spans WHERE kind='chat' AND model IS NOT NULL
  GROUP BY session_id, model
`);

// --------------------------------------------------------------------------
// OTLP parsing
// --------------------------------------------------------------------------

// An OTLP/JSON attribute is { key, value: { stringValue | intValue | doubleValue
// | boolValue } }. int64 values are JSON strings per the protobuf mapping.
function attrVal(v) {
    if (!v || typeof v !== 'object') return undefined;
    if ('stringValue' in v) return v.stringValue;
    if ('intValue' in v) return Number(v.intValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('boolValue' in v) return v.boolValue;
    return undefined;
}

function attrMap(attrs) {
    const m = {};
    for (const a of attrs || []) m[a.key] = attrVal(a.value);
    return m;
}

const nanoToMs = (n) => (n ? Math.round(Number(n) / 1e6) : null);

// Pull the usage-bearing spans out of an OTLP ExportTraceServiceRequest and write
// them. Returns the number of spans stored.
function ingestTraces(body, receivedMs) {
    let stored = 0;
    for (const rs of body.resourceSpans || []) {
        for (const ss of rs.scopeSpans || rs.instrumentationLibrarySpans || []) {
            for (const sp of ss.spans || []) {
                const a = attrMap(sp.attributes);
                const session = a['gen_ai.conversation.id'];
                if (!session) continue;
                const op = a['gen_ai.operation.name'];
                const name = sp.name || '';
                const hasAiu = a['github.copilot.nano_aiu'] != null;
                const isChat = op === 'chat' || name.startsWith('chat ');
                const isAgent = op === 'invoke_agent' || name === 'invoke_agent';
                // Store chat calls (per-call AIC + tokens) and agent turns (cost).
                // Skip anything else, and skip chat spans with no AIC attribute.
                let kind;
                if (isChat && hasAiu) kind = 'chat';
                else if (isAgent) kind = 'agent';
                else continue;

                upsert.run({
                    span_id: sp.spanId || `${session}:${sp.startTimeUnixNano}:${name}`,
                    trace_id: sp.traceId || null,
                    session_id: session,
                    kind,
                    model: a['gen_ai.request.model'] || a['gen_ai.response.model'] || null,
                    initiator: a['github.copilot.initiator'] || null,
                    nano_aiu: Math.round(a['github.copilot.nano_aiu'] || 0),
                    cost: Number(a['github.copilot.cost'] || 0),
                    input_tokens: Math.round(a['gen_ai.usage.input_tokens'] || 0),
                    output_tokens: Math.round(a['gen_ai.usage.output_tokens'] || 0),
                    cache_read_tokens: Math.round(a['gen_ai.usage.cache_read.input_tokens'] || 0),
                    cache_write_tokens: Math.round(a['gen_ai.usage.cache_creation.input_tokens'] || 0),
                    reasoning_tokens: Math.round(a['gen_ai.usage.reasoning.output_tokens'] || 0),
                    start_ms: nanoToMs(sp.startTimeUnixNano),
                    end_ms: nanoToMs(sp.endTimeUnixNano),
                    received_ms: receivedMs,
                });
                stored++;
            }
        }
    }
    return stored;
}

// "running" is a heuristic: the collector can't see process exit, so treat a
// session with activity in the last RUNNING_WINDOW_MS as still active.
const RUNNING_WINDOW_MS = 5 * 60 * 1000;

function sessionsJson(nowMs) {
    const models = {};
    for (const r of modelStmt.all()) {
        (models[r.id] || (models[r.id] = {}))[r.model] = {
            aic: r.nano_aiu / NANO_PER_AIC, nano_aiu: r.nano_aiu, calls: r.calls,
        };
    }
    const sessions = aggregateStmt.all().map((r) => ({
        id: r.id,
        aic: r.nano_aiu / NANO_PER_AIC,
        nano_aiu: r.nano_aiu,
        cost: r.cost,
        calls: r.calls,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        reasoning_tokens: r.reasoning_tokens,
        first_ms: r.first_ms,
        last_ms: r.last_ms,
        running: r.last_ms != null && (nowMs - r.last_ms) < RUNNING_WINDOW_MS,
        models: models[r.id] || {},
    }));
    return { ok: true, updated_ms: nowMs, session_count: sessions.length, sessions };
}

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            let buf = Buffer.concat(chunks);
            const enc = (req.headers['content-encoding'] || '').toLowerCase();
            try {
                if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
                else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
            } catch (e) { return reject(e); }
            resolve(buf);
        });
        req.on('error', reject);
    });
}

function sendJson(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(s);
}

const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    try {
        if (req.method === 'POST' && url.startsWith('/v1/')) {
            const buf = await readBody(req);
            if (url === '/v1/traces') {
                let n = 0;
                try { n = ingestTraces(JSON.parse(buf.toString('utf8')), Date.now()); }
                catch (e) { return sendJson(res, 400, { error: 'bad OTLP json: ' + e.message }); }
                if (process.env.COPILOT_COLLECTOR_DEBUG) console.error(`stored ${n} span(s)`);
            }
            // traces/metrics/logs all get an empty OTLP success response.
            return sendJson(res, 200, {});
        }
        if (req.method === 'GET' && (url === '/sessions' || url === '/')) {
            return sendJson(res, 200, sessionsJson(Date.now()));
        }
        if (req.method === 'GET' && url === '/healthz') {
            return sendJson(res, 200, { ok: true, db: DB_PATH });
        }
        sendJson(res, 404, { error: 'not found' });
    } catch (e) {
        sendJson(res, 500, { error: e.message });
    }
});

// systemd socket activation hands us the listening socket as fd 3.
const listenFds = parseInt(process.env.LISTEN_FDS || '0', 10);
const fdForUs = listenFds > 0 &&
    (!process.env.LISTEN_PID || Number(process.env.LISTEN_PID) === process.pid);
if (fdForUs) {
    server.listen({ fd: SD_LISTEN_FDS_START }, () => console.error(`collector: listening on fd ${SD_LISTEN_FDS_START}, db ${DB_PATH}`));
} else {
    server.listen(PORT, HOST, () => console.error(`collector: listening on http://${HOST}:${PORT}, db ${DB_PATH}`));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { db.close(); } catch (e) {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); });
}
