# Code map

Where things live, so a change request goes straight to the right files. Paths are from the repo root. Verified against the tree at contract v3.4.1; v3.7.0 additions (hand listings, registrar state, offer dry run, small-buy read, buy display name/drop policy) added by hand.

## 1. How to use this map

- Find the module (section 2), then the file, then its test file. Use section 3 ("Where do I change X?") for the usual change types.
- Other code may import a module only through its `index.ts` (`tests/unit/module-boundaries.test.ts`). Graph: registrars <- listing <- selection <- buying <- candidates; selling <- reporting <- outreach; ops on top.
- Run only the affected tests locally: `npx vitest run tests/modules/<module>/<file>.test.ts` (pure tests: `tests/modules/<module>/unit/`). API tests need Postgres (`npm run db:up`). CI runs the full suite on push.
- Before commit still run `npx tsc --noEmit && npm run build` (the gate in CLAUDE.md).
- Test files sit under the module they cover and are named by feature (`tests/modules/candidates/screen.test.ts`, `outreach/posting.test.ts`), never by release. Test IDs (T21-1, AC-6, V214-5, ...) are part of the test names, so docs refer to IDs. To find the tests for a route, `grep -l "<path>" -r tests/modules`. Paths in the "Tests" columns below are relative to `tests/modules/` (a `unit/` entry is a pure test).

Test layout: `tests/modules/<module>/*.test.ts` (API tests: Fastify `inject` + test DB, built by `tests/setup/global-db.ts` from `migrations/`; one folder per `src/modules/*` plus `core`, `http`), `tests/modules/<module>/unit/` (pure: no DB, no network), `tests/unit/` (cross-cutting guards: module/core boundaries, no-llm, no-topup, network-block, config, test-evidence, domain-name), `tests/contract/` (`contract-doc.test.ts` runs in the unit project; `porkbun-mock`/`porkbun-sandbox` are opt-in), `tests/helpers/` (`app.ts` makeApp/runJobToEnd/settleJob, `db.ts` TABLES + reset, `buy.ts`, `listing.ts`, `pricing.ts`, `screening.ts`, `screening-fixtures.ts`, `fake-adapter.ts`, `porkbun-msw.ts`, `godaddy-msw.ts`, `buffer-schema.ts`, `images.ts`, `tokens.ts`, `env.ts`, `csv.ts`), `tests/fixtures/` (recorded screening data, Porkbun OpenAPI, pricing vectors), `vitest.config.ts` (projects unit = `tests/unit` + `tests/modules/*/unit` + contract-doc; api = `tests/modules/**` minus `unit/`; porkbun-*).

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

Tables: `quotes`. Tests: `tests/modules/registrars/` (`check`, `check-porkbun`, `check-service`, `godaddy`), `tests/modules/registrars/unit/` (`porkbun-*`, `godaddy-static`, `selection`), `tests/modules/ops/registrar-check.test.ts`; `tests/contract/porkbun-*.test.ts`; helpers `porkbun-msw.ts`, `godaddy-msw.ts`, `fake-adapter.ts`.

### listing
Per-domain listing plan (mode, BIN, floor, walk-away, schedule), `POST /list`, pricing settings, Afternic/Sedo exports.

| Route | File |
|---|---|
| POST /list/:domain | `listing/api/list.ts` |
| GET /pricing/preview | `listing/api/pricing.ts` |
| GET /export/afternic.csv, GET /export/sedo.csv, POST /export/:venue/uploaded | `listing/api/export.ts` |
| POST /listings/:domain/venue (v3.7.0, CR-031 C: a listing made by hand on afternic/sedo, or `delisted: true`; strict schema, no walk-away) | `listing/api/venue.ts` (`registerVenue`) |

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

