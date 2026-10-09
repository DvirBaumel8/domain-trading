# Code map

Where things live, so a change request goes straight to the right files. Paths are from the repo root. Verified against the tree at contract v3.4.1.

## 1. How to use this map

- Find the module (section 2), then the file, then its test file. Use section 3 ("Where do I change X?") for the usual change types.
- Other code may import a module only through its `index.ts` (`tests/unit/module-boundaries.test.ts`). Graph: registrars <- listing <- selection <- buying <- candidates; selling <- reporting <- outreach; ops on top.
- Run only the affected tests locally: `npx vitest run tests/api/<file>.test.ts tests/unit/<file>.test.ts`. API tests need Postgres (`npm run db:up`). CI runs the full suite on push.
- Before commit still run `npx tsc --noEmit && npm run build` (the gate in CLAUDE.md).
- API test files are named by feature (`buy-*`, `screening-*`, `selection-*`) or by release (`vX-Y-Z[-a|-b].test.ts`). To find the tests for a route, `grep -l "<path>" tests/api`.

Test layout: `tests/unit/` (no DB, no network), `tests/api/` (Fastify `inject` + test DB, built by `tests/setup/global-db.ts` from `migrations/`), `tests/contract/` (`contract-doc.test.ts` runs in the unit project; `porkbun-mock`/`porkbun-sandbox` are opt-in), `tests/helpers/` (`app.ts` makeApp/runJobToEnd/settleJob, `db.ts` TABLES + reset, `buy.ts`, `listing.ts`, `pricing.ts`, `screening.ts`, `screening-fixtures.ts`, `fake-adapter.ts`, `porkbun-msw.ts`, `godaddy-msw.ts`, `buffer-schema.ts`, `images.ts`, `tokens.ts`, `env.ts`, `csv.ts`), `tests/fixtures/` (recorded screening data, Porkbun OpenAPI, pricing vectors), `vitest.config.ts` (projects unit/api/porkbun-*).

Top level: `src/app.ts` (`buildApp`: wires hooks in order auth -> rate limit -> scope -> idempotency -> audit, then every `register*`, the job queue, openapi), `src/main.ts` (server start), `src/config.ts` (zod `EnvSchema`, `loadConfig`; tests `tests/unit/config.test.ts`), `src/domain-name.ts` (domain normalisation; `tests/unit/domain-name.test.ts`), `scripts/` (`evidence.ts`, `build-wordlists.ts`, `record-screening-fixtures.ts`, `refresh-porkbun-spec.ts`, `ac6-split.ts`).

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

Tables: `quotes`. Tests: `tests/api/check*.test.ts`, `check-porkbun`, `check-service`, `godaddy`, `registrar-check`; `tests/unit/porkbun-*.test.ts`, `godaddy-static`, `selection.test.ts`; `tests/contract/porkbun-*.test.ts`; helpers `porkbun-msw.ts`, `godaddy-msw.ts`, `fake-adapter.ts`.

### listing
Per-domain listing plan (mode, BIN, floor, walk-away, schedule), `POST /list`, pricing settings, Afternic/Sedo exports.

| Route | File |
|---|---|
| POST /list/:domain | `listing/api/list.ts` |
| GET /pricing/preview | `listing/api/pricing.ts` |
| GET /export/afternic.csv, GET /export/sedo.csv, POST /export/:venue/uploaded | `listing/api/export.ts` |

| File | Inside |
|---|---|
| `list.ts` | `ListService` (validates, sets nameservers to lander, writes plan + `listing_history`) |
| `listing-v2.ts` | `validateListing`, `validateComps`, `CompSchema`, `isCategory`, `checkSettingsVersion` |
| `pricing/plan.ts` | `computePlan`, `priceFormula`, `hybridBinMin` |
| `pricing/schedule.ts` | `buildSchedule`, `ladderStep`, `laneList` (drops M6/M18, final push, delist) |
| `pricing/settings.ts` | `PricingSettings`, `currentSettings`, `settingsByVersion`, `rowToSettings`, `ruleFields`, `RULE_KEYS` |
| `pricing/round.ts`, `int.ts`, `present.ts` | rounding (x95), integer helpers, display |
| `plan-store.ts` | `writePlan`, `currentPlan`, `applyHold`, `historyRow`, `domainPlanColumns` |
| `plan-view.ts` | `planView` (API shape of a plan; walk-away never exposed) |
| `export.ts` | `ExportService`, `AFTERNIC_HEADER`, `afternicRow`, `sedoRow`, `loadSedoTemplate`, `toCsv` |
| `export-state.ts` | `pendingDomains`, `changedColumns`, `manualDelist`, `VENUES` |
| `lander.ts` | `landerNameservers`, `sameNsSet` |

