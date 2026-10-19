#!/bin/bash
# CR-041: deploys the newest release tag (vX.Y.Z) and restarts the server, like Render's "deploy after CI passes".
# Run by launchd every 10 min (com.domaintrading.deploy); `--first` also loads the four agents.
# It deploys only a tag whose commit passed the `ci` workflow (needs `gh`, signed in), and never 23:45-01:00 UTC (the nightly run, CR-016).
# Atomic layout: $PROD_DIR is only the git clone (fetch + tags). Each release is exported with `git archive` and built (npm ci, build, prune)
# in $PROD_DIR-releases/<tag>, away from the running server. Only when the build is complete does the stable symlink $PROD_DIR-current
# (what start.sh runs) switch to it, followed by a kickstart of the api agent. Any failure leaves `current` and the running server untouched.
# The last 3 releases are kept; rollback = point the link at an older release (runbook "Local host").
set -euo pipefail
PROD_DIR="${PROD_DIR:-$HOME/domain-trading-prod}"
RELEASES="${RELEASES_DIR:-$PROD_DIR-releases}"
CURRENT_LINK="${APP_DIR:-$PROD_DIR-current}"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/rotate-logs.sh" || true   # size-capped log rotation (H2); never blocks a deploy
# G-109: stop.sh paused the host on purpose; a pause means no fetch, no build, no switch, no restart (resume.sh ends it).
PAUSE_FLAG="${PAUSE_FLAG:-$HOME/.local/share/domain-trading-host/PAUSED}"
if [ -f "$PAUSE_FLAG" ]; then echo "$(date -u +%FT%TZ) paused since $(cut -d' ' -f1 "$PAUSE_FLAG"), not deploying"; exit 0; fi
# CR-068: hands a requested visit-counter token to the GitHub secret (every tick, also outside the nightly window). Non-fatal; prints no token.
"$HERE/visits-token.sh" || true
cd "$PROD_DIR"
mkdir -p "$RELEASES"

if [ "${1:-}" = "--first" ]; then FIRST=1; else FIRST=0; fi
hm="$(date -u +%H%M)"
if [ "$FIRST" = 0 ] && { [ "$hm" -ge 2345 ] || [ "$hm" -lt 0100 ]; }; then exit 0; fi

git fetch --quiet --tags origin
tag="$(git tag -l 'v*' --sort=-v:refname | head -1)"
[ -n "$tag" ] || { echo "no release tag"; exit 1; }
current=""
[ -L "$CURRENT_LINK" ] && current="$(basename "$(readlink "$CURRENT_LINK")")"
if [ "$tag" = "$current" ] && [ "$FIRST" = 0 ]; then exit 0; fi

# One deploy at a time (a build can outlast the 10 min interval); a lock older than 60 min is stale.
LOCK="$RELEASES/.lock"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true; fi
mkdir "$LOCK" 2>/dev/null || { echo "$(date -u +%FT%TZ) another deploy is running"; exit 0; }
STAGE="$RELEASES/.build-$tag"
trap 'rm -rf "$STAGE"; rmdir "$LOCK" 2>/dev/null || true' EXIT

sha="$(git rev-list -n 1 "$tag")"
ci_status() { gh run list --repo DvirBaumel8/domain-trading --workflow ci --commit "$sha" --json status,conclusion -q '.[0] | if .status == "completed" then .conclusion else .status end' 2>/dev/null || true; }
ci="$(ci_status)"
# G-110: a CI run still going (in_progress / queued / waiting / pending) is waited for inside the lock: every 60 s, up to 15 min.
# A failure (or cancelled / unknown) is not waited for.
waited=0
while [ "$waited" -lt 900 ]; do
  case "$ci" in in_progress|queued|waiting|pending|requested) ;; *) break ;; esac
  echo "$(date -u +%FT%TZ) $tag: ci is '$ci', checking again in 60 s"
  sleep 60; waited=$((waited + 60)); ci="$(ci_status)"
done
if [ "$ci" != "success" ]; then
  # CI cancels an older run on main when a newer push arrives, so the tag's own run may be "cancelled".
  # A passed run on a later main commit that contains the tag commit also covers it (the same rule as deploy-live, BUG-041).
  for later in $(gh run list --repo DvirBaumel8/domain-trading --workflow ci --branch main --status success --limit 20 --json headSha -q '.[].headSha' 2>/dev/null); do
    git cat-file -e "$later" 2>/dev/null || git fetch --quiet origin main
    if git merge-base --is-ancestor "$sha" "$later" 2>/dev/null; then ci=success; break; fi
  done
fi
if [ "$ci" != "success" ]; then echo "$(date -u +%FT%TZ) $tag: ci is '${ci:-unknown}', not deploying"; exit 0; fi

echo "$(date -u +%FT%TZ) deploying $tag ($sha)"
rel="$RELEASES/$tag"
if [ ! -f "$rel/dist/main.js" ]; then
  rm -rf "$STAGE" "$rel"
  mkdir -p "$STAGE"
  if ! { git archive "$tag" | tar -x -C "$STAGE" \
      && (cd "$STAGE" && npm ci --include=dev --silent && npm run --silent build && npm prune --omit=dev --silent) \
      && [ -f "$STAGE/dist/main.js" ]; }; then
    echo "$(date -u +%FT%TZ) $tag: build FAILED; keeping ${current:-the old tree} running"
    exit 1
  fi
  mv "$STAGE" "$rel"
fi
# Atomic switch: write a temporary link, then rename it over `current` (mv -h on macOS, -T on GNU).
ln -sfn "$rel" "$CURRENT_LINK.new"
mv -fh "$CURRENT_LINK.new" "$CURRENT_LINK" 2>/dev/null || mv -fT "$CURRENT_LINK.new" "$CURRENT_LINK"
# Keep the newest 3 releases (never the one in use).
for old in $(ls -1t "$RELEASES" | grep '^v' | tail -n +4); do [ "$RELEASES/$old" = "$rel" ] || rm -rf "${RELEASES:?}/$old"; done

if [ "$FIRST" = 1 ]; then
  for name in api deploy tunnel tunnel-watch; do
    launchctl bootout "gui/$UID_NUM/com.domaintrading.$name" 2>/dev/null || true
    # bootstrap right after bootout can fail with "Input/output error" while launchd is still unloading: retry
    for try in 1 2 3 4 5; do
      launchctl bootstrap "gui/$UID_NUM" "$AGENTS/com.domaintrading.$name.plist" 2>/dev/null && break
      [ "$try" = 5 ] && { echo "could not load com.domaintrading.$name"; exit 1; }
      sleep 2
    done
  done
else
  launchctl kickstart -k "gui/$UID_NUM/com.domaintrading.api"
fi
echo "$(date -u +%FT%TZ) $tag running"
