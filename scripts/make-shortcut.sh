#!/usr/bin/env bash
#
# Build a signed macOS Shortcut that toggles the web viewer, ready to
# double-click and import.
#
#   scripts/make-shortcut.sh
#
# Regenerate this after moving the checkout: the shortcut runs viewer.sh by
# absolute path, because Shortcuts has no working directory to resolve against.
#
# Assign the hotkey by hand afterwards. There is no API for that: the key
# combination lives in the Shortcuts app's own database, not in the file.

set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VIEWER="$PROJECT/scripts/viewer.sh"
OUT_DIR="$PROJECT/shortcuts"
NAME="SD-Connect-Viewer"
OUT="$OUT_DIR/$NAME.shortcut"

[ -x "$VIEWER" ] || { echo "make-shortcut: $VIEWER is missing or not executable" >&2; exit 1; }
mkdir -p "$OUT_DIR"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A Shortcut is a plist of actions. One action is enough: run the script.
# `exec` keeps it to a single process, and the absolute path means it does not
# depend on the PATH Shortcuts happens to provide.
cat > "$work/sc.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowClientVersion</key><string>2605.0.3</string>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key><integer>946986751</integer>
    <key>WFWorkflowIconGlyphNumber</key><integer>59511</integer>
  </dict>
  <key>WFWorkflowTypes</key><array><string>NCWidget</string><string>WatchKit</string></array>
  <key>WFWorkflowInputContentItemClasses</key><array/>
  <key>WFWorkflowImportQuestions</key><array/>
  <key>WFQuickActionSurfaces</key><array/>
  <key>WFWorkflowHasShortcutInputVariables</key><false/>
  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.runshellscript</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Script</key>
        <string>exec $VIEWER</string>
        <key>Shell</key><string>/bin/zsh</string>
        <key>InputMode</key><string>to stdin</string>
        <key>Input</key>
        <dict>
          <key>Value</key><dict><key>Type</key><string>Nothing</string></dict>
          <key>WFSerializationType</key><string>WFTextTokenAttachment</string>
        </dict>
      </dict>
    </dict>
  </array>
</dict>
</plist>
PLIST

plutil -lint "$work/sc.plist" > /dev/null
# Shortcuts will not read an XML plist here; it wants the binary form.
plutil -convert binary1 "$work/sc.plist" -o "$work/unsigned.shortcut"

# Unsigned shortcuts are refused on import. 'anyone' avoids tying the file to
# this iCloud account, so the same file works on a second machine.
shortcuts sign --mode anyone --input "$work/unsigned.shortcut" --output "$OUT"

echo "Wrote $OUT"
echo
echo "To install:"
echo "  1. open '$OUT'        (imports it into Shortcuts)"
echo "  2. In Shortcuts, select '$NAME'"
echo "  3. Open the details pane (i, top right) and set a Keyboard Shortcut"
echo
echo "First run will ask permission to run a shell script. Approve it once."
