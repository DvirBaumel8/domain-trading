#!/bin/bash
# CR-068 (Dvir, 19 Oct 2026: "Allow it"): hands the visit-counter token from this Mac to the GitHub secret VISIT_COUNTER_TOKEN, so no person sees it.
# Called by deploy.sh on every tick (every 10 min) after the pause check; non-fatal there (`|| true`). Run by launchd through deploy.sh, never by DOM.
# Flow: POST /visits/settings {token: "request"} (Gavriel, after Dvir's line naming "visits token") sets the request in the database. This script then asks the
# built release for the token (`admin visits-token-handoff` prints ONLY the raw token on stdout, or nothing and exits 3 when no token is requested),
# pipes it into `gh secret set` (the token is never an argument, never echoed, never logged), starts deploy-api-proxy (which puts it on the Worker as VISITS_TOKEN),
# and marks the request issued (`--done`). If gh fails, `--failed` revokes the token just created and the request stays open for the next tick.
# No `set -x`: nothing here may print the token.
set -uo pipefail
PAUSE_FLAG="${PAUSE_FLAG:-$HOME/.local/share/domain-trading-host/PAUSED}"
[ -f "$PAUSE_FLAG" ] && exit 0
PROD_DIR="${PROD_DIR:-$HOME/domain-trading-prod}"
APP_DIR="${APP_DIR:-$PROD_DIR-current}"
REPO="${GH_REPO:-DvirBaumel8/domain-trading}"
ENV_FILE="$HOME/.config/domain-trading/prod.env"
# Nothing to do before the first deploy or without the env file (the same check as start.sh).
[ -e "$APP_DIR/dist/modules/ops/admin.js" ] || exit 0
[ -f "$ENV_FILE" ] || exit 0
cd "$APP_DIR" || exit 0
# Read KEY=VALUE lines literally, like start.sh (a DATABASE_URL holds '&' and '?'). Nothing is printed.
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] && [ -n "${BASH_REMATCH[2]}" ] && export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$ENV_FILE"
admin() { node dist/modules/ops/admin.js "$@"; }
log() { echo "$(date -u +%FT%TZ) visits-token: $*"; }

tok="$(admin visits-token-handoff 2>/dev/null)"
rc=$?
if [ "$rc" -ne 0 ]; then
  unset tok
  [ "$rc" -eq 3 ] || log "handoff command exited $rc (an older release without it, or the database is unreachable); nothing done"
  exit 0
fi
if [ -n "$tok" ] && printf %s "$tok" | gh secret set VISIT_COUNTER_TOKEN --repo "$REPO" >/dev/null 2>&1; then
  unset tok
  # A failed workflow start is not fatal: the secret is set, and the next deploy-api-proxy run (any push to api-proxy/ or the tunnel-watch redeploy) installs it.
  gh workflow run deploy-api-proxy --repo "$REPO" >/dev/null 2>&1 || log "secret set, but deploy-api-proxy could not be started; it picks the secret up on its next run"
  admin visits-token-handoff --done >/dev/null 2>&1 && log "token handed to the GitHub secret VISIT_COUNTER_TOKEN" || log "secret set, but --done failed; the next tick issues a new token"
else
  unset tok
  admin visits-token-handoff --failed >/dev/null 2>&1
  log "gh could not set the secret; the new token was revoked, the request stays open"
fi
unset tok
exit 0
