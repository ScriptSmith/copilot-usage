# Copilot Usage GNOME Shell Extension

A GNOME Shell extension that shows your GitHub Copilot CLI spend in the top bar:
today's spend (since midnight) and this week's spend (since Monday), both in
dollars.

It works from local data only, with no API calls or credentials to configure.
The extension watches `~/.copilot/session-state/` and recomputes the totals
whenever a session writes new data.

![Screenshot](screenshot.png)

```
D: $1.23  W: $8.40
```

- D: total spent today, since local midnight
- W: total spent this week, since Monday 00:00

Click the indicator for a submenu per period (today, this week, this month, all
time). Each shows that period's total broken down by session, model, directory,
and repository.

## Installation

```bash
git clone git@github.com:ScriptSmith/copilot-usage.git
cd copilot-usage
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

### Requirements

- GNOME Shell 45-50
- Node.js >= 14 (the extension runs the bundled `copilot-usage.js` with `node`)
- GitHub Copilot CLI (writes the `~/.copilot/session-state` files)
- For live usage: Node >= 22.5 (the collector uses the built-in `node:sqlite`)
  and `systemd --user`

## How it works

The extension reads Copilot's local session data and sums the recorded usage,
converting to dollars at 1 AIC = $0.01 (configurable).

Copilot only records a session's usage when it closes, so open sessions don't
count until they exit, and a session that crashes or is killed never records its
cost. The extension flags these as incomplete and shows a count so you know some
usage went uncounted. The optional [live collector](#live-usage-open-sessions)
closes that gap.

## Live usage (open sessions)

To count open sessions too, Copilot can export per-call usage live over
OpenTelemetry. The bundled collector captures that into a SQLite database, and
the CLI and extension merge it with the on-disk totals so a session's spend shows
up while it is still running. Reconciliation is by session id: a closed session's
shutdown total is authoritative, an open session's live total is added in, and
any disagreement between the two is surfaced as an anomaly in the menu.

### 1. Install the collector

```bash
./collector/install-collector.sh
```

This installs a socket-activated systemd user service listening on
`127.0.0.1:4318`, and writes the env var below. Socket activation means the port
is always accepting, so Copilot never hits a connection-refused even when the
collector is idle. It runs as a systemd service rather than from the extension so
it stays up whenever you use Copilot, including in a plain TTY or while GNOME
Shell is reloading.

### 2. Point Copilot at it (set the env var)

Copilot reads OTel config only from environment variables, so it has to be set in
the environment Copilot launches in:

```ini
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

Recommended: put it in `~/.config/environment.d/copilot-otel.conf` (the installer
does this for you). systemd applies it to the whole graphical session at login,
so every `copilot` you start exports, with no shell-specific setup. It takes
effect on your next login. Alternatively, `export` it from your shell profile, or
wrap `copilot` in an alias that sets it.

Already-running Copilot sessions won't export, since OTel binds at startup. Only
sessions started afterwards will.

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
running won't be counted until it exits, and a session that crashed or was killed
never recorded its cost at all. The menu's Incomplete sessions submenu lists any
such sessions.

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
