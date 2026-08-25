#!/usr/bin/env bash
# install-lockscreen-nautilus-script.sh
# Installs (or removes) the "Set as Lockscreen Wallpaper" Nautilus script.
#
# Usage:
#   bash install-lockscreen-nautilus-script.sh           — install
#   bash install-lockscreen-nautilus-script.sh --remove  — remove

set -e

SCRIPT_NAME="Set as Lockscreen Wallpaper"
SCRIPTS_DIR="$HOME/.local/share/nautilus/scripts"
SCRIPT_PATH="$SCRIPTS_DIR/$SCRIPT_NAME"
SCHEMA_ID="org.gnome.shell.extensions.wack-lockscreen-clock"

# ── Remove mode ────────────────────────────────────────────────────────────────
if [ "$1" = "--remove" ]; then
    if [ -f "$SCRIPT_PATH" ]; then
        rm -f "$SCRIPT_PATH"
        echo "Removed: $SCRIPT_PATH"
    else
        echo "Script not installed, nothing to remove."
    fi
    exit 0
fi

# ── Install mode ───────────────────────────────────────────────────────────────
if [ "$EUID" -eq 0 ]; then
    echo "Warning: Running as root. The script will be installed for root, not your user."
fi

# Check gsettings is available
if ! command -v gsettings &> /dev/null; then
    echo "Error: 'gsettings' not found. Cannot communicate with lockscreen extension."
    exit 1
fi

# Create scripts directory if needed
mkdir -p "$SCRIPTS_DIR"

# Write the Nautilus script
cat > "$SCRIPT_PATH" << 'NAUTILUS_SCRIPT'
#!/usr/bin/env bash
# Set as Lockscreen Wallpaper — WACK Shell Nautilus Script
# Sends the selected image file path to the WACK Sonoma Lockscreen extension.

SCHEMA="org.gnome.shell.extensions.wack-lockscreen-clock"

# NAUTILUS_SCRIPT_SELECTED_FILE_PATHS contains newline-separated absolute paths
FILE=$(echo "$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS" | head -1 | tr -d '\n\r')

if [ -z "$FILE" ]; then
    notify-send "WACK Shell" "No file selected." --icon=dialog-error 2>/dev/null || true
    exit 1
fi

# Verify schema is available
if ! gsettings list-schemas 2>/dev/null | grep -q "^${SCHEMA}$"; then
    notify-send "WACK Shell" "WACK Sonoma Lockscreen extension is not installed." --icon=dialog-error 2>/dev/null || true
    exit 1
fi

# Apply the wallpaper
gsettings set "$SCHEMA" lockscreen-wallpaper-path "$FILE"
gsettings set "$SCHEMA" lockscreen-wallpaper-enable true

BASENAME=$(basename "$FILE")
notify-send "WACK Shell" "Lockscreen wallpaper set to: $BASENAME" --icon=preferences-desktop-wallpaper 2>/dev/null || true
NAUTILUS_SCRIPT

chmod +x "$SCRIPT_PATH"

echo "=========================================="
echo "  Installed: $SCRIPT_PATH"
echo "=========================================="
echo "  Right-click any image in Nautilus and"
echo "  look under: Scripts > Set as Lockscreen Wallpaper"
echo "=========================================="
