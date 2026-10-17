#!/bin/bash
# Size-capped log rotation for the Mac host (no root needed, unlike /etc/newsyslog.d). Called at the start of every deploy.sh run
# (every 10 min by launchd). A log over MAX_BYTES (default 10 MB) is copied to <name>.1 (older ones shift up to <name>.5, the
# oldest is dropped) and then truncated in place, because launchd keeps the file open (copy-and-truncate, like newsyslog's default).
set -euo pipefail
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/domain-trading}"
MAX_BYTES="${LOG_MAX_BYTES:-10485760}"
KEEP="${LOG_KEEP:-5}"

[ -d "$LOG_DIR" ] || exit 0
for f in "$LOG_DIR"/*.log; do
  [ -f "$f" ] || continue
  size="$(wc -c < "$f" | tr -d ' ')"
  [ "$size" -gt "$MAX_BYTES" ] || continue
  i="$KEEP"
  rm -f "$f.$i"
  while [ "$i" -gt 1 ]; do
    prev=$((i - 1))
    [ ! -f "$f.$prev" ] || mv -f "$f.$prev" "$f.$i"
    i=$prev
  done
  cp "$f" "$f.1" && : > "$f"
  echo "$(date -u +%FT%TZ) rotated $(basename "$f") ($size bytes)"
done
