# Workflow files to install by hand

The Claude GitHub App cannot write `.github/workflows/`. Dvir copies these there (needs the `APIFY_TOKEN` repo secret, already set):

- `apify-push.yml` (copy over the one in `.github/workflows/`; needs the `APIFY_TOKEN` secret): pytest first, then `apify push`, then `tools/apify_memory.py` (memory 256 via PUT of `defaultRunOptions` only), then a GET check. Two paths:
  - **Private** (manual): `wayback-domain-history`, `bulk-pagespeed-checker`, `ai-brand-mention-check` (or `all-new`). The check fails if the Actor is public, priced or memory is not 256.
  - **Live** (manual, or on every push to `main` that changes `apify-actors/<name>/**`): `bulk-domain-availability-checker`, `sitemap-url-extractor`, `broken-link-auditor`, already public and priced. A merge rebuilds only the live Actors whose folder changed (`tools/apify_changed.py`); a merge touching only private Actors pushes nothing. `tools/apify_baseline.py` records visibility, listing text, categories and price before the push; the check fails if any of them changed, if the Actor is no longer public, if memory is not 256, or if `broken-link-auditor` timeout is not 7200 s (set after the push; other Actors keep their timeout). Never publishes, unpublishes or sets a price.
  - Anything else fails closed ("actor not allowed"). Manual runs need Dvir's OK via Gavriel.
- `apify-usage.yml`: daily `0 6 * * *` plus manual; `tools/apify_usage.py` writes `usage/DATE.json` and day-over-day deltas to the branch `apify-usage`. GET-only; nothing is written if a call fails.
