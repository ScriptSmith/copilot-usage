#!/bin/bash

# Install script for Copilot Usage GNOME extension

EXTENSION_UUID="copilot-usage@local"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing Copilot Usage extension..."

# Create extension directory
mkdir -p "$EXTENSION_DIR/schemas"

# Copy files
cp "$SRC_DIR/metadata.json" "$EXTENSION_DIR/"
cp "$SRC_DIR/extension.js" "$EXTENSION_DIR/"
cp "$SRC_DIR/prefs.js" "$EXTENSION_DIR/"
cp "$SRC_DIR/stylesheet.css" "$EXTENSION_DIR/"
# Bundle the copilot-usage-cli script; the extension runs it with node.
cp "$SRC_DIR/copilot-usage-cli/copilot-usage.js" "$EXTENSION_DIR/"
cp "$SRC_DIR/schemas/"*.xml "$EXTENSION_DIR/schemas/"

# Compile schemas in the extension directory
glib-compile-schemas "$EXTENSION_DIR/schemas/"

# Sanity check: the extension needs node to run the bundled CLI.
if ! command -v node >/dev/null 2>&1; then
    echo "WARNING: 'node' not found on PATH. Install Node.js (>=14) so the extension can run copilot-usage.js."
fi

echo "Extension installed to: $EXTENSION_DIR"
echo ""
echo "To enable the extension:"
echo "  1. Log out and log back in (or press Alt+F2, type 'r', press Enter on X11)"
echo "  2. Enable the extension with: gnome-extensions enable $EXTENSION_UUID"
echo "  3. Or use the GNOME Extensions app to enable it"
echo ""
echo "To configure:"
echo "  gnome-extensions prefs $EXTENSION_UUID"
echo ""
echo "To test it in a nested shell:"
echo "  dbus-run-session gnome-shell --devkit --wayland"
