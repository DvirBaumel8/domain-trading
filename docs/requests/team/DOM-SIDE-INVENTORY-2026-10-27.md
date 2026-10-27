# DOM side: factual inventory (27 Oct 2026)

For the team-process review. Repo files only (contract v5.59.0); nothing read from production.

## 1. What DOM is and how it works

- **DOM** is Claude Code (Opus plans and reviews, Sonnet builders implement) working in this repo on Dvir's Mac. It owns the code, tests, internal docs, the API contract, releases and deploys (`CLAUDE.md`). Note: "DOM Architect" is a separate Grok bot that files CRs (e.g. `CR-080`, `owner_bot: dom-architect`).
- **Repo and releases:** work on `main`, no branches. Every visible change bumps the contract (semver) with a release note (116 so far). 40 tags from 20 to 27 Oct; 279 test files.
- **Host:** production runs on Dvir's Mac mini with Neon until Render resumes (about 1 Nov; CR-041). DOM runs `install.sh`, `deploy.sh` and the `com.domaintrading.*` agents (api, tunnel, tunnel-watch, deploy, datasave, backup).
- **Tokens:** own `dom-read` and `dom-write` since 25 Oct: may run jobs, load data, run dry runs.
- **May not:** do money actions (buy, S8 import, bid plans, listing, prices, sell) without Dvir's chat line per action; write the approval sentence; use the bots' tokens; print secrets; touch the production DB directly.
- **Browser:** Dvir's logged-in Chrome (skills `afternic-listing`, `sedo-listing`), no sign-ins, a chat confirmation before any submit or price step.

## 2. The system DOM owns

### Modules (`docs/internal/code-map.md` §2)

| Module | One line |
|---|---|
| registrars | Porkbun (live) and GoDaddy (manage-only) adapters, quotes, `GET /check` |
| listing | Plan (BIN, floor, walk-away, drops), pricing settings, Afternic/Sedo exports, venue records |
| selection | Largest (~8,400 lines): selection settings, screening runs and checks, packs, test sets, replays, pre-bid checks |
| buying | `/buy`, tranches, reconciler, ledger, domain cap |
| candidates | Intake, on-demand screening, daily list, drop lists, cohorts, scout lessons, sales patterns |
| engine | Scoring-engine data (sales, unsold, endings), models, lift table, `POST /score` |
| data | Bot-loaded research tables (RDAP, live checks, TM kills, big-company names, comps) |
| market | Market episodes, labels, sale reports, data-quality checks |
| knowledge | Knowledge base: sources, claims, evidence, verdicts computed by code (no AI) |
| pickproof | Off since 5.59.0; replaced by the historical replay |
| visits | Visitor counter fed by the api-proxy Worker |
| selling | Offers, sold records |
| reporting | `/report`, portfolio, ledger, books, audit, job views |
| outreach | Outreach email log, company document, forbidden terms |
| ops | Job queue, health, admin CLI, backup, auctions, closeouts, snapshots, RDAP service, replay, S8 import |

### Schedules

| Job | When / who triggers | Source |
|---|---|---|
| `daily` | 00:05 UTC, Cloudflare Worker cron (the only Cloudflare cron) | `jobs.md` |
| `tick` (first 3 daily steps) | 08:30 UTC, GitHub Actions `tick.yml` | `jobs.md` |
| `datasave` | 15:05 UTC by the Mac agent (hourly at :05 catch-up); GitHub `datasave.yml` at 15:00 UTC is the backup, same Idempotency-Key | `datasave-trigger.sh` |
| Encrypted `pg_dump` | 01:30 UTC, Mac `backup.sh`, kept 14 days. Turned on 27 Oct (first dump 29 MB) | `backup.sh`; DOM-TO-GAVRIEL 27 Oct 02:00 |
| `train`, `screen` | On demand only (`POST /engine/train`, `POST /candidates/screen`) | `jobs.md` |

### Daily steps (00:05 UTC): outside calls and what they store

