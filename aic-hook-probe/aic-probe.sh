#!/usr/bin/env bash
# aic-probe.sh — log everything a GitHub Copilot CLI hook can observe, so we can
# find out whether AIC usage is readable *before* the session.shutdown event.
#
# Registered for every hook event (see hooks/aic-probe.json). It is deliberately
# side-effect-free from the CLI's point of view:
#   * everything it captures is written to a log file, never to stdout
#   * stdout is always empty  -> "default behavior" for every event type
#   * it always exits 0        -> never denies a tool (preToolUse is fail-closed)
# so leaving it installed cannot block tools, force extra turns, or change
# permission decisions.
#
# Usage (from the hook config): bash /abs/path/aic-probe.sh <eventName>
set -uo pipefail

EVENT="${1:-unknown}"
LOG_DIR="${AIC_PROBE_LOG_DIR:-$HOME/.copilot/aic-probe-logs}"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG="$LOG_DIR/probe.jsonl"

# stdin = the hook payload JSON (may be empty for some events)
PAYLOAD="$(cat)"

DB="$HOME/.copilot/data.db"

# Live usage snapshot: the 5 most-recently-updated session rows, including the
# running one(s). total_nano_aiu / 1e9 = AIC. If this is non-zero here, it means
# usage is queryable at this hook stage, before shutdown writes events.jsonl.
DB_SNAPSHOT='[]'
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DB" ]; then
  SNAP="$(sqlite3 "$DB" -json \
    "SELECT id, is_running, model, total_nano_aiu, total_input_tokens, total_output_tokens, total_cached_tokens, total_reasoning_tokens, updated_at \
     FROM sessions ORDER BY updated_at DESC LIMIT 5;" 2>/dev/null)" || SNAP=""
  [ -n "$SNAP" ] && DB_SNAPSHOT="$SNAP"
fi

# Any environment variables the CLI exposes to the hook process (the real
# session id may be hiding in here even when the payload sessionId is a tool id).
ENV_SNAPSHOT="$(env | grep -iE '^(COPILOT|GH_|GITHUB|AIC|AIU|XDG|SESSION)' | sort || true)"

# Assemble one JSON-lines record with Python (safe JSON, no shell-quoting traps).
python3 - "$EVENT" "$PAYLOAD" "$DB_SNAPSHOT" "$ENV_SNAPSHOT" >>"$LOG" 2>/dev/null <<'PY'
import sys, json, os, time
event, payload, db, envs = sys.argv[1:5]
def parse(s, default):
    try:
        return json.loads(s)
    except Exception:
        return default
rec = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int((time.time()%1)*1000):03d}Z",
    "event": event,
    "pid": os.getpid(),
    "payload": parse(payload, {"_raw": payload}),
    "db_sessions": parse(db, db),
    "env": dict(l.split("=", 1) for l in envs.splitlines() if "=" in l),
}
print(json.dumps(rec))
PY

exit 0
