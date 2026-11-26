# Changelog

## 0.1.0 (actor.json version `0.1`; Apify needs MAJOR.MINOR)
- API key now required (PS-1); plain error reasons for 400, 403, 429 (PS-2); a quota 429 stops the run.
- First version (CR-129). Private and unpublished. No price is set in the repo (pay-per-event `result`, set on Apify).

## Unreleased
- Text only: re-angled for sitemap-wide Core Web Vitals as CSV, input descriptions, README states the apiKey and the 50-row per-run cap as the code has them, dataset schema with required keys and a view. No behaviour change.

## Release checklist
Only from Dvir's machine, after his OK: `apify push`, then `python3 ../tools/sync-store-meta.py` (add the actor id to its table first), then check the Store page.
