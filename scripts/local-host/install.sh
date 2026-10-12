#!/bin/bash
# CR-041 (Dvir, 12 Oct 2026): run the production API on Dvir's Mac mini while Render is suspended.
# Dvir runs this, not DOM (CLAUDE.md HARD RULE). It sets up, but does not start, the service:
#   - a separate checkout at ~/domain-trading-prod (DOM's working copy is never what runs);
#   - an env file at ~/.config/domain-trading/prod.env (chmod 600) with every key and EMPTY values: Dvir pastes the Render values;
#   - LaunchAgents: com.domaintrading.api (the server, restarted if it exits), com.domaintrading.deploy (every 10 min, deploys a new release tag),
#     com.domaintrading.tunnel (cloudflared quick tunnel) and com.domaintrading.tunnel-watch (every 60 s, publishes a changed tunnel URL to the api-proxy Worker).
# Then: fill the env file, run deploy.sh --first (docs/runbook.md, "Local host").
set -euo pipefail

PROD_DIR="${PROD_DIR:-$HOME/domain-trading-prod}"
ENV_DIR="$HOME/.config/domain-trading"
ENV_FILE="$ENV_DIR/prod.env"
LOG_DIR="$HOME/Library/Logs/domain-trading"
AGENTS="$HOME/Library/LaunchAgents"
# The host scripts live outside the release checkout: deploy.sh checks out release tags, and a tag older than this kit has no scripts/local-host/.
HOST_DIR="$HOME/.local/share/domain-trading-host"
REPO_URL="${REPO_URL:-https://github.com/DvirBaumel8/domain-trading.git}"
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "node is missing (brew install node@22)"; exit 1; }
command -v cloudflared >/dev/null || { echo "cloudflared is missing (brew install cloudflared)"; exit 1; }
mkdir -p "$ENV_DIR" "$LOG_DIR" "$AGENTS" "$HOST_DIR"
cp "$HERE/start.sh" "$HERE/deploy.sh" "$HERE/tunnel-watch.sh" "$HOST_DIR/" && chmod +x "$HOST_DIR"/*.sh
[ -d "$PROD_DIR/.git" ] || git clone --quiet "$REPO_URL" "$PROD_DIR"

if [ ! -f "$ENV_FILE" ]; then
  # Same keys as .env.example; values stay empty until Dvir copies them from Render. Never commit this file.
  {
    echo "# domain-trading production env (copy each value from Render > domain-trading-api > Environment). chmod 600."
    echo "APP_ENV=production"
    echo "DATABASE_SSL=true"
    echo "PORT=3000"
    echo "HOST=127.0.0.1"
    echo "PUBLIC_BASE_URL="
    grep -oE '^[A-Z_]+=' "$PROD_DIR/.env.example" | grep -vE '^(APP_ENV|DATABASE_SSL|PORT|HOST|PUBLIC_BASE_URL|TEST_DATABASE_URL|PORKBUN_SANDBOX_[A-Z_]+)=$'
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE: fill in the values from Render."
fi

for name in api deploy tunnel tunnel-watch; do
  sed -e "s#__HOST_DIR__#$HOST_DIR#g" -e "s#__PROD_DIR__#$PROD_DIR#g" -e "s#__LOG_DIR__#$LOG_DIR#g" -e "s#__HOME__#$HOME#g" -e "s#__PATH__#$PATH#g" \
    "$HERE/com.domaintrading.$name.plist" > "$AGENTS/com.domaintrading.$name.plist"
done
echo "LaunchAgents written to $AGENTS (not loaded yet)."
echo "Next:"
echo "  1. Fill $ENV_FILE from Render (PUBLIC_BASE_URL = the api-proxy URL, known after the first deploy-api-proxy run; fill it then and restart the api agent)."
echo "  2. $HOST_DIR/deploy.sh --first   (loads all four agents; re-run install.sh after a kit change)"
echo "  3. Within a minute tunnel-watch sets the GitHub variable TUNNEL_URL and runs deploy-api-proxy; its log prints https://domain-trading-api-proxy.<subdomain>.workers.dev."
echo "  4. Set the GitHub variable API_BASE_URL to that URL (once) and run deploy-jobs-trigger."
