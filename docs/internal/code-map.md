# Code map

Where things live, so a change request goes straight to the right files. Paths are from the repo root. Kept in step with the tree by the commit that changes it (a change that adds, moves or removes a file, route, table or test file updates this map); last full check at contract v5.15.0. Which release added what is in `docs/contract/CHANGELOG.md` and `docs/releases/`, so the `vX.Y.Z` tags below are history, not a promise of completeness.

## 1. How to use this map

- Find the module (section 2), then the file, then its test file. Use section 3 ("Where do I change X?") for the usual change types.
- Other code may import a module only through its `index.ts` (`tests/unit/module-boundaries.test.ts`). Graph: registrars <- listing <- selection <- buying <- candidates; selection <- engine (v5.4.0); engine and candidates <- data (v5.15.0); selling <- reporting <- outreach; registrars, listing <- visits (v5.18.0); market (v5.23.0, imports nothing); knowledge (v5.43.0, CR-078, imports nothing; `ops` and `app.ts` import it); pickproof (v5.28.0, imports selection); ops on top.
- Run only the affected tests locally: `npx vitest run tests/modules/<module>/<file>.test.ts` (pure tests: `tests/modules/<module>/unit/`). API tests need Postgres (`npm run db:up`). CI runs the full suite on push.
- Before commit still run `npx tsc --noEmit && npm run build` (the gate in CLAUDE.md).
- Test files sit under the module they cover and are named by feature (`tests/modules/candidates/screen.test.ts`, `outreach/company-terms.test.ts`), never by release. Test IDs (T21-1, AC-6, V214-5, ...) are part of the test names, so docs refer to IDs. To find the tests for a route, `grep -l "<path>" -r tests/modules`. Paths in the "Tests" columns below are relative to `tests/modules/` (a `unit/` entry is a pure test).

