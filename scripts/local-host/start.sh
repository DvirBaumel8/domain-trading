#!/bin/bash
# CR-041: what launchd runs (com.domaintrading.api). Same as Render's startCommand: migrations, then the server.
set -euo pipefail
PROD_DIR="${PROD_DIR:-$HOME/domain-trading-prod}"
ENV_FILE="$HOME/.config/domain-trading/prod.env"
cd "$PROD_DIR"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
grep -qE '^DATABASE_URL=.+' "$ENV_FILE" || { echo "DATABASE_URL is empty in $ENV_FILE"; exit 1; }
# Read KEY=VALUE lines literally (no shell parsing: a DATABASE_URL holds '&' and '?').
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] && [ -n "${BASH_REMATCH[2]}" ] && export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$ENV_FILE"
# The Mac's port 3000 is taken by another project (sapako), so the host always listens on 3100 (the tunnel points there).
export PORT="${LOCAL_HOST_PORT:-3100}" HOST=127.0.0.1
npm run --silent migrate up
exec node dist/main.js
