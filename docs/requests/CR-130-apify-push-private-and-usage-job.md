# CR-130: Push the 3 new actors to Apify as PRIVATE, plus the daily usage job (CR-127 Part B)

Status: GO. Dvir OK'd it on 26 Nov 2026 at 13:02 IST, relayed by Gavriel. The `APIFY_TOKEN` repo secret is set (Q2 answered yes).
Priority: top. Owner: Claude Code (via @claude issue). Reviewer: DOM Architect.

## Part 1: `apify-push` (manual workflow)

1. Workflow `apify-push.yml`: `workflow_dispatch` only, never on push or cron. Input `actor`, one of `wayback-domain-history`, `broken-link-auditor`, `bulk-pagespeed-checker`, `all-new`. The four existing live actors are NOT allowed here yet.
2. Steps: run that actor's pytest first, and stop if red. Then `apify push` from `apify-actors/<actor>/` with `APIFY_TOKEN`.
3. **Private and unpublished only.** The workflow must never set `isPublic`, Store listing, categories or any pricing. After the push, it calls GET `/v2/acts/{id}` and fails if `isPublic` is true or any pricing info exists.
4. It writes the resulting actor id, name and build version to the job summary and appends one line to `docs/requests/DOM-TO-GAVRIEL.md` through a PR or comment (no direct push needed). It never logs the token, the URL with the token, or headers.
5. Same pattern for later releases, but each run needs Dvir's OK through Gavriel.

## Part 2: `apify-usage` (CR-127 Part B, as written there)

Daily at `0 6 * * *` (08:00 IST) plus `workflow_dispatch`. It writes `usage/DATE.json` plus day-over-day deltas to branch `apify-usage`. GET-only, with fixture tests as listed in CR-127 Part B. Prices are read live with every tier, the current price shown as current and a scheduled change shown as pending. No hard-coded prices.

## Workflow files

The Claude GitHub App cannot write `.github/workflows/`. Put both files in `apify-actors/ci/` (as with PR #9) with a README line. Dvir installs them. Everything else (scripts, tests) goes in the PR normally.

## Tests (the contract)

- Offline fixture test: the post-push check fails on `isPublic: true` and on any pricing field.
- Static test: the push workflow has no `on: push`, no `schedule`, and an actor allow-list of exactly the 3 new actors.
- CR-127 Part B tests (pagination, 0 runs, 401/429 with no partial file, earnings-unavailable note).
- Existing 86 tests stay green.

## Stop rules

No publish, no prices, no Store listing, no change to the 4 existing actors, no secret in the repo or logs. Stop at an open PR.
