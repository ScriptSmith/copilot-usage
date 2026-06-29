# Copilot Usage - GNOME Shell Extension

A GNOME Shell extension that shows your GitHub Copilot CLI spend in the top bar:
today's spend (since midnight) and this week's spend (since Monday), both in
dollars.

It works from local data only, with no API calls or credentials to configure.
The extension watches `~/.copilot/session-state/` and recomputes the totals
whenever a session writes new data.

![Screenshot](screenshot.png)

## Top bar display

```
D: $1.23  W: $8.40
```

- D: total spent today, since local midnight
- W: total spent this week, since Monday 00:00

Click the indicator for a submenu per period (today, this week, this month, all
time). Each shows that period's total and breaks it down into nested submenus:
Sessions, Models, Directories, and Repositories. So you can see where this
month's spend went by model or by repository.

## How it works

GitHub Copilot CLI writes an `events.jsonl` file per session to:

```
~/.copilot/session-state/<session-id>/events.jsonl
```

When a session closes it appends a `session.shutdown` event recording usage as
nano-AIU at `data.totalNanoAiu`, where `AIC = totalNanoAiu / 1e9`. The extension
sums that across sessions and converts AIC to dollars at 1 AIC = $0.01
(configurable). Sessions before roughly 2026-06 predate nano-AIU tracking and
are excluded. See `SUMMARY.md` for the full data-format notes.

Because usage is only recorded on shutdown, sessions that are still open don't
contribute to the total until they exit. A session that ends abnormally (crash,
kill, reboot) never writes its shutdown event, so its cost is lost. The CLI and
the extension flag such sessions as incomplete and show a count, so you know
some usage went uncounted.

