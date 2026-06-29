#!/usr/bin/env bash
#
# Install the Copilot Usage OTLP collector as a socket-activated systemd *user*
# service, and point Copilot CLI's OpenTelemetry exporter at it.
#
# After this runs, every `copilot` session you start (in a fresh login session)
# streams live usage to the collector, which the CLI/extension read back and
# reconcile against the on-disk shutdown totals.
#
# Usage:  ./install-collector.sh           install + enable
#         ./install-collector.sh --uninstall
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$HOME/.local/lib/copilot-usage-collector"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/environment.d"
ENV_FILE="$ENV_DIR/copilot-otel.conf"
SCRIPT="$LIB_DIR/copilot-usage-collector.js"
ENDPOINT="http://127.0.0.1:4318"

if [ "${1:-}" = "--uninstall" ]; then
    echo "Uninstalling collector..."
    systemctl --user disable --now copilot-usage-collector.socket 2>/dev/null || true
    systemctl --user stop copilot-usage-collector.service 2>/dev/null || true
    rm -f "$UNIT_DIR/copilot-usage-collector.socket" "$UNIT_DIR/copilot-usage-collector.service"
    rm -f "$ENV_FILE"
    rm -rf "$LIB_DIR"
    systemctl --user daemon-reload
    echo "Removed units, script, and $ENV_FILE."
    echo "Note: the usage database under ~/.local/share/copilot-usage-collector was kept."
    echo "Log out/in (or unset OTEL_EXPORTER_OTLP_ENDPOINT) to stop Copilot exporting."
    exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
    echo "ERROR: 'node' not found on PATH (need Node >= 22.5 for node:sqlite)." >&2
    exit 1
fi
NODE_MAJOR="$("$NODE" -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "ERROR: Node $($NODE --version) is too old; the collector needs node:sqlite (Node >= 22.5)." >&2
    exit 1
fi

echo "Installing collector script -> $SCRIPT"
mkdir -p "$LIB_DIR" "$UNIT_DIR" "$ENV_DIR"
cp "$SRC_DIR/copilot-usage-collector.js" "$SCRIPT"

echo "Rendering systemd units -> $UNIT_DIR"
sed -e "s#@NODE@#$NODE#g" -e "s#@SCRIPT@#$SCRIPT#g" \
    "$SRC_DIR/systemd/copilot-usage-collector.service" > "$UNIT_DIR/copilot-usage-collector.service"
cp "$SRC_DIR/systemd/copilot-usage-collector.socket" "$UNIT_DIR/copilot-usage-collector.socket"

echo "Writing $ENV_FILE"
cat > "$ENV_FILE" <<EOF
# Point GitHub Copilot CLI's OpenTelemetry exporter at the local usage collector.
# Read by systemd at login and exported into the whole graphical session.
OTEL_EXPORTER_OTLP_ENDPOINT=$ENDPOINT
EOF

systemctl --user daemon-reload
systemctl --user enable --now copilot-usage-collector.socket

echo
echo "Collector installed and socket-activated on $ENDPOINT."
echo "Verify:   curl -s $ENDPOINT/healthz"
echo
echo "IMPORTANT: the env var is applied to NEW login sessions. For this terminal now:"
echo "    export OTEL_EXPORTER_OTLP_ENDPOINT=$ENDPOINT"
echo "Then start a copilot session and run:  curl -s $ENDPOINT/sessions | python3 -m json.tool"
echo
echo "Already-running copilot sessions won't export (OTel binds at startup)."
echo "Log out and back in to cover every future session automatically."
