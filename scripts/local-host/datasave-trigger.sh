#!/bin/bash
# v5.73.0 (BUG-060): the Mac starts the daily data save itself. GitHub starts the schedule 3-4 hours late; this agent starts it at ~15:35 UTC (was 15:05 UTC before BUG-060).
# What launchd runs (com.domaintrading.datasave, every hour at :35 local time). launchd uses local time, so the script decides by the UTC clock: from 15:30 UTC on, once a
# UTC day, it calls the local server POST /jobs/run {"job":"datasave"} with the job-trigger token read from prod.env (never printed, never in the process list, never logged).
# It uses the same Idempotency-Key as the GitHub workflow (datasave-<15:00 UTC of the day in ms>), so a later GitHub run of the same day is a replay, and the server's
# overlap rule (a still-open datasave run is returned, not started twice) and sealed files make a double trigger harmless. GitHub's schedule stays as the backup.
# An hourly run also catches up after a sleep or a restart: the day is marked done only after a 202 answer (marker file in the host dir).
set -euo pipefail
ENV_FILE="$HOME/.config/domain-trading/prod.env"
HOST_DIR="${HOST_DIR:-$HOME/.local/share/domain-trading-host}"
MARK="$HOST_DIR/datasave-last-trigger"
PAUSE_FLAG="$HOST_DIR/PAUSED"
say() { echo "$(date -u +%FT%TZ) $*"; }
[ -f "$PAUSE_FLAG" ] && { say "paused ($(cat "$PAUSE_FLAG")): no trigger"; exit 0; }
hour=$((10#${DATASAVE_TEST_HOUR:-$(date -u +%H)}))   # DATASAVE_TEST_HOUR is for the manual check only
min=$((10#${DATASAVE_TEST_MIN:-$(date -u +%M)}))
day="$(date -u +%Y-%m-%d)"
[ "$((hour * 60 + min))" -ge 930 ] || exit 0      # before 15:30 UTC: nothing to do (stay silent; BUG-060 moved from 15:00)
[ "$(cat "$MARK" 2>/dev/null || true)" = "$day" ] && exit 0   # already started today
[ -f "$ENV_FILE" ] || { say "missing $ENV_FILE"; exit 1; }
# Read KEY=VALUE lines literally, like start.sh and backup.sh. Only the three keys this script needs are kept. Nothing is printed.
JOB_TRIGGER_TOKEN=""; LOCAL_HOST_PORT_ENV=""
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^JOB_TRIGGER_TOKEN=(.*)$ ]] && JOB_TRIGGER_TOKEN="${BASH_REMATCH[1]}"
  [[ "$line" =~ ^LOCAL_HOST_PORT=(.*)$ ]] && LOCAL_HOST_PORT_ENV="${BASH_REMATCH[1]}"
done < "$ENV_FILE"
[ -n "$JOB_TRIGGER_TOKEN" ] || { say "JOB_TRIGGER_TOKEN is empty in $ENV_FILE: not triggering"; exit 1; }
PORT="${LOCAL_HOST_PORT:-${LOCAL_HOST_PORT_ENV:-3100}}"   # start.sh listens on 3100 unless LOCAL_HOST_PORT says otherwise
BASE="http://127.0.0.1:$PORT"
curl -s -o /dev/null --max-time 10 "$BASE/health/ping" || { say "server not answering on $BASE: will try again next hour"; exit 0; }
# The token goes to curl through a private header file (curl -H @file), not on the command line.
hdr="$(mktemp)"; out="$(mktemp)"; trap 'rm -f "$hdr" "$out"' EXIT
chmod 600 "$hdr"
printf 'Authorization: Bearer %s\n' "$JOB_TRIGGER_TOKEN" > "$hdr"
ms=$(( $(date -u -j -f '%Y-%m-%d %H:%M:%S' "$day 15:00:00" +%s) * 1000 ))
code=$(curl -s -o "$out" -w '%{http_code}' --max-time 60 -X POST "$BASE/jobs/run" -H "@$hdr" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: datasave-$ms" -d '{"job":"datasave"}' || true)
if [ "$code" = "202" ]; then
  echo "$day" > "$MARK"
  say "datasave triggered: HTTP 202 $(head -c 300 "$out")"
else
  say "datasave trigger answered HTTP ${code:-none}: will try again next hour"
  exit 1
fi
