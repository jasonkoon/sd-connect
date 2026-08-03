#!/bin/bash
#
# Install (or reinstall) the sd-connect launch agent, so the daemon starts at
# login and stays running.
#
#   ./scripts/install-launchd.sh
#   ./scripts/install-launchd.sh --node /path/to/node
#
# Safe to re-run: it unloads any existing agent first.

set -euo pipefail

LABEL="com.jasonkoon.sd-connect"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$PROJECT/launchd/$LABEL.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/sd-connect"

NODE_BIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) NODE_BIN="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Pick a node.
#
# launchd has no useful PATH, so the plist needs an absolute path. Prefer a
# Homebrew node: it lives outside any version manager, so a version-manager
# upgrade or prune cannot silently break login startup.
# ---------------------------------------------------------------------------
if [[ -z "$NODE_BIN" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then NODE_BIN="$candidate"; break; fi
  done
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "error: no node found at /opt/homebrew/bin/node or /usr/local/bin/node." >&2
  echo "       install one with 'brew install node', or pass --node <path>." >&2
  echo >&2
  echo "       A version-manager node (nvm, vite-plus, fnm) will work today but" >&2
  echo "       can be upgraded or pruned out from under the agent, which breaks" >&2
  echo "       startup at login with no obvious cause." >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "error: $NODE_BIN is not executable" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Preflight: fail here, with an explanation, rather than in a login-time log.
# ---------------------------------------------------------------------------
echo "sd-connect launch agent"
echo "  project: $PROJECT"
echo "  node:    $NODE_BIN ($("$NODE_BIN" --version))"

if [[ ! -f "$PROJECT/src/main.ts" ]]; then
  echo "error: $PROJECT/src/main.ts not found" >&2
  exit 1
fi

if [[ ! -d "$PROJECT/node_modules" ]]; then
  echo "error: node_modules missing; run 'npm install' first" >&2
  exit 1
fi

# The native modules are the fragile part across node versions, so prove they
# load under exactly the interpreter the agent will use.
echo -n "  checking native modules... "
if ! "$NODE_BIN" -e "
  await import('@elgato-stream-deck/node');
  await import('@napi-rs/canvas');
" 2>/tmp/sd-connect-preflight.err; then
  echo "FAILED"
  echo >&2
  echo "The native modules do not load under $NODE_BIN:" >&2
  sed 's/^/    /' /tmp/sd-connect-preflight.err >&2
  echo >&2
  echo "Try 'npm rebuild', or pass a different --node." >&2
  exit 1
fi
echo "ok"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

# ---------------------------------------------------------------------------
# Render and install.
# ---------------------------------------------------------------------------
sed \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__PROJECT__|$PROJECT|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$TEMPLATE" > "$PLIST"

plutil -lint "$PLIST" >/dev/null || { echo "error: generated plist is invalid" >&2; exit 1; }

# Unload any previous copy, then WAIT for launchd to actually finish.
#
# bootout returns before teardown completes, so bootstrapping straight after it
# fails with "Bootstrap failed: 5: Input/output error". Worse, bootout itself
# succeeded, so without this the script reported success while leaving nothing
# loaded. Measured: reinstalling without the wait failed about two times in three.
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 50); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 0.1
  done
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "error: could not unload the existing agent; try again in a moment" >&2
    exit 1
  fi
fi

# Retry regardless: launchd can still be briefly busy after teardown.
bootstrapped=false
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/tmp/sd-connect-bootstrap.err; then
    bootstrapped=true
    break
  fi
  sleep 0.5
done

if [[ "$bootstrapped" != true ]]; then
  echo "error: launchctl bootstrap failed after 5 attempts:" >&2
  sed 's/^/    /' /tmp/sd-connect-bootstrap.err >&2
  exit 1
fi

launchctl enable "gui/$(id -u)/$LABEL"

echo "  installed: $PLIST"
echo "  logs:      $LOG_DIR/sd-connect.log"
echo

sleep 2
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  pid="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')"
  if [[ -n "$pid" ]]; then
    echo "running (pid $pid)"
  else
    echo "loaded, but not currently running. Check:"
    echo "  tail -20 $LOG_DIR/sd-connect.error.log"
  fi
else
  echo "warning: agent does not appear to be loaded" >&2
fi

cat <<'NOTE'

One-time permission step
------------------------
Pressing a key raises the terminal window, which uses AppleScript. The first
time the agent tries it, macOS will show an Accessibility prompt; approve it.
Until you do, presses still focus the pane inside herdr but the window will not
come forward, and the log will say:

  osascript is not allowed assistive access. (-1719)

If you miss the prompt, grant it manually under
System Settings > Privacy & Security > Accessibility.
NOTE
