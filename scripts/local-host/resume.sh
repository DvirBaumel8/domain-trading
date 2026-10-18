#!/bin/bash
# G-109: end the pause set by stop.sh. Removes the pause flag and loads the api agent again (RunAtLoad starts the server).
# deploy.sh (every 10 min) then deploys any newer release tag as usual.
set -euo pipefail
HOST_DIR="${HOST_DIR:-$HOME/.local/share/domain-trading-host}"
FLAG="$HOST_DIR/PAUSED"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
if [ -f "$FLAG" ]; then echo "was paused since $(cat "$FLAG")"; else echo "no pause flag"; fi
rm -f "$FLAG"
launchctl bootout "gui/$UID_NUM/com.domaintrading.api" 2>/dev/null || true
# bootstrap right after bootout can fail with "Input/output error" while launchd is still unloading: retry
for try in 1 2 3 4 5; do
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/com.domaintrading.api.plist" 2>/dev/null && break
  [ "$try" = 5 ] && { echo "could not load com.domaintrading.api"; exit 1; }
  sleep 2
done
launchctl kickstart -k "gui/$UID_NUM/com.domaintrading.api" 2>/dev/null || true
echo "$(date -u +%FT%TZ) resumed: api agent loaded"
