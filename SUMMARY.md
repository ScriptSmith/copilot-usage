# Copilot CLI AIC Usage -- How to Retrieve It

## Where it's stored

Each CLI session writes an `events.jsonl` file to:

```
~/.copilot/session-state/<session-id>/events.jsonl
```

AIC cost is recorded in the `session.shutdown` event that is appended when a session closes. Sessions that are still open have no shutdown event yet, so their cost won't appear until they exit.

## Shutdown event structure

```json
{
  "type": "session.shutdown",
  "data": {
    "sessionStartTime": 1750000000000,
    "totalPremiumRequests": 5,
    "totalNanoAiu": 7654275000,
    "modelMetrics": {
      "gpt-5.5": {
        "requests": {
          "count": 3,
          "cost": 1
        },
        "totalNanoAiu": 7654275000,
        "usage": {
          "inputTokens": 120000,
          "outputTokens": 4000,
          "cacheReadTokens": 80000,
          "cacheWriteTokens": 0,
          "reasoningTokens": 0
        }
      }
    }
  }
}
```

**Use `totalNanoAiu` for the AIC, not `cost`.** As of ~2026-06 the CLI records the true fractional AIC in nano-AIU units: `AIC = totalNanoAiu / 1e9` (here `7654275000 / 1e9 = 7.65 AIC`). The top-level `data.totalNanoAiu` equals the sum of the per-model `modelMetrics.<model>.totalNanoAiu`.

The `cost` field under `modelMetrics.<model>.requests.cost` is **not** reliable: on newer sessions it holds the premium-request count, not the AIC. It is only useful as a fallback for older sessions (before ~2026-06) that predate `totalNanoAiu`.

## One-liner: today's AIC by session

```bash
find ~/.copilot/session-state -name "events.jsonl" | xargs grep -h "session.shutdown" | python3 -c "
import sys, json
from datetime import datetime, timezone
today = datetime.now(timezone.utc).date()
def aic(d):
    # nano-AIU only; pre-2026-06 sessions lack it and are excluded
    nano = d.get('totalNanoAiu') or sum(m.get('totalNanoAiu',0) or 0 for m in d.get('modelMetrics',{}).values())
    return nano/1e9 if nano else 0
total = 0
for line in sys.stdin:
    try:
        e = json.loads(line)
        if e.get('type') == 'session.shutdown':
            d = e['data']
            dt = datetime.fromtimestamp(d['sessionStartTime']/1000, tz=timezone.utc).date()
            if dt == today:
                a = aic(d)
                print(f'  {a:.2f} AIC  {list(d.get(\"modelMetrics\", {}).keys())}')
                total += a
    except: pass
print(f'Total: {total:.2f} AIC')
"
```

## One-liner: all-time total

```bash
find ~/.copilot/session-state -name "events.jsonl" | xargs grep -h "session.shutdown" | python3 -c "
import sys, json
def aic(d):
    # nano-AIU only; pre-2026-06 sessions lack it and are excluded
    nano = d.get('totalNanoAiu') or sum(m.get('totalNanoAiu',0) or 0 for m in d.get('modelMetrics',{}).values())
    return nano/1e9 if nano else 0
total = 0
for line in sys.stdin:
    try:
        e = json.loads(line)
        if e.get('type') == 'session.shutdown':
            total += aic(e['data'])
    except: pass
print(f'All-time total: {total:.2f} AIC')
"
```

## Notes

- The cloud session store (`session_store_sql`) does **not** record AIC or token counts for CLI sessions -- only these local `events.jsonl` files do.
- AIC is **only** written in `session.shutdown`. There is no incremental per-turn or per-request usage in the log, so a session that ends abnormally (crash, kill, reboot) has no recoverable cost. The `assistant.message` / `function` events carry no token or AIU data (any `aiu` substring there is base64 inside `encryptedContent` / `reasoningOpaque`). Such sessions can be detected (activity but no shutdown event) and dated via the `session.start` event's ISO `startTime`, but their AIC cannot be reconstructed.
- The working directory, git repository, and branch a session ran in are recorded in the **`session.start`** event at `data.context.cwd` / `data.context.repository` / `data.context.branch` (not in the shutdown event), which is what lets usage be broken down by directory and repository.
- Sessions still open at the time of querying are excluded (no shutdown event yet).
- `totalPremiumRequests` in the shutdown event is a rounded integer.
- The fractional AIC shown by `/usage` is `totalNanoAiu / 1e9`. The `modelMetrics.<model>.requests.cost` field is **not** the AIC on newer sessions (it became the premium-request count); only fall back to it for pre-~2026-06 sessions that lack `totalNanoAiu`.
