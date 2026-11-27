# Changelog

## 0.1.0 (actor.json version `0.1`; Apify needs MAJOR.MINOR)
- First version (CR-134). Private and unpublished. No price is set in the repo (pay-per-event `result`, set on Apify).
- Asks ChatGPT, Gemini and Claude with web search on; mention yes/no by plain text matching; competitors and rank by a small extractor model with a simple list parser as fallback; `SUMMARY` record in the key-value store.

## 0.2.0 (actor.json version `0.2`)
- No grounded or cited text is exported: `snippet`, `citedUrls`, `answerText` and competitor names are gone; `competitorCount` is added; `topCompetitors` is gone from `SUMMARY`. `includeAnswerText` is ignored.
- Listing and marketing copy no longer name the AI providers.
- Spend-guard tests now prove that no provider call follows a reached limit. `scripts/live_smoke.py` is a manual one-call check, never run in CI.

## Release checklist
Only from Dvir's machine, after his OK: `apify push`, then add the actor id to `ACTOR_IDS` in `../tools/sync-store-meta.py` and run it, then check the Store page. Provider keys are set as Actor environment variables on Apify, never in the repo.
