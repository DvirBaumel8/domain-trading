#!/bin/bash
# G-109: pause the production API on the Mac host on purpose (e.g. Dvir: "stop the server").
# Writes the pause flag (UTC timestamp + optional reason) and boots out the api agent. The tunnel agents stay loaded.
# While the flag exists: deploy.sh does nothing, start.sh will not start the server (a reboot or login cannot bring it back), install.sh does not load it.
# Undo with resume.sh. Usage: stop.sh ["reason"]
set -euo pipefail
HOST_DIR="${HOST_DIR:-$HOME/.local/share/domain-trading-host}"
FLAG="$HOST_DIR/PAUSED"
UID_NUM="$(id -u)"
mkdir -p "$HOST_DIR"
echo "$(date -u +%FT%TZ)${1:+ $1}" > "$FLAG"
launchctl bootout "gui/$UID_NUM/com.domaintrading.api" 2>/dev/null || true
echo "$(date -u +%FT%TZ) paused: $(cat "$FLAG"). The api agent is unloaded; run resume.sh to start it again."
