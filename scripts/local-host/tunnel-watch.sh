#!/bin/bash
# CR-041: run by launchd every 60 s (com.domaintrading.tunnel-watch). A Cloudflare quick tunnel gets a new
# https://<x>.trycloudflare.com URL on every start. When the newest one in tunnel.log differs from the saved one,
# set the GitHub variable TUNNEL_URL and run the deploy-api-proxy workflow (the Worker then forwards to the new URL).
# The URL is saved only after both gh calls succeed, so a failure is retried on the next run.
set -euo pipefail
HOST_DIR="${HOST_DIR:-$HOME/.local/share/domain-trading-host}"
LOG="${TUNNEL_LOG:-$HOME/Library/Logs/domain-trading/tunnel.log}"
REPO="DvirBaumel8/domain-trading"
SAVED="$HOST_DIR/.tunnel-url"

[ -f "$LOG" ] || exit 0
url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | grep -v '^https://api\.' | tail -1 || true)"  # api.trycloudflare.com shows up in cloudflared's own error lines
[ -n "$url" ] || exit 0
[ "$url" != "$(cat "$SAVED" 2>/dev/null || true)" ] || exit 0

echo "$(date -u +%FT%TZ) tunnel URL changed: $url"
gh variable set TUNNEL_URL --repo "$REPO" --body "$url"
gh workflow run deploy-api-proxy --repo "$REPO"
echo "$url" > "$SAVED"
echo "$(date -u +%FT%TZ) published $url; the deploy-api-proxy run prints the stable proxy URL"
