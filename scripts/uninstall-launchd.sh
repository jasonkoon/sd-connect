#!/bin/bash
#
# Remove the sd-connect launch agent.
#
#   ./scripts/uninstall-launchd.sh
#
# Leaves logs in ~/Library/Logs/sd-connect alone.

set -euo pipefail

LABEL="com.jasonkoon.sd-connect"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  echo "unloaded $LABEL"
else
  echo "$LABEL was not loaded"
fi

if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "removed $PLIST"
else
  echo "no plist at $PLIST"
fi

echo "done. Logs kept in ~/Library/Logs/sd-connect"
