#!/usr/bin/env bash
# Unit tests + local `apify run` smoke test for all 3 Actors (no Apify token needed).
set -e
export PATH=/workspace/apify-actors/.venv/bin:$PATH APIFY_CLI_DISABLE_TELEMETRY=1
cd /workspace/apify-actors
for a in bulk-domain-availability-checker sitemap-url-extractor bulk-dns-email-auth-checker; do
  echo "== $a"; (cd $a && python -m pytest -q tests | tail -1 && apify validate-schema >/dev/null 2>&1 && echo "schema ok" || echo "schema check skipped/failed";
   timeout 300 apify run --purge 2>&1 | grep -E "Done|ERROR|Traceback" ; echo "rows: $(ls storage/datasets/default/0*.json 2>/dev/null | wc -l)")
done