Tables: `domains` (plan columns), `listing_history`, `price_schedule`, `export_runs`, `export_uploads`, `venue_listings` (v3.7.0, append-only; `/portfolio/:domain` `export.<venue>` reads it in `reporting/report/portfolio.ts` `exportBlock`: `listed_by_hand_at`, `shown`, `pending` follows the shown BIN/min offer vs the plan); reads `pricing_settings`. Tests: `tests/modules/listing/` (`list`, `list-concurrency`, `lander-none`, `export`, `export-v2`, `export-state`, `plan-store`, `pricing-*`, `venue`), `tests/modules/listing/unit/` (`listing-v2`, `pricing-*`, `export-rows`); fixtures `tests/fixtures/pricing-vectors.v2.json`, `.v3.json`; helpers `listing.ts`, `pricing.ts`.

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
| `form.ts`, `lexicon.ts`, `typo` data | name form (`analyzeForm`, `gform1`, `isShort`, `regimeDigitsOk` (CR-039, also used by intake)) |
| `pack.ts` | screening pack: `assessPack`, `issuePack`, `latestPackFor`, `requiredChecks` |
| `sellers.ts`, `site.ts`, `html-text.ts`, `wayback.ts` | seller pages and site classification, HTML text, Wayback history |
| `rdap-batch.ts`, `popularity.ts`, `namebio.ts`, `web-risk.ts` | RDAP pacing/cache, popularity list, NameBio, Web Risk lookup |
| `lists.ts` | versioned signature lists (`writeList`, `currentLists`) |
| `replay.ts`, `test-sets.ts`, `split-v2.ts`, `siblings.ts`, `sibling-methods.ts` | replays, holdout (`holdoutCheck`), test sets, sibling method `bt1@vN` |
| `hold-steps.ts` | `buyHoldSteps` (GET /selection/buy-hold). The route also adds `small_buy` (v3.7.0, G-3) from `SelectionDeps.smallBuy`, composed in `src/app.ts` from `buying` `smallBuyView` (selection must not import buying) |
| `unknowns.ts`, `money.ts`, `evidence.ts`, `domain-records.ts`, `tranche-members.ts` | unknown-input reports, EV/Ratio math, evidence rows, cached records, geo members |

Tables: `selection_settings`, `selection_lists`, `sibling_method_approvals`, `screening_runs/results/verdicts/packs/evidence`, `manual_quotes`, `domain_records`, `test_sets`, `test_set_rows`, `labelled_names`, `holdout_suites`, `replay_runs`, `rdap_lookups`, `reference_files`, `api_usage`, `registrar_presence` (ops writes it). Tests: `tests/modules/selection/` (`screening-*`, `selection-*`, `sibling-methods`, `sibling-bt1-v2`, `bt1-v3-records`, `test-sets`, `web-risk`, `reference-refresh`, `r1b-*`, `rdap-pacing`, `run-cancel`, `run-integrity`, `lists-current`, `records-unknowns`, `tier-lanes`, `sellers`, `seller-fetch`, `scout-words`, `settings-intake-keys`), `tests/modules/selection/unit/` (`screening-*`, `pack-assess`, `sellers`, `site-classify`, `html-text`, `sibling-bt1`, `split-v2/v3`); helpers `screening.ts`, `screening-fixtures.ts`.

### buying
`POST /buy` (approval, gates, registrar register, ledger), tranches, reconciler, budget.

| Route | File |
|---|---|
| POST /buy | `buying/api/buy.ts` |
| GET/POST /tranches, POST /tranches/:id/(close, members) | `buying/api/tranches.ts` |

