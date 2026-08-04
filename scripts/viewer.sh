#!/usr/bin/env bash
#
# Show the sd-connect web viewer, as a standalone window rather than a browser
# tab. Meant to be bound to a hotkey.
#
#   scripts/viewer.sh           toggle: raise it, or hide it if already frontmost
#   scripts/viewer.sh show      always raise, never hide
#   scripts/viewer.sh --port N  override the port
#
# Toggling is the point: one key both summons and dismisses it, so glancing at
# agent status costs a single keystroke each way.
#
# The port is resolved the same way the daemon resolves it (flag, then config,
# then the built-in default) so the two cannot disagree about where to look.

set -euo pipefail

DEFAULT_PORT=8787
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/sd-connect/config.toml"
# Chrome renders --app windows without tabs or an address bar, which is what
# makes this read as a dedicated display instead of a browser.
BROWSER="Google Chrome"

action="toggle"
port=""

while [ $# -gt 0 ]; do
  case "$1" in
    show)     action="show"; shift ;;
    toggle)   action="toggle"; shift ;;
    --port)   port="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "viewer: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

# Port from config: the first `port =` inside the [web] table.
#
# Scoped to that table so a `port` under another section cannot match, and the
# trailing comment is stripped before reading digits — `port = 8500 # was 9000`
# would otherwise concatenate into 85009000.
config_port() {
  [ -f "$CONFIG" ] || return 0
  awk '
    /^[[:space:]]*\[/ { in_web = ($0 ~ /^[[:space:]]*\[web\]/) }
    in_web && /^[[:space:]]*port[[:space:]]*=/ {
      sub(/#.*/, "", $0)
      sub(/^[^=]*=[[:space:]]*/, "", $0)
      gsub(/[^0-9]/, "", $0)
      if (length($0)) { print; exit }
    }
  ' "$CONFIG"
}

if [ -z "$port" ]; then
  port="$(config_port || true)"
fi
: "${port:=$DEFAULT_PORT}"

case "$port" in
  ''|*[!0-9]*) echo "viewer: invalid port '$port'" >&2; exit 64 ;;
esac

URL="http://127.0.0.1:${port}"

# Nothing listening means the daemon is down, and a browser window would just
# show a connection error. Say so instead.
if ! nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "viewer: nothing listening on ${URL}" >&2
  echo "viewer: is the daemon running?  launchctl list | grep sd-connect" >&2
  osascript -e "display notification \"Nothing listening on ${URL}\" with title \"sd-connect viewer\"" 2>/dev/null || true
  exit 3
fi

# Find an existing viewer window. Matching on URL rather than title means a
# frame with no agents (blank title) is still found.
read -r found frontmost <<EOF
$(osascript <<APPLESCRIPT 2>/dev/null || echo "false false"
on run
  set foundIt to false
  if application "${BROWSER}" is running then
    tell application "${BROWSER}"
      repeat with w in windows
        -- Count tabs by hand. "index of t" is not a valid tab property: it
        -- fails with -10006, which aborted the whole script and made every
        -- invocation look like "no window found", so the toggle never hid.
        set tabIndex to 0
        repeat with t in tabs of w
          set tabIndex to tabIndex + 1
          if URL of t starts with "${URL}" then
            set index of w to 1
            set active tab index of w to tabIndex
            set foundIt to true
            exit repeat
          end if
        end repeat
        if foundIt then exit repeat
      end repeat
    end tell
  end if
  set isFront to false
  if foundIt then
    tell application "System Events"
      set isFront to (name of first application process whose frontmost is true) is "${BROWSER}"
    end tell
  end if
  return (foundIt as text) & " " & (isFront as text)
end run
APPLESCRIPT
)
EOF

if [ "$found" = "true" ]; then
  if [ "$action" = "toggle" ] && [ "$frontmost" = "true" ]; then
    # Already looking at it: the same key should put it away. Hiding the app
    # returns focus to whatever was behind it, which beats minimising.
    osascript -e "tell application \"System Events\" to set visible of application process \"${BROWSER}\" to false" 2>/dev/null || true
    exit 0
  fi
  osascript -e "tell application \"${BROWSER}\" to activate" 2>/dev/null || true
  exit 0
fi

# No window yet: open a fresh app-mode one. `-n` is required, otherwise Chrome
# reuses the running instance and ignores --app entirely.
open -na "${BROWSER}" --args --app="${URL}" >/dev/null 2>&1
exit 0
