# AIC hook probe

A throwaway experiment: **can a Copilot CLI hook read a session's AIC usage
*before* the `session.shutdown` event is written?**

Short answer: **no.** The probe registers a logging command on every hook event
and records, at each stage, the full payload + environment + a live snapshot of
`~/.copilot/data.db`. Running a real session through it shows the final usage is
not reachable from any hook.

## Files

- `aic-probe.sh` — the logging hook. Side-effect-free for the CLI: writes only to
  a log file, always emits empty stdout, always exits 0 (never blocks a tool,
  forces a turn, or changes a permission decision).
- `hooks/aic-probe.json` — registers `aic-probe.sh` on all 13 hook events.
- `interactive_live_test.py` — drives an interactive session in a PTY while
  polling `data.db`, to test whether `total_nano_aiu` updates mid-session.
- `logs/probe.jsonl` — one JSON record per hook invocation captured during the test.

## Install / uninstall

```bash
# install user-level (fires for every copilot session until removed)
mkdir -p ~/.copilot/hooks && cp hooks/aic-probe.json ~/.copilot/hooks/

# uninstall
rm -f ~/.copilot/hooks/aic-probe.json
```

(Repo-level alternative: drop the json in a project's `.github/hooks/`.)

Then run any session, e.g. `copilot -p "echo hi; date" --allow-all`, and read
`logs/probe.jsonl`.

## What the experiment found (Copilot CLI 1.0.64)

**All 13 hook events fire**, including in non-interactive `-p` mode. Observed
order for a 1-turn, 2-tool session:

```
userPromptSubmitted -> sessionStart -> preToolUse -> permissionRequest
  -> postToolUse -> agentStop -> sessionEnd -> [session.shutdown written]
```

- **No hook payload contains usage.** Every payload is just
  `sessionId`/`timestamp`/`cwd` plus event-specific fields (toolName, prompt,
  reason, transcriptPath…). No tokens, no cost, no AIU/AIC.
- **No env var carries usage or even the session UUID.** The only Copilot vars
  exposed to the hook are `COPILOT_CLI`, `COPILOT_CLI_BINARY_VERSION`,
  `COPILOT_LOADER_PID`, `COPILOT_PROJECT_DIR`.
- **`session.shutdown` (the event holding `data.totalNanoAiu`) is written to
  `events.jsonl` *after* the last hook.** In the test, `sessionEnd` ended at
  `…38.945Z` and `session.shutdown` landed at `…39.002Z` — 57 ms later. So even
  the `sessionEnd` hook runs before the number exists.
- **`data.db` is not a live source.** Its `sessions` table *does* have
  `total_nano_aiu` + token columns + `is_running` + `updated_at`, but:
  - the `-p` test session never got a row at all (not even at `sessionEnd`);
  - with 4 real interactive sessions running, `WHERE is_running=1` returned
    **zero rows** and nothing was updated in the preceding 15 min.
  So running sessions are not mirrored there; rows appear only after a session
  is persisted/ended.

### Conclusion

AIC is computed server-side and committed only at `session.shutdown`, which is
the last thing written and is not exposed to hooks or to `data.db` while the
session is open. The existing approach (sum `totalNanoAiu` from shutdown events
in `events.jsonl`) remains the only reliable source.

## Where `totalNanoAiu` actually lives (rg sweep of ~/.copilot)

`rg` for the test session's exact value `12350550000` and for `aiu`/`aic`/
`nano_aiu` across the whole `~/.copilot` tree:

- The value appears in **exactly one place**: that session's `events.jsonl`
  `session.shutdown` event. **Nothing** in `~/.copilot/logs/` (process/app logs),
  nothing in `data.db`/`session-store.db` as text.
- The other `totalNanoAiu` hits are all in the **bundled CLI source** under
  `pkg/linux-x64/<ver>/` (`app.js`, `sdk/index.d.ts`, `schemas/…`) — i.e. type
  defs and schemas, not data.

### The one live source — and why it's out of reach for hooks/logs

The bundled event schema (`pkg/.../schemas/session-events.schema.json`) defines a
**`assistant.usage`** event, emitted per LLM API call, whose `data`
(`AssistantUsageData`) carries live usage including:

```
model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
reasoningTokens, cost, duration, quotaSnapshots,
copilotUsage.totalNanoAiu   <-- live AIC for that call
```

But the same schema marks it:

```
"ephemeral": { "const": true,
  "description": "...transient and not persisted to the session event log on disk." }
```

Confirmed empirically: **0 of the on-disk `events.jsonl` files contain an
`assistant.usage` event.** It exists only on the live in-process event stream
(SDK / `copilot --acp`), is not delivered to hooks, and is never written to a log
or DB. So live AIC is real, but only reachable by *being the client driving
Copilot* (ACP/SDK), not by reading files or installing hooks.

### Salvageable bits (for a passive, log-reading dashboard)

- **Live token estimate, not AIC:** `assistant.message` transcript events carry
  per-message `model` + `outputTokens`. A hook (or a tailer) can sum these live,
  but there is no exposed per-model AIU multiplier to turn tokens into AIC.
- **`sessionEnd` as a refresh trigger:** it fires ~60 ms before shutdown with
  `reason` and `cwd`. Useful to make a dashboard re-scan the moment a session
  closes (sub-second freshness) instead of waiting for the next poll — it just
  can't deliver the number itself.
- **Live AIC requires the ACP/SDK path:** to show usage for an *open* session you
  must consume `assistant.usage` from `copilot --acp` (or the SDK), not the logs.

## The clean live path: OpenTelemetry (works)

`copilot help monitoring` documents an OTel exporter, off by default. Enable it
per session with an env var (no collector needed):

```bash
COPILOT_OTEL_FILE_EXPORTER_PATH=/path/otel.jsonl copilot ...
# or stream to a collector:  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 copilot ...
```

Each LLM call and agent turn is exported as a span **as it completes** (live,
not at shutdown), carrying AIC as a span attribute:

```
chat <model>   span:  github.copilot.nano_aiu = <AIC for this call>, initiator, turn_id
invoke_agent   span:  github.copilot.nano_aiu = <cumulative session AIC>,
                      github.copilot.cost = <premium requests>, turn_count
```

Verified: a 2-call session exported `nano_aiu` 11254275000 + 946590000 =
12200865000 = **12.20 AIC**, identical to the footer and to the `invoke_agent`
cumulative attribute. Token breakdown also present via `gen_ai.usage.*`.

This is the supported, structured, live source. To capture usage for *open*
sessions, set `COPILOT_OTEL_FILE_EXPORTER_PATH` (or point at a local collector)
globally so every `copilot` session emits, then read that instead of waiting for
`session.shutdown`.

## Q&A from the investigation

- **Does editing `schemas/session-events.schema.json` make `assistant.usage`
  persist?** No. `app.js` never reads that file (it's a generated artifact). The
  `ephemeral` flag is set in code at emit time (`emitEphemeral(...)`) and the
  writer filters it out (`events.filter(e => !e.ephemeral)`). Only patching the
  minified `app.js` would change it — fragile and reverted by auto-update. Use
  OTLP instead.
- **Probing a running session's memory (e.g. PID 210546 showing 8.39 AIC)?**
  Technically the value is live in the V8 heap, but `yama/ptrace_scope=1` plus
  not being root means you can only attach to your *own child* processes — not a
  separately-started session — so `gcore`/reading `/proc/<pid>/mem` returns EIO
  without `sudo`. And attaching (`gcore`) `SIGSTOP`s the live session, risking the
  user's work. Not worth it when OTLP exposes the same number cleanly.
