#!/bin/bash
# CR-041: deploys the newest release tag (vX.Y.Z) to ~/domain-trading-prod and restarts the server, like Render's
# "deploy after CI passes". Run by launchd every 10 min (com.domaintrading.deploy); `--first` also loads the four agents.
# It deploys only a tag whose commit passed the `ci` workflow (needs `gh`, signed in), and never 23:45-01:00 UTC (the nightly run, CR-016).
set -euo pipefail
PROD_DIR="${PROD_DIR:-$HOME/domain-trading-prod}"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
cd "$PROD_DIR"

if [ "${1:-}" = "--first" ]; then FIRST=1; else FIRST=0; fi
hm="$(date -u +%H%M)"
if [ "$FIRST" = 0 ] && { [ "$hm" -ge 2345 ] || [ "$hm" -lt 0100 ]; }; then exit 0; fi

git fetch --quiet --tags origin
tag="$(git tag -l 'v*' --sort=-v:refname | head -1)"
[ -n "$tag" ] || { echo "no release tag"; exit 1; }
current="$(cat .deployed-tag 2>/dev/null || true)"
if [ "$tag" = "$current" ] && [ "$FIRST" = 0 ]; then exit 0; fi

sha="$(git rev-list -n 1 "$tag")"
ci="$(gh run list --repo DvirBaumel8/domain-trading --workflow ci --commit "$sha" --json conclusion -q '.[0].conclusion' 2>/dev/null || true)"
if [ "$ci" != "success" ]; then echo "$(date -u +%FT%TZ) $tag: ci is '${ci:-unknown}', not deploying"; exit 0; fi

echo "$(date -u +%FT%TZ) deploying $tag ($sha)"
git checkout --quiet --detach "$tag"
npm ci --include=dev --silent && npm run --silent build && npm prune --omit=dev --silent
echo "$tag" > .deployed-tag

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
