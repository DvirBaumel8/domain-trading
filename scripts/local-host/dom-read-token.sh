#!/bin/bash
# Dvir, 25 Oct 2026 ("Yes of course I want this change! You should have read only access!"): DOM gets its own READ token, so it can read production
# (GET routes only: no write, no money action) without anyone handling a key. Called by deploy.sh on every tick; non-fatal there (`|| true`).
# If the token file is missing, it creates a READ token named `dom-read` with the current release's admin command and writes it to TOKEN_FILE (mode 600).
# The token is never an argument, never echoed and never logged. To revoke: `npm run admin -- token list` / `token revoke --id`, then delete the file.
set -uo pipefail
PAUSE_FLAG="${PAUSE_FLAG:-$HOME/.local/share/domain-trading-host/PAUSED}"
[ -f "$PAUSE_FLAG" ] && exit 0
TOKEN_FILE="${DOM_READ_TOKEN_FILE:-$HOME/.config/domain-trading/dom-read.token}"
[ -s "$TOKEN_FILE" ] && exit 0
PROD_DIR="${PROD_DIR:-$HOME/domain-trading-prod}"
APP_DIR="${APP_DIR:-$PROD_DIR-current}"
ENV_FILE="$HOME/.config/domain-trading/prod.env"
[ -e "$APP_DIR/dist/modules/ops/admin.js" ] || exit 0
[ -f "$ENV_FILE" ] || exit 0
cd "$APP_DIR" || exit 0
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] && [ -n "${BASH_REMATCH[2]}" ] && export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$ENV_FILE"
log() { echo "$(date -u +%FT%TZ) dom-read-token: $*"; }
tok="$(node dist/modules/ops/admin.js token create --scope read --name dom-read 2>/dev/null | tail -1)"
if [ -n "$tok" ]; then
  umask 077
  mkdir -p "$(dirname "$TOKEN_FILE")"
  printf %s "$tok" > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE" && log "READ token dom-read created and stored for DOM"
else
  log "could not create the dom-read token (database unreachable?); the next tick tries again"
fi
unset tok
exit 0
