# Workflow files waiting for install

The GitHub App that built these could not write `.github/workflows/` (no `workflows` permission). Dvir installs them by hand, then deletes this folder:

1. `git mv apify-actors/ci/apify-actors.yml .github/workflows/apify-actors.yml`
2. `git apply apify-actors/ci/requests-only.patch` (the bot text guard: bots may change only `README.md` and the text keys of `.actor/*.json`, via `apify-actors/tools/bot-text-guard.py`)