Tables: `domains` (plan columns), `listing_history`, `price_schedule`, `export_runs`, `export_uploads`; reads `pricing_settings`. Tests: `tests/api/list*.test.ts`, `export*.test.ts`, `pricing-*.test.ts`, `plan-store`, `export-state`; `tests/unit/listing-v2`, `pricing-*.test.ts`, `export-rows`; fixtures `tests/fixtures/pricing-vectors.v2.json`, `.v3.json`; helpers `listing.ts`, `pricing.ts`.

### selection
The largest module (about 8,400 lines). Versioned selection settings, screening runs and checks, tier/lead logic, screening packs, test sets, replays, holdout suites, sellers, buy-hold steps.

| Route | File |
|---|---|
| GET/POST /selection/settings, POST /selection/settings/:label/activate, GET /selection/namebio, GET/POST /selection/lists/:name, GET/POST /selection/sibling-methods/:method(/approve) | `selection/api/selection.ts` |
| POST /selection/evaluate, labelled-names, holdout-suites, replays, GET /selection/buy-hold | `selection/api/selection.ts` |
| POST /screening/runs, GET /screening/runs/:id, POST /screening/runs/:id/(cancel, manual, verdicts), GET /screening/evidence/:id, POST /quotes/manual | `selection/api/screening.ts` |
| POST/GET /screening/packs, GET /screening/packs/:id | `selection/api/packs.ts` |
| POST /selection/test-sets, GET /selection/test-sets/:name, POST /selection/test-sets/:name/(seal, cancel) | `selection/api/test-sets.ts` |

| File | Inside |
|---|---|
| `settings.ts` | zod `SelectionValues`, `DEFAULT_SELECTION_VALUES`, `TIER_FEATURES`, `CHECK_IDS`, `LANES`, `LOCKED_PREFIXES`, `applySet`, `createDraft`, `activate`, `activeSelectionSettings` |
| `engine.ts` | `createRun`, `ScreeningWorker` (runs checks, heartbeat, resume), `assemble`, `planFor`, `effectiveHold` |
| `checks/index.ts` | `CHECKS` registry, `GATE_OF`, `DEPENDS_ON` (from `depends.ts`) |
| `checks/*.ts` | one check each: `form`, `brand-lists`, `typo`, `availability`, `concentration`, `surbl`, `history` (Wayback), `census`, `ext-dates`, `namebio`, `same-name`, `tier`, `quote`, `price`, `manual` (web_risk, tm_us/tm_eu) |
| `types.ts` | `CheckId`, `Lane`, `Check`, `CheckContext`, `ResultRow`, `RunItem` |
| `derive.ts` | `deriveItem`, `latestByCheck`, `funnel`, final status (`buy_candidate`, `would_buy`, ...) |
| `tier.ts` | `evaluateTier`, `condHolds`, `cmp`, `unknownInputsOf` (clause ops and tier feature inputs) |
| `form.ts`, `lexicon.ts`, `typo` data | name form (`analyzeForm`, `gform1`, `isShort`) |
| `pack.ts` | screening pack: `assessPack`, `issuePack`, `latestPackFor`, `requiredChecks` |
| `sellers.ts`, `site.ts`, `html-text.ts`, `wayback.ts` | seller pages and site classification, HTML text, Wayback history |
| `rdap-batch.ts`, `popularity.ts`, `namebio.ts`, `web-risk.ts` | RDAP pacing/cache, popularity list, NameBio, Web Risk lookup |
| `lists.ts` | versioned signature lists (`writeList`, `currentLists`) |
| `replay.ts`, `test-sets.ts`, `split-v2.ts`, `siblings.ts`, `sibling-methods.ts` | replays, holdout (`holdoutCheck`), test sets, sibling method `bt1@vN` |
| `hold-steps.ts` | `buyHoldSteps` (GET /selection/buy-hold) |
| `unknowns.ts`, `money.ts`, `evidence.ts`, `domain-records.ts`, `tranche-members.ts` | unknown-input reports, EV/Ratio math, evidence rows, cached records, geo members |

