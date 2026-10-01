#!/usr/bin/env bash
#
# Run a command in the current Ghostty pane.
#
# Stream Deck macros are spawned by the daemon with the daemon's own working
# directory (the sd-connect repo, under launchd), not the directory you happen
# to be looking at. This script works around that: it asks Ghostty which
# project the frontmost window's focused terminal is in, then cd's there and
# runs the given command. One press = run in the pane you're looking at.
#
#   scripts/run-in-pane.sh <command...>
#
# Example (the MR macro):
#   scripts/run-in-pane.sh 'pi --model vertex/gemini-3.7-flash -p "create and push an MR"'
#
# If Ghostty cannot report a directory (no Ghostty window open), it fails
# loudly rather than silently running in the wrong place, because "ran in the
# wrong repo" is worse than "did nothing".

set -euo pipefail

# Ghostty's AppleScript "front window" is the app's own frontmost window — the
# one you last used, even if a different app has focus right now. That is the
# pane we want: pressing a Stream Deck key happens while you're looking at the
# terminal, and should run where you were working.
cwd() {
  osascript <<'APPLESCRIPT' 2>/dev/null || true
on run
  tell application "Ghostty" to get working directory of focused terminal of selected tab of front window
end run
APPLESCRIPT
}

if [ $# -eq 0 ]; then
  echo "run-in-pane: missing command" >&2
  exit 64
fi

DIR="$(cwd || true)"
if [ -z "$DIR" ]; then
  echo "run-in-pane: could not determine the frontmost Ghostty pane's directory" >&2
  echo "run-in-pane: make sure a Ghostty window is open, then retry" >&2
  exit 3
fi

cd "$DIR"
# Run through the shell so a single config string parses into args, exactly
# as the daemon's /bin/zsh -c does for plain macros.
exec /bin/zsh -c "$*"
