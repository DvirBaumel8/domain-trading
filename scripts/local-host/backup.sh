#!/bin/bash
# Nightly database backup on the Mac host (Dvir, 14 Oct 2026: "implement it and we will turn it on soon").
# What launchd runs (com.domaintrading.backup, 01:30 UTC, after the nightly run). OFF until Dvir sets BACKUP_ENABLED=1 and
# BACKUP_PASSPHRASE in prod.env and loads the agent (runbook "Backups"). A pg_dump in custom format, encrypted with
# AES-256 (openssl, PBKDF2) using BACKUP_PASSPHRASE; kept BACKUP_KEEP_DAYS days (default 14). Restore: runbook "Backups".
set -euo pipefail
ENV_FILE="$HOME/.config/domain-trading/prod.env"
DIR="${BACKUP_DIR:-$HOME/domain-trading-backups}"
[ -f "$ENV_FILE" ] || { echo "$(date -u +%FT%TZ) missing $ENV_FILE"; exit 1; }
# Read KEY=VALUE lines literally, like start.sh (a DATABASE_URL holds '&' and '?'). Nothing is printed.
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] && [ -n "${BASH_REMATCH[2]}" ] && export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done < "$ENV_FILE"
if [ "${BACKUP_ENABLED:-0}" != "1" ]; then echo "$(date -u +%FT%TZ) backup off (BACKUP_ENABLED is not 1)"; exit 0; fi
[ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "$(date -u +%FT%TZ) BACKUP_PASSPHRASE is empty: not backing up"; exit 1; }
[ -n "${DATABASE_URL:-}" ] || { echo "$(date -u +%FT%TZ) DATABASE_URL is empty"; exit 1; }
command -v pg_dump >/dev/null || { echo "$(date -u +%FT%TZ) pg_dump is missing (brew install postgresql@18)"; exit 1; }

mkdir -p "$DIR" && chmod 700 "$DIR"
out="$DIR/domain-trading-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
tmp="$out.partial"
# The passphrase goes to openssl through an environment variable, never on the command line.
if pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$tmp"; then
  mv "$tmp" "$out" && chmod 600 "$out"
  echo "$(date -u +%FT%TZ) backup ok $(basename "$out") $(du -h "$out" | cut -f1)"
else
  rm -f "$tmp"; echo "$(date -u +%FT%TZ) backup FAILED"; exit 1
fi
find "$DIR" -name 'domain-trading-*.dump.enc' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