| Step | Calls outside | Stores |
|---|---|---|
| reconciler | Registrar (finish stuck purchases, receipts, auto-renew off) | purchases, ledger |
| nsVerifier | Public DNS | nameserver state |
| screeningResume | none | screening runs |
| priceJob, dropJob | none | price_schedule, listing_history, domains |
| listingSync | Spaceship SellerHub (skipped: no keys) | listing_sync_log |
| portfolioLifecycle | RDAP/home page (lookalikes) | holdout, domains |
| registrarCheck | Registrar APIs (read) | registrar_presence, registrar_state_checks |
| portfolioCheck | Verisign RDAP, our own lander pages, SURBL, Google Web Risk | portfolio_checks; CR-079 ownership warnings |
| dropWatch, cohortOutcomes | Verisign RDAP | drop_list_checks, cohort_outcomes |
| intakeScreening, buildDailyList | Screening checks (RDAP, web, blocklists) | screening tables, daily lists |
| referenceRefresh | Majestic popularity list, IANA RDAP bootstrap (NameBio off) | reference_files |
| kbLoad | none (repo files `data/knowledge/*.jsonl`) | kb_* tables |
| retention | none | deletes old rows |
| backupExport | GitHub (skipped: no token or repo) | none |
| engineEndings | RDAP for .net/.co/.org/.io/.ai/.com (up to 20,000 pairs) | engine_endings, owned_ending_events |
| engineTrain, liftTrain | none | engine_models, lift_models |

### Datasave steps (15:05 UTC)

| Step | Calls outside | Stores |
|---|---|---|
| godaddyInventory | `inventory.auctions.godaddy.com` (5 zip files) | raw zips 7 days, manifests (sealed), datasave_pool, GoDaddy auctions, godaddy_auctions_live, daily archive on Mac disk (kept for good) |
| dynadotCloseouts / dynadotAftermarket | none yet (`not_configured`; client being built, CR-080) | reports the bots' upload status |
| scorePool | none (offline score) | closeout filters and scores |
| buildPanel | Verisign RDAP (up to 1,500 a run) | disappearance tags, closeout_expiries |
| engineFeed | none | engine_sales, engine_unsold, engine_auction_ends |
| auctionShortlist | RDAP (endings, 2-minute budget), pre-bid checks | auction_shortlist (25 a day), prebid_checks, auction_outcomes (paper trading) |
| pickproofSeal, pickproofLabels | off since 5.59.0 | none |
| snapshotRetention | none | deletes old raw files and rows |
| episodes, dqMarket | none | market_names, market_dq_runs |

## 3. Data DOM holds (main tables)

| Purpose | Tables | Retention |
|---|---|---|
| Portfolio and money | domains, purchases, receipts, deals, ledger_entries, tranches, quotes, offers, sales, forward_cost_plans/lines | ledger, sales, offers, purchases, domains never pruned; quotes 180 days except referenced |
| Listings | listing_history, price_schedule, pricing_settings, export_runs/uploads, venue_listings, listing_sync_log | history and pricing append-only, kept; sync log 180 days |
| Selection and screening | selection_settings, screening_runs/results/evidence/packs/verdicts, test_sets, holdout_suites, replay_runs, candidate_intake, daily_candidate_lists, drop_lists, cohorts, scout_lessons | unbought-name results 180 days; packs kept; daily lists 90 days |
| Market and engine | engine_sales/unsold/auction_ends/endings/models, lift_models, market_names/sales, data tables (domain_rdap, live_checks, tm_kills, bigco_names, sales_comps), rdap_cache | engine rows not pruned; live checks 3-14 days |
| Auctions, shortlist, replay | godaddy auctions tables, godaddy_auctions_live, auction_shortlist, auction_outcomes, prebid_checks, bid_plans, closeout_expiries, snapshot manifests, replay reports | live 7 days; shortlist 90; outcomes and ended auctions 120; pool 2 days; manifests kept; Mac archive kept |
| Knowledge base | kb_authors, kb_sources, kb_questions, kb_claims, kb_evidence, kb_source_links, kb_verdicts, kb_loads | kept |
| Audit and ops | audit_log, idempotency_keys, api_tokens, job_runs/steps | audit kept; keys 30 days; job history 60 days |

