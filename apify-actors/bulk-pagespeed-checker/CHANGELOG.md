# Changelog

## 0.1.0 (actor.json version `0.1`; Apify needs MAJOR.MINOR)
- API key now required (PS-1); plain error reasons for 400, 403, 429 (PS-2); a quota 429 stops the run.
- First version (CR-129). Private and unpublished. No price is set in the repo (pay-per-event `result`, set on Apify).
- Store text and README re-angled to Core Web Vitals for a list of pages as CSV; input and output schema descriptions completed. No code change.

## Release checklist
Only from Dvir's machine, after his OK: `apify push`, then `python3 ../tools/sync-store-meta.py` (add the actor id to its table first), then check the Store page.
