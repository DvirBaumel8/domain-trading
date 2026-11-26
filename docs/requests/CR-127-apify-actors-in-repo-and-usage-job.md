# CR-127: Apify actors' source in the repo, and a daily usage job

**Status:** Filed 26 Nov 2026 11:40 IST. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir (26 Nov, via Gavriel):** the code of our 4 public Apify actors (account `looped_kite`) is now owned by DOM Architect + Claude Code. Bots keep only texts, prices, listing and settings.

**Do not start until** the source snapshot lands in `docs/requests/apify-import/` (see Part A). Gavriel is editing the README/SEO/input texts today; I copy the source only after he says those are done.

## Actors

| Actor | Apify id | Local folder |
|---|---|---|
| Domain Checkup Report | Hfr4MI0LjpkjEYXcA | domain-checkup-report |
| Bulk DNS & Email Auth Checker | VnrYq91nbRYrRMmS1 | bulk-dns-email-auth-checker |
| Sitemap URL Extractor | HcsxPAYrb95rOsOrQ | sitemap-url-extractor |
| Bulk Domain Availability Checker | mKqSGmlx8krmtqgpU | bulk-domain-availability-checker |

They're Python (Apify SDK) and include a `shared/` folder (`doh.py`, `scaffold.py`). Each actor has `tests/test_core.py` (pytest, offline).

## Part A: Source under version control

1. Move `docs/requests/apify-import/*` to the top-level folder `apify-actors/` (one subfolder per actor plus `shared/`). Then delete the snapshot folder.
2. Keep the existing pytest suites as the contract. Add a CI workflow `apify-actors.yml` that runs on changes under `apify-actors/**`. It does `pytest` for each actor and validates each `.actor/*.json` against Apify's schema. It runs no network calls and needs no token.
3. Extend the existing tests so these are locked:
   - Pay-per-event `result` is charged once per dataset row, and invalid inputs are never charged.
   - Every actor fails with a clear status message when its main input is empty.
   - The output row shape matches `.actor/dataset_schema.json`.
4. Text ownership. Bots may edit only these files:
   - `apify-actors/*/README.md`
   - text keys in `apify-actors/*/.actor/*.json`: `title`, `description`, `seoTitle`, `seoDescription`, `sectionCaption`, `sectionDescription`, `example`, `prefill`, `editor`
   
   To allow this, extend `requests-only.yml` with a check that fails a bot commit if it changes any other key or file. Claude Code must not overwrite those text keys. If a code change needs a text change, it goes into a CR as a request to the bots.
5. Deploy. Pushing to Apify (`apify push`) happens only from Dvir's machine, with his token, after his OK on each release. No CI deploy. Each actor keeps its own version in `actor.json`, plus a `CHANGELOG.md`.
6. Prices, pricing model, visibility and listing settings stay on Apify, owned by the bots. They are not in the repo.

## Part B: Daily usage report as a DOM feature

The source is `docs/requests/apify-import/usage-report.py`. It is read-only, GET-only, and reads per-actor user counts, our runs vs others' runs, reviews, issues, list prices and our own platform cost. The Apify API doesn't expose earnings, so the report must say that and never guess.

1. Add a GitHub Actions workflow `apify-usage.yml` with cron `0 6 * * *` (08:00 IST) plus `workflow_dispatch`. Port the script's logic into it. It writes `usage/DATE.json` to the branch `apify-usage`, the same pattern as `shadow-log`. It also writes a per-actor day-over-day delta: new users, new runs by others, new reviews and new issues.
2. Optional, after step 1 works: add `GET /apify/usage?date=` to DOM. It reads the latest file from the `apify-usage` branch, so Render needs no Apify token.
3. Token. The secret `APIFY_TOKEN` is a GitHub Actions secret that **Dvir adds himself** (it needs his OK; see the open question). Use a scoped read-only token if Apify allows it. The job must never log the token, the URL with the token, or raw headers.
4. Tests: run against recorded API fixtures (no network). Cover:
   - pagination
   - an actor with 0 runs
   - a 401 or 429 from Apify (backoff, then the run fails clearly with no partial file)
   - the earnings-unavailable note

## Open questions for Dvir (via Gavriel)

- **Q1 (public source):** this repo is public, so the actors' full code becomes public and anyone can copy it. Is that OK, or should Claude Code put the code in a new private repo (for example `DvirBaumel8/apify-actors`) under the same rules?
- **Q2 (secret):** is it OK to add `APIFY_TOKEN` as a GitHub Actions secret for the daily usage job? Dvir adds it himself.

## Out of scope

CR-128 has the code backlog from Gavriel's audit.

## Update 26 Nov 2026, 11:30 IST

**Text edits done (Gavriel, ~11:23 IST).** Live builds: dns 0.1.4, sitemap 0.1.4, availability 0.1.4, checkup 0.1.5. They include the README kit, SEO texts and input schemas. The main input is required on dns, sitemap and checkup. Availability needs Domains or Keywords. Sitemap `maxUrlsPerSite` defaults to 1000. The snapshot must match these builds.

**Snapshot timing:** I import the source into `docs/requests/apify-import/` only after Dvir answers Q1. If he picks a private repo, the snapshot goes there and not into this public repo.

**SEO drift (add to Part A, item 5):** the Store SEO fields (`seoTitle`, `seoDescription`) were set by API with `PUT /v2/actors/{id}`, because `apify push` does not apply them. A later push may reset them.
- Add a small script, `apify-actors/tools/sync-store-meta.py`, run from Dvir's machine right after each `apify push`. It reads the text keys from each `.actor/actor.json` and does `PUT /v2/actors/{id}` with only those fields. Then it reads them back with GET and fails if any differ. It must never print the token.
- Add an offline test with a recorded fixture: the script sends only the allowed text keys, and never touches prices, the pricing model or visibility.
- The release checklist in each `CHANGELOG.md` says: push, then sync-store-meta, then check the Store page.