Test layout: `tests/modules/<module>/*.test.ts` (API tests: Fastify `inject` + test DB. `tests/setup/global-db.ts` migrates the `TEST_DATABASE_URL` database once and copies it into one database per vitest worker (`<name>_w1_test` .. `_wN_test`, N = `DT_TEST_WORKERS`, default 4, `tests/setup/workers.ts`); `tests/helpers/env.ts` picks the worker's database from `VITEST_POOL_ID`, so API test files run in parallel; `resetDb` (`tests/helpers/db.ts`) fingerprints the tables and truncates only the ones a test touched, falling back to the full wipe when a seeded table changed; `waitFor` / `waitForLockWaiter` replace fixed sleeps; one folder per `src/modules/*` plus `core`, `http`), `tests/modules/<module>/unit/` (pure: no DB, no network), `tests/unit/` (cross-cutting guards: module/core boundaries, `doc-test-ids` (IDs in `docs/internal` must be in a test name; stale ones are listed in `KNOWN_STALE`), no-llm, no-topup, network-block, config, test-evidence, domain-name, `test-clock-guard` (L516-2, G-111: real-clock `approved_at` guard)), `tests/contract/` (`contract-doc.test.ts` and `version-sync.test.ts` run in the unit project; `porkbun-mock.test.ts`/`porkbun-sandbox.test.ts` are opt-in, with `setup.ts`, `sandbox-guard.ts`, `sandbox-guard-setup.ts`), `tests/helpers/` (`app.ts` makeApp/runJobToEnd/settleJob, `db.ts` TABLES + reset, `buy.ts`, `listing.ts`, `pricing.ts`, `screening.ts`, `screening-fixtures.ts`, `fake-adapter.ts`, `porkbun-msw.ts`, `godaddy-msw.ts`, `tokens.ts`, `env.ts`, `csv.ts`), `tests/fixtures/` (recorded screening data, Porkbun OpenAPI, pricing vectors), `vitest.config.ts` (projects unit = `tests/unit` + `tests/modules/*/unit` + contract-doc; api = `tests/modules/**` minus `unit/`; porkbun-*).

Top level: `src/app.ts` (`buildApp`: wires hooks in order auth -> rate limit -> scope -> idempotency -> audit, then every `register*`, the job queue, openapi), `src/main.ts` (server start), `src/config.ts` (zod `EnvSchema`, `loadConfig`; tests `tests/unit/config.test.ts`), `src/domain-name.ts` (domain normalisation; `tests/unit/domain-name.test.ts`), `scripts/` (`evidence.ts`, `build-wordlists.ts`, `record-screening-fixtures.ts`, `refresh-porkbun-spec.ts`, `release.ts`; `local-host/`: CR-041 kit to run production on Dvir's Mac mini while Render is suspended (`install.sh`, `visits-token.sh` (v5.18.0, CR-068: hands a requested visit-counter token to the GitHub secret; called by `deploy.sh` every tick), `start.sh` (runs the `<prod>-current` symlink), `deploy.sh` (builds each tag in `<prod>-releases/<tag>`, switches the link atomically), `rotate-logs.sh` (10 MB x 5 log rotation, called by deploy.sh), `datasave-trigger.sh` (v5.46.0: hourly LaunchAgent `com.domaintrading.datasave`; from 15:00 UTC once a UTC day it posts the datasave job to the local server with the job token it reads from prod.env itself; runbook "Local host", `datasave.md` "Mac trigger"), `stop.sh` / `resume.sh` (G-109: pause flag `~/.local/share/domain-trading-host/PAUSED`; `deploy.sh`, `start.sh`, `install.sh` honour it; deploy.sh also waits up to 15 min for a running CI, G-110), `tunnel-watch.sh`, five LaunchAgent plists (v5.46.0: datasave): api, deploy, tunnel = cloudflared quick tunnel, tunnel-watch = publishes a changed tunnel URL; run by Dvir, never DOM; runbook "Local host")). Top-level `api-proxy/` (Cloudflare Worker `domain-trading-api-proxy`, the stable workers.dev URL that forwards to the quick tunnel in `TUNNEL_URL`; `src/index.ts`, `src/index.test.ts`; deployed by `.github/workflows/deploy-api-proxy.yml`; CR-041; v5.18.0: also `GET|HEAD /r/<domain>`, the counting redirect, CR-068).

## 2. Modules

### registrars
Registrar adapters (Porkbun live, GoDaddy management-only), quote evaluation and winner choice, `GET /check`.

| Route | File |
|---|---|
| GET /check | `src/modules/registrars/api/check.ts` |

| File | Inside |
|---|---|
| `check.ts` | `CheckService` (quotes across registrars, writes `quotes`) |
| `porkbun.ts` | Porkbun adapter (`RegistrarAdapter`), `redactInvoice` |
| `godaddy.ts` | GoDaddy adapter (manage only) |
| `registry.ts` | `createAdapters`, `REGISTRAR_ENV`, `adapterStatus` |
| `selection.ts` | `evaluateQuote`, `pickWinner` (first year + one renewal, premium/Cloudflare exclusions) |
| `types.ts` | `RegistrarAdapter`, `RegistrarError`, `AMBIGUOUS_CODES`, `nsPendingWarning` |

Tables: `quotes`. Tests: `tests/modules/registrars/` (`check`, `check-porkbun`, `check-service`, `godaddy`), `tests/modules/registrars/unit/` (`porkbun-*`, `godaddy-static`, `selection`), `tests/modules/ops/registrar-check.test.ts`; `tests/contract/porkbun-*.test.ts`; helpers `porkbun-msw.ts`, `godaddy-msw.ts`, `fake-adapter.ts`.

### listing
Per-domain listing plan (mode, BIN, floor, walk-away, schedule), `POST /list`, pricing settings, Afternic/Sedo exports.

| Route | File |
|---|---|
| POST /list/:domain | `listing/api/list.ts` |
| GET /pricing/preview | `listing/api/pricing.ts` |
| GET /export/afternic.csv, GET /export/sedo.csv, POST /export/:venue/uploaded | `listing/api/export.ts` |
| POST /listings/:domain/venue (v3.7.0, CR-031 C: a listing made by hand on afternic/sedo, or `delisted: true`; strict schema, no walk-away; v5.27.0: `provenance`), POST /listings/:domain/observed (v5.27.0, CR-076: a public sighting, `observed_public`), POST /portfolio/:domain/display-name (v5.27.0, CR-076 R-5) | `listing/api/venue.ts` (`registerVenue` registers all three) |

| File | Inside |
|---|---|
| `list.ts` | `ListService` (validates, sets nameservers to lander, writes plan + `listing_history`) |
| `listing-v2.ts` | `validateListing`, `validateComps`, `CompSchema`, `isCategory`, `checkSettingsVersion` |
| `pricing/plan.ts` | `computePlan`, `priceFormula`, `hybridBinMin` |
| `pricing/schedule.ts` | `buildSchedule`, `ladderStep`, `laneList` (drops M6/M18, final push, delist) |
| `pricing/settings.ts` | `PricingSettings`, `currentSettings`, `settingsByVersion`, `rowToSettings`, `ruleFields`, `RULE_KEYS` |
| `pricing/round.ts`, `int.ts`, `present.ts` | rounding (x95), integer helpers, display |
| `plan-store.ts` | `applyPlan` (v5.15.0: the history row, then `writePlan`; the one way /buy, /list and the import store a new plan), `writePlan`, `currentPlan`, `applyHold`, `historyRow`, `domainPlanColumns` |
| `plan-view.ts` | `planView` (API shape of a plan; walk-away never exposed) |
| `export.ts` | `ExportService`, `AFTERNIC_HEADER`, `afternicRow` (v5.50.0, P9: second argument `AfternicLease` from `settings.afternic_lease_to_own` / `afternic_lease_months` via `leaseOf`; lease needs BIN >= `AFTERNIC_LTO_MIN_BIN_CENTS`), `sedoRow`, `loadSedoTemplate`, `toCsv` |
| `export-state.ts` | `pendingDomains`, `changedColumns`, `manualDelist`, `VENUES` |
| `lander.ts` | `landerNameservers`, `sameNsSet` |

Tables: `domains` (plan columns), `listing_history`, `price_schedule`, `export_runs`, `export_uploads`, `venue_listings` (v3.7.0, append-only; v5.27.0 columns `provenance`, `seen_price_cents`, `seen_url`, `seen_at`, migration `1765900000000_v5-27-0.sql` incl. the R-4 seed as appended rows; `listed_venues` / `observed_venues` come from `portfolioRows` in `reporting/report/portfolio.ts`; `/portfolio/:domain` `export.<venue>` reads it in `reporting/report/portfolio.ts` `exportBlock`: `listed_by_hand_at`, `shown`, `pending` follows the shown BIN/min offer vs the plan); reads `pricing_settings`. Tests: `tests/modules/listing/` (`list`, `list-concurrency`, `lander-none`, `export`, `export-v2`, `export-state`, `plan-store`, `pricing-*`, `venue`, `provenance` (v5.27.0: PV527-1..8), `mineunited-fix` (v5.20.1: M5201-1, V5201-2, the data migration `1765200000000_v5-20-1.sql`)), `tests/modules/listing/unit/` (`listing-v2`, `pricing-*`, `export-rows`); fixtures `tests/fixtures/pricing-vectors.v2.json`, `.v3.json`; helpers `listing.ts`, `pricing.ts`.

### selection
(v5.39.0: `prebid.ts` = `runPrebidChecks`, the automatic pre-bid checks of a registered name, used by `ops/api/auctions.ts`; tests `ops/auction-plans`; v5.42.0: the five endings are probed side by side; v5.44.0: `brand-typo.ts` = `brandMatches`, `commonWord` (BRAND-TYPO-2 against the stored popularity list), `checks/surbl.ts` now holds `dnsblCheck` with `surblCheck` and `uriblCheck` (URIBL-1), prebid adds BRAND-TYPO-2, URIBL-1, SPAMHAUS-DBL (SKIP), EUIPO-1 (SKIP) and `checked_at` per check; tests `selection/unit/brand-typo` SF544-1..7, `ops/safety-checks` SF544-8..18)
The largest module (about 8,400 lines). Versioned selection settings, screening runs and checks, tier/lead logic, screening packs, test sets, replays, holdout suites, sellers, buy-hold steps.

| Route | File |
|---|---|
| GET/POST /selection/settings, POST /selection/settings/:label/activate, GET /selection/namebio, GET/POST /selection/lists/:name, GET/POST /selection/sibling-methods/:method(/approve) | `selection/api/selection.ts` |
| POST/GET /demand/keywords (v4.2.0, CR-044 item 3) | `selection/api/demand.ts` (`registerDemand`, called from `src/app.ts`; the 2 MB route body limit; logic in `selection/demand.ts`) |
| POST /selection/sibling-scan, GET /selection/sibling-scan/:domain (v4.1.0, CR-050) | `selection/api/sibling-scan.ts` (`registerSiblingScan`, called from `src/app.ts` after `screeningDeps`) |
| POST /selection/evaluate, labelled-names, holdout-suites, replays, GET /selection/buy-hold | `selection/api/selection.ts` |
| POST /screening/runs, GET /screening/runs/:id, GET /screening/runs/:id/report.csv, POST /screening/runs/:id/(cancel, manual, verdicts), GET /screening/evidence/:id, POST /quotes/manual | `selection/api/screening.ts` |
| POST/GET /screening/packs, GET /screening/packs/:id | `selection/api/packs.ts` |
| POST /selection/test-sets, GET /selection/test-sets/:name, POST /selection/test-sets/:name/(seal, cancel) | `selection/api/test-sets.ts` |

| File | Inside |
|---|---|
| `settings.ts` | zod `SelectionValues`, `DEFAULT_SELECTION_VALUES`, `TIER_FEATURES`, `CHECK_IDS`, `LANES`, `LOCKED_PREFIXES`, `applySet`, `createDraft`, `activate`, `activeSelectionSettings` |
| `engine.ts` | `createRun`, `ScreeningWorker` (runs checks, heartbeat, resume; v5.14.0: `prefetchCached` reads the reusable cache rows of a check for all names in one query), `assemble`, `assembleRun` (a stored run through `assemble`: the one helper for reading a run), `groupByItem`, `loadRowsForRuns`, `planFor`, `effectiveHold`, `heldByActive` |
| `checks/index.ts` | `CHECKS` registry, `GATE_OF`, `DEPENDS_ON` (from `depends.ts`) |
| `checks/*.ts` | one check each (`surbl.ts` also exports `uriblCheck`, run only by the pre-bid check): `form`, `brand-lists`, `typo`, `availability`, `concentration`, `surbl`, `history` (manual HIST-2 records only since 5.15.0), `census`, `ext-dates`, `namebio`, `same-name`, `tier`, `quote`, `price`, `manual` (web_risk, tm_us/tm_eu) |
| `types.ts` | `CheckId`, `Lane`, `Check`, `CheckContext`, `ResultRow`, `RunItem` |
| `derive.ts` | `deriveItem`, `latestByCheck`, `funnel`, final status (`buy_candidate`, `would_buy`, ...) |
| `tier.ts` | `evaluateTier`, `condHolds`, `cmp`, `unknownInputsOf` (clause ops and tier feature inputs) |
| `form.ts`, `lexicon.ts`, `typo` data | name form (`analyzeForm`, `gform1`, `isShort`, `regimeDigitsOk` (CR-039, also used by intake)) |
| `pack.ts` | screening pack: `assessPack`, `issuePack`, `latestPackFor`, `requiredChecks` |
| `sellers.ts`, `site.ts`, `html-text.ts`, `capped-read.ts` | seller pages and site classification, HTML text, bounded body reads and the `makeMatcher` signature matcher (was `wayback.ts` until 5.15.0) |
| `rdap-batch.ts` (v5.42.0: `runRdapBase` = the IANA base of an ending once per run, shared by endings asked side by side; `site.ts` `PagePace` takes the host), `popularity.ts`, `namebio.ts`, `web-risk.ts` | RDAP pacing/cache, popularity list, NameBio (v5.11.0, CR-062: free endpoints only, `assertNameBioRequest` allow-list, persisted rate limits in `namebio_calls`, `refreshNameBio`, `keywordCounts`, tables `namebio_keyword_stats` / `namebio_tld_stats` / `namebio_calls`; test `tests/modules/selection/namebio-free.test.ts`), Web Risk lookup |
| `checks/lookalikes.ts` | v3.10.0 (CR-043, G-70): `lookalikesCheck`, `lookalikeNames` (feature check appended to every plan by `planFor` while `lookalikes.enabled`; `featureChecksOf` in `settings.ts`); v4.1.0: the per-name RDAP + home-page work is `probeLookalike`, shared with the sibling scan; v4.2.1 (CR-052): `wordHyphenNames` (hyphen forms from dictionary words, used when `lookalikeNames` gets a dictionary: the sibling scan only), and `.co/.us/.io` RDAP from `RDAP_FALLBACK_BASES` in `src/core/rdap.ts` |
| `demand.ts` | v4.2.0 (CR-044 item 3): `decodeKeywordFile` (UTF-16LE/BE/UTF-8, BOM), `parseKeywordExport` (by header name, `KEYWORD_CSV_INVALID`), `storeKeywordUpload`, `latestKeyword`, `demandForKeywords`, `keywordCandidates`, `keywordsOfDomain`, `searchesOfDomain` (the renewal keep-signal in `reporting/report/lifecycle.ts`) |
| `checks/demand.ts`, `checks/companies.ts` | v4.2.0 feature checks (G8, never reject, never decide a pack), appended to every plan by `planFor` while `demand.enabled` / `companies.enabled` (`APPENDED_FEATURE_CHECKS` in `settings.ts`). `companies`: Companies House search through `safeFetch` (HTTP Basic, key `COMPANIES_HOUSE_API_KEY` as `ScreeningDeps.companiesHouseApiKey`), `Pacer` from `companies.max_per_minute`, `titleMatches`, `companyMatches` |
| `sibling-scan.ts` | v5.42.0 (G-122): `HostPaces` (one gap per host, 4 fetches in flight), `inPool`, `SCAN_CALL_MAX_SECONDS` (300; `time_budget_seconds` is per name); v4.1.0 (CR-050): `scanSiblings` (per name: `lookalikeNames` with `siblings.endings` + `probeLookalike`, then company / `contactUrlOf` / `leadPointsOf`; one `sibling_scans` row per name), `latestSiblingScan`, `contactUrlOf` (same-site contact page URL, never an email), `leadPointsOf` (weights from `siblings` settings). `anchorLinks` is in `html-text.ts` |
| `topic.ts` | v3.10.0: `topicFor`, `earlierWithTopic` (TOPIC_REUSED; used by intake and the report) |
| `run-report.ts` | v3.10.0: `runReportCsv` (v5.14.0: topic, reuse and comps for all names in two statements), `csvSafe` (`GET /screening/runs/:id/report.csv`, route in `api/screening.ts`) |
| `lists.ts` | versioned signature lists (`writeList`, `currentLists`) |
| `replay.ts`, `test-sets.ts`, `split-v2.ts`, `siblings.ts`, `sibling-methods.ts` | replays, holdout (`holdoutCheck`), test sets, sibling method `bt1@vN` |
| `hold-steps.ts` | `buyHoldSteps` (GET /selection/buy-hold; v5.14.0: takes the route's `holdSuites` answer, picks unheld drafts in SQL). The route also adds `small_buy` (v3.7.0, G-3) from `SelectionDeps.smallBuy`, composed in `src/app.ts` from `buying` `smallBuyView` (selection must not import buying) |
| `closeout-name.ts` | v5.26.0 (CR-072): `closeoutNameChecker` (SPELL-1 = `analyzeForm` FAIL, BRAND-1 / BIGCO-1 / TM_KILL by a set lookup of the same token-run rule as `brand_lists`), `termKey`; used by `ops/closeouts` |
| `lane-fit.ts` | `laneFitter` (v3.2.0, CR-020 A): which kept lane (S2, S4, S6) a drop-list name fits, from the `form` token types and the current word lists; none = NO_KEPT_LANE (tests `candidates/lane-fit`) |
| `prior-business.ts` | prior-business guard of the history check (CR-002 A1): takes the business name a captured page gives itself (og:site_name, title, `<Name> LLC` / copyright line), deterministic, linear scans |
| `verdicts.ts` | `VerdictBody`, `verdictsFor`: human PASS/REJECT verdicts bound to one FLAG result row (append-only `screening_verdicts`; route `POST /screening/runs/:id/verdicts`; tests `selection/screening-verdicts`) |
| `unknowns.ts`, `money.ts`, `evidence.ts`, `domain-records.ts` (v5.14.0: `prefetchDomainRecords` for the daily list), `tranche-members.ts` | unknown-input reports, EV/Ratio math, evidence rows, cached records, geo members |

Tables: `selection_settings`, `selection_lists`, `sibling_method_approvals`, `screening_runs/results/verdicts/packs/evidence`, `manual_quotes`, `domain_records`, `test_sets`, `test_set_rows`, `labelled_names`, `holdout_suites`, `replay_runs`, `rdap_lookups`, `reference_files`, `api_usage`, `registrar_presence` (ops writes it), `sibling_scans` (v4.1.0, append-only), `keyword_demand_uploads`, `keyword_demand` (v4.2.0, append-only, in the backup). Tests: `tests/modules/selection/` (`screening-*`, `selection-*`, `sibling-methods`, `sibling-bt1-v2`, `bt1-v3-records`, `test-sets`, `web-risk`, `reference-refresh`, `r1b-*`, `rdap-pacing`, `run-cancel`, `run-integrity`, `lists-current`, `records-unknowns`, `tier-lanes`, `sellers`, `seller-fetch`, `scout-words`, `settings-intake-keys`, `cr043-scout-checks`, `sibling-scan`, `keyword-demand` (v4.2.0: KD-1..KD-7, CH-2..CH-6)), `tests/modules/selection/unit/` (`screening-*`, `pack-assess`, `sellers`, `site-classify`, `html-text`, `sibling-bt1`, `sibling-scan` (CR-050), `keyword-demand` (v4.2.0 parser, Companies House match), `split-v2/v3`, `sibling-scan`); helpers `screening.ts`, `screening-fixtures.ts`.

### buying
`POST /buy` (approval, gates, registrar register, ledger), tranches, reconciler, domain count.

| Route | File |
|---|---|
| POST /buy | `buying/api/buy.ts` |
| GET/POST /tranches, POST /tranches/:id/(close, members) | `buying/api/tranches.ts` |

| File | Inside |
|---|---|
| `buy.ts` | `BuyService` (v5.15.0, split from one 855-line file): `buy()` runs the checks in order (approval, category, proposed listing, hold, pack, tranche, availability, caps, renewal maths, account state, registrar dry run) and hands over to the dry-run body or the money phase; `defaultDisplayName` (newest `candidate_intake.words`) |
| `buy-types.ts` | `BuyInput`, `BuyCtx`, `BuyResult`, `BuyDeps`, `Approved`, `Horizon`, `DropPolicy`; the drop-policy words (`policyFields`, `policyLine`, `withPolicyLine`, `horizonWarnings`) |
| `buy-reserve.ts` | `reservePending` (the `purchases` row and the `pending_purchase` domains row, shared by the reservation and the dry-run ambiguity record), `assertNotOwned`, `assertDomainCap`, `isUniqueViolation` |
| `buy-dryrun.ts` | `assertAccountState`, `registrarDryRun` (re-quote once on COST_MISMATCH), `recordDryRunAmbiguous`, `gateFields`, `dryRunBody` (the `dry_run` 200 body), `priceDetails` |
| `buy-register.ts` | the money phase: `priorOutcome` (idempotent replay), `purchase` (reserve under the locks, `register_sent` before the registrar call, retries, ambiguity, `finishFound`, `finishRegistered`, `complete` = booking + the 201 body; `drop_policy` `at_first_expiry` sets drop_date = expiry here) |
| `buy-postbuy.ts` | after booking (buy.md step 7): `postBuy` (pricing evidence, privacy, auto-renew off, lander nameservers `saveLander`, the proposed listing `saveListing` through `applyPlan`) |
| `buy-gates.ts` | `buyBlocks`, `packGate`, `trancheGate`, `gateError`; block codes `BUY_HOLD`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE` |
| `buy-hold.ts` | `screeningHold`, `latestScreeningRun` |
| `renewal-math.ts` | v4.0.0: `renewalMath` (BIN x (1 - commission) x STRe / renewal cost, integer cents and basis points), `binForMath`, `screeningGroupOf` (`passed` / `borderline` from FLAG results of the latest run); `buy.ts` stores `horizon`, `screening_group`, `buy_card` (`sell_or_drop_by` is set by `bookkeeping.ts` `bookPurchase`); the domain cap is 40 (`settings.max_domains`, migration) and a dry run reports `DOMAIN_CAP_REACHED` as `would_be_blocked` |
| `small-buy.ts` | CR-030 small-buy exception to the buy hold: fixed limit `SMALL_BUY_MAX_FIRST_YEAR_CENTS`, `smallBuyRequested`, `smallBuyGate`, `smallBuyView` (the price ceiling for GET /selection/buy-hold); code `SMALL_BUY_PRICE`. 5.0.0 (G-86): no weekly money cap |
| `tranches.ts` | `TrancheService` |
| `caps.ts` | (renamed from `budget.ts` in 5.13.0) `activeDomainCount`; v5.8.0 (CR-059): `activeLaneCounts`, `laneCapBlock` (the total 40-name cap shared by both lines since 5.52.0, no S8 reserve; `buy-reserve.ts` `assertDomainCap` applies it to Line 1, `import-domain.ts` to S8). The 40-domain cap, `settings.max_domains`, is applied in `buy-reserve.ts` and `buy.ts`. 5.0.0 (G-86): no money budget in the service; `spentCents`, `pendingCents`, `spentAndPending` are gone |
| `bookkeeping.ts` | `bookPurchase` (v3.9.0: optional `dropDate`, set in its transaction; default expiry + 1 year; 5.13.0: also sets `sell_or_drop_by` = buy date + `renewal.horizon_months` for a trend / regulation name, so `/buy` and the reconciler agree; test `buying/reconciler` M2), `failPurchase`, `registrarApiOf` |
| `reconciler.ts` | `Reconciler` (stuck `unknown`/`register_sent` purchases; job step `reconciler`). v3.9.0: no rdap dependency, never fails an open purchase (`/report` `PURCHASE_UNRESOLVED` + admin `resolve-purchase`); on booking it sets auto-renew off and the drop policy (`at_first_expiry`) |

Tables: `purchases`, `receipts`, `deals`, `ledger_entries`, `tranches`, `tranche_members`, `pricing_evidence`; writes `domains`, `listing_history`. Tests: `tests/modules/buying/` (`s8-import` S8-1..S8-19 (v5.8.0, CR-059 + v5.9.0, CR-060: the import route, the shared cap CAP552-1/2, `/report` lines), `buy-*`, `buy-display-drop-policy`, `caps` (domain count only), `reconciler`, `tranches`, `evidence-gaps`, `small-buy`, `small-buy-hold`); `purchases.small_buy_exception` marks small-buy purchases (migration `1762800000000_v3-5-0-b.sql`); helper `tests/helpers/buy.ts`.

### candidates
Intake of candidate names, on-demand screening, the daily list, drop lists, cohorts.

| Route | File |
|---|---|
| POST /candidates/intake, POST /candidates/screen, GET /candidates/daily, POST /candidates/daily/rebuild, GET/POST /candidates/:domain/records | `candidates/api/candidates.ts` |
| POST /patterns/sales, GET /patterns/latest (v4.0.0, CR-044 item 4) | `candidates/api/patterns.ts` (`registerPatterns`; logic `candidates/patterns.ts`: `parseSalesCsv`, `storeSales`, `clusterSales`; the split is `bt1@v3` via `selection` `loadSplitV2`/`splitClasses`) |
| POST/GET/PATCH /lessons, GET /lessons/check, GET /lessons/report (v5.3.0, CR-053) | `candidates/api/lessons.ts` (`registerLessons`, called from `src/app.ts`; logic `candidates/lessons.ts`: `addLessons` (merge rule, one transaction, advisory lock), `listLessons`, `lessonsForDomain`, `patchLesson`, `lessonReport`, `reportMarkdown`; table `scout_lessons`, mutable, not in the backup export, not touched by retention) |
| POST/GET /selection/drop-lists, GET /selection/drop-lists/:name | `candidates/api/drop-lists.ts` |
| POST /selection/cohorts, GET /selection/cohorts/report, GET /selection/cohorts/:name | `candidates/api/cohorts.ts` |

| File | Inside |
|---|---|
| `intake.ts` | (v5.42.0: `takeIntake` decides in memory and writes with prefetch + multi-row inserts; `rescreenCandidates` reads in bulk) `IntakeBody` (zod), `takeIntake`, `intakeFormReason`, `checkIntake*`, `onDemandAllowance`, `planOnDemand`, `IntakeScreeningJob` |
| `daily-list.ts` | v3.9.0: `buildDailyList` takes the `daily_rebuild` lock itself; `DailyEntry`, `buildDailyList`, `BuildDailyListJob`, `readDailyList`, `buildWhy`, `autoRebuildDailyList`, limits `DAILY_LIST_*` |
| `drop-lists.ts` | drop-list helpers (`watchStatusOf`, `freshLookups`, `retentionCutoff`, constants) |
| `cohorts.ts` | `freezeReadyCohorts`, `FINAL_DROP`, `REREG_DAYS` |
| `pool.ts` | v5.15.0: `candidatePoolHosts` (which of some hosts are in the pool: a non-removed intake name or a kept drop-list row; used by the `data` module's RDAP load) |

Tables (v4.0.0 patterns tests: `candidates/patterns`; v5.3.0 `scout_lessons`, tests `candidates/lessons` LS-1..LS-8): `candidate_intake`, `candidate_screenings`, `daily_candidate_lists`, `drop_lists`, `drop_list_rows`, `cohorts`, `cohort_names`, `cohort_decisions` (`drop_list_checks`, `cohort_outcomes` written by ops jobs). Tests: `tests/modules/candidates/` (`intake`, `intake-resume`, `intake-rules`, `screen`, `screen-domains`, `screen-force`, `scout-split`, `lane-fit`, `daily-list`, `daily-list-fields`, `daily-list-rebuild`, `daily-list-rejected`, `drop-lists`, `cohorts`, `cohorts-freeze`, `cohort-settings`).

### engine
v5.4.0 (CR-056 part 1): data for the name-scoring engine; v5.5.0 (part 2): features, models, training, scoring. Rules and plan: `docs/internal/engine.md`. Imports `selection` (RDAP helpers, split table, lists); nothing in selection, buying or candidates imports it; ops runs its jobs through `JobRunnerDeps.engineEndingsJob` and `JobRunnerDeps.engineTrainer`.

| Route | File |
|---|---|
| POST /engine/sales, POST /engine/unsold, GET /engine/health; v5.10.0 (CR-061): GET/POST /engine/holdout-date, `db_bytes_*` and the 409 DB_SIZE_HIGH guard (logic `engine/holdout.ts`: `salesMaxDate`, `setSalesMaxDate`, `guardDbSize`; v5.41.0: the holdout date blocks nothing, the answers carry `effect: "none since 5.41.0"`, `HOLDOUT_SEALED` is gone from `bulk.ts` `dateOf`) | `engine/api/engine.ts` (`registerEngine`; the two upload routes are `registerBulkRoute` from `engine/bulk.ts`: 8 MB body limit; the audit log keeps the row count only, `elideRows` in `src/http/audit.ts`) |
| POST /engine/train, GET /engine/train/:id (v5.5.0) | `engine/api/engine.ts` (`EngineTrainer.start` / `get`) |
| POST/GET /data/rdap, /data/live-checks, /data/tm-kills, /data/bigco-names, /data/sales-comps (v5.12.0, CR-063; WRITE or `data` loads, READ reads, `stale` flag on rdap) | moved to the `data` module in v5.15.0: see section `data` |
| GET /engine/rows (v5.50.0, P6: stored labels paged by `kind` sales / unsold / auction_ends, READ or bots) | `engine/api/engine.ts`, logic `engine/rows.ts` (`engineRows`, `RowsQuery`); tests `engine/rows` (EN-100..EN-105) |
| GET /engine/lift (v5.47.0) | `engine/api/engine.ts` (`liftView` in `lift-train.ts`) |
| GET /owned/:domain/endings (v5.7.0, CR-058) | `engine/api/engine.ts` (`ownedEndingsView` in `endings.ts`) |
| POST /score (v5.5.0, the one read-only POST) | `engine/api/engine.ts` (`Scorer.score`); read-only status comes from `READ_ONLY_POSTS` in `src/http/methods.ts` (`isMutating(method, routeUrl)`: scope, idempotency, audit, rate class, openapi) |

| File | Inside |
|---|---|
| `uploads.ts` | `storeSales`, `storeUnsold`, `parseSaleRow`, `parseUnsoldRow` (per-row reject reasons), `SALE_DEDUPE_DAYS`; on `bulkLoad` |
| `bulk.ts` | v5.15.0: the bulk-upload skeleton shared with the `data` module: `bulkLoad` (per-row rejects, one transaction under the `engine_upload` lock; v5.41.0: no sealed-date plumbing), `registerBulkRoute` (DB_SIZE_HIGH guard, 8 MB body, audit summary, 201 with the byte counts), the row validators (`domainOf`, `dateOf`, `centsOf`, `textOf`, `isObj`, `rawDomain`), `ENGINE_MAX_ROWS`, `Reject`; exported through `engine/index.ts` |
| `regime.ts` | v5.41.0: `loadRegimeTest(db)` = the engine's `inRegime` test on the extended split table as a function, for the datasave steps (`buildPanel` regime-first RDAP cap, `engineFeed`); exported through `engine/index.ts` together with `storeSales` / `storeUnsold` / `guardDbSize` |
| `endings.ts` | v5.42.0 (G-124): `askEndingsFor` / `endingsState` / `endingDue` (v5.45.0: ask the five endings of a given list of names inside a time budget, used by the ops shortlist step; exported through `index.ts`), `EndingsWriter` (buffers bulk answers, flushes per 500 with the v5.14.0 keep/update/append rule; owned pairs are still written one by one before their event). `EndingsJob` (daily step `engineEndings`: due pairs, per-host pacing with `hostPacer`, writes `engine_endings`; v5.7.0: owned names first and weekly (`ownedDue`), `recordOwnedEvent`, `ownedEndingsView`, `OWNED_RECHECK_DAYS`), `endingsHealth`, `ENDINGS_*` constants |
| `slices.ts` | v5.7.0 (CR-058): `holdSlices` (quick / held split of the sold test rows; run by `train.ts`, stored in `metrics.slices`, shown by `health.ts`), `RECALL_THRESHOLD`, `QUICK_SALE_DAYS` |
| `rows.ts` | v5.50.0 (P6): `engineRows`, `RowsQuery` (GET /engine/rows) |
| `health.ts` | `engineHealth` (GET /engine/health; v5.50.0: `data.auction_ends_n` by band; v5.5.0: model fields; v5.6.0: ablation, drift, `computeBars`, bar thresholds) |
| `drift.ts` | v5.6.0: `computeDrift` / `driftBlock` (drift per year and last quarter, point-in-time; run by `train.ts`, stored in metrics); v5.14.0: a feature cache per `domain|asOf`, `computeDriftYielding` (warms the cache with an event-loop turn every 2,000 rows) |
| `features.ts` | v5.5.0: pure point-in-time features (`computeFeatures`, `FEATURE_NAMES`, `buildTokenIndex`, `extendedTable`, `inRegime`, `zipfOfCost`, `COM_FEATURES`) |
| `data.ts` | v5.5.0: database loaders (`loadSales`, `loadUnsold` (dropped-after-held rows only since v5.14.0), `countRegisteredUnsold`, `loadEndings`, `loadDemand`, `loadExtraTerms`, `tokenContext`) |
| `dataset.ts` | v5.5.0: sold / unsold rows, `quarterOf`, the time split, `frozenHash` (`buildDataset`, `DataError`; v5.14.0: `registeredUnsold` option, hash-decorated sort) |
| `train.ts` | v5.5.0: `EngineTrainer` (`start`, `get`, `runById` = queue step `trainModel`, `weekly` = daily step `engineTrain`), `ModelParams`, `TIERS` |
| `score.ts` | v5.5.0: `Scorer` (`score`, `activeModel`, live registry asks inside `SCORE_LIVE_BUDGET_MS`; v5.14.0: the token-index cache key follows `max(engine_uploads.id)`) |
| `lift.ts` | v5.47.0 (F5): the pure lift model: `binOf`, `trainBins`, `scoreLift`, `seedWeight`, `inHoldout`, `liftAuc`, `crossValidatedAuc`, `parseSeed`, constants (`LIFT_CAP`, `LIFT_MIN_OWN_PER_CLASS`, `LIFT_SEED_FADE_ROWS`, `LIFT_MIN_BIN_ROWS`) |
| `lift-train.ts` | v5.47.0: `LiftTrainJob` (daily step `liftTrain`), `trainLift` (seed + own rows blend, holdout AUC), `loadOwnLiftRows`, `liftInputFor`, `loadLiftModel`, `liftTable`, `loadLiftSeed` (`data/lift-seed/cr002.jsonl`, built by `scripts/build-lift-seed.ts`), `liftView` (GET /engine/lift) |
| `reasons.ts` | v5.5.0: plain-English reason texts from the logistic contributions |
| `model/gbm.ts`, `logit.ts`, `metrics.ts`, `rng.ts` | v5.5.0: histogram gradient boosting (binary and softmax), L2 logistic regression (IRLS), AUC / bootstrap / precision / quantiles, seeded randomness; pure, no dependency |

Tables: `lift_models` (v5.47.0, append-only, migration `1767200000000_v5-47-0.sql`, in the backup), `engine_uploads`, `engine_sales`, `engine_unsold` (append-only), `engine_auction_ends` (v5.50.0, P6: the middle label class, append-only, migration `1767500000000_v5-50-0.sql`, filled by datasave `engineFeed`, not in the backup), `engine_endings` (migration `1763800000000_v5-4-0.sql`; v5.5.0 adds tld `com`), `engine_models` (migration `1763900000000_v5-5-0.sql`, which also adds queue job kind `train`), `owned_ending_events` (v5.7.0, append-only, migration `1764000000000_v5-7-0.sql` which also adds `engine_endings.registrar`; `/report` `ENDING_REGISTERED` reads it in `reporting/report/warnings.ts`); none in the backup, none in retention. Tests: `tests/modules/engine/` (v5.46.0: `com_age_years` is whole years, FX546-7 in `features`; `uploads` EN-1..EN-10, `endings` EN-11..EN-20, `model-math` EN-21..EN-30, `features` EN-31..EN-38, `train` EN-40..EN-52, `score` EN-60..EN-70, `health` EN-80..EN-89 (EN-88/89: hold-time slices), `owned-endings` EN-90..EN-99; helper `tests/helpers/engine-data.ts`); step order in `tests/modules/ops/jobs.test.ts`.

### data
v5.12.0 (CR-063), its own module since v5.15.0. Research data tables loaded by bots. Imports `engine` (`bulk.ts` skeleton and validators, the holdout date) and `candidates` (`candidatePoolHosts`); only `app.ts` and `ops` (retention) import it.

| Route | File |
|---|---|
| POST/GET /data/rdap, /data/live-checks, /data/tm-kills, /data/bigco-names, /data/sales-comps (WRITE or `data` loads, READ reads, `stale` flag on rdap) | `data/api/data.ts` (`registerData`, called from `src/app.ts`; every POST is `registerBulkRoute`) |

| File | Inside |
|---|---|
| `tables.ts` | `loadRdap`, `loadLive`, `loadTmKills`, `loadBigcoNames`, `loadSalesComps` (row parsers per table), `readData`, `dataRowCounts`, `pruneDataTables` (called by `ops/jobs/retention.ts`) |

Tables: `domain_rdap`, `live_checks` (both pruned by `pruneDataTables`), `tm_kills`, `bigco_names` (append-only), `sales_comps` (migration `1764500000000_v5-12-0.sql`; none in the backup). Tests: `tests/modules/data/` (`data-tables` DT-1..DT-10); scope tests `tests/modules/http/data-scope.test.ts`.

### market
v5.23.0 (CR-075). Episodes, labels, sale reports, matched sets, data-quality checks. Imports no other module (reads the datasave tables through Kysely); `ops` (the datasave job steps `episodes`, `dqMarket`) and `app.ts` import it. Rules and test ids: `docs/internal/market.md`.

| Route | File |
|---|---|
| POST /data/sales (bots/WRITE/data, add-only), PUT/PATCH/DELETE /data/sales[/{id}] (405 `APPEND_ONLY`), GET /market/episodes, /market/matched, /market/dq, /market/coverage, GET /auctions/live (v5.37.0) | `market/api/market.ts` (`registerMarket`, called from `src/app.ts`) |

| File | Inside |
|---|---|
| `episodes.ts` | `runEpisodes` (derive + label + write, idempotent), `labelUnsold`, `GAP_DAYS`, `SALE_WINDOW_DAYS` |
| `sales.ts` | `parseSale`, `loadSales` (v5.42.0: stored keys looked up with `unnest` in chunks of 5,000, multi-row inserts of 1,000), `SalesBody` |
| `matched.ts` | `buildMatched`, `matchedSet` (frozen sets; v5.25.0: `MATCHED_ASOF_FUTURE`, empty sets not stored), `newestSealedDay` |
| `dq.ts` | `runDqMarket`, `latestDq`, thresholds |
| `auctions-live.ts` | v5.37.0: `AuctionsLiveQuery`, `listAuctionsLive` (GET /auctions/live over `godaddy_auctions_live`) |
| `coverage.ts` | `coverage`, `TARGETS` |
| `read.ts`, `common.ts` | `listEpisodes`, `episodeOut`, `CLEAN_FEATURES`; `bandOf`, `episodeId`, `normalizeName` |

Tables: `market_names`, `market_sales` (append-only), `market_dq_runs`, `market_matched_sets` (append-only), migration `1765500000000_v5-23-0.sql`; none in the backup. Health/report: `reporting/market-dq-state.ts` (`marketDqStatus`), `ops/api/health.ts` (`dq_market`), `reporting/report/warnings.ts` (`DQ_MARKET_FAIL`). Tests: `tests/modules/market/market.test.ts` (MK523-1..22, MK525-1..3), `tests/modules/market/auctions-live.test.ts` (MK537-1..3). v5.37.0: table `godaddy_auctions_live` (not in the backup), written by `ops/jobs/datasave/datasave.ts` `parseAuctions`.

### knowledge
v5.43.0 (CR-078, G-132). The evidence base and plain-code verdicts, no AI. Imports no other module (only `core`, `http`, `db`); `ops` (daily step `kbLoad` via `KbLoadJob`) and `app.ts` (`registerKnowledge`) import `knowledge/index.ts`. Rules, formulas and test ids: `docs/internal/knowledge.md`.

| Route | File |
|---|---|
| POST /kb/sources, /kb/authors, /kb/claims, /kb/evidence, /kb/links, /kb/questions (bulk, all-or-nothing, WRITE / bots / data); GET /kb/questions, /kb/questions/{id}/verdict, /kb/claims, /kb/sources, /kb/recheck, /kb/echo-candidates | `knowledge/api/kb.ts` (`registerKnowledge`, called from `src/app.ts`) |

| File | Inside |
|---|---|
| `rows.ts` | zod strict row schemas of the six kinds (`SCHEMAS`), `KIND_ORDER`, `claimKeyOf`, `authorKeyOf`, `sourceCols` (canonical URL, hashes, MinHash) |
| `store.ts` | `applyKind` (parse, resolve natural keys, decide accepted / duplicate / superseded / rejected, insert), `writeKinds` (transaction + `kb_write` lock); `KB_ROWS_REJECTED` |
| `verdict.ts` | pure: `weightOf` (G x C x N x R x K), `clusterOf` (union-find), `computeVerdict` (agreement, weighted median, certainty steps) |
| `read.ts` | `loadItems` (newest rows as engine items), `clusterEdges`, `verdictFor` (compute + append `kb_verdicts` when changed), `recheckList`, `echoCandidates` |
| `settings.ts` | `activeKbSettings`, `KbValues` (zod), `halfLifeOf`, `GRADE_ORDER` |
| `url.ts`, `minhash.ts` | `canonicalUrl`, `urlHash`, `sha256`; `minhashOf`, `estimatedJaccard`, `candidatePairs` |
| `load.ts` | `KbLoadJob` (step `kbLoad`), `parseKnowledgeFile`: `data/knowledge/*.jsonl`, once per sha256 |
| `data/knowledge/` (repo data, not code) | `0001-questions.jsonl` (25 decision questions), `0002-october-research.jsonl` (October 2026 research: 203 graded sources, 93 claims, 271 evidence rows, 22 links); a new research round adds a new numbered file. Test KB543-24 loads the shipped files. Tests use an empty folder by default (`tests/helpers/app.ts`) |
| `size.ts` | the DB size guard (a copy of the engine's, so the module imports no other module) |

Tables: `kb_settings` (v1 seeded by the migration), `kb_authors`, `kb_sources`, `kb_questions`, `kb_claims`, `kb_evidence`, `kb_source_links`, `kb_verdicts`, `kb_loads` (migration `1766800000000_v5-43-0.sql`; all in the backup). Scope: `/kb/` POSTs are in the data scope (`KB_PREFIX` in `http/auth.ts`) and `allowed` in `BOTS_ROUTES`; audit `elideRows` records `[n rows]`. Tests: `tests/modules/knowledge/unit/knowledge-pure.test.ts` (KB543-1..9), `tests/modules/knowledge/knowledge.test.ts` (KB543-10..22), `tests/unit/no-ai-knowledge.test.ts` (KB543-23); fixture `tests/fixtures/knowledge/0000-example.jsonl`.

### pickproof
v5.59.0 (CR-081): off by default (`settings.pickproof_enabled`, `pool.ts` `pickproofEnabled` / `PICKPROOF_OFF`); the historical replay (section ops, `docs/internal/replay.md`) replaced it.

v5.28.0 (CR-073). The pick-proof test mechanics: frozen daily pool, arms A/B1/B2/C1, seal, T30 labels, report. Imports `selection` (`closeoutNameChecker` for the two-word split) and `src/core` (`mt19937.ts`, `rdap.ts`); reads the datasave tables through Kysely; `ops` (datasave step `pickproofLabels`) and `app.ts` import it. Rules, the exact recipe and test ids: `docs/internal/pickproof.md`.

| Route | File |
|---|---|
| POST /pickproof/:date/picks (bots/WRITE), GET /pickproof/:date/manifest, GET /pickproof/:date/arms, GET /pickproof/:date/pool (v5.30.0), GET /pickproof/report | `pickproof/api/pickproof.ts` (`registerPickproof`, called from `src/app.ts`) |

| File | Inside |
|---|---|
| `pool.ts` | `buildPool`, `poolSha`, `ensureDay` (freeze), `getDay`, `lockDay`, `pickproofSettings` |
| `two-word.ts` | v5.33.0 (CR-073a PP-V2): `twoWordSplitV2`, `commonWords` (the frozen `data/wordlists/en-scowl-35-lower.txt`, sha256 checked on load) |
| `store.ts` | `postPicks`, `sealIfDue`, `manifest`, `armsView` |
| `draw.ts`, `recipe.ts` | `drawArm`, `seedOfPool`, `armSha`; frozen rule texts, `RECIPE_SHAS`, `ARM_CONSTANTS` |
| `labels.ts` | `pickproofLabels` (datasave step: RDAP T30 labels; v5.47.0: `shrinkPool` = a sealed day older than `pickproof_pool_keep_days` (1) keeps only its arm names; v5.42.0: cache read once, labels and cache answers written in batches) |
| `report.ts`, `stats.ts` | `report` (arms, comparisons, overlap rule); pure `fisherGreater`, `cmh`, `holm`, `permutationTest`, `normalSf` |

Tables: `pickproof_days`, `pickproof_pool`, `pickproof_arms`, `pickproof_picks_history` (append-only), `pickproof_labels`, settings columns `pickproof_*` (migration `1766000000000_v5-28-0.sql`; `pickproof_days.recipe_version` by `1766200000000_v5-33-0.sql`); none in the backup. The seeded MT19937 / Fisher-Yates (CR-008) lives in `src/core/mt19937.ts` (used by `selection/siblings.ts` and here). Tests: `tests/modules/pickproof/` (`pickproof` PP528-10..43), `tests/modules/pickproof/unit/stats.test.ts` (PP528-1..6).

### visits
v5.18.0 (CR-068): the $0 visitor counter (rules and test IDs `docs/internal/visits.md`). Imports `registrars` (URL forwards) and `listing` (`landerNameservers`); only `app.ts` imports it.

| Route | File |
|---|---|
| POST /visits/hit (visits token only, not audited per hit), POST /visits/import, POST /visits/settings (`enabled`, `token: "request"`), POST /visits/forward/:domain, GET /visits, GET /visits/weekly | `visits/api/visits.ts` (`registerVisits`, called from `src/app.ts`) |

| File | Inside |
|---|---|
| `store.ts` | `recordHit` (one upsert; cap 1,000 a day; v5.47.0: `suspect_hits`, `HUMAN_DAILY_MAX` 10 human a day, referrer top 10), `normalizeReferrerHost`, `isCountable`, `onAfternicNs`, `importAfternic`, `setVisitsEnabled`, `requestVisitsToken`, `readDaily`, `weekly` |
| `forward.ts` | `setForward` (approval, listed + Porkbun + not Afternic NS, read / delete / add the Porkbun URL forwards, `visit_forwards` row) |

Other files of the feature: `registrars/porkbun.ts` (`getUrlForwards`, `addUrlForward`, `deleteUrlForward`), `ops/admin/visits-token.ts` + `ops/admin.ts` (`visits-token-handoff [--done|--failed]`), `scripts/local-host/visits-token.sh` (called by `deploy.sh`), `api-proxy/src/index.ts` (`countingRedirect`, GET|HEAD `/r/<domain>`), `.github/workflows/deploy-api-proxy.yml` (sets the Worker secret `VISITS_TOKEN`), `http/auth.ts` (`VISITS_HIT_ROUTE`, scope `visits`, `/visits/import` in `DATA_ROUTES`), `http/audit.ts` (`UNAUDITED_POSTS`), `http/rate-limit.ts` (600 a minute for a visits token), `ops/jobs/retention.ts` (`visit_daily`, 400 days).

Tables: `visit_daily`, `visit_forwards`; `settings.visits_enabled`, `visits_token_request` (migration `1764900000000_v5-18-0.sql`; v5.19.0 `1765000000000_v5-19-0.sql` turns the counter on and requests the token; not in the backup). Tests: `tests/modules/visits/` (`visits` V518-1..V518-15, `token-handoff` V518-16..V518-18), `api-proxy/src/index.test.ts` ("counting redirect").

### selling
Offers (record, classify, outcome), sold records, offer stats.

| Route | File |
|---|---|
| POST /offers, POST /offers/:id/outcome, GET /offers, GET /report/offers | `selling/api/offers.ts` |
| POST /sold/:domain | `selling/api/sold.ts` |

| File | Inside |
|---|---|
| `offers.ts` | `OffersService` (`record` with `dry_run: true`, v3.7.0: classify and return the view, write no row/hold/dedupe), `validateOffer`, `offerView`, `snapshotAt`, `OFFER_BANDS` |
| `offer-rules.ts` | `classify`, `OFFER_SOURCES`, `BUYER_TYPES` (band and routing rules) |
| `offer-stats.ts` | `perDomainOffers` (v5.14.0: `{offers?, domainIds?}`), `offersByStrategy` (preloaded offers), `loadOffers`, `reportOffers` |
| `sold.ts` | `SoldService` (v4.0.0: optional `afterSold` callback, wired in `app.ts` to the SellerHub delist; checklist names venues the latest `venue_listings` row says are hand-listed), `VENUES`, `EVIDENCE_SOURCES` |

Tables: `offers`, `sales`; writes `domains`, `price_schedule`, `ledger_entries`. Tests: `tests/modules/selling/` (`offers`, `offers-dry-run`, `offer-stats`, `sold`), `tests/modules/selling/unit/offer-rules`; the table CHECKs and triggers are in `tests/modules/core/schema.test.ts`.

### reporting
Read-only reports: `/report`, portfolio, ledger, audit, job-run views.

| Route | File |
|---|---|
| GET /report, GET /report/pricing-review | `reporting/api/report.ts` |
| GET /portfolio, GET /portfolio/:domain, GET /ledger, GET /deals/:id, GET /audit | `reporting/api/reads.ts` |
| POST /ledger/costs, PUT/GET /portfolio/:domain/forward-costs, GET /costs/forward, GET /books.csv (v5.25.0, CR-070) | `reporting/api/books.ts` (`registerBooks`; logic `reporting/books.ts`; rules `docs/internal/books.md`) |

| File | Inside |
|---|---|
| `report/index.ts` | `buildReport` (v5.14.0: domains, offers and the Afternic pending set are read once and shared; the 8 parts run in `Promise.all`; `portfolioDetail` builds one domain with `perDomain(db, now, {domain})`) |
| `report/ownership.ts`, `report/ownership-summary.ts` | v5.58.0 (CR-079): `ownershipWarnings` (LISTING_RECORD_MISSING, LISTING_UNAPPROVED, OBSERVED_UNCONFIRMED, RECEIPT_POINTER_MISSING; called by `buildWarnings`), `OWNERSHIP_CODES`, `ownershipSummary` (read by `ops/jobs/portfolio-check.ts` for `alerts_n` / `by_code`); `portfolioRows` adds `receipt_ref`, `deal_id`; migration `1767800000000_v5-58-0.sql` (`venue_listings.approval_source`); tests `reporting/ownership-check` (CR079-AT1..7); rules `docs/internal/books.md` |
| `report/warnings.ts` | `buildWarnings` (every `/report` warning code; `LANDER_DOWN_ERROR_DAYS`; v5.50.0 (P8): active `visit_forwards` silence `NS_UNVERIFIED` and the `REGISTRAR_DRIFT` nameserver part, `DROP_FEED_IDLE_DAYS` 14 makes `DROP_FEED_STALE` info, `FLOOR_AUTO_ACCEPT` is plan-time only (`listing/pricing/plan.ts`); v3.9.0: `PURCHASE_UNRESOLVED_MINUTES`, `NEON_FREE_STORAGE_BYTES`, `DB_SIZE_WARN_PERCENT` (`PURCHASE_UNRESOLVED`, `DB_SIZE_HIGH`); v3.7.0: `LANDER_AWAITING_MARKETPLACE` until the first confirmed Afternic upload, which also starts the LANDER_DOWN clock; `AUTO_RENEW_ON`, `REGISTRAR_DRIFT` from `registrar_state_checks`) |
| `report/lifecycle.ts` | v4.0.0: `lifecycleWarnings` (`RENEWAL_DROP_SUGGESTED`, `SELL_BEFORE_DROP`, `HORIZON_DUE`, `DELIST_NEEDED`), `signalsFor` (offers, inquiries, lookalike rise) |
| `report/outcomes.ts`, `api/outcomes.ts` | v4.0.0: `GET /portfolio/outcomes`, `/monthly`, `/quarterly` (`outcomes`, `outcomesMonthly`, `outcomesQuarterly`) |
| `report/lines.ts` | v5.8.0 (CR-059): `reportLines` (`/report` `lines`: Line 1 = `domains.lane` NULL, Line 2 = `S8`; names, spend, sales, pnl, committed renewals) |
| `report/money.ts`, `portfolio.ts` (`portfolioDetail` adds `registrar_state`, v3.7.0), `domains.ts` (`loadReportDomains`, `perDomain` with shared rows or one name, `applied7d` in two statements), `upcoming.ts`, `pricing-review.ts`, `markdown.ts` | report sections; `ledgerRows`, `ledgerCsvRows`, `usdSigned`, `csvSafeText` (G-98, 5.16.0) in `portfolio.ts` |
| `books.ts` | v5.25.0 (v5.42.0: `postCosts` inserts in chunks of 1,000): `postCosts`, `parseForwardBody`, `putForwardCosts`, `forwardCostHistory`, `forwardCosts`, `booksRows`, `DERIVED_FIELDS`; the shared renewal rule is `unrenewedLiveNames` / `dropsAtFirstExpiry` in `report/money.ts` |
| `job-runs.ts` | `jobRunsView`, `jobsOverdue`, `dailyScheduleState`, `stepView`, `triggerFromKey` |

Tables: `forward_cost_plans`, `forward_cost_lines` (v5.25.0, append-only, versioned plan per domain, in the backup; migration `1765700000000_v5-25-0.sql`); otherwise reads all. Tests: `tests/modules/reporting/` (`books` (v5.25.0: BK525-1..13), `report-core`, `report-warnings`, `reads`, `pricing-review`, `forecast`, `drop-feed-stale`, `keyword-keep-signal` (v4.2.0), `ledger-csv-formula` (L516-1)); the schedule view is also in `tests/modules/ops/jobs.test.ts`, `missed-runs`.

### outreach
Outreach email log, company documents, forbidden-term block list. (X posting through Buffer was removed in 5.2.0, CR-057.)

| Route | File |
|---|---|
| POST /outreach/emails, GET /outreach/emails/summary (v4.0.0, CR-045 item 5) | `outreach/api/emails.ts` (`registerEmails`; cap `outreach.max_emails_per_name`; table `outreach_emails`) |
| POST /company/document, GET /company/document/versions(/:n), POST/GET /company/forbidden-terms, POST /company/forbidden-terms/:id/retire | `outreach/api/company.ts` |

| File | Inside |
|---|---|
| `diff.ts` | `unifiedDiff` (company document versions) |
| `blocklist.ts` | `checkText` (secret/email/phone/forbidden term) |

Tables: `company_documents`, `forbidden_terms`, `forbidden_term_retirements`, `outreach_emails` (v4.0.0). Tests: `tests/modules/outreach/` (`emails` (EM-1..EM-6), `blocklist`, `blocklist-redos`, `company-document`, `company-terms`), `tests/unit/no-llm`.

### ops
Jobs and queue, health, admin CLI, backup.

| Route | File |
|---|---|
| POST /jobs/run, GET /jobs/runs, POST /jobs/preview | `ops/api/jobs.ts` |
| POST /auctions/prebid, POST /auctions/plans, POST /auctions/plans/:id/result, GET /auctions/plans, GET /auctions/plans/:id, GET /auctions/shortlist and GET /auctions/funnel (v5.45.0, G-127) (v5.39.0, CR-077; rules `docs/internal/auctions.md`) | `ops/api/auctions.ts` (`registerAuctions`, called from `src/app.ts`; plan logic `ops/auctions/plans.ts`: `createPlan`, `recordResult`, `listPlans`, `getPlan`, `importPlanFor`, `markImported`, `amountsNamed`; the automatic checks are `selection/prebid.ts` `runPrebidChecks`; the S8 import rule is in `ops/api/portfolio-import.ts` and `ops/admin/import-domain.ts` (`enforceBidPlan`, `bidPlan`)) |
| GET /candidates/closeouts (v5.26.0, CR-072: ranked closeout and drop candidates, read-only; stored filters and scores from the `scorePool` step) | `ops/api/closeouts.ts` (`registerCloseouts`, called from `src/app.ts`; filters `ops/closeouts/filters.ts`; scoring step `ops/closeouts/score-pool.ts`; name filters `selection/closeout-name.ts`; offline score `engine/score.ts` `Scorer.scoreOffline`). Tests `ops/closeouts` (CC526-1..13); doc `docs/internal/closeouts.md` |
| GET /rdap/:domain, POST /rdap/batch (read-only POST; tables `rdap_cache`, `lookup_usage`, migration `1766100000000_v5-29-0.sql`, none in the backup), GET /lookups/usage (v5.29.0, CR-074) | `ops/api/lookups.ts` (`registerLookups`; cache and limit in `src/core/rdap-cache.ts`; rules `docs/internal/lookups.md`) |
| GET /snapshots, GET /snapshots/missing (v5.21.0, CR-071), POST /snapshots/dynadot (v5.22.0, bot uploads of Dynadot rows) | `ops/api/snapshots.ts` (`registerSnapshots`; state in `reporting/datasave-state.ts`; upload service and schemas in `ops/jobs/datasave/dynadot-upload.ts`) |
| GET /health/ping, GET /health (v5.20.0, BUG-047: `jobs` also overdue by a stale tick, `jobs_last`; `reporting/job-runs.ts` `tickOverdue`, `lastJobRunAt`) | `ops/api/health.ts` |
| POST /tokens/bots/rotate (v5.20.0, CR-069: the shared `bots` token, see `docs/internal/bots-token.md`) | `ops/api/tokens.ts` (`registerTokens`) |
| POST /portfolio/import (v5.8.0, CR-059: S8 / Line 2 aftermarket import; approval_ref, cap `settings.s8_max_price_cents`, BIN from the S8 ladder `s8LadderBin` in `listing/pricing/plan.ts` (v5.9.0, CR-060: `settings.s8_bin_ladder`, `bin_override` / `floor_override` named in the approval, S8 exempt from the price list, no M6/M18 drops via `buildSchedule` `lane`); logic is `importDomain` with `lane: 'S8'`; test ids S8-1..S8-19) | `ops/api/portfolio-import.ts` (`registerPortfolioImport`, called from `src/app.ts`) |
| POST /portfolio/:domain/horizon, POST /portfolio/:domain/stats (v4.0.0), POST /portfolio/:domain/renewal-price (v5.20.0, BUG-047; columns `domains.renewal_price_source`, `renewal_price_as_of`) | `ops/api/portfolio.ts` (`registerPortfolioWrites`; horizon reuses `admin/drop-date.ts` `dropAtFirstExpiry`; tables `portfolio_stats`) |

| File | Inside |
|---|---|
| `jobs/runner.ts` | `JobRunner.plan(job)` = the step list for `tick`, `daily`, `screen`, `train` (v5.5.0: step `trainModel`; daily gets `engineTrain` last); `STEP_ATTEMPTS`, `STEP_TIMEOUT_MS`, `classify` |
| `queue.ts` | `JobQueue` (Postgres queue: enqueue, claim, run step by step, keepalive; v3.9.0: a skipped retry after a timeout is marked failed) |
| `job.ts` | `npm run job` CLI |
| `cli.ts` | v5.15.0: `withDb` (config + pool lifetime), `exitWith` (exit codes, usage errors), `UsageError`; shared by `job.ts` and `admin.ts` |
| `jobs/price-schedule.ts`, `drop.ts`, `registrar-check.ts`, `portfolio-check.ts`, `drop-watch.ts`, `ns-verify.ts`, `cohort-outcomes.ts`, `reference-refresh.ts` | `PriceScheduleJob` (step `priceJob`), `DropJob`, `RegistrarCheckJob`, `PortfolioCheckJob`, `DropWatchJob`, `NsVerifier` (`runOnce({onlyUnverified})`: the runner calls it for never-verified names even after the day's run, v3.7.0), `CohortOutcomesJob`, `ReferenceRefreshJob`; `RegistrarCheckJob` also appends `registrar_state_checks` (auto-renew, privacy, NS of Porkbun names, read-only) |
| `jobs/listing-sync.ts`, `sellerhub.ts` | v4.0.0 (CR-049): `ListingSyncJob` (step `listingSync`; `delist(domain)` is also called after `/sold`) and `SellerHubClient` (Spaceship SellerHub REST, headers X-API-Key / X-API-Secret, env `SPACESHIP_SELLERHUB_API_KEY` / `_SECRET`; tests mock it with MSW only); table `listing_sync_log` |
| `jobs/portfolio-lifecycle.ts` | v4.0.0: `PortfolioLifecycleJob` (step `portfolioLifecycle`): expired unrenewed names, lookalike re-check in the renewal window, monthly holdout and its re-check (table `holdout`); uses `selection` `screenedNames` / `rerunLookalikes` (`selection/portfolio-support.ts`) |
| `admin/record-renewal.ts` | v4.0.0 (G-85): `recordRenewal` (admin `record-renewal`: `renewal` ledger row, `renewals_used` 1, expiry + 1 year, POC cap) |
| `jobs/portfolio-check.ts` | v4.0.0: the lander check reads `https://`, follows 3 redirects, a TLS failure is a miss, `landerPriceCheck` (kind `price`); v5.44.0: the registry check also sets `domains.transfer_confirmed` / `transfer_checked_at` of an S8 name until true (`registrarMatches` is in `core/rdap.ts`; import side in `ops/admin/import-domain.ts`, warning `S8_TRANSFER_UNCONFIRMED` in `reporting/report/warnings.ts`; migration `1766900000000_v5-44-0.sql`; tests `ops/safety-checks` SF544-15..18) |
| `closeouts/expiries.ts` | v5.49.0 (P1): `collect` keeps at most `closeout_expiry_collect_max` new names a run by `md5Of(domain)`, `stale_deleted_n`. v5.47.0 (F19): regime-only collection, `deleteOutOfRegime`, decided rows deleted after `closeout_expiry_keep_days`. v5.46.0: `checkExpiries` (collect ended closeout names from the pool into `closeout_expiries`, RDAP checks after the end date with what `tagDisappearances` left of the shared cap), `expiryTagOf` (the rule), `RENEWED_MIN_DAYS`; called by `buildPanel` (summary `expiries`); `engineFeed` feeds the `dropped` rows to `engine_unsold` (`fed_at`). Table `closeout_expiries` and `settings.closeout_expiry_*` (migration `1767100000000_v5-46-0.sql`, not in the backup); rules `docs/internal/closeouts.md` "Closeout expiries", `datasave.md` 30-33; tests `ops/closeout-expiries` (FX546-1..6) |
| `closeouts/disappearances.ts` | v5.34.0 (BUG-052): (v5.42.0: cache read once, 4 live lookups at a time through the Verisign `hostPacer` after a first lone probe, tag updates in batches of 300, `TAG_CONCURRENCY`) (v5.41.0: `TagDeps.regime` puts in-regime names first in the daily RDAP cap) `tagDisappearances` (collect gone closeout names and DISAPPEARED episodes, RDAP tag bought / deleted / unknown, prune), `tagOf` (the rule), `goneByTag`, `FEED_REGISTRAR`; called by `buildPanel`. Table `disappearances`, settings `disappearance_lookups_max_per_run` / `disappearance_keep_days` (migration `1766300000000_v5-34-0.sql`, not in the backup); rules `docs/internal/datasave.md` "Disappearance tags"; tests `ops/disappearances.test.ts` (BG052-1..8) |
| `jobs/datasave/` | v5.21.0 (CR-071): the `datasave` job (job kind `datasave`, lock `job:datasave`, plan in `jobs/runner.ts`, wired in `src/app.ts`). `datasave.ts` `DatasaveJob`: steps `godaddyInventory` (official inventory host, manifests, raw zips under `SNAPSHOT_DIR`, streams only `closeout_listings` into `datasave_pool`), `dynadotCloseouts` / `dynadotAftermarket` (`not_configured` stubs), `scorePool` (v5.26.0, CR-072: calls `closeouts/score-pool.ts`), `buildPanel`, `engineFeed` (v5.41.0: `engine_unsold` from deleted-tagged closeout names and `engine_sales` from ended GoDaddy auctions with a bid, through `engine/index.ts` `storeUnsold` / `storeSales`; setting `datasave_auction_min_cents`, migration `1766700000000_v5-41-0.sql`; tests `ops/engine-feed.test.ts` EF541-1..8), `auctionShortlist` (v5.45.0, G-127: calls `ops/auctions/shortlist.ts` `runAuctionShortlist`, between `engineFeed` and `pickproofSeal`; `DatasaveDeps.screening`), `snapshotRetention` (also deletes `auction_shortlist` rows past `settings.shortlist_keep_days`); `zip.ts` (streaming zip reader), `json-stream.ts` (streaming `{data:[...]}` reader). Retry: `ops/queue.ts` `retryDatasave` + `job_queue_runs.not_before`. Schedule `.github/workflows/datasave.yml`. Tables `snapshot_manifests` (sealed), `datasave_pool`, `settings.datasave_*`. v5.22.0: `parseAuctions` (the four auction files into `godaddy_auctions`, endings in `auctionSummary`), `dynadot-upload.ts` (`uploadDynadot`, `DynadotBody`, sha256), tables `dynadot_rows`, `godaddy_auctions`, `snapshot_manifests.origin`. v5.28.0 (CR-073): the last step `pickproofLabels` calls `pickproof/labels.ts`. v5.35.0: step `pickproofSeal` (after `buildPanel`, before `snapshotRetention`) calls `pickproof/store.ts` `autoSeal`. Rules and test ids: `docs/internal/datasave.md`; tests `ops/datasave.test.ts`, `ops/datasave-dynadot.test.ts` (DS522-1..15, DS524-1..2, DS532-1; v5.37.0 `parseAuctions` also fills `godaddy_auctions_live`, DS537-1..4 in `ops/datasave.test.ts`; v5.32.0 `ROWS_LIMIT` / `PRICE_CAP` in `ops/api/snapshots.ts` `parseDynadot`), `ops/unit/datasave-stream.test.ts` (DS521-1..19) |
| `auctions/adult-terms.ts` (v5.47.0, F20: `adultFilter`, `ADULT_WORDS`, `ADULT_STEMS`; used by the shortlist), `auctions/person-names.ts` (v5.56.0: `personName`, the PERSON_NAME filter; lists `data/wordlists/given-names-census1990.txt`, `surnames-census2010.txt`; test `ops/unit/person-names`), `auctions/plans.ts`, `auctions/prebid-store.ts`, `auctions/shortlist.ts` (v5.47.0: lift table scoring, `auction-v3`; v5.49.0: `auction-v4`, field position, paper trading calls), `auctions/shortlist-score.ts` (v5.47.0: `lift` input, `BIDS_WEIGHT_V3`; v5.49.0: `v4` input, `WEIGHTS_V4`, `demandValue`, `fieldPercentile`), `auctions/outcomes.ts` (v5.49.0, P4: `updateOutcomes`, `recordOutcomes`, `pickControl`; table `auction_outcomes`), `jobs/datasave/auction-fields.ts` (v5.49.0, P3: `demandFields`, `mergeDemand`: the free demand fields of the GoDaddy rows) | v5.39.0 `plans.ts` (bid plan logic). v5.45.0 (G-127): `prebid-store.ts` = `storePrebid` (runs `runPrebidChecks`, stores the `prebid_checks` row; used by `POST /auctions/prebid` and the shortlist step) and `manualRequired` / `manualSearches`; `shortlist-score.ts` = the pure auction score (v5.46.0: auction-v2 with word quality, graded shape, the uncommon-word cap and `SCORE_FULL_MAX` 85; `scoreAuction`, `maxBidRule`, `seoFlag`, `AUCTION_SCORE_VERSION`), `word-quality.ts` (v5.46.0: `wordLevel`, `nameQuality`, from the frozen split classes and the SCOWL 35 list); `shortlist.ts` = `runAuctionShortlist` (datasave step `auctionShortlist`: candidates from `godaddy_auctions_live`, hard filters, brand typo, endings via `engine/index.ts` `askEndingsFor`, rank, automatic pre-bid, store in `auction_shortlist`), `getShortlist` (GET /auctions/shortlist), `getFunnel` (GET /auctions/funnel). Table `auction_shortlist` and `settings.shortlist_*` (migration `1767000000000_v5-45-0.sql`, not in the backup; v5.48.0 migration `1767300000000_v5-48-0.sql` adds `settings.shortlist_sale_chance_bp` / `shortlist_renewal_cents` for the expected-value maximum bid and `auction_shortlist.field_n`). Rules and test ids: `docs/internal/auctions.md` "Shortlist"; migration `1767400000000_v5-49-0.sql` (v5.49.0): `auction_outcomes`, the five demand columns of `godaddy_auctions_live`, `settings.closeout_expiry_collect_max`, renewal 2300, pool keep 2, drops index `datasave_pool_domain`; tests `ops/auction-shortlist` (AS545-5..22, AS548-1, AS549-10..14), `ops/unit/shortlist-score` (AS545-1..4, AS546-1..4), `ops/unit/auction-v4` (AS549-1..5), `ops/datasave` (AS549-6), `ops/closeout-expiries` (AS549-7..9) |
| `jobs/retention.ts` | v5.1.0 (G-95): `RetentionJob.runOnce({dryRun?})` (step `retention`, before `backupExport`), `RETENTION_RULES` (ages normal / tight per table; v5.14.0: also `drop_list_checks`, `drop_list_rows`, `drop_lists` (pk `name`), `daily_candidate_lists`, `namebio_calls`, `listing_sync_log`; the evidence rule builds its referenced-id set once per run in a temp table on one connection, `withEvidenceRefs`), batches of 5,000 in one transaction each with `set_config('app.retention','on',true)` (the only place that sets it; migration `1763500000000_v5-1-0.sql` makes `reject_mutation_except_retention()` allow a DELETE then on `screening_results`, `screening_evidence`, `candidate_screenings`, `sibling_scans`, `job_runs`, `registrar_state_checks`; migration `1764700000000_v5-14-0.sql` adds `drop_list_checks`, `drop_list_rows`, `drop_lists`, `daily_candidate_lists`, `listing_sync_log`), 60 s budget, size from `pg_database_size` vs `NEON_FREE_STORAGE_BYTES` / `DB_SIZE_WARN_PERCENT` (exported by `reporting`). Tests `tests/modules/ops/retention.test.ts` (RT-1..RT-12). No route; only runs inside the daily job |
| `jobs/backup-export.ts`, `backup-import.ts` | `BackupExporter`, `TABLE_FILES`, `ORDER`, `migrationNames` |
| `admin.ts`, `admin/*.ts` | admin CLI (`npm run admin`): `tokens`, `pricing-settings`, `import-domain`, `drop-date`, `resolve-purchase`, `doctor` |

Daily step order (`runner.ts`): reconciler, nsVerifier, screeningResume, priceJob, dropJob, listingSync, portfolioLifecycle, registrarCheck, portfolioCheck, dropWatch, intakeScreening, buildDailyList, cohortOutcomes, referenceRefresh, kbLoad (v5.43.0), retention, backupExport. `tick` = first three (5.53.0: the outside review and its steps `outsideReview`, `reviewRetry` were removed). `screen` = onDemandScreen + buildDailyList.

Tables: `prebid_checks` (append-only), `bid_plans`, `bid_plan_events` (append-only), all three in the backup, and `settings.s8_closeouts_allowed` (v5.39.0, CR-077, migration `1766600000000_v5-39-0.sql`; tests `ops/auction-plans`); `job_runs`, `job_steps`, `job_queue_runs`, `portfolio_checks`, `cohort_outcomes`, `drop_list_checks`, `api_tokens`, `registrar_presence`, `registrar_state_checks` (v3.7.0, append-only, in the backup), `pricing_settings` (admin). Tests: `tests/modules/ops/` (`jobs*`, `job-queue`, `job-cli`, `jobs-run-scope`, `daily-schedule`, `daily-run-cohorts`, `tick-triggers`, `missed-runs`, `price-job`, `drop-job`, `drop-date`, `drop-watch`, `drop-watch-idt`, `cohort-outcomes`, `ns-verify`, `ns-verify-new-names`, `portfolio-check`, `lander-awaiting`, `registrar-check`, `registrar-check-fields`, `admin-cli`, `admin-tokens`, `import-domain`, `backup`, `health`, `renewal-price`, `datasave`), `tests/modules/ops/unit/` (`jobs-runner-config`, `backup-coverage`, `datasave-stream`). v4.0.0: `listing_sync_log` (append-only), `holdout`, `portfolio_stats` (append-only, written by `ops/api/portfolio.ts`), `outreach_emails`, `sales_pattern_uploads`, `sales_pattern_rows` (append-only); `domains` gains `horizon`, `sell_or_drop_by`, `screening_group`, `buy_card`; `portfolio_checks` kinds `price`, `lookalikes`.

### core (`src/core/`)
Shared helpers, no module imports (`tests/unit/core-boundaries.test.ts`).

| File | Inside | Test |
|---|---|---|
| `dates.ts` | IDT days, `idtDay`, `addDays`, `toJerusalemIso`, `jerusalemDeep`, zod `ymd`/`isoWithOffset` | `core/unit/dates`, `time`, `time-jerusalem-deep` |
| `money.ts` | cents <-> USD, `pair('x', cents)` -> `x_cents` + `x`; 5.13.0: `apiCents(n, field, status?)` (the one request-amount to cents helper with its 422/400 VALIDATION_ERROR) and `usdSigned` | `core/unit/money` |
| `approval.ts` | `checkApproval`, `checkTimedApproval`, `namesToken` (72 h rule) | `core/unit/approval` |
| `validation.ts` | `approvalRef` zod, `assertNoteNoPii`, `piiError` | via api tests |
| `redact.ts` | `redact`, `scrubSecrets` | `core/unit/redact` |
| `locks.ts` | `withDomainLock`, `withDomainLocks` (v5.14.0: many names on one connection, sorted, one deadline; used by the export confirm), `withAdvisoryLock`, `trySessionLock` | `selection/r1b-locks`, `listing/list-concurrency` |
| `rdap-cache.ts` | v5.29.0 (CR-074): the shared RDAP cache (`rdap_cache`), v5.42.0: `cachePutMany` (multi-row upsert), `lookupFromCache`, `cacheGetMany` in chunks; `cachedRdapLookup` (pickproof labels, portfolio check), `reserveSlots` / `readUsage` (the rolling 24 h bot limit, `lookup_usage`); `lookupCached` in `selection/rdap-batch.ts` fills it | `ops/rdap-lookups` |
| `rdap.ts`, `ns-lookup.ts`, `safe-fetch.ts` | RDAP, DNS NS lookup, SSRF-safe fetch (`safeFetch`) | `core/unit/rdap*`, `ns-lookup`, `dns-query`, `safe-fetch*` |
| `tokens.ts` | `generateToken`, `hashToken` | `core/unit/tokens` |
| `chunks.ts` | `chunks` (bulk insert and `in (...)` pieces) | none |

### http (`src/http/`)
Tables: `audit_log` (append-only) and `idempotency_keys`, written by the hooks below.

| File | Inside | Test |
|---|---|---|
| `auth.ts` | `registerAuth` (bearer tokens, job token), `registerScope` (READ/WRITE/intake/data/visits/bots), `BOTS_ROUTES` (v5.20.0: every mutating route classified allowed / money / write_only; unlisted = money), `INTAKE_ROUTES`, `DATA_ROUTES`/`DATA_PREFIX` (v5.10.0), `PUBLIC_PATHS` | `http/auth`, `token-expiry`, `http/data-scope`, `http/bots-scope` (B520-1..8) (DS-1..DS-6) |
| `idempotency.ts` | `registerIdempotency`, `requestHash`, `pruneIdempotencyKeys` | `http/idempotency`, `idempotency-hygiene`, `http/unit/canonical-json` |
| `audit.ts` | `registerAuditId`, `registerAuditWrite`, `dbAuditWriter`, `writeJobAudit` (v5.15.0: the one writer of job, queue and CLI audit rows), `elideArrays` (v5.14.0, D2: an array over 50 items is stored as `[N items, sha256:<hex>]`; AL-4) | `http/audit`, `audit-token`, `timestamps` |
| `db-stats.ts` | v5.40.0 (G-125): `registerDbScope` (onRequest, first) and `registerDbStatsLog` (onSend, last): `db_queries`, `db_ms`, `db_top` on the "request completed" log line; counter in `src/core/db-stats.ts` (`withDbScope`, `recordQuery`, `stepDb`), hooked in `src/db/client.ts`; step record `db` via `ops/queue.ts` and `reporting/job-runs.ts` `stepView`; report `scripts/traffic-report.ts` (`npm run traffic`) | `ops/db-stats` (DQ540-5..6), `ops/unit/db-stats` (DQ540-1..4), `unit/traffic-report` (TR540-1..3) |
| `errors.ts` | `AppError`, `errorBody`, `registerErrorHandling` | `http/errors` |
| `rate-limit.ts` | `registerRateLimit` | `http/rate-limit`, `rate-limit-replay`, `http/unit/rate-limit` |
| `openapi.ts` | `SUMMARIES` map, `collectOpenApiRoutes`, `buildOpenApi`, `registerOpenApi` | `contract/contract-doc`, `http/openapi`, `openapi-schema` |
| `canonical-json.ts`, `methods.ts` | request hashing, method list | `http/unit/canonical-json` |

### db (`src/db/`)
`client.ts` (pool max 20 since v5.14.0: `/report` runs its parts together; `createDb` with a `log` option, `pingDb`, `poolConfig`; v3.9.0: `attachPoolErrorHandler`, pool connection/idle timeouts), `types.ts` (Kysely `Database` interface, one table type per table; about 1,050 lines, hand-written). Migrations: `migrations/<epoch-ms>_<name>.sql`, plain SQL for node-pg-migrate, ordered by the numeric prefix (latest `1767900000000_v5-59-0.sql`: `settings.pickproof_enabled`, `replay_day_runs` (then `1767800000000_v5-58-0.sql`, `1767700000000_v5-53-0.sql`); before them `1767600000000_v5-52-0.sql`: drops `settings.s8_reserved_slots`, the 40 slots are shared; before it `1767400000000_v5-49-0.sql`: `auction_outcomes`, demand columns of `godaddy_auctions_live`, `closeout_expiry_collect_max`; before it `1767300000000_v5-48-0.sql`, `1767200000000_v5-47-0.sql`; before them `1767100000000_v5-46-0.sql`: `closeout_expiries` and `settings.closeout_expiry_*`; before it `1767000000000_v5-45-0.sql`: `auction_shortlist` and `settings.shortlist_*`; before it `1766900000000_v5-44-0.sql`; before it `1766800000000_v5-43-0.sql`: the nine `kb_*` tables and `kb_settings` v1; before it `1766700000000_v5-41-0.sql`: `settings.datasave_auction_min_cents`; before it `1766600000000_v5-39-0.sql`; before it `1766500000000_v5-37-0.sql`: `godaddy_auctions_live`, `settings.datasave_auction_live_keep_days` / `datasave_auction_live_min_bids`; before it `1766400000000_v5-36-0.sql`, `1766300000000_v5-34-0.sql`; older: `1765500000000_v5-23-0.sql`: `market_names`, `market_sales`, `market_dq_runs`, `market_matched_sets`; before it `1765400000000_v5-22-0.sql`: `dynadot_rows`, `godaddy_auctions`, `snapshot_manifests.origin` and source `dynadot_closed_auctions`, `settings.datasave_dynadot_keep_days` / `datasave_auction_keep_days`; before it `1765300000000_v5-21-0.sql`: job kind `datasave`, `job_queue_runs.not_before`, `settings.datasave_*`, tables `snapshot_manifests` and `datasave_pool`; before it `1765200000000_v5-20-1.sql` (data); before it `1765100000000_v5-20-0.sql`: scope `bots` (api_tokens and audit_log CHECKs), `audit_log.bot_name`, `domains.renewal_price_source` / `renewal_price_as_of`, deletes the `visit_daily` rows of 2026-10-19 (BUG-046); before the v5.18-v5.19 files, `1764800000000_v5-15-0.sql`: drops `namebio_tld_stats`; before it `1764700000000_v5-14-0.sql`: R3 indexes (`screening_results (run_id, item_idx)`, `(cached_from)`, `screening_packs (run_id)`, `domain_records (source_run_id)`, kept-only `drop_list_rows` indexes, `audit_log (path, at desc)`, GIN `screening_runs.input jsonb_path_ops` for the buy-hold lookup), the retention delete-carve-out on five more append-only tables, and the one-off cleanup of identical consecutive `engine_endings` rows; before it `1764600000000_v5-13-0.sql`: `screening_runs.cancel_reason` (M15); before it `1764500000000_v5-12-0.sql`: domain_rdap, live_checks, tm_kills, bigco_names, sales_comps (CR-063); before it `1764400000000_v5-11-0.sql`: namebio_keyword_stats, namebio_tld_stats, namebio_calls (CR-062); before it `1764300000000_v5-10-0.sql`: token scope `data` (api_tokens and audit_log CHECKs), `settings.engine_sales_max_date` (CR-061); before it `1764200000000_v5-9-0.sql`: `settings.s8_bin_ladder` (CR-060); before it `1764100000000_v5-8-0.sql`: `domains.lane` (NULL = Line 1, `S8` = Line 2), `settings.s8_max_price_cents`, `settings.s8_reserved_slots`; before it `1764000000000_v5-7-0.sql`: owned_ending_events; before it `1763900000000_v5-5-0.sql`: engine_models, tld com, job kind train; before it `1763800000000_v5-4-0.sql`: engine_uploads, engine_sales, engine_unsold, engine_endings; before it `1763400000000_v5-0-0.sql`: G-86 drops `settings.poc_cap_cents`, `tranches.spend_cap_cents`, `tranche_members.est_cost_cents`; before it `1763300000000_v4-2-0.sql`: keyword_demand_uploads, keyword_demand; before it `1763200000000_v4-1-0.sql` sibling_scans and `1763100000000_v3-11-0.sql`: cap 40, horizon / group / buy card columns, portfolio_stats, outreach_emails, holdout, sales patterns, listing_sync_log; one file per migration, `ls migrations`). Run with `npm run migrate`.

## 3. Where do I change X?

"Contract" below always means the doc set in section 4. `tests/unit/test-evidence.test.ts` fails if a documented error code has no test.

| Change | Code | Tests |
|---|---|---|
| Change the visitor counter (cap, referrers, weekly view, forward, token hand-off) | `visits/store.ts`, `visits/forward.ts`, `visits/api/visits.ts`, `api-proxy/src/index.ts`, `ops/admin/visits-token.ts`; contract `endpoints.md` (Visitor counter), `docs/internal/visits.md` | `visits/visits`, `visits/token-handoff`, `api-proxy/src/index.test.ts` |
| Change the keyword upload or the demand / companies inputs (v4.2.0) | `selection/demand.ts`, `selection/checks/demand.ts`, `selection/checks/companies.ts`, `selection/api/demand.ts`, settings `demand` / `companies` in `selection/settings.ts`, fixture `tests/fixtures/keywords/` (copy of the real export) | `selection/keyword-demand`, `selection/unit/keyword-demand`, `reporting/keyword-keep-signal` |
| Change the sibling scan (CR-050: endings, points, contact page) | `selection/sibling-scan.ts`, settings `siblings` in `selection/settings.ts` (`SIBLINGS_DEFAULT`), `selection/api/sibling-scan.ts` | `selection/sibling-scan`, `selection/unit/sibling-scan` |
| Add a field to POST /candidates/intake | `candidates/intake.ts` (`IntakeBody`, `takeIntake`; store column via migration), `candidates/api/candidates.ts` | `candidates/intake`, `intake-rules`, `screen`, `screen-domains`, `scout-split` |
| Add a field to a daily list entry | `candidates/daily-list.ts` (`DailyEntry`, `buildDailyList`, `buildWhy`) | `candidates/daily-list`, `daily-list-fields`, `daily-list-rejected`, `daily-list-rebuild` |
| Add a field to the daily list summary / sections | `candidates/daily-list.ts` (`DailyList`, `readDailyList`) | same |
| Add a cost row type, change the forward-cost plan or the books file (v5.25.0) | `reporting/books.ts`, `reporting/api/books.ts`, `BOTS_ROUTES` in `http/auth.ts`, `docs/contract/formats.md` §Books CSV, `docs/internal/books.md` | `reporting/books` |
| Change the pre-bid check, the bid plan rules or the S8 import plan rule (v5.39.0) | `selection/prebid.ts`, `ops/auctions/plans.ts`, `ops/api/auctions.ts`, `ops/api/portfolio-import.ts`, `ops/admin/import-domain.ts`, `BOTS_ROUTES` in `http/auth.ts`, migration `1766600000000_v5-39-0.sql` (`prebid_checks`, `bid_plans`, `bid_plan_events`, `settings.s8_closeouts_allowed`), `docs/internal/auctions.md` | `ops/auction-plans` (AB539-*), `buying/s8-import` (helper `tests/helpers/bid-plans.ts`) |
| Change the auction shortlist (candidates, filters, the auction score, the maximum bid, the automatic pre-bid, the funnel) (v5.45.0, G-127) | `ops/auctions/shortlist.ts`, `ops/auctions/shortlist-score.ts`, `ops/auctions/prebid-store.ts`, `engine/endings.ts` (`askEndingsFor`), `ops/api/auctions.ts`, migration `1767000000000_v5-45-0.sql` for the table and `settings.shortlist_*`, `docs/internal/auctions.md` "Shortlist", contract `endpoints.md` §`GET /auctions/shortlist` / `GET /auctions/funnel`, `jobs.md` row `datasave` | `ops/auction-shortlist` (AS545-5..22, AS549-10..14), `ops/unit/shortlist-score` (AS545-1..4, AS546-1..4), `ops/unit/auction-v4` (AS549-1..5); v5.49.0 also `ops/auctions/outcomes.ts`, `ops/jobs/datasave/auction-fields.ts`, migration `1767400000000_v5-49-0.sql` |
| Add a /report warning | `reporting/report/warnings.ts` (`buildWarnings`) + warning list in `docs/contract/reports.md` | `reporting/report-warnings`, `drop-feed-stale` |
| Add a /report section or number | `reporting/report/*.ts`, `report/index.ts` | `reporting/report-core`, `forecast` |
| Add a selection settings key | `selection/settings.ts` (zod `Base`, `DEFAULT_SELECTION_VALUES`; add to `LOCKED_PREFIXES` if founder-level), `docs/contract/selection.md` | `selection/unit/screening-settings`, `selection/selection-settings`, `selection-settings-v12`, `settings-intake-keys` |
| Add a tier input (feature) | `selection/settings.ts` (`TIER_FEATURES`), `selection/tier.ts` (`TierFeatures`, `condHolds`), the check that produces it, `selection/engine.ts` (`inputsOf`) | `selection/unit/screening-tier`, `selection/selection-v11`, `tier-lanes` |
| Add a clause op | `selection/settings.ts` (`OPS`, `Cond` zod), `selection/tier.ts` (`cmp`/`condHolds`) | `selection/unit/screening-tier`, `screening-settings` |
| Add a screening check | new `selection/checks/<id>.ts`; register in `checks/index.ts` (`CHECKS`, `GATE_OF`); `selection/settings.ts` (`CHECK_IDS`, gates per lane); `selection/types.ts` (`CheckId`); `selection/depends.ts`; `docs/contract/selection.md` | new `tests/modules/selection/screening-<id>.test.ts` (see `screening-same-name`), `selection/unit/screening-*` |
| Change what a screening pack requires | `selection/pack.ts` (`assessPack`, `requiredChecks`), `selection/settings.ts` (`PACK_DEFAULT`) | `selection/unit/pack-assess`, `selection/screening-packs` |
| Change seller-page checks | `selection/sellers.ts`, `selection/site.ts` | `selection/unit/sellers`, `site-classify`, `selection/sellers`, `seller-fetch` |
| Change the engine uploads or the endings fill | `engine/uploads.ts`, `engine/endings.ts`, `engine/health.ts`; document in `docs/contract/endpoints.md` (Scoring engine) and `jobs.md` | `engine/uploads`, `engine/endings`, `engine/holdout-guard` (HG-1..HG-9) |
| Add or change an engine feature | `engine/features.ts` (`FEATURE_NAMES`, `computeFeatures`), the loader in `engine/data.ts`, the reason text in `engine/reasons.ts`; engine.md features table; a feature with no data is left out by `train.ts` | `engine/features`, `engine/train`, `engine/score` |
| Change the training split, metrics or weighting | `engine/dataset.ts`, `engine/train.ts`, `engine/model/metrics.ts`; engine.md and `endpoints.md` (POST /engine/train) | `engine/train`, `engine/model-math` |
| Change a model | `engine/model/gbm.ts`, `logit.ts` (a changed model changes every score: bump the model version note in the release) | `engine/model-math`, `engine/train` |
| Make another POST read-only | `READ_ONLY_POSTS` in `src/http/methods.ts` (and the README §Idempotency note) | `engine/score` EN-61 |
| Change a bulk write or a batch size (v5.42.0: sales 5,000/1,000, labels, tags 300, intake, endings 500, costs, labelled names 500) | the file named in its row above; query counts are asserted with `withDbScope` (`src/core/db-stats.ts`) | `bulk/` (BK542-1, 7, 8), `pickproof/pickproof` (BK542-2), `ops/disappearances` (BK542-3), `candidates/intake` (BK542-4), `selection/screening-registry` (BK542-5), `selection/sibling-scan` (BK542-6), `ops/auction-plans` (BK542-9) |
| Change market episodes, labels, sale reports, matched sets, dq checks (CR-075) | `market/episodes.ts` (labels), `market/sales.ts`, `market/matched.ts`, `market/dq.ts`; rules `docs/internal/market.md`; tests `tests/modules/market/` |
| Change the closeout candidates (filters, order, score storage, the route) (v5.26.0, CR-072) | `ops/closeouts/filters.ts`, `ops/closeouts/score-pool.ts`, `ops/api/closeouts.ts`, `selection/closeout-name.ts`, `engine/score.ts` (`scoreOffline`); migration `1765800000000_v5-26-0.sql` for columns and the setting; `docs/internal/closeouts.md`, contract `endpoints.md` §`GET /candidates/closeouts`, `jobs.md` row `datasave` | `ops/closeouts` |
| Change the knowledge base (weights, certainty rules, a route, the repo load) (v5.43.0, CR-078) | weights and thresholds: a new `kb_settings` version by migration; formulas `knowledge/verdict.ts`; write rules `knowledge/rows.ts`, `knowledge/store.ts`; routes `knowledge/api/kb.ts`; load `knowledge/load.ts`; `BOTS_ROUTES` / `KB_PREFIX` in `http/auth.ts`; contract `endpoints.md` §Knowledge base, `jobs.md` step `kbLoad`; `docs/internal/knowledge.md` | `knowledge/unit/knowledge-pure`, `knowledge/knowledge` |
| Change the historical replay, the daily archive or the pick-proof switch (v5.59.0, CR-081) | `ops/archive/godaddy-archive.ts`, `ops/replay/{logic,outcomes,report,run}.ts`, `ops/api/replay.ts` (`registerReplay`, called from `src/app.ts`), `ops/jobs/datasave/datasave.ts` (`archiveFile`, the pickproof steps), `pickproof/pool.ts` (`pickproofEnabled`), `config.ts` (`ARCHIVE_DIR`), `ops/api/health.ts` (`archive`), migration `1767900000000_v5-59-0.sql` (`settings.pickproof_enabled`, `replay_day_runs`), `docs/internal/replay.md`, contract `endpoints.md` §Historical replay | `ops/replay` (RPY81-1..RPY81-21) |
| Change the pick-proof test (pool rule, arms, seal, labels, report, stats) (v5.28.0, CR-073) | `pickproof/pool.ts`, `pickproof/store.ts`, `pickproof/draw.ts`, `pickproof/recipe.ts` (a rule text change changes the recipe hashes: new `RECIPE_VERSION`), `pickproof/labels.ts`, `pickproof/report.ts`, `pickproof/stats.ts`, `pickproof/api/pickproof.ts`; migration for settings; `docs/internal/pickproof.md`, contract Pick-proof | `pickproof/pickproof`, `pickproof/unit/stats` |
| Change the closeout expiries (the unsold feed of names that stayed to their end) (v5.46.0) | `ops/closeouts/expiries.ts`, `ops/jobs/datasave/datasave.ts` (`buildPanel`, `engineFeed`), migration `1767100000000_v5-46-0.sql`, `docs/internal/closeouts.md` "Closeout expiries", `datasave.md` 30-33, contract `jobs.md` row `datasave` | `ops/closeout-expiries` (FX546-1..6) |
| Change the daily data save (files, parse, retention, retry, health) | `ops/jobs/datasave/datasave.ts`, `ops/jobs/datasave/dynadot-upload.ts`, `ops/queue.ts` (`retryDatasave`), `reporting/datasave-state.ts`, `ops/api/snapshots.ts`, settings columns by migration; `docs/internal/datasave.md`, contract `jobs.md` row `datasave`, `endpoints.md` §Daily data saves | `ops/datasave`, `ops/datasave-dynadot`, `ops/unit/datasave-stream` |
| Add a step to the daily job | `ops/jobs/runner.ts` (`plan()`, `JobRunnerDeps`, `STEP_ATTEMPTS`), new job class under `ops/jobs/`, export in `ops/index.ts`, wire in `src/app.ts`; document in `docs/contract/jobs.md` | `ops/unit/jobs-runner-config`, `ops/jobs`, `job-queue`, `daily-schedule` |
| Change the daily/overdue schedule view | `reporting/job-runs.ts` (`dailyScheduleState`, `jobsOverdue`) | `ops/jobs`, `missed-runs` |
| Add a /buy gate or block code | `buying/buy-gates.ts` (`BuyBlock`, `buyBlocks`, gate fn), call in `buying/buy.ts`; code in `docs/contract/endpoints.md` Code index | `buying/buy-hold`, `buy-checks`, `buy-v2` |
| Change a /buy request field or approval rule | `buying/api/buy.ts`, `buying/buy.ts` (`BuyInput`), `core/approval.ts` | `buying/buy-*`, `core/unit/approval` |
| Change the small-buy exception limit ($11.08 first year) | `buying/small-buy.ts` (needs a release, Dvir's approval) | `buying/small-buy`, `small-buy-hold` |
| Change the domain cap (40), or the S8 price cap ($250) | migration only (no API; `settings.max_domains`, `s8_max_price_cents`; the S8 reserve `s8_reserved_slots` was dropped by `1767600000000_v5-52-0.sql`; the last is `1764100000000_v5-8-0.sql`, set to $250 by `1766400000000_v5-36-0.sql`; the S8 ladder `settings.s8_bin_ladder` is `1764200000000_v5-9-0.sql`); read in `buying/caps.ts` (`laneCapBlock`), `buy.ts`, `ops/admin/import-domain.ts` | `buying/caps`, `buying/portfolio-buy`, `buying/s8-import` |
| Change the S8 import (sources, backorder refusal, BIN rung) | `ops/api/portfolio-import.ts`, `ops/admin/import-domain.ts` (`lane: 'S8'`), `listing/pricing/plan.ts` (`s8LadderBin`), `listing/pricing/schedule.ts` (S8 no drops), `ops/jobs/price-schedule.ts` (`rowValid` lane); `docs/contract/endpoints.md` §S8 import lane | `buying/s8-import` |
| Change the renewal maths gate, STRe or the commission | `buying/renewal-math.ts`, `buy.ts` (step 7b), selection settings `buy.*` (`selection/settings.ts` `BUY_DEFAULT`) | `buying/portfolio-buy` |
| Change the renewal drop check, SELL_BEFORE_DROP, HORIZON_DUE, DELIST_NEEDED | `reporting/report/lifecycle.ts`, settings `renewal.*` | `reporting/portfolio-lifecycle` |
| Change the outcomes reports | `reporting/report/outcomes.ts` | `reporting/portfolio-lifecycle` (OC-1, OC-2, RN-5) |
| Change the SellerHub sync | `ops/jobs/listing-sync.ts`, `ops/sellerhub.ts` | `ops/listing-sync` |
| Change the lander check or its price check | `ops/jobs/portfolio-check.ts` (`web`, `landerPriceCheck`), `reporting/report/warnings.ts` | `ops/portfolio-check` (LP-1..LP-5) |
| Book a renewal | admin `record-renewal` (`ops/admin/record-renewal.ts`) | `reporting/portfolio-lifecycle` (RN-1..RN-4), `ops/admin-cli` |
| Change the holdout or the expiry step | `ops/jobs/portfolio-lifecycle.ts`, `selection/portfolio-support.ts` | `ops/portfolio-lifecycle`, `selection/portfolio-support` |
| Change pricing rules (65%, 48%, ladder, list) | new `pricing_settings` version by admin command (`ops/admin/pricing-settings.ts`) or migration; logic in `listing/pricing/plan.ts`, `schedule.ts`; never hard-code | `listing/unit/pricing-*`, `listing/pricing-*` (incl. `pricing-vectors`) |
| Change the scheduled drops | `listing/pricing/schedule.ts` (`buildSchedule`), `ops/jobs/price-schedule.ts`, `drop.ts` | `listing/unit/pricing-schedule`, `ops/price-job`, `drop-job` |
| Change POST /list behaviour | `listing/list.ts`, `listing/listing-v2.ts` | `listing/list`, `list-concurrency`, `buying/buy-listing` |
| Change an export format or the lease-to-own setting | `listing/export.ts` (`AFTERNIC_HEADER`, `afternicRow`, `sedoRow`); `settings.afternic_lease_*` by migration; `docs/contract/formats.md` | `listing/export*`, `listing/unit/export-rows` |
| Add an offer source / buyer type | `selling/offer-rules.ts` (`OFFER_SOURCES`, `BUYER_TYPES`, `classify`), `selling/offers.ts` | `selling/unit/offer-rules`, `selling/offers` |
| Change sold evidence rules | `selling/sold.ts` (`EVIDENCE_SOURCES`, `VENUES`), `selling/api/sold.ts` | `selling/sold` |
| Add a registrar error code mapping | `registrars/porkbun.ts` (or `godaddy.ts`), `registrars/types.ts` (`RegistrarError`, `AMBIGUOUS_CODES`) | `registrars/unit/porkbun-*`, `registrars/check-porkbun` |
| Rule-guard tests (founder rules enforced by tests) | `tests/unit/no-llm.test.ts` (rule 9), `no-topup.test.ts` (rule 6), `no-web-risk-update.test.ts`, `sandbox-guard.test.ts` (rule 12, with `tests/contract/sandbox-guard.ts`), `global-db-guard.test.ts` (tests never touch a real DB), `network-block.test.ts` with `tests/setup/network.ts` (offline: MSW unhandled = error, UDP blocked) | run the guard files after any change near their subject |
| Add a migration | new `migrations/<epoch>_<name>.sql` (epoch above the latest); `src/db/types.ts`; for a new table: `ops/jobs/backup-export.ts` (`TABLE_FILES`) and `backup-import.ts` (`ORDER`) or `EXCLUDED` in `tests/modules/ops/unit/backup-coverage.test.ts`; `tests/helpers/db.ts` `TABLES`; `APPEND_ONLY_TABLES` in `scripts/evidence.ts` if append-only; the migration count in `tests/modules/ops/admin-cli.test.ts` (doctor: `migrations: 34 applied`) | `core/schema`, `core/append-only`, `ops/backup`, `ops/unit/backup-coverage`, `ops/admin-cli` |
| Add an error code | throw `new AppError(status, 'CODE', ...)` (`http/errors.ts`); add to the Code index in `docs/contract/endpoints.md` (line ~734) and the endpoint's section; add a test whose name/body asserts it; `npm run evidence` | `unit/test-evidence`, `contract/contract-doc` |
| Add a hand-listing field (venue record) | `listing/api/venue.ts` (strict zod; never a walk-away), `venue_listings` columns via migration, `reporting/report/portfolio.ts` `exportBlock` (+ `portfolioRows` for `listed_venues` / `observed_venues`, `docs/internal/books.md` §Listing provenance) | `listing/venue`, `listing/provenance` |
| Add a route | module `api/<x>.ts` + its `register*` in the module `index.ts` and `src/app.ts`; route table row and `### METHOD /path` section in `docs/contract/endpoints.md`; `SUMMARIES` in `http/openapi.ts`; scope (READ/WRITE) in `http/auth.ts` if special | `contract/contract-doc`, a new test under `tests/modules/<module>/` |
| Add a POST that needs an idempotency key | nothing extra: `registerIdempotency` covers all POSTs; add a replay test | `http/idempotency` |
| Change the RENDER/APP_ENV startup guard (refuses to start when `RENDER` is set and `APP_ENV` is not `production`, v3.9.0) | `src/config.ts` (`loadConfig`) | `tests/unit/config` |
| Add an env var | `src/config.ts` (`EnvSchema`, `Config`), `.env.example`, `docs/runbook.md` / `DEPLOYMENT.md` if ops-visible | `tests/unit/config`, `contract/contract-doc` |
| Add a secret that must never leak | `config.ts` `secretValues`; check `core/redact.ts` | `http/secrets`, `core/unit/redact` |
| Add an admin CLI command | `ops/admin.ts` + `ops/admin/<cmd>.ts`; `docs/internal/cli.md` | `ops/admin-cli` |
| Record or change a renewal price | `ops/api/portfolio.ts` (`RenewalPriceBody`), `reporting/report/portfolio.ts` (`portfolioDetail`) | `ops/renewal-price` (L520-2) |
| Change /health output | `ops/api/health.ts` | `ops/health` (L520-1) |
| Change auth or token scope | `http/auth.ts` (a new mutating route must be added to `BOTS_ROUTES`), `ops/admin/tokens.ts`, `ops/api/tokens.ts` | `http/auth`, `token-expiry`, `ops/admin-tokens`, `http/bots-scope` |
| Change the audit log shape | `http/audit.ts` | `http/audit`, `core/append-only` |
| Change rate limits | `http/rate-limit.ts` | `http/rate-limit` |
| Change tranches | `buying/tranches.ts`, `buying/api/tranches.ts`, `selection/tranche-members.ts` | `buying/tranches` |
| Change drop lists / cohorts | `candidates/drop-lists.ts`, `cohorts.ts` and their `api/` files | `candidates/drop-lists`, `cohorts`, `cohort-settings`, `ops/drop-watch`, `ops/cohort-outcomes` |
| Change test sets / replay / holdout | `selection/test-sets.ts`, `replay.ts`, `api/test-sets.ts`, `api/selection.ts` | `selection/test-sets`, `selection-replay*`, `selection/unit/screening-replay` |
| Change the buy-hold lift steps | `selection/hold-steps.ts`, `selection/api/selection.ts` (`/selection/buy-hold`) | `buying/buy-hold`, `selection/bt1-v3-records` |
| Change backup contents | `ops/jobs/backup-export.ts`, `backup-import.ts` | `ops/backup`, `ops/unit/backup-coverage` |
| Change the nameserver verify / lander | `core/ns-lookup.ts`, `listing/lander.ts`, `ops/jobs/ns-verify.ts` | `core/unit/ns-lookup`, `ops/ns-verify` |
| Change the RDAP lookup service (cache TTL, bot limit, rows, which steps share the cache) (v5.29.0, CR-074) | `core/rdap-cache.ts`, `ops/api/lookups.ts`, `selection/rdap-batch.ts` (`cachePut`), `pickproof/labels.ts`, `app.ts` (portfolio check); settings columns `lookups_*` by migration; `docs/internal/lookups.md`, contract §RDAP lookup service | `ops/rdap-lookups` |
| Change the bots scope order (money route, body) (v5.29.0) | `http/auth.ts` (`registerScope`, `botsBodyRefusal`), `http/errors.ts` | `http/bots-scope-order`, `http/bots-scope` |
| Change money formatting | `core/money.ts` (`pair`, `formatUsd`) | `core/unit/money` |

## 4. Release checklist for a change

Anything Gavriel can see (route, field, code, behaviour) needs all of these in the same commit:

1. `docs/contract/README.md`: the contract version line.
2. The "(contract vX.Y.Z)" label in the first line of `docs/contract/endpoints.md`, `formats.md`, `jobs.md`, `reports.md`, `selection.md`, and `test-evidence.md` (generated, see 5). `tests/contract/contract-doc.test.ts` checks them against `package.json`, and `tests/contract/version-sync.test.ts` checks the version spots stay in sync.
3. `docs/contract/CHANGELOG.md` entry and the new `docs/releases/vX.Y.Z.md` (contract changes, impact on Gavriel, how to test with `dry_run`, deploy status).
4. `package.json` `version` (`src/config.ts` reads it for `/health` and openapi). MAJOR breaks a caller, MINOR adds, PATCH is docs or a fix back to the contract.
5. `npm run evidence` rewrites `docs/contract/test-evidence.md`; commit the result (`tests/unit/test-evidence.test.ts` fails on a diff or an untested code).
6. Internal docs in `docs/internal/` and `docs/internal/gaps.md` if a rule or test ID changed; every test ID in them must exist in a test name.
7. Gate: `npx vitest run && npx tsc --noEmit && npm run build`.
8. CI-before-push: check the last CI run before pushing (green or in progress: push; red: fix first). Do not push 23:45-01:00 UTC (nightly run). Push to `main`; tag `vX.Y.Z` for the release workflow. Deploy is done when `GET /health` shows the version (not verified after the push, per the project rule).
