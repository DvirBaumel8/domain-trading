#!/bin/bash
# Dvir, 25 Oct 2026 ("You are allowed to operate production. No need token go ahead"): DOM gets its own WRITE token to operate production (jobs, data loads, checks).
# Money actions (buy, import, list, price, sell, bid plans) still need Dvir's own chat line per action (CLAUDE.md, DOM operating rule). Run once by DOM on the host.
# If the token file is missing, it creates a WRITE token named `dom-write` with the current release's admin command and writes it to TOKEN_FILE (mode 600).
# The token is never an argument, never echoed and never logged. To revoke: `npm run admin -- token list` / `token revoke --id`, then delete the file.
set -uo pipefail
PAUSE_FLAG="${PAUSE_FLAG:-$HOME/.local/share/domain-trading-host/PAUSED}"
[ -f "$PAUSE_FLAG" ] && exit 0
TOKEN_FILE="${DOM_WRITE_TOKEN_FILE:-$HOME/.config/domain-trading/dom-write.token}"
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
log() { echo "$(date -u +%FT%TZ) dom-write-token: $*"; }
tok="$(node dist/modules/ops/admin.js token create --scope write --name dom-write 2>/dev/null | tail -1)"
if [ -n "$tok" ]; then
  umask 077
  mkdir -p "$(dirname "$TOKEN_FILE")"
  printf %s "$tok" > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE" && log "WRITE token dom-write created and stored for DOM"
else
  log "could not create the dom-write token (database unreachable?); the next tick tries again"
fi
unset tok
exit 0