Tables: `selection_settings`, `selection_lists`, `sibling_method_approvals`, `screening_runs/results/verdicts/packs/evidence`, `manual_quotes`, `domain_records`, `test_sets`, `test_set_rows`, `labelled_names`, `holdout_suites`, `replay_runs`, `rdap_lookups`, `reference_files`, `api_usage`, `registrar_presence` (ops writes it). Tests: `tests/api/screening-*.test.ts`, `selection-*.test.ts`, `sibling-methods`, `test-sets`, `web-risk`, `reference-refresh`, `r1b-*`, `v2-6/7/9/13/15-0`, `v3-3-0-b`, `v3-4-0`, `v3-4-1`; `tests/unit/screening-*.test.ts`, `selection`, `pack-assess`, `sellers`, `site-classify`, `html-text`, `sibling-bt1`, `split-v2/v3`; helpers `screening.ts`, `screening-fixtures.ts`.

### buying
`POST /buy` (approval, gates, registrar register, ledger), tranches, reconciler, budget.

| Route | File |
|---|---|
| POST /buy | `buying/api/buy.ts` |
| GET/POST /tranches, POST /tranches/:id/(close, members) | `buying/api/tranches.ts` |

| File | Inside |
|---|---|
| `buy.ts` | `BuyService` (781 lines: approval check, caps, dry run, purchase state machine, ledger/receipt writes) |
| `buy-gates.ts` | `buyBlocks`, `packGate`, `trancheGate`, `spendCapGate`, `gateError`; block codes `BUY_HOLD`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP` |
| `buy-hold.ts` | `screeningHold`, `latestScreeningRun` |
| `small-buy.ts` | CR-030 small-buy exception to the buy hold: fixed limits `SMALL_BUY_MAX_FIRST_YEAR_CENTS` / `SMALL_BUY_WEEKLY_CAP_CENTS`, `smallBuyRequested`, `smallBuyGate`; codes `SMALL_BUY_PRICE`, `SMALL_BUY_WEEKLY_CAP` |
| `tranches.ts` | `TrancheService` |
| `budget.ts` | `spentCents`, `activeDomainCount` ($1,500 / 50 caps are applied in `buy.ts` from config) |
| `bookkeeping.ts` | `failPurchase`, `registrarApiOf` |
| `reconciler.ts` | `Reconciler` (stuck `unknown`/`register_sent` purchases; job step `reconciler`) |

Tables: `purchases`, `receipts`, `deals`, `ledger_entries`, `tranches`, `tranche_members`, `pricing_evidence`; writes `domains`, `listing_history`. Tests: `tests/api/buy-*.test.ts`, `budget`, `cap-property`, `reconciler`, `tranches`, `buy-hold`, `evidence-gaps`, `v3-5-0` (small buy); `purchases.small_buy_exception` marks small-buy purchases (migration `1762800000000_v3-5-0-b.sql`); helper `tests/helpers/buy.ts`.

### candidates
Intake of candidate names, on-demand screening, the daily list, drop lists, cohorts.

| Route | File |
|---|---|
| POST /candidates/intake, POST /candidates/screen, GET /candidates/daily, POST /candidates/daily/rebuild, GET/POST /candidates/:domain/records | `candidates/api/candidates.ts` |
| POST/GET /selection/drop-lists, GET /selection/drop-lists/:name | `candidates/api/drop-lists.ts` |
| POST /selection/cohorts, GET /selection/cohorts/report, GET /selection/cohorts/:name | `candidates/api/cohorts.ts` |

| File | Inside |
|---|---|
| `intake.ts` | `IntakeBody` (zod), `takeIntake`, `intakeFormReason`, `checkIntake*`, `onDemandAllowance`, `planOnDemand`, `IntakeScreeningJob` |
| `daily-list.ts` | `DailyEntry`, `buildDailyList`, `BuildDailyListJob`, `readDailyList`, `buildWhy`, `autoRebuildDailyList`, limits `DAILY_LIST_*` |
| `drop-lists.ts` | drop-list helpers (`watchStatusOf`, `freshLookups`, `retentionCutoff`, constants) |
| `cohorts.ts` | `freezeReadyCohorts`, `FINAL_DROP`, `REREG_DAYS` |

Tables: `candidate_intake`, `candidate_screenings`, `daily_candidate_lists`, `drop_lists`, `drop_list_rows`, `cohorts`, `cohort_names`, `cohort_decisions` (`drop_list_checks`, `cohort_outcomes` written by ops jobs). Tests: `tests/api/v2-8-0`, `v2-14-0`, `v2-15-0`, `v2-16-0-a`, `v3-2-0-b`, `v3-3-0-a`, `v3-3-0-b`, `v3-4-0`, `v3-4-1` (grep the route to narrow).

### selling
Offers (record, classify, outcome), sold records, offer stats.

| Route | File |
|---|---|
| POST /offers, POST /offers/:id/outcome, GET /offers, GET /report/offers | `selling/api/offers.ts` |
| POST /sold/:domain | `selling/api/sold.ts` |

| File | Inside |
|---|---|
| `offers.ts` | `OffersService`, `validateOffer`, `offerView`, `snapshotAt`, `OFFER_BANDS` |
| `offer-rules.ts` | `classify`, `OFFER_SOURCES`, `BUYER_TYPES` (band and routing rules) |
| `offer-stats.ts` | `perDomainOffers`, `offersByStrategy`, `reportOffers` |
| `sold.ts` | `SoldService`, `VENUES`, `EVIDENCE_SOURCES` |

Tables: `offers`, `sales`; writes `domains`, `price_schedule`, `ledger_entries`. Tests: `tests/api/offers`, `offer-stats`, `sold`, `schema`; `tests/unit/offer-rules`.

### reporting
Read-only reports: `/report`, portfolio, ledger, audit, job-run views.

| Route | File |
|---|---|
| GET /report, GET /report/pricing-review | `reporting/api/report.ts` |
| GET /portfolio, GET /portfolio/:domain, GET /ledger, GET /deals/:id, GET /audit | `reporting/api/reads.ts` |

| File | Inside |
|---|---|
| `report/index.ts` | `buildReport` (assembles sections) |
| `report/warnings.ts` | `buildWarnings` (every `/report` warning code; `LANDER_DOWN_ERROR_DAYS`, `REVIEW_OVERDUE_HOURS`) |
| `report/money.ts`, `portfolio.ts`, `domains.ts`, `upcoming.ts`, `pricing-review.ts`, `markdown.ts` | report sections; `ledgerRows`, `ledgerCsvRows`, `usdSigned` in `portfolio.ts` |
| `job-runs.ts` | `jobRunsView`, `jobsOverdue`, `dailyScheduleState`, `stepView`, `triggerFromKey` |

Tables: none owned (reads all). Tests: `tests/api/report-core`, `report-warnings`, `reads`, `pricing-review`, `jobs.test.ts`, `v2-1-0-part1`, `v3-1-0`.

### outreach
Outward voice and outside review: Buffer posting to X, Gemini review, company documents, forbidden-term block list.

| Route | File |
|---|---|
| POST /posts, /posts/schema-check, GET /posts, GET /posts/:id/images/:part/:position, POST /posts/:id/remove, /posts/pause, /posts/burst, GET /media/:token | `outreach/api/posts.ts` |
| POST /reviews/packet, /reviews/run, GET/POST /reviews/settings (+ history), GET /reviews/packets/:id, POST /reviews/:packet_id/feedback, GET /reviews/items, POST /reviews/items/:id/status, GET /reviews/cost | `outreach/api/reviews.ts` |
| POST /company/document, GET /company/document/versions(/:n), POST/GET /company/forbidden-terms, POST /company/forbidden-terms/:id/retire | `outreach/api/company.ts` |

| File | Inside |
|---|---|
| `posting/posts.ts` | `PostBody`, `validatePost`, `createPost`, `removePost`, `allowanceNow` + `POSTS_PER_DAY`, `postsRefresh`, `postingHealth`, `postSchemaCheck` |
| `posting/buffer.ts` | `BufferClient`, `buildCreateInput` (the exact Buffer mutation input), `validateAgainstSchema`, `SCHEMA_CHECK_TYPES` |
| `posting/images.ts`, `x-length.ts` | image inspection, X length counting |
| `review/run.ts` | `runReview`, `retryReview` (backoff, skip reasons) |
| `review/gemini.ts`, `packet.ts`, `diff.ts`, `feedback.ts`, `novelty.ts`, `settings.ts` | Gemini call, packet building, diffing, feedback, novelty, `currentReviewSettings` |
| `blocklist.ts` | `checkText` (secret/email/phone/forbidden term) |

Tables: `posts`, `post_images`, `post_allowance_exclusions`, `posting_switches`, `posting_bursts`, `review_*` (packets, feedback, items, item_statuses, settings_changes, retries), `company_documents`, `forbidden_terms`, `forbidden_term_retirements`. Tests: `tests/api/v2-10-0`, `v2-11-0`, `v2-11-2`, `v2-12-0`, `v2-15-0`, `v2-16-0-c`, `v3-2-0-a`, `v3-4-0`; `tests/unit/review-pure`, `no-llm`; helpers `buffer-schema.ts`, `images.ts`.

### ops
Jobs and queue, health, admin CLI, backup.

| Route | File |
|---|---|
| POST /jobs/run, GET /jobs/runs, POST /jobs/preview | `ops/api/jobs.ts` |
| GET /health/ping, GET /health | `ops/api/health.ts` |

| File | Inside |
|---|---|
| `jobs/runner.ts` | `JobRunner.plan(job)` = the step list for `tick`, `daily`, `screen`; `STEP_ATTEMPTS`, `STEP_TIMEOUT_MS`, `classify` |
| `queue.ts` | `JobQueue` (Postgres queue: enqueue, claim, run step by step, keepalive) |
| `job.ts` | `npm run job` CLI |
| `jobs/price-schedule.ts`, `drop.ts`, `registrar-check.ts`, `portfolio-check.ts`, `drop-watch.ts`, `ns-verify.ts`, `cohort-outcomes.ts`, `reference-refresh.ts` | `PriceScheduleJob` (step `priceJob`), `DropJob`, `RegistrarCheckJob`, `PortfolioCheckJob`, `DropWatchJob`, `NsVerifier`, `CohortOutcomesJob`, `ReferenceRefreshJob` |
| `jobs/backup-export.ts`, `backup-import.ts` | `BackupExporter`, `TABLE_FILES`, `ORDER`, `migrationNames` |
| `admin.ts`, `admin/*.ts` | admin CLI (`npm run admin`): `tokens`, `pricing-settings`, `import-domain`, `drop-date`, `resolve-purchase`, `doctor` |

Daily step order (`runner.ts`): reconciler, nsVerifier, screeningResume, priceJob, dropJob, registrarCheck, portfolioCheck, dropWatch, intakeScreening, buildDailyList, cohortOutcomes, referenceRefresh, outsideReview, postsRefresh, backupExport. `tick` = first three + reviewRetry. `screen` = onDemandScreen + buildDailyList.

Tables: `job_runs`, `job_steps`, `job_queue_runs`, `portfolio_checks`, `cohort_outcomes`, `drop_list_checks`, `api_tokens`, `registrar_presence`, `pricing_settings` (admin). Tests: `tests/api/jobs*.test.ts`, `job-queue`, `job-cli`, `price-job`, `drop-job`, `drop-date`, `ns-verify`, `portfolio-check`, `registrar-check`, `admin-cli`, `admin-tokens`, `import-domain`, `backup`, `health`; `tests/unit/jobs-runner-config`, `backup-coverage`.

### core (`src/core/`)
Shared helpers, no module imports (`tests/unit/core-boundaries.test.ts`).

| File | Inside | Test |
|---|---|---|
| `dates.ts` | IDT days, `idtDay`, `addDays`, `toJerusalemIso`, `jerusalemDeep`, zod `ymd`/`isoWithOffset` | `unit/dates`, `time`, `time-jerusalem-deep` |
| `money.ts` | cents <-> USD, `pair('x', cents)` -> `x_cents` + `x` | `unit/money` |
| `approval.ts` | `checkApproval`, `checkTimedApproval`, `namesToken` (72 h rule) | `unit/approval` |
| `validation.ts` | `approvalRef` zod, `assertNoteNoPii`, `piiError` | via api tests |
| `redact.ts` | `redact`, `scrubSecrets` | `unit/redact` |
| `locks.ts` | `withDomainLock`, `withAdvisoryLock`, `trySessionLock` | `api/r1b-locks`, `list-concurrency` |
| `rdap.ts`, `ns-lookup.ts`, `safe-fetch.ts` | RDAP, DNS NS lookup, SSRF-safe fetch (`safeFetch`) | `unit/rdap*`, `ns-lookup`, `dns-query`, `safe-fetch*` |
| `tokens.ts` | `generateToken`, `hashToken` | `unit/tokens` |

### http (`src/http/`)
| File | Inside | Test |
|---|---|---|
| `auth.ts` | `registerAuth` (bearer tokens, job token), `registerScope` (READ/WRITE), `INTAKE_ROUTES`, `PUBLIC_PATHS` | `api/auth`, `token-expiry` |
| `idempotency.ts` | `registerIdempotency`, `requestHash`, `pruneIdempotencyKeys` | `api/idempotency`, `unit/canonical-json` |
| `audit.ts` | `registerAuditId`, `registerAuditWrite`, `dbAuditWriter` | `api/audit` |
| `errors.ts` | `AppError`, `errorBody`, `registerErrorHandling` | `api/errors` |
| `rate-limit.ts` | `registerRateLimit` | `api/rate-limit`, `unit/rate-limit` |
| `openapi.ts` | `SUMMARIES` map, `collectOpenApiRoutes`, `buildOpenApi`, `registerOpenApi` | `contract/contract-doc`, `api/v3-3-0-a` |
| `canonical-json.ts`, `methods.ts` | request hashing, method list | `unit/canonical-json` |

### db (`src/db/`)
`client.ts` (`createDb`, `pingDb`, `poolConfig`), `types.ts` (Kysely `Database` interface, one table type per table; about 1,050 lines, hand-written). Migrations: `migrations/<epoch-ms>_<name>.sql`, plain SQL for node-pg-migrate, ordered by the numeric prefix (latest `1762600000000_v3-3-1.sql`; 29 files). Run with `npm run migrate`.

## 3. Where do I change X?

"Contract" below always means the doc set in section 4. `tests/unit/test-evidence.test.ts` fails if a documented error code has no test.

| Change | Code | Tests |
|---|---|---|
| Add a field to POST /candidates/intake | `candidates/intake.ts` (`IntakeBody`, `takeIntake`; store column via migration), `candidates/api/candidates.ts` | `api/v2-14-0`, `v3-3-0-a`, `v3-4-0` |
| Add a field to a daily list entry | `candidates/daily-list.ts` (`DailyEntry`, `buildDailyList`, `buildWhy`) | `api/v2-14-0`, `v3-2-0-b`, `v3-3-0-a` |
| Add a field to the daily list summary / sections | `candidates/daily-list.ts` (`DailyList`, `readDailyList`) | same |
| Add a /report warning | `reporting/report/warnings.ts` (`buildWarnings`) + warning list in `docs/contract/reports.md` | `api/report-warnings` |
| Add a /report section or number | `reporting/report/*.ts`, `report/index.ts` | `api/report-core`, `v3-1-0` |
| Add a selection settings key | `selection/settings.ts` (zod `Base`, `DEFAULT_SELECTION_VALUES`; add to `LOCKED_PREFIXES` if founder-level), `docs/contract/selection.md` | `unit/screening-settings`, `api/selection-settings`, `selection-settings-v12` |
| Add a tier input (feature) | `selection/settings.ts` (`TIER_FEATURES`), `selection/tier.ts` (`TierFeatures`, `condHolds`), the check that produces it, `selection/engine.ts` (`inputsOf`) | `unit/screening-tier`, `api/selection-v11` |
| Add a clause op | `selection/settings.ts` (`OPS`, `Cond` zod), `selection/tier.ts` (`cmp`/`condHolds`) | `unit/screening-tier`, `screening-settings` |
| Add a screening check | new `selection/checks/<id>.ts`; register in `checks/index.ts` (`CHECKS`, `GATE_OF`); `selection/settings.ts` (`CHECK_IDS`, gates per lane); `selection/types.ts` (`CheckId`); `selection/depends.ts`; `docs/contract/selection.md` | new `tests/api/screening-<id>.test.ts` (see `screening-same-name`), `unit/screening-*` |
| Change what a screening pack requires | `selection/pack.ts` (`assessPack`, `requiredChecks`), `selection/settings.ts` (`PACK_DEFAULT`) | `unit/pack-assess`, `api/screening-packs` |
| Change seller-page checks | `selection/sellers.ts`, `selection/site.ts` | `unit/sellers`, `site-classify`, `api/v3-4-1` |
| Add a step to the daily job | `ops/jobs/runner.ts` (`plan()`, `JobRunnerDeps`, `STEP_ATTEMPTS`), new job class under `ops/jobs/`, export in `ops/index.ts`, wire in `src/app.ts`; document in `docs/contract/jobs.md` | `unit/jobs-runner-config`, `api/jobs`, `job-queue` |
| Change the daily/overdue schedule view | `reporting/job-runs.ts` (`dailyScheduleState`, `jobsOverdue`) | `api/jobs`, `v3-1-0` |
| Change the post allowance | `outreach/posting/posts.ts` (`POSTS_PER_DAY`, `allowanceNow`); burst rows via `posting_bursts` | `api/v3-2-0-a`, `v3-4-0`, `v2-12-0` |
| Change the Buffer input | `outreach/posting/buffer.ts` (`buildCreateInput`, `SAMPLE_INPUT`, `SCHEMA_CHECK_TYPES`) | `api/v2-12-0`, `v2-16-0-c`; helper `buffer-schema.ts` |
| Change post validation (length, images, thread) | `outreach/posting/posts.ts` (`validatePost`), `images.ts`, `x-length.ts`, `blocklist.ts` | `api/v2-12-0`, `v2-15-0` |
| Change the outside review | `outreach/review/*.ts` (`run.ts`, `packet.ts`, `gemini.ts`), `outreach/api/reviews.ts` | `api/v2-10-0`, `v2-11-0`, `unit/review-pure` |
| Add a /buy gate or block code | `buying/buy-gates.ts` (`BuyBlock`, `buyBlocks`, gate fn), call in `buying/buy.ts`; code in `docs/contract/endpoints.md` Code index | `api/buy-hold`, `buy-checks`, `buy-v2` |
| Change a /buy request field or approval rule | `buying/api/buy.ts`, `buying/buy.ts` (`BuyInput`), `core/approval.ts` | `api/buy-*`, `unit/approval` |
| Change the small-buy exception limits ($11.08 first year, $50 per rolling 7 days) | `buying/small-buy.ts` (needs a release, Dvir's approval) | `api/v3-5-0` |
| Change caps ($1,500, 50) | migration only (no API); read in `buying/budget.ts`, `buy.ts`; `src/config.ts` | `api/budget`, `cap-property` |
| Change pricing rules (65%, 48%, ladder, list) | new `pricing_settings` version by admin command (`ops/admin/pricing-settings.ts`) or migration; logic in `listing/pricing/plan.ts`, `schedule.ts`; never hard-code | `unit/pricing-*`, `api/pricing-*`, vectors |
| Change the scheduled drops | `listing/pricing/schedule.ts` (`buildSchedule`), `ops/jobs/price-schedule.ts`, `drop.ts` | `unit/pricing-schedule`, `api/price-job`, `drop-job` |
| Change POST /list behaviour | `listing/list.ts`, `listing/listing-v2.ts` | `api/list`, `list-concurrency`, `buy-listing` |
| Change an export format | `listing/export.ts` (`AFTERNIC_HEADER`, `afternicRow`, `sedoRow`); `docs/contract/formats.md` | `api/export*`, `unit/export-rows` |
| Add an offer source / buyer type | `selling/offer-rules.ts` (`OFFER_SOURCES`, `BUYER_TYPES`, `classify`), `selling/offers.ts` | `unit/offer-rules`, `api/offers` |
| Change sold evidence rules | `selling/sold.ts` (`EVIDENCE_SOURCES`, `VENUES`), `selling/api/sold.ts` | `api/sold` |
| Add a registrar error code mapping | `registrars/porkbun.ts` (or `godaddy.ts`), `registrars/types.ts` (`RegistrarError`, `AMBIGUOUS_CODES`) | `unit/porkbun-*`, `api/check-porkbun` |
| Add a migration | new `migrations/<epoch>_<name>.sql` (epoch above the latest); `src/db/types.ts`; for a new table: `ops/jobs/backup-export.ts` (`TABLE_FILES`) and `backup-import.ts` (`ORDER`) or `EXCLUDED` in `tests/unit/backup-coverage.test.ts`; `tests/helpers/db.ts` `TABLES`; `APPEND_ONLY_TABLES` in `scripts/evidence.ts` if append-only; the migration count in `tests/api/admin-cli.test.ts` (doctor: `migrations: 29 applied`) | `api/schema`, `append-only`, `backup`, `unit/backup-coverage`, `admin-cli` |
| Add an error code | throw `new AppError(status, 'CODE', ...)` (`http/errors.ts`); add to the Code index in `docs/contract/endpoints.md` (line ~734) and the endpoint's section; add a test whose name/body asserts it; `npm run evidence` | `unit/test-evidence`, `contract/contract-doc` |
| Add a route | module `api/<x>.ts` + its `register*` in the module `index.ts` and `src/app.ts`; route table row and `### METHOD /path` section in `docs/contract/endpoints.md`; `SUMMARIES` in `http/openapi.ts`; scope (READ/WRITE) in `http/auth.ts` if special | `contract/contract-doc`, a new api test |
| Add a POST that needs an idempotency key | nothing extra: `registerIdempotency` covers all POSTs; add a replay test | `api/idempotency` |
| Add an env var | `src/config.ts` (`EnvSchema`, `Config`), `.env.example`, `docs/runbook.md` / `DEPLOYMENT.md` if ops-visible | `unit/config`, `contract/contract-doc` |
| Add a secret that must never leak | `config.ts` `secretValues`; check `core/redact.ts` | `api/secrets`, `unit/redact` |
| Add an admin CLI command | `ops/admin.ts` + `ops/admin/<cmd>.ts`; `docs/internal/cli.md` | `api/admin-cli` |
| Change /health output | `ops/api/health.ts`, `outreach/posting/posts.ts` (`postingHealth`) | `api/health` |
| Change auth or token scope | `http/auth.ts`, `ops/admin/tokens.ts` | `api/auth`, `admin-tokens`, `token-expiry` |
| Change the audit log shape | `http/audit.ts` | `api/audit`, `append-only` |
| Change rate limits | `http/rate-limit.ts` | `api/rate-limit` |
| Change tranches | `buying/tranches.ts`, `buying/api/tranches.ts`, `selection/tranche-members.ts` | `api/tranches` |
| Change drop lists / cohorts | `candidates/drop-lists.ts`, `cohorts.ts` and their `api/` files | `api/v2-8-0`, `v2-15-0`, `v3-2-0-b` |
| Change test sets / replay / holdout | `selection/test-sets.ts`, `replay.ts`, `api/test-sets.ts`, `api/selection.ts` | `api/test-sets`, `selection-replay*`, `unit/screening-replay` |
| Change the buy-hold lift steps | `selection/hold-steps.ts`, `selection/api/selection.ts` (`/selection/buy-hold`) | `api/buy-hold` |
| Change backup contents | `ops/jobs/backup-export.ts`, `backup-import.ts` | `api/backup`, `unit/backup-coverage` |
| Change the nameserver verify / lander | `core/ns-lookup.ts`, `listing/lander.ts`, `ops/jobs/ns-verify.ts` | `unit/ns-lookup`, `api/ns-verify` |
| Change money formatting | `core/money.ts` (`pair`, `formatUsd`) | `unit/money` |

## 4. Release checklist for a change

Anything Gavriel can see (route, field, code, behaviour) needs all of these in the same commit:

1. `docs/contract/README.md`: the contract version line.
2. The "(contract vX.Y.Z)" label in the first line of `docs/contract/endpoints.md`, `formats.md`, `jobs.md`, `reports.md`, `selection.md`, and `test-evidence.md` (generated, see 5). `tests/contract/contract-doc.test.ts` checks them against `package.json`.
3. `docs/contract/CHANGELOG.md` entry and the new `docs/releases/vX.Y.Z.md` (contract changes, impact on Gavriel, how to test with `dry_run`, deploy status).
4. `package.json` `version` (`src/config.ts` reads it for `/health` and openapi). MAJOR breaks a caller, MINOR adds, PATCH is docs or a fix back to the contract.
5. `npm run evidence` rewrites `docs/contract/test-evidence.md`; commit the result (`tests/unit/test-evidence.test.ts` fails on a diff or an untested code).
6. Internal docs in `docs/internal/` and `docs/internal/gaps.md` if a rule or test ID changed; every test ID in them must exist in a test name.
7. Gate: `npx vitest run && npx tsc --noEmit && npm run build`.
8. CI-before-push: check the last CI run before pushing (green or in progress: push; red: fix first). Do not push 23:45-01:00 UTC (nightly run). Push to `main`; tag `vX.Y.Z` for the release workflow. Deploy is done when `GET /health` shows the version (not verified after the push, per the project rule).