The optional [live collector](#live-usage-open-sessions) closes that gap: it
captures per-call usage as it happens, so open sessions show up before they
exit.

The scanning is done by [`copilot-usage-cli`](copilot-usage-cli/), a small
dependency-free Node script. The extension bundles a copy and runs
`node copilot-usage.js --json` in a short-lived subprocess, so it never blocks
GNOME Shell, and an mtime/size cache keeps repeat scans cheap. It sets up
`inotify`-backed file monitors on the session directory and each
recently-active session sub-directory so the totals update in near real time,
with a periodic rescan (default every 30s) as a backstop.

## Live usage (open sessions)

By default the totals only reflect closed sessions, because Copilot writes its
usage to disk only in the `session.shutdown` event. Copilot can also export
per-LLM-call usage live over OpenTelemetry when configured: each `chat` span
carries `github.copilot.nano_aiu` (the AIC for that call) tagged with the
session id. The bundled collector captures that into its own SQLite database,
and the CLI and extension merge it with the on-disk totals so a session's spend
shows up while it is still running.

```
on-disk shutdown totals  ─┐
                          ├─►  copilot-usage --collector  ─►  reconciled JSON
live OTLP collector       ─┘     (merge by session id)        (+ anomalies)
```

Reconciliation is by session id. A closed session's billed shutdown total is
authoritative, an open session's live total is added to today and this week,
and if the collector and the shutdown total disagree for the same session,
that's surfaced as an anomaly in the menu.

Anomalies older than 3 days and incomplete sessions older than 1 week stop
showing a ⚠ warning but stay listed in their submenus so you can still inspect
them. The CLI thresholds are configurable with `--anomaly-days` and
`--incomplete-days`.

### 1. Install the collector

```bash
./collector/install-collector.sh
```

This installs a socket-activated systemd user service listening on
`127.0.0.1:4318`, and writes the env var below. Socket activation means the port
is always accepting, so Copilot never hits a connection-refused even when the
collector is idle. (Requires Node >= 22.5 for the built-in `node:sqlite`.)

The collector runs as a systemd service rather than from the extension because
it has to be up whenever you use Copilot, including in a plain TTY with the
extension disabled or while GNOME Shell is reloading. A systemd user service
gives it its own lifecycle, restarts on failure, and starts on demand via the
socket. Use the extension as a fallback only if you can't use systemd.

### 2. Point Copilot at it (set the env var)

Copilot reads OTel config only from environment variables, not its
`settings.json`, so it has to be set in the environment Copilot launches in:

```ini
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Recommended: put it in `~/.config/environment.d/copilot-otel.conf` (the
installer does this for you). systemd applies it to the whole graphical session
at login, so every `copilot` you start exports, with no shell-specific setup. It
takes effect on your next login.

Alternatives:

| Method | File | Scope | Note |
|--------|------|-------|------|
| systemd user env (recommended) | `~/.config/environment.d/copilot-otel.conf` | whole login session | needs re-login |
| Shell profile | `~/.zshenv` / `~/.bashrc` | terminals only | `export OTEL_EXPORTER_OTLP_ENDPOINT=...` |
| Wrapper alias | shell rc | opt-in per command | `alias copilot='OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 copilot'` |

Prefer the endpoint form over `COPILOT_OTEL_FILE_EXPORTER_PATH`: a single file
exporter path makes concurrent sessions append to one file and interleave, while
the collector demultiplexes cleanly by session id. Already-running Copilot
sessions won't export, since OTel binds at startup. Only sessions started
afterwards will.

### 3. Verify

```bash
curl -s http://127.0.0.1:4318/healthz
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 copilot -p "echo hi" --allow-all
curl -s http://127.0.0.1:4318/sessions | python3 -m json.tool   # live per-session AIC
node copilot-usage-cli/copilot-usage.js --collector             # reconciled view
```

The extension picks the collector up automatically via its Live collector URL
setting (default `http://127.0.0.1:4318`; clear it to use on-disk data only).
Uninstall with `./collector/install-collector.sh --uninstall`.

## Requirements

- GNOME Shell 45-50
- Node.js >= 14 (the extension runs the bundled `copilot-usage.js` with `node`)
- GitHub Copilot CLI (writes the `~/.copilot/session-state` files)
- For live usage: Node >= 22.5 (the collector uses the built-in `node:sqlite`)
  and `systemd --user`

## Installation

```bash
./install.sh
```

Then either log out and back in, or on X11 press Alt+F2, type `r`, Enter.

Enable it:

```bash
gnome-extensions enable copilot-usage@local
```

Open preferences (refresh interval, dollars-per-AIC):

```bash
gnome-extensions prefs copilot-usage@local
```

## Files

```
copilot-usage/
├── extension.js              # Main GNOME extension code
├── prefs.js                  # Preferences UI
├── metadata.json             # Extension metadata
├── stylesheet.css            # Panel/menu styles
├── schemas/                  # GSettings schema
│   └── org.gnome.shell.extensions.copilot-usage.gschema.xml
├── install.sh                # Installation script (bundles the CLI script)
├── copilot-usage-cli/        # Standalone npm package (the scanner)
│   ├── copilot-usage.js      # Single-file CLI: reads events.jsonl, prints JSON/text
│   ├── package.json
│   └── README.md
├── collector/                # Optional live-usage collector
│   ├── copilot-usage-collector.js   # OTLP/HTTP receiver -> SQLite, serves /sessions
│   ├── systemd/              # socket-activated user units
│   └── install-collector.sh  # installs the service + sets the env var
└── README.md
```

The scanner lives in `copilot-usage-cli/` and is also publishable to npm as
`copilot-usage-cli` for standalone terminal use. `install.sh` copies
`copilot-usage.js` into the installed extension directory.

## Quick check from the terminal

Run the CLI directly to see the JSON the extension consumes:

```bash
node copilot-usage-cli/copilot-usage.js --json     # or, if installed globally: copilot-usage --json
```

It also has human-readable output: `copilot-usage`, `copilot-usage sessions`,
`copilot-usage session <id>`.

## Troubleshooting

Indicator shows `D: ERR`: run the CLI manually (above) to see the error. Make
sure `node` is on `PATH` (the extension uses `/usr/bin/node` if present).

Totals look low: only closed sessions report a cost. A session you're still
running won't be counted until it exits, and a session that crashed or was
killed never recorded its cost at all. The menu's Incomplete sessions submenu
lists any such sessions (warning only about ones from the last week).

Logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i copilot
```

## Development

Test changes without logging out by running a nested GNOME Shell:

```bash
dbus-run-session gnome-shell --devkit --wayland
```

## License

MIT