The DB stood at 390 MB (36% of Neon's 1 GB) on 26 Oct (`improve-2026-10-26.md`).

## 4. Outside services and keys (names only, `.env.example`)

| Service | Keys | Status per repo |
|---|---|---|
| Neon Postgres | `DATABASE_URL`, `DATABASE_SSL` | in use |
| Porkbun | `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` (+ sandbox) | the only `/check`/`/buy` registrar |
| GoDaddy | `GODADDY_PAT` | manage-only |
| Jobs | `JOB_TRIGGER_TOKEN` | in use (Worker, Mac, GitHub) |
| Google Web Risk | `GOOGLE_WEB_RISK_API_KEY` | Lookup API, 10,000 a month cap (`CLAUDE.md`) |
| Companies House | `COMPANIES_HOUSE_API_KEY` | optional; repo doesn't say if set |
| NameBio free files | `NAMEBIO_RETAILSTATS_CSV_URL` | off (`sources.namebio`) |
| Spaceship SellerHub | `SPACESHIP_SELLERHUB_API_KEY/_SECRET` | not configured (needs free keys) |
| GitHub data backup | `GITHUB_BACKUP_TOKEN/_REPO` | not configured (repo doesn't exist, G-128) |
| Dynadot | `DYNADOT_API_KEY/_SECRET` | read-only key installed 27 Oct; no code reads it yet |
| Afternic Portfolio API | `AFTERNIC_API_KEY/_SECRET` | key in `prod.env` 27 Oct; not in `.env.example` or `src/config.ts`; sync not built |
| Paths | `SNAPSHOT_DIR`, `ARCHIVE_DIR`, `PUBLIC_BASE_URL` | Mac disk |
| No adapter | Name.com, Namecheap, Spaceship registrar, NameSilo | commented out on purpose |
| Free public | Verisign/IANA RDAP, public DNS, SURBL, URIBL, Majestic list, GoDaddy inventory host | no key |

## 5. Interfaces to the bots

**Token scopes** (`docs/contract/README.md`): READ (every GET, `POST /score`, `POST /rdap/batch`); WRITE (Gavriel, everything, 4 job runs an hour); intake (scouts); data (loads, never money); visits (api-proxy Worker only); `bots-shared` (non-money writes; money routes only with `dry_run: true`); job token.

**Route groups** (`endpoints.md`): health, buying, listing/exports, offers/sold, reports/books/audit, S8 import, auctions, engine, `/data/*` and market, `/kb/*`, replay, pick-proof (off), visits, selection/screening/tranches, candidates/closeouts, jobs, RDAP, snapshots, company, lessons, patterns.

**Files:**
- CR/BUG files in `docs/requests/` get DOM's answer in the same file. Approved CRs are built at once.
- `DOM-TO-GAVRIEL.md` holds DOM's notices, newest first. Since 27 Oct DOM also posts a digest after each session.
- `GAVRIEL-TO-DOM.md` holds Gavriel's live checks of each release.
- `docs/bot-logic/00-04` are the bots' mechanical SOPs. `docs/requests/bot-logic/04-09` are drafts (Risk Gate, Sales, Challenger, FIXED-vs-JUDGMENT table, day timeline).

**What each side does now (per these files):**

| DOM does for the bots | The bots do for DOM |
|---|---|
| Builds every CR (Gavriel's lines are pre-approved) | File CRs/BUGs with acceptance tests |
| Runs datasave, the shortlist, pre-bid checks and portfolioCheck | Gavriel checks every release live on `/health` and runs the acceptance tests |
| Posts digests and replay proposals, asks for pain points | Buyer, Risk Gate and Gavriel judge shortlist names, write cards, take them to Dvir |
| Ran Dvir's at-computer setup on 27 Oct (backup, Afternic nameservers, keys) | Upload Dynadot rows; will load retail sales (CR-082); loaded the KB import (79 evidence rows, 185 claims) |
| | Gavriel does the money actions after Dvir's line; re-ran a failed CI job once |

## 6. Overlaps and duplicated work (all seen in repo)

| # | Overlap | Reference |
|---|---|---|
| O-1 | Dynadot data: bots upload by hand via `POST /snapshots/dynadot`, and DOM is building its own client with the new key. Seal state is the lock; bots stay primary until it ships | `docs/bot-logic/00-02`; CR-080 "BUILD NOW"; DOM-TO-GAVRIEL 27 Oct |
| O-2 | GoDaddy files: DOM saves and archives them daily; the Buyer may still grep local zips "in an emergency" | `jobs.md` datasave; `bot-logic/04` §0 |
| O-3 | Sales data in four stores: `engine_sales` (`POST /engine/sales` plus datasave), `market_sales` (`POST /data/sales`), `sales_comps` (`POST /data/sales-comps`), `/patterns/sales`. The bots also keep `sales-graded.csv` (~16k) and `POSITIVES-staging.csv` | `endpoints.md`; CR-082 |
| O-4 | Knowledge base: Gavriel's ledger and registry stay on his box. 106 registry rows and 15 ledger claims have no URL, so they are claims without evidence in DOM. Some research rounds were not imported | DOM-TO-GAVRIEL 26 Oct 21:50 |
| O-5 | Backtests: DOM's (`docs/research/backtest-production-2026-10-26.md`) and Gavriel's D2 (`docs/requests/research/gavriel-backtests-2026-10.md`) disagree on age and other endings. The D2 source question is still open | DOM-TO-GAVRIEL 26 Oct 22:20; F40 |
| O-6 | Pick-proof: DOM's seal/label steps and Gavriel's pick-proof routines both ran. Both are stopped now (CR-081) | DOM-TO-GAVRIEL 27 Oct |
| O-7 | Hard filters run twice: the shortlist drops SPELL/BRAND/BIGCO/TM_KILL/typo names, and the Buyer re-applies hard filters before carding | `bot-logic/08` Buyer table |
| O-8 | Tier A gate applied only on Gavriel's side; server enforcement planned | `CLAUDE.md` main buying line |
| O-9 | Budget: the service tracks none (G-86). The Buyer card shows "spent vs $1,500 POC cap" from the bots' own books | `CLAUDE.md`; `bot-logic/04` §3 |
| O-10 | Lessons: `scout_lessons` table in DOM and `lessons/*.md` on the bots' side | code-map candidates; `bot-logic/04` |
| O-11 | Listing state in three places: DOM's plan/venue records, the live Afternic state (mismatched Make Offer/LTO on 2 names, 27 Oct), and the bots' Sales docs. The Afternic skill still says "no seller API" | DOM-TO-GAVRIEL 27 Oct; `.claude/skills/afternic-listing/SKILL.md` |
| O-12 | Visits: DOM's counter overcounted (F17) and is inert for the 3 names moved to Afternic nameservers; Afternic's own views are the other source | F17; DOM-TO-GAVRIEL 27 Oct |
| O-13 | Lock notes: `00` says `docs/locks/` is notes only, `09` says the winner writes a lock file there. `09` also lists `portfolioCheck` inside datasave, but it runs in `daily` at 00:05 | `bot-logic/00`, `09`; `jobs.md` |
| O-14 | `04-buyer-shortlist-to-card.md` exists twice, identical, in `docs/bot-logic/` and `docs/requests/bot-logic/` | both folders |
| O-15 | Chores the server could do: retail-sales fetch (CR-082 keeps it bot-side), Dynadot pulls (O-1), Afternic listing changes (API key exists, sync not built), the GoDaddy auto-renew check (unchecked, F38) | CR-082 R-1; F38 |
| O-16 | The requests-only guard still blocks bot commits to `docs/bot-logic/` and `docs/locks/`, which CR-080 created | `NOTE-2026-10-26-requests-only-guard-bot-logic.md`; `requests-only.yml` |

## 7. Strengths and weaknesses seen in the files

**Strengths**
- Fast: 11-13 releases a day, each with a contract bump, a release note and a Lessons line.
- Every CR gets an in-file answer. Rounds stay short (CR-080, CR-081).
- Strong guards: about 2,965 tests, contract and module-boundary checks, an offline suite.
- Findings are closed with numbers (F2, F3 worked; F19 marked "did not hold").
- Took over bot chores while the bots were paused (datasave, shortlist, portfolioCheck).

**Weaknesses**
- Browser work is fragile: Sedo pages "do not work under automation" (27 Oct), and the Afternic skill is out of date.
- Release mistakes recur (`release-mechanics-lessons.md`): v5.36.0 CI red on a migration count; v5.48.0 note committed after the tag; v5.57.0 flaky HG-6 test (Gavriel re-ran CI); builder logic errors that passed their own tests.
- Fixes that didn't hold the first time: F19 storage (then F28), score bunching (P2).
- Idle parts: the outside review (~2,700 lines) was removed after 17 days off; pick-proof stopped before its first result; `engineTrain` had no model for weeks; 15 of 18 warnings were noise until v5.50.0.
- Rules built to the letter: the holdout block dropped new rows for 11 days.
- Results so far: 5 names, 0 sales, 0 leads, 0 offers, 0 bid plans (26 Oct).
