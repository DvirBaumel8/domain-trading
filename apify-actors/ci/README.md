# Workflow files to install by hand

The Claude GitHub App cannot write `.github/workflows/`. Dvir copies these there (needs the `APIFY_TOKEN` repo secret, already set):

- `apify-push.yml` (copy over the one in `.github/workflows/`; it now prints the apify CLI output, token redacted): manual `workflow_dispatch`; pytest first, then `apify push` of one of the 4 new actors (the fourth, `ai-brand-mention-check`, is CR-134) (or `all-new`) as PRIVATE; then `tools/apify_memory.py` sets `defaultRunOptions.memoryMbytes = 256` (PUT, that field only); then a GET check that fails on `isPublic: true`, any pricing or memory other than 256; summary with id, name and build, plus the line for `docs/requests/DOM-TO-GAVRIEL.md` (job summary and artifact). Each run needs Dvir's OK via Gavriel.
- `apify-usage.yml`: daily `0 6 * * *` plus manual; `tools/apify_usage.py` writes `usage/DATE.json` and day-over-day deltas to the branch `apify-usage`. GET-only; nothing is written if a call fails.