| File | Inside |
|---|---|
| `buy.ts` | `BuyService` (v3.7.0: `display_name` (given, else `defaultDisplayName` from the newest `candidate_intake.words`), `drop_policy` (`at_first_expiry` sets drop_date = expiry in `complete()`), `drop_policy`/`renewal_committed_cents`/`drop_policy_line` in the dry run and the 201; ~830 lines: approval check, caps, dry run, purchase state machine, ledger/receipt writes) |
| `buy-gates.ts` | `buyBlocks`, `packGate`, `trancheGate`, `spendCapGate`, `gateError`; block codes `BUY_HOLD`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP` |
| `buy-hold.ts` | `screeningHold`, `latestScreeningRun` |
| `small-buy.ts` | CR-030 small-buy exception to the buy hold: fixed limits `SMALL_BUY_MAX_FIRST_YEAR_CENTS` / `SMALL_BUY_WEEKLY_CAP_CENTS`, `smallBuyRequested`, `smallBuyGate`, `smallBuySpend`, `smallBuyView` (read for GET /selection/buy-hold, v3.7.0); codes `SMALL_BUY_PRICE`, `SMALL_BUY_WEEKLY_CAP` |
| `tranches.ts` | `TrancheService` |
| `budget.ts` | `spentCents`, `activeDomainCount` ($1,500 / 50 caps are applied in `buy.ts` from config) |
| `bookkeeping.ts` | `failPurchase`, `registrarApiOf` |
| `reconciler.ts` | `Reconciler` (stuck `unknown`/`register_sent` purchases; job step `reconciler`) |

Tables: `purchases`, `receipts`, `deals`, `ledger_entries`, `tranches`, `tranche_members`, `pricing_evidence`; writes `domains`, `listing_history`. Tests: `tests/modules/buying/` (`buy-*`, `buy-display-drop-policy`, `budget`, `cap-property`, `reconciler`, `tranches`, `evidence-gaps`, `small-buy`, `small-buy-hold`); `purchases.small_buy_exception` marks small-buy purchases (migration `1762800000000_v3-5-0-b.sql`); helper `tests/helpers/buy.ts`.

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

Tables: `candidate_intake`, `candidate_screenings`, `daily_candidate_lists`, `drop_lists`, `drop_list_rows`, `cohorts`, `cohort_names`, `cohort_decisions` (`drop_list_checks`, `cohort_outcomes` written by ops jobs). Tests: `tests/modules/candidates/` (`intake`, `intake-resume`, `intake-rules`, `screen`, `screen-domains`, `screen-force`, `scout-split`, `lane-fit`, `daily-list`, `daily-list-fields`, `daily-list-rebuild`, `daily-list-rejected`, `drop-lists`, `cohorts`, `cohorts-freeze`, `cohort-settings`).

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
| `offer-stats.ts` | `perDomainOffers`, `offersByStrategy`, `reportOffers` |
| `sold.ts` | `SoldService` (checklist names venues the latest `venue_listings` row says are hand-listed), `VENUES`, `EVIDENCE_SOURCES` |

Tables: `offers`, `sales`; writes `domains`, `price_schedule`, `ledger_entries`. Tests: `tests/modules/selling/` (`offers`, `offers-dry-run`, `offer-stats`, `sold`), `tests/modules/selling/unit/offer-rules`; the table CHECKs and triggers are in `tests/modules/core/schema.test.ts`.

### reporting
Read-only reports: `/report`, portfolio, ledger, audit, job-run views.

| Route | File |
|---|---|
| GET /report, GET /report/pricing-review | `reporting/api/report.ts` |
| GET /portfolio, GET /portfolio/:domain, GET /ledger, GET /deals/:id, GET /audit | `reporting/api/reads.ts` |

| File | Inside |
|---|---|
| `report/index.ts` | `buildReport` (assembles sections) |
| `report/warnings.ts` | `buildWarnings` (every `/report` warning code; `LANDER_DOWN_ERROR_DAYS`, `REVIEW_OVERDUE_HOURS`; v3.7.0: `LANDER_AWAITING_MARKETPLACE` until the first confirmed Afternic upload, which also starts the LANDER_DOWN clock; `AUTO_RENEW_ON`, `REGISTRAR_DRIFT` from `registrar_state_checks`) |
| `report/money.ts`, `portfolio.ts` (`portfolioDetail` adds `registrar_state`, v3.7.0), `domains.ts`, `upcoming.ts`, `pricing-review.ts`, `markdown.ts` | report sections; `ledgerRows`, `ledgerCsvRows`, `usdSigned` in `portfolio.ts` |
| `job-runs.ts` | `jobRunsView`, `jobsOverdue`, `dailyScheduleState`, `stepView`, `triggerFromKey` |

Tables: none owned (reads all). Tests: `tests/modules/reporting/` (`report-core`, `report-warnings`, `reads`, `pricing-review`, `forecast`, `drop-feed-stale`); the schedule view is also in `tests/modules/ops/jobs.test.ts`, `missed-runs`.

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

Tables: `posts`, `post_images`, `post_allowance_exclusions`, `posting_switches`, `posting_bursts`, `review_*` (packets, feedback, items, item_statuses, settings_changes, retries), `company_documents`, `forbidden_terms`, `forbidden_term_retirements`. Tests: `tests/modules/outreach/` (`posting`, `posting-buffer`, `posting-guards`, `schema-check-body`, `blocklist`, `blocklist-redos`, `company-document`, `review-run`, `review-settings`, `review-packet`, `review-hardening`, `review-backoff`, `review-concurrency`), `tests/modules/outreach/unit/review-pure`, `tests/unit/no-llm`; helpers `buffer-schema.ts`, `images.ts`.

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
| `jobs/price-schedule.ts`, `drop.ts`, `registrar-check.ts`, `portfolio-check.ts`, `drop-watch.ts`, `ns-verify.ts`, `cohort-outcomes.ts`, `reference-refresh.ts` | `PriceScheduleJob` (step `priceJob`), `DropJob`, `RegistrarCheckJob`, `PortfolioCheckJob`, `DropWatchJob`, `NsVerifier` (`runOnce({onlyUnverified})`: the runner calls it for never-verified names even after the day's run, v3.7.0), `CohortOutcomesJob`, `ReferenceRefreshJob`; `RegistrarCheckJob` also appends `registrar_state_checks` (auto-renew, privacy, NS of Porkbun names, read-only) |
| `jobs/backup-export.ts`, `backup-import.ts` | `BackupExporter`, `TABLE_FILES`, `ORDER`, `migrationNames` |
| `admin.ts`, `admin/*.ts` | admin CLI (`npm run admin`): `tokens`, `pricing-settings`, `import-domain`, `drop-date`, `resolve-purchase`, `doctor` |

Daily step order (`runner.ts`): reconciler, nsVerifier, screeningResume, priceJob, dropJob, registrarCheck, portfolioCheck, dropWatch, intakeScreening, buildDailyList, cohortOutcomes, referenceRefresh, outsideReview, postsRefresh, backupExport. `tick` = first three + reviewRetry. `screen` = onDemandScreen + buildDailyList.

Tables: `job_runs`, `job_steps`, `job_queue_runs`, `portfolio_checks`, `cohort_outcomes`, `drop_list_checks`, `api_tokens`, `registrar_presence`, `registrar_state_checks` (v3.7.0, append-only, in the backup), `pricing_settings` (admin). Tests: `tests/modules/ops/` (`jobs*`, `job-queue`, `job-cli`, `jobs-run-scope`, `daily-schedule`, `daily-run-cohorts`, `tick-triggers`, `missed-runs`, `price-job`, `drop-job`, `drop-date`, `drop-watch`, `drop-watch-idt`, `cohort-outcomes`, `ns-verify`, `ns-verify-new-names`, `portfolio-check`, `lander-awaiting`, `registrar-check`, `registrar-check-fields`, `admin-cli`, `admin-tokens`, `import-domain`, `backup`, `health`, `health-posting-review`), `tests/modules/ops/unit/` (`jobs-runner-config`, `backup-coverage`).

### core (`src/core/`)
Shared helpers, no module imports (`tests/unit/core-boundaries.test.ts`).

| File | Inside | Test |
|---|---|---|
| `dates.ts` | IDT days, `idtDay`, `addDays`, `toJerusalemIso`, `jerusalemDeep`, zod `ymd`/`isoWithOffset` | `core/unit/dates`, `time`, `time-jerusalem-deep` |
| `money.ts` | cents <-> USD, `pair('x', cents)` -> `x_cents` + `x` | `core/unit/money` |
| `approval.ts` | `checkApproval`, `checkTimedApproval`, `namesToken` (72 h rule) | `core/unit/approval` |
| `validation.ts` | `approvalRef` zod, `assertNoteNoPii`, `piiError` | via api tests |
| `redact.ts` | `redact`, `scrubSecrets` | `core/unit/redact` |
| `locks.ts` | `withDomainLock`, `withAdvisoryLock`, `trySessionLock` | `selection/r1b-locks`, `listing/list-concurrency` |
| `rdap.ts`, `ns-lookup.ts`, `safe-fetch.ts` | RDAP, DNS NS lookup, SSRF-safe fetch (`safeFetch`) | `core/unit/rdap*`, `ns-lookup`, `dns-query`, `safe-fetch*` |
| `tokens.ts` | `generateToken`, `hashToken` | `core/unit/tokens` |

### http (`src/http/`)
| File | Inside | Test |
|---|---|---|
| `auth.ts` | `registerAuth` (bearer tokens, job token), `registerScope` (READ/WRITE), `INTAKE_ROUTES`, `PUBLIC_PATHS` | `http/auth`, `token-expiry` |
| `idempotency.ts` | `registerIdempotency`, `requestHash`, `pruneIdempotencyKeys` | `http/idempotency`, `idempotency-hygiene`, `http/unit/canonical-json` |
| `audit.ts` | `registerAuditId`, `registerAuditWrite`, `dbAuditWriter` | `http/audit`, `audit-token`, `timestamps` |
| `errors.ts` | `AppError`, `errorBody`, `registerErrorHandling` | `http/errors` |
| `rate-limit.ts` | `registerRateLimit` | `http/rate-limit`, `rate-limit-replay`, `http/unit/rate-limit` |
| `openapi.ts` | `SUMMARIES` map, `collectOpenApiRoutes`, `buildOpenApi`, `registerOpenApi` | `contract/contract-doc`, `http/openapi`, `openapi-schema` |
| `canonical-json.ts`, `methods.ts` | request hashing, method list | `http/unit/canonical-json` |

### db (`src/db/`)
`client.ts` (`createDb`, `pingDb`, `poolConfig`), `types.ts` (Kysely `Database` interface, one table type per table; about 1,050 lines, hand-written). Migrations: `migrations/<epoch-ms>_<name>.sql`, plain SQL for node-pg-migrate, ordered by the numeric prefix (latest `1762900000000_v3-7-0.sql`: `registrar_state_checks`, `venue_listings`; 32 files). Run with `npm run migrate`.

## 3. Where do I change X?

"Contract" below always means the doc set in section 4. `tests/unit/test-evidence.test.ts` fails if a documented error code has no test.

| Change | Code | Tests |
|---|---|---|
| Add a field to POST /candidates/intake | `candidates/intake.ts` (`IntakeBody`, `takeIntake`; store column via migration), `candidates/api/candidates.ts` | `candidates/intake`, `intake-rules`, `screen`, `screen-domains`, `scout-split` |
| Add a field to a daily list entry | `candidates/daily-list.ts` (`DailyEntry`, `buildDailyList`, `buildWhy`) | `candidates/daily-list`, `daily-list-fields`, `daily-list-rejected`, `daily-list-rebuild` |
| Add a field to the daily list summary / sections | `candidates/daily-list.ts` (`DailyList`, `readDailyList`) | same |
| Add a /report warning | `reporting/report/warnings.ts` (`buildWarnings`) + warning list in `docs/contract/reports.md` | `reporting/report-warnings`, `drop-feed-stale` |
| Add a /report section or number | `reporting/report/*.ts`, `report/index.ts` | `reporting/report-core`, `forecast` |
| Add a selection settings key | `selection/settings.ts` (zod `Base`, `DEFAULT_SELECTION_VALUES`; add to `LOCKED_PREFIXES` if founder-level), `docs/contract/selection.md` | `selection/unit/screening-settings`, `selection/selection-settings`, `selection-settings-v12`, `settings-intake-keys` |
| Add a tier input (feature) | `selection/settings.ts` (`TIER_FEATURES`), `selection/tier.ts` (`TierFeatures`, `condHolds`), the check that produces it, `selection/engine.ts` (`inputsOf`) | `selection/unit/screening-tier`, `selection/selection-v11`, `tier-lanes` |
| Add a clause op | `selection/settings.ts` (`OPS`, `Cond` zod), `selection/tier.ts` (`cmp`/`condHolds`) | `selection/unit/screening-tier`, `screening-settings` |
| Add a screening check | new `selection/checks/<id>.ts`; register in `checks/index.ts` (`CHECKS`, `GATE_OF`); `selection/settings.ts` (`CHECK_IDS`, gates per lane); `selection/types.ts` (`CheckId`); `selection/depends.ts`; `docs/contract/selection.md` | new `tests/modules/selection/screening-<id>.test.ts` (see `screening-same-name`), `selection/unit/screening-*` |
| Change what a screening pack requires | `selection/pack.ts` (`assessPack`, `requiredChecks`), `selection/settings.ts` (`PACK_DEFAULT`) | `selection/unit/pack-assess`, `selection/screening-packs` |
| Change seller-page checks | `selection/sellers.ts`, `selection/site.ts` | `selection/unit/sellers`, `site-classify`, `selection/sellers`, `seller-fetch` |
| Add a step to the daily job | `ops/jobs/runner.ts` (`plan()`, `JobRunnerDeps`, `STEP_ATTEMPTS`), new job class under `ops/jobs/`, export in `ops/index.ts`, wire in `src/app.ts`; document in `docs/contract/jobs.md` | `ops/unit/jobs-runner-config`, `ops/jobs`, `job-queue`, `daily-schedule` |
| Change the daily/overdue schedule view | `reporting/job-runs.ts` (`dailyScheduleState`, `jobsOverdue`) | `ops/jobs`, `missed-runs` |
| Change the post allowance | `outreach/posting/posts.ts` (`POSTS_PER_DAY`, `allowanceNow`); burst rows via `posting_bursts` | `outreach/posting`, `posting-buffer`, `posting-guards` |
| Change the Buffer input | `outreach/posting/buffer.ts` (`buildCreateInput`, `SAMPLE_INPUT`, `SCHEMA_CHECK_TYPES`) | `outreach/posting`, `posting-buffer`, `posting-guards`, `schema-check-body`; helper `buffer-schema.ts` |
| Change post validation (length, images, thread) | `outreach/posting/posts.ts` (`validatePost`), `images.ts`, `x-length.ts`, `blocklist.ts` | `outreach/posting`, `review-hardening`, `blocklist` |
| Change the outside review | `outreach/review/*.ts` (`run.ts`, `packet.ts`, `gemini.ts`), `outreach/api/reviews.ts` | `outreach/review-packet`, `review-run`, `review-settings`, `outreach/unit/review-pure` |
| Add a /buy gate or block code | `buying/buy-gates.ts` (`BuyBlock`, `buyBlocks`, gate fn), call in `buying/buy.ts`; code in `docs/contract/endpoints.md` Code index | `buying/buy-hold`, `buy-checks`, `buy-v2` |
| Change a /buy request field or approval rule | `buying/api/buy.ts`, `buying/buy.ts` (`BuyInput`), `core/approval.ts` | `buying/buy-*`, `core/unit/approval` |
| Change the small-buy exception limits ($11.08 first year, $50 per rolling 7 days) | `buying/small-buy.ts` (needs a release, Dvir's approval) | `buying/small-buy`, `small-buy-hold` |
| Change caps ($1,500, 50) | migration only (no API); read in `buying/budget.ts`, `buy.ts`; `src/config.ts` | `buying/budget`, `cap-property` |
| Change pricing rules (65%, 48%, ladder, list) | new `pricing_settings` version by admin command (`ops/admin/pricing-settings.ts`) or migration; logic in `listing/pricing/plan.ts`, `schedule.ts`; never hard-code | `listing/unit/pricing-*`, `listing/pricing-*` (incl. `pricing-vectors`) |
| Change the scheduled drops | `listing/pricing/schedule.ts` (`buildSchedule`), `ops/jobs/price-schedule.ts`, `drop.ts` | `listing/unit/pricing-schedule`, `ops/price-job`, `drop-job` |
| Change POST /list behaviour | `listing/list.ts`, `listing/listing-v2.ts` | `listing/list`, `list-concurrency`, `buying/buy-listing` |
| Change an export format | `listing/export.ts` (`AFTERNIC_HEADER`, `afternicRow`, `sedoRow`); `docs/contract/formats.md` | `listing/export*`, `listing/unit/export-rows` |
| Add an offer source / buyer type | `selling/offer-rules.ts` (`OFFER_SOURCES`, `BUYER_TYPES`, `classify`), `selling/offers.ts` | `selling/unit/offer-rules`, `selling/offers` |
| Change sold evidence rules | `selling/sold.ts` (`EVIDENCE_SOURCES`, `VENUES`), `selling/api/sold.ts` | `selling/sold` |
| Add a registrar error code mapping | `registrars/porkbun.ts` (or `godaddy.ts`), `registrars/types.ts` (`RegistrarError`, `AMBIGUOUS_CODES`) | `registrars/unit/porkbun-*`, `registrars/check-porkbun` |
| Add a migration | new `migrations/<epoch>_<name>.sql` (epoch above the latest); `src/db/types.ts`; for a new table: `ops/jobs/backup-export.ts` (`TABLE_FILES`) and `backup-import.ts` (`ORDER`) or `EXCLUDED` in `tests/modules/ops/unit/backup-coverage.test.ts`; `tests/helpers/db.ts` `TABLES`; `APPEND_ONLY_TABLES` in `scripts/evidence.ts` if append-only; the migration count in `tests/modules/ops/admin-cli.test.ts` (doctor: `migrations: 32 applied`) | `core/schema`, `core/append-only`, `ops/backup`, `ops/unit/backup-coverage`, `ops/admin-cli` |
| Add an error code | throw `new AppError(status, 'CODE', ...)` (`http/errors.ts`); add to the Code index in `docs/contract/endpoints.md` (line ~734) and the endpoint's section; add a test whose name/body asserts it; `npm run evidence` | `unit/test-evidence`, `contract/contract-doc` |
| Add a hand-listing field (venue record) | `listing/api/venue.ts` (strict zod; never a walk-away), `venue_listings` columns via migration, `reporting/report/portfolio.ts` `exportBlock` | `listing/venue` |
| Add a route | module `api/<x>.ts` + its `register*` in the module `index.ts` and `src/app.ts`; route table row and `### METHOD /path` section in `docs/contract/endpoints.md`; `SUMMARIES` in `http/openapi.ts`; scope (READ/WRITE) in `http/auth.ts` if special | `contract/contract-doc`, a new test under `tests/modules/<module>/` |
| Add a POST that needs an idempotency key | nothing extra: `registerIdempotency` covers all POSTs; add a replay test | `http/idempotency` |
| Add an env var | `src/config.ts` (`EnvSchema`, `Config`), `.env.example`, `docs/runbook.md` / `DEPLOYMENT.md` if ops-visible | `tests/unit/config`, `contract/contract-doc` |
| Add a secret that must never leak | `config.ts` `secretValues`; check `core/redact.ts` | `http/secrets`, `core/unit/redact` |
| Add an admin CLI command | `ops/admin.ts` + `ops/admin/<cmd>.ts`; `docs/internal/cli.md` | `ops/admin-cli` |
| Change /health output | `ops/api/health.ts`, `outreach/posting/posts.ts` (`postingHealth`) | `ops/health`, `health-posting-review` |
| Change auth or token scope | `http/auth.ts`, `ops/admin/tokens.ts` | `http/auth`, `token-expiry`, `ops/admin-tokens` |
| Change the audit log shape | `http/audit.ts` | `http/audit`, `core/append-only` |
| Change rate limits | `http/rate-limit.ts` | `http/rate-limit` |
| Change tranches | `buying/tranches.ts`, `buying/api/tranches.ts`, `selection/tranche-members.ts` | `buying/tranches` |
| Change drop lists / cohorts | `candidates/drop-lists.ts`, `cohorts.ts` and their `api/` files | `candidates/drop-lists`, `cohorts`, `cohort-settings`, `ops/drop-watch`, `ops/cohort-outcomes` |
| Change test sets / replay / holdout | `selection/test-sets.ts`, `replay.ts`, `api/test-sets.ts`, `api/selection.ts` | `selection/test-sets`, `selection-replay*`, `selection/unit/screening-replay` |
| Change the buy-hold lift steps | `selection/hold-steps.ts`, `selection/api/selection.ts` (`/selection/buy-hold`) | `buying/buy-hold`, `selection/bt1-v3-records` |
| Change backup contents | `ops/jobs/backup-export.ts`, `backup-import.ts` | `ops/backup`, `ops/unit/backup-coverage` |
| Change the nameserver verify / lander | `core/ns-lookup.ts`, `listing/lander.ts`, `ops/jobs/ns-verify.ts` | `core/unit/ns-lookup`, `ops/ns-verify` |
| Change money formatting | `core/money.ts` (`pair`, `formatUsd`) | `core/unit/money` |

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
