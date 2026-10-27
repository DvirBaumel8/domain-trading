#!/bin/bash
# Sets one KEY=value line in prod.env without printing the value (27 Oct 2026, Dvir: set things once from the computer, run from the phone).
#   set-secret.sh KEY --clipboard   the value is the clipboard's content (pbpaste), e.g. an API key copied from a site
#   set-secret.sh KEY --generate    a random 32-byte value is generated and also left on the clipboard, for Dvir's password manager
# The line is replaced if KEY exists, else appended. prod.env stays mode 600. Nothing is echoed; only "KEY set (N chars)".
set -euo pipefail
ENV_FILE="$HOME/.config/domain-trading/prod.env"
key="${1:?KEY}"; mode="${2:?--clipboard or --generate}"
[[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "bad key"; exit 1; }
case "$mode" in
  --clipboard) val="$(pbpaste | tr -d '\r\n')";;
  --generate) val="$(openssl rand -base64 32 | tr -d '\n=+/' | cut -c1-40)"; printf '%s' "$val" | pbcopy;;
  *) echo "mode must be --clipboard or --generate"; exit 1;;
esac
[ -n "$val" ] || { echo "empty value: nothing set"; exit 1; }
tmp="$(mktemp)"; chmod 600 "$tmp"
grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
printf '%s=%s\n' "$key" "$val" >> "$tmp"
mv "$tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
echo "$key set (${#val} chars)"
