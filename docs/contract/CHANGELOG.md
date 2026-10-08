# Contract changelog

Semver for the API contract (`README.md` §Versioning). Newest first. Each entry links to its release note in `docs/releases/`.

## 3.2.2 (2026-10-09): the Buffer input from Buffer's live schema
PATCH, a fix back to the contract (posting). `createPost` sends `mode: shareNow`, `schedulingType: automatic`, `needsApproval: false`, always an `assets` list, and the image alt text under `image.metadata.altText`, as Buffer's live schema requires. `types` on `POST /posts/schema-check` follows only X's metadata. Release note: `docs/releases/v3.2.2.md`.

## 3.2.1 (2026-10-09): schema check returns Buffer's types
PATCH, additive. `POST /posts/schema-check` adds `types` (Buffer's live input definitions). The live check on 3.2.0 showed Buffer's live API differs from its published reference (`mode`, `schedulingType` and `needsApproval` are required; `ImageAssetInput` has no `altText`); 3.2.2 fixes the input from these definitions. Release note: `docs/releases/v3.2.1.md`.

## 3.2.0 (2026-10-08): CR-017, CR-018, CR-019 part C, CR-020
MINOR, **additive** (except: `summary.partial` narrowed to its documented meaning, and pending-delete names leave `failed_by_check.availability`). Release note: `docs/releases/v3.2.0.md`.
- **Posting (CR-017):**
  - the Buffer `createPost` input fixed (`assets: [{image}]`, `shareMode`);
  - new `POST /posts/schema-check`, and a real post checks the schema first;
  - a failed post doesn't use the allowance;
  - `review_reason` is `CODE: text`, at most 200;
  - a replay takes no rate-limit slot;
  - `triggered_by` is never null for new runs.
- **Daily (CR-018):** an interrupted screening run resumes at start; the list rebuilds automatically when screening finishes (`built_by: auto`); `summary.why`.
- **Intake (CR-019 C, CR-020):**
  - scout names first;
  - drop-list names only as leftovers that fit a kept lane (S2/S4/S6, else `NO_KEPT_LANE`), capped by `intake.drop_list_max_share`;
  - timeout retry in the same run;
  - pending-delete names show as `dropping`;
  - `dropWatch` re-checks names for 7 days after their drop;
  - `who_chases`;
  - `summary.partial` / `screening_ended_partial` / `timeout_n`;
  - settings `tranche.main_lanes` (default = today's rule).

## 3.1.0 (2026-10-08): CR-016, missed and stuck runs, review retries
MINOR, **additive**. Release note: `docs/releases/v3.1.0.md`.
- **`/report`:** new errors `JOB_MISSED` (today's 00:05 UTC slot passed by 30 minutes with no daily run) and `JOB_RUN_INCOMPLETE` (a daily run open for more than 2 hours). `GET /jobs/runs` `jobs.daily` adds `last_scheduled` and `missed_slot`. `/health` `jobs` is `overdue` in both cases.
- **Review:**
  - a Google 503 / UNAVAILABLE is retried inside the call (3 tries, 20 s then 40 s); `attempts` on `POST /reviews/run`;
  - only an `ok` review counts as the day's review;
  - `/health` `review_reason` when the review failed.

## 3.0.0 (2026-10-08): job queue in Postgres (refactor R3)
**MAJOR** for callers of `POST /jobs/run` (DOM's Worker and workflow, which are updated in this release; Gavriel was told in `DOM-TO-GAVRIEL.md`). Release note: `docs/releases/v3.0.0.md`.
- **`POST /jobs/run`** answers **202** `{run_id, job, status, skipped, steps}` at once instead of 200 with every step's result. An overlap answers with the running run's id.
- **Steps run from a queue** (`job_steps`), with attempts, time limits, and takeover of a step whose instance died. While it works, the service pings itself every 5 minutes so Render doesn't sleep mid-run.
- **`GET /jobs/runs`** adds `run_id`, run `status` and per-step `status`, `attempts`, `started_at`, `finished_at`; unfinished runs come first.
- **Unchanged:** `npm run job` (CLI) and `POST /jobs/preview`.

## 2.16.4 (2026-10-08): refactor R2 part 2, all code in modules
PATCH, **no contract change**. Release note: `docs/releases/v2.16.4.md`. Nine modules in all (registrars, listing, selection, buying, candidates, selling, reporting, outreach, ops); shared infrastructure in `src/core/`. Module dependencies have no cycle, and a test enforces that.

## 2.16.3 (2026-10-08): refactor R2 part 1, first modules
PATCH, **no contract change**. Release note: `docs/releases/v2.16.3.md`. Outreach (posting, review, company document, block list), reporting and selling (offers, sales) moved to `src/modules/<name>/` with one public `index.ts` each. A test enforces the boundaries.

## 2.16.2 (2026-10-08): refactor R1b, database locks and efficiency
PATCH. Release note: `docs/releases/v2.16.2.md`.
- **Visible:**
  - each job step has `ms`;
  - `GET /selection/test-sets/{name}` returns `lookups: null` and `unknowns: null` while its run is going (it used to compute them from every row on each poll).
- **Inside:**
  - every in-memory lock or "running" flag is now a database lock, so it holds across restarts and overlapping deploys (a second run is still `skipped`);
  - one shared polite pace per registry host for the whole service;
  - the screening engine makes about a third of the database calls it did (225 → 83 on a 20-name run).

## 2.16.1 (2026-10-08): refactor R1a, shared core
PATCH, **no contract change**. Release note: `docs/releases/v2.16.1.md`. One home (`src/core/`) for dates, money, validation and redaction; the duplicate copies are removed, and a test stops new copies. Responses, codes and messages are unchanged.

## 2.16.0 (2026-10-08): tech-debt pass, CR-014, CR-015
MINOR. Release note: `docs/releases/v2.16.0.md`. Mostly fixes. Additive fields and one new route. A few checks are now stricter, each listed here.
- **New:** `POST /candidates/daily/rebuild` (6 a day); `token_name` on `GET /audit` rows; `checked_at` on `POST /candidates/{domain}/records`; `unknowns` lists undecided names, with `unread` and `unknown_inputs`; cohort status `abandoned`; post statuses `pending` and `unknown`; `REVIEW_IN_PROGRESS`; admin `resolve-purchase`.
- **Stricter:**
  - a `tm_us` domain record needs an https evidence URL and the domain's own phrase (CR-014 N-1);
  - intake notes refuse personal data (`NO_PII`, CR-015 I-1) and remove `NO_SPLIT` / `ONE_WORD` names;
  - a test set seals only from a `done` run;
  - a cohort freezes only from a `done` run;
  - a real `/buy` refuses an unknown auto top-up state (`REGISTRAR_STATE_UNKNOWN`, founder rule 6);
  - geo LANDER-1 fails closed without a price list;
  - bot-posted review cost at most $5, and only Gemini cost counts toward the cap;
  - `/media` is limited to 120 a minute per IP.
- **Behaviour:**
  - **Posting:** a post is recorded `pending` before Buffer is called, so a retry can't post twice (`unknown` counts toward the cap).
  - **Reviews:** one review runs at a time.
  - **Jobs:**
    - a step with failed items is `ok: false`;
    - the walk-away is no longer in `/jobs/run`, `/jobs/preview` or `GET /jobs/runs`;
    - NS verification and the weekly blocklist follow IDT days;
    - the review-retry `tick` runs at 08:30 UTC.
  - **The daily list** judges domain records at build time.
  - **Idempotency:** a stale `in_progress` key says `stale: true`.
  - **Restore:** the backup now restores every exported table.

## 2.15.0 (2026-10-08): CR-013 acceptance fixes
MINOR, **additive**. Release note: `docs/releases/v2.15.0.md`.
- **Review:** one weekly rule (a failed review never uses up the full-document packet, F-1); actor and token ids in packets become `operator` (F-2); a 503, timeout or network error is retried at 10:30 IDT like a 429 (F-3); `GET /reviews/settings/history` (F-10); only calls that reach Google count toward 3 per hour (F-9).
- **Block list:** more key shapes, listed in the contract (F-4); a trailing `s`, `es` or `'s` matches a listed term (F-8); `POST /company/forbidden-terms/{id}/retire` (F-2). Codes `TERM_NOT_FOUND`, `TERM_ALREADY_RETIRED`.
- **Smaller fixes:** any unknown `/media/` token is 404 (F-6); removed drop-list rows show their tokens, and an empty cohort window names its reason (F-11).
- **Docs:** the cohort report shape (F-5), dry runs answer 200 (F-7), the remove 404 (F-11a).

## 2.14.0 (2026-10-07): CR-012 parts B and C, scout intake and the daily candidate list
MINOR, **additive**. Release note: `docs/releases/v2.14.0.md`.
- **Token scope `intake`:** may only `POST /candidates/intake` and `POST /selection/drop-lists`.
- **`POST /candidates/intake`:** scouts send names (30-day dedupe; owned refused).
- **Daily steps** `intakeScreening` (at most 30 names a day, intake first, then drop names due in 7 days) and `buildDailyList`.
- **`GET /candidates/daily`:** the day's ranked buy-ready list with sections and a summary; never the walk-away.
- **New tables:** `candidate_intake`, `candidate_screenings`, `daily_candidate_lists` (append-only, in the backup).

## 2.13.0 (2026-10-07): CR-012 parts A, D, E, and the sibling method bt1@v3
MINOR, **additive**. Release note: `docs/releases/v2.13.0.md`.
- **`bt1@v3`** (Dvir approved building it): `bt1@v2` plus a general token list; 1,826 of 1,900 vectors.
- **Unknowns explained (A):** `unknowns` on test sets and screening runs; rescore option `only_names_with_unknowns` with `from_set`, report `gaps`.
- **Records per domain (E):** `POST/GET /candidates/{domain}/records`; fresh records (tm_us 30 days, history 180) are reused by live runs; the per-run manual route also writes one. New append-only table `domain_records` (in the backup).
- **Path to a real buy (D):** `GET /selection/buy-hold` adds `steps` and `ready`.

## 2.12.0 (2026-10-07): CR-011 part A, posting to the company's X account through Buffer
MINOR, **additive**. Release note: `docs/releases/v2.12.0.md`. Founder rule 10 changed by Dvir (7 Oct 2026).
- **Routes:** `POST /posts` (dry run, images with alt text, threads, daily cap with a burst), `GET /posts`, `GET /posts/{id}/images/{part}/{position}`, `POST /posts/{id}/remove`, `POST /posts/pause`, `POST /posts/burst`, and the public `GET /media/{token}` (images for Buffer, 7 days).
- **Codes:** `POST_INVALID`, `POST_TOO_LONG`, `POSTING_PAUSED`, `POSTING_NOT_CONFIGURED`, `POST_DAILY_CAP`, `POST_FAILED`, `POST_NOT_REMOVABLE`, `POST_DELETE_UNSUPPORTED`.
- **`/health`** adds `posting`, `posting_reason`; daily step `postsRefresh`. Env `BUFFER_API_KEY` (secret), `BUFFER_CHANNEL_ID`, `PUBLIC_BASE_URL`.

## 2.11.2 (2026-10-07): CR-011 addendum C, review switch, model setting, free tier
PATCH-sized but **additive** routes (kept in the 2.11 line). Release note: `docs/releases/v2.11.2.md`.
- **`GET/POST /reviews/settings`:** `enabled` (default true), `model` (default `gemini-3.8-flash`, from an allowed list), `tier` (default `free`, cost 0; `paid` needs a note naming Dvir's approval). Codes `REVIEW_MODEL_NOT_ALLOWED`, `REVIEW_MODEL_NEEDS_PAID`, `REVIEW_DISABLED`. The env `GEMINI_MODEL` is removed.
- **429 retry:** the daily review stores nothing on a 429; a second Worker cron runs `tick` at 07:30 UTC (10:30 IDT) whose `reviewRetry` step tries once more, then stores `unknown`.
- **`/health`** `review: "disabled"` and `review_model`; `GET /reviews/cost` adds `enabled`, `model`, `tier`.

## 2.11.1 (2026-10-07): registry circuit breaker
PATCH. Release note: `docs/releases/v2.11.1.md`. After 5 refusals in a row from one RDAP registry within a run, the run stops asking it and answers the rest of its lookups UNKNOWN `RATE_LIMITED` at once (counted in `rate_limited`). It makes a rerun of a test set no longer wait on a registry that refuses everything (`.biz`, CR-010 T10-1).

## 2.11.0 (2026-10-07): CR-011 addendum B, DOM calls the outside reviewer
MINOR, **additive**. Release note: `docs/releases/v2.11.0.md`. Founder rule 9 changed by Dvir (7 Oct 2026, 19:07): one AI call is allowed, this review.
- **Daily step `outsideReview`** (once per IDT day, weekly on Sunday) and **`POST /reviews/run`** (WRITE, 3 per hour): build the packet, call Google Gemini, store the feedback with model and computed cost.
- **`/health`** adds `review`. New code `REVIEWER_NOT_CONFIGURED`. New optional env `GEMINI_API_KEY` (secret) and `GEMINI_MODEL`.
- **Guarantee changed:** "one AI call only (`src/services/review/gemini.ts`); no AI SDK, no other provider host" (checked by `tests/unit/no-llm.test.ts`).

## 2.10.0 (2026-10-07): CR-011 part B, the daily outside review (founder rule 9 kept)
MINOR, **additive**. Release note: `docs/releases/v2.10.0.md`.
- **Company document:** versioned upload and reads with diffs (`/company/document`).
- **Block list:** secrets, emails, phones and forbidden terms (`/company/forbidden-terms`) are refused as `TEXT_BLOCKED` with the category only.
- **Reviews:** `POST /reviews/packet` (what the reviewer gets, stored exactly), `POST /reviews/{packet_id}/feedback` (items marked new or repeat), `GET /reviews/items`, `POST /reviews/items/{id}/status`, `GET /reviews/cost` ($5 monthly cap); `/report` warning `REVIEW_OVERDUE`. DOM never calls an AI: Gavriel does.
- **New codes:** `TEXT_BLOCKED`, `DOCUMENT_VERSION_NOT_FOUND`, `DOCUMENT_MISSING`, `REVIEW_COST_CAP`, `PACKET_NOT_FOUND`, `FEEDBACK_EXISTS`, `REVIEW_ITEM_NOT_FOUND`. Six new append-only tables (in the data backup).

## 2.9.0 (2026-10-07): CR-010 v2.7.0 findings: cancel, answer source, run totals, pending
MINOR, **additive**. Release note: `docs/releases/v2.9.0.md`.
- **Cancel (F-1):** `POST /screening/runs/{id}/cancel` and `POST /selection/test-sets/{name}/cancel` (WRITE, audited); status `cancelled`; unfinished checks UNKNOWN `CANCELLED`; new code `RUN_NOT_RUNNING`. A cancelled run is never woken or reopened by a read. The contract now says when a read restarts work.
- **Answer source (F-3):** census siblings and `ext_dates` extensions add `source`.
- **Run totals (F-4):** `GET /screening/runs/{id}` adds `lookups`.
- **Pending (F-5):** a name whose checks are not all done in a running run is `pending` and not ranked.
- **Docs (F-2):** test-set features name the current methods and the measured times.

## 2.8.0 (2026-10-07): CR-007 G-2 (drop lists, source A) and G-1 (cohorts, the forward test)
MINOR, **additive**. Release note: `docs/releases/v2.8.0.md`.
- **Drop lists:** `POST /selection/drop-lists`, `GET /selection/drop-lists/{name}`, `GET /selection/drop-lists?drop_from=&drop_to=`; daily step `dropWatch` (registry status, expected drop date); `/report` warning `DROP_FEED_STALE`.
- **Cohorts:** `POST /selection/cohorts`, `GET /selection/cohorts/{name}`, `GET /selection/cohorts/report`; decisions frozen before the drop; daily step `cohortOutcomes` (drop outcome, re-registration at 30/60/90 days); FWD-1 pass line.
- **New codes:** `DROP_LIST_NAME_TAKEN`, `DROP_LIST_NOT_FOUND`, `COHORT_NAME_TAKEN`, `COHORT_EMPTY`, `COHORT_NOT_FOUND`.
- **New tables:** `drop_lists`, `drop_list_rows`, `drop_list_checks`, `cohorts`, `cohort_names`, `cohort_decisions`, `cohort_outcomes` (in the data backup).

## 2.7.0 (2026-10-07): CR-010 fast test runs
MINOR, **additive**. Release note: `docs/releases/v2.7.0.md`.
- **Provenance:** each census sibling and `ext_dates` extension shows `checked_at` and `reused`; census and `ext_dates` fields add `rate_limited_n`.
- **Test sets:** `max_answer_age_days` (default 7); `GET` adds `lookups {fresh, reused, unknown, rate_limited}` and `timing`. A stored answer is reused for an `as_of` only if read on or after it.
- **Speed:** test-set runs ask each registry up to 4 at a time, 250 ms apart, slowing down automatically on a 429 or refusal; stored answers are read in one query per name and never wait for the pacer. Live screening is unchanged.

## 2.6.0 (2026-10-07): CR-009 sibling method bt1@v2 (frequency-aware split) and acceptance fixes
MINOR, **additive**. Release note: `docs/releases/v2.6.0.md`.
- **Sibling method `bt1@v2` (N-8):** the `bt1` recipe on a frozen word split that prefers common words (SCOWL size levels, DOM's term lists, fixed costs; `data/bt1/bt1_v2_split.json` with its sha256). It agrees with the research split on 1,810 of 1,900 vectors (95.3%). `GET /selection/sibling-methods/{method}` adds `split_sha256`. `bt1@v1` is unchanged.
- **Test sets:** `sibling_method` (default `bt1@v2`) and, for `rescore`, `features_as_of: "row" | "now"`. A rescore may use a method not yet approved (it registers nothing); a `new` set and live screening still need the approval.
- **`POST /jobs/preview`:** adds `would_cancel` and `would_fail`; each array's item shape is documented (N-2).
- **Web Risk:** an UNKNOWN adds `http_status`, `error_status`, `error_reason`, `error_message` (never the key). The weekly blocklist check is `unknown` when a source failed and none listed the name (N-3).
- **`/jobs/run`:** a refused (401) call carries no `RateLimit-*` headers and uses no manual-run slot (N-4); every WRITE call counts, a 422 included (N-5); a WRITE-started run is audited under scope `write` (N-6).
- **Screening:** a name whose plan has no gating check is `not_screened` and left out of `ranking` (N-7).
- **Docs:** the `Connection` header over HTTP/1.1 and HTTP/2 (N-1).

## 2.5.0 (2026-10-07): CR-007 G-4 test sets and suites, CR-008 AC-10 rescore
MINOR, **additive** (one widening: a suite outside `holdout.required_suites` can now be frozen). Release note: `docs/releases/v2.5.0.md`.
- **Test sets:** `POST /selection/test-sets` (`new`: DOM filters, removes names used before, splits by seed and computes as-of features; `rescore`: as-of features and a report for names already registered), `GET /selection/test-sets/{name}`, `POST /selection/test-sets/{name}/seal` (registers the rows, freezes the test membership). New codes `SIBLING_METHOD_NOT_APPROVED`, `TEST_SET_NAME_TAKEN`, `TEST_SET_EMPTY`, `TEST_SET_NOT_FOUND`, `TEST_SET_NOT_READY`, `TEST_SET_ALREADY_SEALED`, `TEST_SET_NOT_SEALABLE`. New tables `test_sets`, `test_set_rows` (in the data backup).
- **Suites:** any suite id; new fields `gates_not_assessed` and `clears_hold`, each named in Dvir's approval. Holdout replays apply only the assessed gates and report `accepts_at_risk`.
- **Buy hold:** the hold suites are those with `clears_hold`; with none, `holdout.required_suites` as before. `GET /selection/buy-hold` adds `hold_suites_source`.

## 2.4.0 (2026-10-07): CR-008 sibling method bt1@v1 and ext.alt_list (CR-007 G-3)
MINOR, **additive**. Release note: `docs/releases/v2.4.0.md`.
- **Sibling method `bt1@v1`:** `GET /selection/sibling-methods/{method}` (READ: frozen pools, approval state, the 20 siblings for a domain or a word split) and `POST /selection/sibling-methods/{method}/approve` (WRITE, Dvir's `approval_ref` naming the method, once). New codes `SIBLING_METHOD_NOT_FOUND`, `SIBLING_METHOD_ALREADY_APPROVED`. New append-only table `sibling_method_approvals` (in the data backup).
- **Census:** an item's `census_list` may be `bt1@v1`: siblings built at run time; UNKNOWN `CENSUS_METHOD_NOT_APPROVED` before the approval. Per-name lists are unchanged.
- **`ext.alt_list` (C-1):** an optional settings key; `ext_dates` (`alt_tld_before_n`) reads it when present, else `ext.list`. `same_name` is unchanged. Existing versions behave as before.

## 2.3.0 (2026-10-07): CR-007 operations: manual runs, token expiry, automatic Web Risk, daily portfolio check
MINOR, **additive**. Release note: `docs/releases/v2.3.0.md`.
- **`POST /jobs/run` with a WRITE token (T-2):** `daily` or `tick` only, at most 4 calls per hour per token, same overlap lock; `GET /jobs/runs` adds `triggered_by` (the token's name). The READ token is still refused.
- **Token expiry (T-3):** a token may carry an expiry time set by DOM's admin command; after it the token gets 401 `UNAUTHORIZED` like an unknown one.
- **Automatic Web Risk (G-6):** with the server's Google Web Risk key, `web_risk` calls the Lookup API: a match is FAIL `UNSAFE`, no match is PASS (CAP-06; `requires_clean_history` applies only to manual records), errors are UNKNOWN `QUOTA` / `SOURCE_ERROR`, DOM's monthly cap (10,000) UNKNOWN `QUOTA_CAP`. Without the key, MANUAL_REQUIRED as before. The Update API is never called (a static test).
- **Daily `portfolioCheck` step (G-5):** registry (RDAP) and web answer daily, blocklists weekly, for every owned, listed or delisted name, hand-bought names included. New `/report` warnings `REGISTRY_MISMATCH` (error), `LANDER_DOWN` (warn, error from the 2nd day), `OWNED_NAME_BLOCKLISTED` (error). New append-only table `portfolio_checks` (operational, not in the data backup).
- **US trademark:** stays manual; the contract says the USPTO key gives no wordmark search (CR-007 Q-8).

## 2.2.0 (2026-10-07): CR-006 acceptance findings
MINOR, **additive**. Release note: `docs/releases/v2.2.0.md`. Two additions; the rest makes the docs match what the service and the platform do.
- **`/report` warning `AUTO_RENEW_UNCONFIRMED` (info, F-2):** on every report for each live name whose auto-renew the service can't read (GoDaddy, or `registrar_api: none`). Before, it appeared only in the import output.
- **`GET /deals/{id}` approvals add `dry_run` (Q-6):** `true` for a dry-run call, so a dry run and the real call with the same approval line read as one dry run plus one real row.
- **Platform responses (F-1, F-4, Q-5):** `README.md` §Errors now says which malformed paths the platform edge answers itself (`%ZZ` → 400 HTML, a truncated escape → 520) and that only `%C3%28`-style escapes reach the service's 400 `INVALID_REQUEST`. No `Connection` header reaches a client over HTTP/2. This corrects the 2.1.0 BUG-6 entry below.
- **Final push (Q-1):** stated: the final push changes only the BIN; floor and walk-away stay as set by the last drop (`endpoints.md` §Pricing version). Behaviour unchanged.
- **Job days (Q-2, Q-3):** `jobs.md` states the day each job acts (a drop on the first run after `drop_date`) and what a run does with rows due earlier (newest valid row applied, older ones superseded; a due delist wins). Behaviour unchanged.
- **Labels and evidence (F-3, F-5):** every contract file carries the contract version (`selection.md` was v1.1.0; the label test now checks it and `test-evidence.md`). `test-evidence.md` now covers the 40 listing rule codes under `POST /list/{domain}` (24 were missing; all had tests) and lists the platform responses.

## 2.1.0 (2026-10-07): CR-005 bugs and docs, daily-only schedule, CR-004 lander none and forecast fixes, job runs read, JOB_OVERDUE, strict dry run, rate-limit headers, drop preview, test evidence map
MINOR, **additive**. Release note: `docs/releases/v2.1.0.md`. No route, field or code is removed; the behaviour changes below only turn wrong answers into the documented ones.
- **Schedule (CR-005 Amendment A):** one Worker cron, `5 0 * * *`: `daily` only. `daily` now runs `reconciler`, `nsVerifier`, `screeningResume` first, then its own steps; `tick` stays callable by hand (`jobs.md`). A stuck purchase settles by the next daily run (up to about 24 h) or a manual run.
- **BUG-2:** every response timestamp uses the Asia/Jerusalem offset (tranches, `/report` `tranches[]`, screening runs and results, packs, manual records, manual quotes, selection activation and replays). UTC stays only on `uploaded_at` (`/export/{venue}/uploaded`) and `started_at` / `finished_at` (`/jobs/run`). New packs freeze their `content` (and its hash) with the offset form. Two things are passed through exactly as recorded: a screening check's `fields` object (the source's own dates, e.g. RDAP `created_at`, `as_of`) and a pack's `judgment` (the caller's own echoed `judged_at`).
- **BUG-3:** a `text/plain` body on a JSON route is 415 `INVALID_BODY` (it was 422 `VALIDATION_ERROR`).
- **BUG-4:** `POST /offers/{id}/outcome` checks the body (outcome value, note) before the id: an invalid body is 422 even for a bad or unknown id.
- **BUG-5:** replacing a locked parent (`tier.p_passive`, `lead.p_lead`, `priors_v91`, `holdout`) with a different value is 422 `SETTINGS_KEY_LOCKED` with `details.path` (it was `SETTINGS_INVALID` for a wrong-shaped value).
- **BUG-6:** a malformed percent-encoding in the path that reaches the service is 400 `INVALID_REQUEST` in the error shape, with a plain-ASCII body that does not echo the path. *(Corrected in 2.2.0: `%ZZ` and truncated escapes are answered by the platform edge before the service; no `Connection` header reaches a client over HTTP/2. See `README.md` §Errors.)*
- **DOCS-1 / DOCS-2:** the route table lists every route (48 at part 1; 50 with the two jobs routes of this release); the version labels follow the contract version; the code index lists every code a route throws (new entries: `MANUAL_REQUIRED`, `RUN_RUNNING`, `PACK_NOT_FOUND`, `JUDGED_AT_INVALID`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `MODE_INVALID` under Buying, the listing codes `DISPLAY_NAME_MISMATCH`, `REPLAN_NOTHING_LISTED`, `OVERRIDE_NEEDS_APPROVAL`, `DROP_DATE_UNKNOWN`, `LANDER_RETIRED`, `LANDER_INVALID`, `NS_INVALID`); `LABELLED_NAME_CONFLICT` is documented on `POST /selection/labelled-names`. `tests/contract/contract-doc.test.ts` now fails on a route without a table row or a section, a thrown code missing from the index, an index code nothing emits, and a stale version label.
- **DOCS-3:** `POST /selection/replays` (holdout) returns 422 `SUITE_UNKNOWN` (`details.required_suites`) for a suite not in `holdout.required_suites` (checked first), and `SUITE_NOT_DEFINED` only for a required suite with no frozen definition. Before, an unknown suite gave `SUITE_NOT_DEFINED`.
- **`POST /list` `lander: "none"` (CR-004 §10.3):** stores or changes the listing and plan with no nameserver action. New response fields `lander_pending` (every `/list` response) and `ns_status: "skipped"`; new `/report` info warning `LANDER_PENDING`. A later call with a real lander switches the nameservers and clears the flag. New column `domains.lander_pending` (migration `1760400000000_v2-1-0.sql`, default false).
- **Forecast fixes (CR-004 §10.3):** a name with `drop_date` = `expiry_date` counts no renewal in `budget.committed_forward` and gets no `RENEWAL_PRICE_UNKNOWN` (also on `import-domain`). `POST_BUY_INCOMPLETE` is not raised for a name imported as `legacy_no_comps`.
- **`GET /jobs/runs` (READ, CR-005 N-1, N-5):** every run since 2.1.0 (newest first) with `trigger` (`scheduled` / `manual` / `cli`), `scheduled_for`, times, `ok`, `skipped` and the full `steps`; per job `last_run_at`, `last_ok_at`, `next_due_at`; `reference` (popularity list, IANA refresh, NameBio disabled) and `backup` status blocks. New append-only table `job_runs` (migration `1760500000000_v2-1-0-job-runs.sql`; operational telemetry, not in the data backup).
- **`JOB_OVERDUE` (N-2):** `/report` error warning when no `daily` run has finished in 26 hours (constant `JOBS_OVERDUE_HOURS`); `GET /health` adds `jobs: "ok" | "overdue"` (`"unknown"` while degraded). `GET /health/ping` is unchanged.
- **`POST /buy` `dry_run: "strict"` (N-7):** the first real-buy gate refusal (`BUY_HOLD`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP`) is returned as the error, in contract order; otherwise identical to `dry_run: true`. Any other string is 422.
- **Rate-limit headers (N-8a):** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every authenticated response, a 429 included, per token and method class.
- **`POST /jobs/preview` (WRITE, N-4 narrowed):** `priceJob` and `dropJob` as a dry run on real data for `today` (default today, up to 3 years ahead); writes only the audit row; never counts as a run.
- **Test evidence map (N-11b):** `docs/contract/test-evidence.md`, generated by `npm run evidence` and checked in the default suite. New static checks: no LLM (SDK or provider host), and an append-only check over every append-only table.

## 2.0.2 (2026-10-07): dry-run /buy errors carry the gate fields
MINOR, **additive only**. Release note: `docs/releases/v2.0.2.md`. In a dry run, any `AppError` thrown after the DOM gates were evaluated (for example 409 `REGISTRAR_FUNDS`, `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_STATE_UNKNOWN`, `PRICE_ABOVE_MAX`, `NOT_AVAILABLE`) now has `would_be_blocked`, `screening_pack` and `advisories` in `error.details` (same shapes as the 200 body). Real buys, the dry-run 200 and errors before the gates are unchanged.

## 2.0.1 (2026-10-07): documentation
- `GET /check`: states the existing rule that `available` needs at least one enabled adapter to confirm. RDAP `not_registered` with no enabled adapter gives `unknown`. Behaviour is unchanged (question from Gavriel's v2.0.0 acceptance run).

## 2.0.0 (2026-10-06): /buy requires a complete screening pack and an open tranche
**MAJOR (breaking, `/buy` only).** Release note: `docs/releases/v2.0.0.md`. Founder rules, caps, `approval_ref`, idempotency and audit are unchanged; manual imports are not affected.
- **`SCREENING_PACK_REQUIRED` (409, real buys):** the domain's latest pack must be `complete`, from its latest screening run, issued under the still-active settings version, and at most `pack.max_age_at_buy_hours` old (new selection setting, default 72, ruling G-75). `details.reason` is `NO_PACK`, `INCOMPLETE`, `NOT_FROM_LATEST_RUN`, `SETTINGS_NOT_ACTIVE` or `PACK_TOO_OLD`; `details.pack_id`. After `BUY_HOLD`, before any registrar call.
- **`NO_TRANCHE` (409, real buys):** the domain must be an active member of the open tranche.
- **`TRANCHE_SPEND_CAP` (409, real buys):** the tranche's optional `spend_cap` against this buy's cost plus its earlier purchases, re-checked under the global buy lock. New nullable `purchases.tranche_id` (migration `1760300000000_v2-0-0.sql`).
- **Dry run:** `would_be_blocked` is now the first of `BUY_HOLD`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP`, or `null` (was only the literal `"BUY_HOLD"`). `advisories` is unchanged.
- **Not changed:** comps stay required (`comps_min`); making them optional needs a new `pricing_settings` version with Dvir's approval (gaps G-4).

**Migration note for Gavriel.** Before a real `/buy`: (1) screen the name (full plan) and record what it needs; (2) judge it and issue a pack (`POST /screening/packs`) from the **latest** run, with the active settings; (3) `POST /tranches` if none is open, then `POST /tranches/{id}/members` for the name (with `est_cost` if the tranche has a spend cap); (4) `POST /buy` with `dry_run: true` and read `would_be_blocked` (null means a real buy passes these gates); (5) the real `/buy` within 72 h of the pack. A new screening run of the name, a new settings activation or a removal from the tranche invalidates the earlier steps. Code that typed `would_be_blocked` as `"BUY_HOLD"` must accept the four codes.

## 1.2.0 (2026-10-06): screening pack, EU trademark record, same-name check, FLAG verdicts, same-run recompute
MINOR, **additive only**. Release note: `docs/releases/v1.2.0.md`. No route, field or code is removed, renamed or changed in meaning, and no call that v1.1.0 accepted is refused. **Lead verification (CAP-15/16) and erasure were cut on 6 Oct 2026 (Dvir: keep it simple); no lead route, `leadsResume` step or lead table exists in 1.2.0.** Manual records are per run (nothing is reused across runs), a pack from a settings version that is not the active one is never complete, and a run can go from `done` back to `running` when a manual history record triggers a recompute.
- **Selection settings keys (defaults fill the stored `v1` row, so every v1.1.0 route that reads settings works unchanged):** `eu_tm {required_lanes ["S6"], freshness_hours 168}`, `same_name`, `pack`, `lead.qualified_min`, `lead.verify` (**reserved, unused in 1.2.0**: stored and validated, read by nothing; its `never_fetch_hosts` must keep `linkedin.com`, else 422 `SETTINGS_INVALID`), `sources.business_sites` (true). A draft can now add a key under `freshness_hours`. See `selection.md`.
- **New check ids** `tm_eu` (G7, manual; MANUAL_REQUIRED for `eu_tm.required_lanes`, else PASS `NOT_REQUIRED_FOR_LANE`) and `same_name` (G8, CAP-12; implemented, see below). Neither is in a default gate list.
- **`same_name` (CAP-12, G8):** the same name on the other `ext.list` extensions: RDAP registration plus a polite read of each home page (`sources.business_sites`: robots.txt honoured, honest User-Agent, one request per `same_name.min_ms_between_fetches`, no login or CAPTCHA, never `linkedin.com`). FLAG `SAME_NAME_OPERATOR` when another extension is in use under our exact name or describes our service (`fields.same_name_operators`), FLAG `SITE_UNKNOWN` when a site answers but cannot be read (never PASS), PASS otherwise; also UNKNOWN `AS_OF_NOT_SUPPORTED` (a full run with `as_of`), `SOURCE_DISABLED`, `LIST_MISSING`, `ALL_EXT_UNKNOWN`. The page fetch goes through one outbound guard (public addresses only, vetted-IP connection, default ports, never-fetch hosts; `ADDRESS_BLOCKED`, `HOST_EXCLUDED`, `URL_NOT_ALLOWED` reasons). `same_name.parked_max_text_chars` (default 1500) is a new key. Not in any default gate list: a settings version adds it (release step). New evidence source `site`. `ext_dates` is unchanged. See `selection.md`.
- **`POST /screening/runs/{id}/manual`:** `check: "tm_eu"` (CAP-09; the EU, WIPO and UK IPO register search; FAIL `TM_LIVE_MARK`, FLAG `TM_GENERIC_HITS`, PASS), accepted for any name of the run. `CHECK_NOT_MANUAL` now lists four checks.
- **New route** `POST /screening/runs/{id}/verdicts` (a PASS or REJECT verdict on one FLAG result row) and `verdicts` on each name of `GET /screening/runs/{id}` (never changes `final_status` or `flags`). New codes: `VERDICT_RESULT_NOT_FLAG`, `VERDICT_RESULT_STALE`, `RESULT_NOT_FOUND`, `DECIDED_AT_INVALID`, result code `NOT_REQUIRED_FOR_LANE`. New table `screening_verdicts` (append-only; part of the backup export and restore).
- **Same-run recompute after a manual history record:** `POST /screening/runs/{id}/manual` with `check: "history"` now reopens a finished run and recomputes the checks that read history (`ext_dates`, `tier`, `price`, `tm_us`); rows are appended, earlier ones stay. New response field `recompute` (boolean, additive). While it runs `GET /screening/runs/{id}` shows `status: running`. Replaces the 1.1.0 note that these rows were not recomputed. See `selection.md` §Same-run recompute.
- **Screening pack (CAP-19):** new routes `POST /screening/packs` (WRITE), `GET /screening/packs/{id}` and `GET /screening/packs?domain=` (READ): a frozen, versioned pack built from a finished run's current rows, with `missing` codes (`NO_RESULT`, `FAIL`, `UNKNOWN`, `MANUAL_REQUIRED`, `NOT_RUN`, `FLAG_NO_VERDICT`, `FLAG_REJECTED`, `STALE_AVAILABILITY`, `STALE_QUOTE`, `JUDGMENT_REJECTED`). New codes `RUN_RUNNING`, `PACK_NOT_FOUND`, `JUDGED_AT_INVALID`, missing code `SETTINGS_NOT_ACTIVE`; dry-run advisory `PACK_NOT_FROM_LATEST_RUN`. `POST /buy` with `dry_run: true` gains `screening_pack` and `advisories` (`SCREENING_PACK_REQUIRED` unless the latest pack is complete); `would_be_blocked` is unchanged (only `"BUY_HOLD"`), and a real `/buy` still does not require a pack (enforcement is 2.0.0). New table `screening_packs` (append-only; part of the backup export and restore). See `selection.md` §Screening pack.

## 1.1.0 (2026-10-06): selection and screening (CR-001 P1a + CR-002 P1 + Amendment A)
MINOR, **additive only**. Release note: `docs/releases/v1.1.0.md`. Nothing is removed, renamed or tightened for an existing call:
- A client that never uses a new route sees the v1.0.1 behaviour. `POST /buy` has one new refusal, 409 `BUY_HOLD`, and it applies **only to a domain that has a screening result** under settings with `buy_hold` on (a never-screened domain behaves exactly as before; a dry run is never refused). Nothing screens a domain unless a caller starts a screening run.
- `NO_TRANCHE` on `/buy` (a buy outside an open tranche) and the `screening_pack` enforcement are **deferred to 2.0.0**, because they would break today's callers. `tranche.required_for_buy` is stored but not read.
- Pricing v3 applies only after DOM creates the v3 row with Dvir's approval; until then every v2 number is unchanged.
- Callers must ignore unknown response fields (README §Versioning); new fields (`/report` `tranches`, `would_be_blocked` on a dry run) are optional.

**New routes by area (all in `endpoints.md`):**
- Selection settings and lists: `GET` / `POST /selection/settings`, `POST /selection/settings/{label}/activate`, `GET` / `POST /selection/lists/{name}`, `GET /selection/namebio`, `POST /selection/evaluate`.
- Screening: `POST /screening/runs`, `GET /screening/runs/{id}`, `POST /screening/runs/{id}/manual`, `GET /screening/evidence/{id}`, `POST /quotes/manual`.
- Tranches: `GET` / `POST /tranches`, `POST /tranches/{id}/members`, `POST /tranches/{id}/close`.
- Replay and hold clearing: `POST /selection/labelled-names`, `POST` / `GET /selection/holdout-suites`, `POST /selection/replays`, `GET /selection/replays/{id}`, `GET /selection/buy-hold`.
- Jobs: hourly `tick` gains `screeningResume`; daily gains `referenceRefresh` (`jobs.md`).

**Sources switched off by default (`sources.*` in the selection settings, DOM-owned terms log `docs/internal/sources.md`):** NameBio (`sources.namebio` false: terms unverifiable, score feature only, `SOURCE_DISABLED`) and the Internet Archive (`sources.wayback` false by Dvir's decision of 6 Oct: its terms limit access to "scholarship and research", and Amendment B1 says no permission request is pending: it is off for good). With the archive off the `history` check is MANUAL_REQUIRED `MANUAL_SOURCE` and HIST-2 is recorded by hand (below). The popularity list is the Majestic Million (CC BY 3.0), not Tranco. `.co`, `.io` and `.us` have no RDAP service in the IANA bootstrap and are UNKNOWN `NO_REGISTRY_SERVICE`.

**Manual HIST-2 record (CR-002 Amendment B; no new route, shipped in 1.1.0 because 1.1.0 was not yet deployed):** `POST /screening/runs/{id}/manual` accepts `check: "history"` with `result: {result: PASS | REJECT_HARMFUL | FLAG_PRIOR_BUSINESS, category?, prior_business_name?, first_capture_year?, last_capture_year?, evidence_urls?, checked_by}`; `evidence_url` is now optional on the route (still required for `web_risk` and `tm_us`). The record maps to PASS / FAIL `HARMFUL_HISTORY` (`hist2_fail_class` = `category`) / FLAG `PRIOR_BUSINESS_FLAGGED`, runs the A1 guard on `prior_business_name`, and has the automated history's field shape, so tier, `ext_dates`, `price`, `web_risk` and tranche admission read it unchanged. Validation errors are 422 `VALIDATION_ERROR` (the contract's code; the request said 400); a domain not in the run is 404 `NAME_NOT_IN_RUN`; `checked_at` follows the 168 h history window (`CHECKED_AT_INVALID`). New error `409 MANUAL_REQUIRED` on `POST /tranches/{id}/members` for a name whose history is still waiting for a record; new reason code `PRIOR_BUSINESS_FLAGGED`. **Behaviour change inside the unreleased 1.1.0:** with `sources.wayback` false the automated `history` check answers MANUAL_REQUIRED `MANUAL_SOURCE` instead of UNKNOWN `SOURCE_DISABLED`, so the name is `pending_manual` rather than `unknown`. Recording a history result re-reads the name's earlier manual `web_risk` / `tm_us` records and appends a changed verdict; the run's tier / `ext_dates` / `price` rows are not recomputed, a manual record belongs to its run: a new run does not reuse it (superseded in 1.2.0, see below).

**Not in 1.1.0:** the screening pack and `NO_TRANCHE` (2.0.0), CAP-14/15/16/19 (1.2.0), CAP-25 and CAP-21b (P2).

Detail, task by task:
- **Replay, name registry and hold-clearing (CAP-21a, Amendment A2/A3; new routes `POST /selection/labelled-names`, `POST` / `GET /selection/holdout-suites`, `POST /selection/replays`, `GET /selection/replays/{id}`, `GET /selection/buy-hold`; additive):** the labelled-name registry (append-only; `fit`/`dev`/`test`), a diagnostic and a holdout replay through the same tier/DEMAND-2 code as live screening (holdout recomputes CAP-01 and CAP-02, needs TM-1/TN-1/HIST-2 + guard columns, applies gates per row, reports before/after), reports by slice, price band, lane and history type with precision at 1% / 2%, the leakage lint, the profit report, and the hold-clearing check behind `POST /selection/settings/{label}/activate` (`HOLDOUT_NOT_PASSED` now lists the suites). New setting `profit` (`bin_price_cents` 148800, `cost_per_name_year_cents` 1108). Suites are pre-registered (frozen with Dvir's approval naming the suite id; holdout takes only `suite` + `settings`); a failing holdout replay sticks per settings version; diagnostic refuses `test` rows. The registry field is `role` (the plan called it `split`). Suite definitions freeze their test-name membership (`member_hash`, `member_count`), are disjoint and non-empty, and cannot change once scored. New codes: `SUITE_ALREADY_SCORED`, `SUITE_OVERLAP`, `SUITE_EMPTY`, `SUITE_MEMBERSHIP_CHANGED`, `SUITE_NOT_DEFINED`, `SUITE_UNKNOWN`, `LABELLED_NAME_CONFLICT`, `ROWS_INVALID`, `REPLAY_EMPTY`, `HOLDOUT_CONTAMINATED`, `AS_OF_REQUIRED`, `REPLAY_INVALID_NO_GATES`, `VARIANT_NOT_PREREGISTERED`, `PROFIT_REPORT_INCOMPLETE`, `REPLAY_NOT_FOUND`.
- **Tranches and buy hold (CAP-04; new routes `GET /tranches`, `POST /tranches`, `POST /tranches/{id}/members`, `POST /tranches/{id}/close`; additive):** one open tranche at a time; the geo cap (`tranche.geo_max`, default 1) is checked on every addition (409 `GEO_CAP`), the main-lane quota (`ceil(members x min_main_lane / size)`, 10 of 15, **no waiver**) at close (409 `MAIN_LANE_QUOTA`); a name joins only from a non-backtest run on the **full** lane plan (`NOT_SCREENED_OK`, `details.reason` `BACKTEST` or `PARTIAL_PLAN`); a name whose main-lane standing cannot be told (S7, source lane unknown) is not main-lane; a tranche may close below target with `allow_below_target` and a reason (`TRANCHE_BELOW_TARGET` otherwise); optional per-tranche `spend_cap` and member `est_cost`, both at most the POC cap (`TRANCHE_SPEND_CAP`); closed tranches are read-only (service and database triggers) and appear in `/report` `tranches`. The view says `opened_under` and the close report `settings_version_used`. New codes: `TRANCHE_NOT_FOUND` (also on `POST /screening/runs` `tranche_id`), `TRANCHE_ALREADY_OPEN`, `TRANCHE_NAME_TAKEN`, `TRANCHE_CLOSED`, `TRANCHE_FULL`, `GEO_CAP`, `TRANCHE_SPEND_CAP`, `TRANCHE_BELOW_TARGET`, `MAIN_LANE_QUOTA`, `NOT_SCREENED_OK`, `MEMBER_NOT_FOUND`. The concentration check now counts real tranche members other than the item itself (`GEO_CAP`). **`POST /buy`:** new 409 `BUY_HOLD` for a real buy of a domain whose latest screening run (a run that lists the name but has no result yet counts) has `buy_hold` on, or is a backtest or a no-longer-active version; a never-screened domain behaves as before, and a dry run is not refused but reports `would_be_blocked: "BUY_HOLD"`. **`NO_TRANCHE` on `/buy` is deferred to v2.0.0** (breaking, with the P1b screening-pack enforcement); the POC cap still does not count renewals. New tables `tranches`, `tranche_members` (in the backup export and restore).
- **Name form (CAP-01, incl. FORM-2 and G-FORM-1):** new `selection.md` with the form result and its reason codes `HAS_DIGIT`, `HAS_HYPHEN`, `UNKNOWN_TOKEN`, `GFORM1_WORDS`, `GFORM1_LENGTH`, `GEO_ATTR_MISSING`, `CITY_PLUS_LEGAL`, `AMBIGUOUS_SPLIT`. The check runs inside a screening run (`POST /screening/runs`).
- **Pricing v3 (CR-001 G-1/G-2; `pricing_settings` columns, no new route):** when the current settings version has a price list (created only by the admin command, never seeded), new plans use the list, ladder drops, a whole-dollar floor, a geo M12 rung down to $299 and a final push to the lowest list price at or above the floor. New 422 codes on `/list`, `/buy` and `/pricing/preview`: `BIN_NOT_IN_PRICE_LIST`, `LANDER_EXCEPTION_REQUIRED` (always refused until the screening pack exists). `settings_version` is 3 in those responses. An override never waives the list. v2 plans, their schedules and every v2 number are unchanged unless replanned (a replan uses the current version) (`BIN_NOT_NICE` and `BIN_BELOW_FLOOR_MIN` stay for v2).
- **Selection settings, lists and evaluation (CAP-00, CAP-24, CAP-18; new routes):** `GET` / `POST /selection/settings`, `POST /selection/settings/{label}/activate`, `GET` / `POST /selection/lists/{name}`, `POST /selection/evaluate` (all in `endpoints.md`; the settings document, list formats, tier DSL, money fields and codes in `selection.md`). Settings are versioned and immutable; a draft is WRITE, **an activation needs Dvir's `approval_ref`**, the priors are locked against drafts (`SETTINGS_KEY_LOCKED`) and clearing `buy_hold` is refused until the holdout passes (`HOLDOUT_NOT_PASSED`). A census list is frozen only with `approval_ref`. New codes: `SETTINGS_NOT_FOUND`, `SETTINGS_KEY_UNKNOWN`, `SETTINGS_KEY_LOCKED`, `SETTINGS_INVALID`, `SETTINGS_NO_CHANGE`, `SETTINGS_LABEL_TAKEN`, `SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `LIST_NOT_FOUND`, `LIST_NAME_INVALID`, `LIST_TERM_INVALID`, `LIST_NO_CHANGE`, `CENSUS_LIST_SIZE`, `CENSUS_LIST_INVALID`, `FORBIDDEN_FEATURE`, `BIN_REQUIRED`, and the 500s `SELECTION_SETTINGS_MISSING` / `SELECTION_SETTINGS_INVALID`; warning `PRICING_V3_MISSING`. `approval_ref` is now also required for those two actions (README §Conventions).
- **Selection hardening:** an activation approval must name the settings label and a census freeze its list name or sld (`APPROVAL_INVALID` otherwise); `holdout.*` is locked against drafts; `tranche.geo_max` defaults to 1; `money.lander1` gains `message`.
- **Name form (CAP-01) settings:** `form.short_token_flag_min` (default 2: a split with that many dictionary-only 2-letter tokens, such as `animal·it·os`, is `FLAG` `AMBIGUOUS_SPLIT`) and `form.city_word_allowlist` (a place name that is also a dictionary word counts as a city only if listed there or in the `city_extra` list).
- **Registry, DNS and dated-extension checks (CAP-03, CAP-05, CAP-10, CAP-12; no new route):** the screening checks `availability` (G2, RDAP via the cache), `surbl` (G4, straight to the zone's authoritative servers with a per-run control), `census` (G8, sibling registered-share from a frozen census list) and `ext_dates` (G8, other extensions created before the .com) replace their `NOT_IMPLEMENTED` rows; their `fields` and reason codes (`REGISTERED`, `SOURCE_DISABLED`, `RATE_LIMITED`, `QUERY_REFUSED`, `SURBL_LISTED`, `CENSUS_LIST_MISSING`, `CENSUS_LIST_SIZE`, `TOO_MANY_UNKNOWN`, `ALL_EXT_UNKNOWN`, `NO_REGISTRY_SERVICE`, `AS_OF_REQUIRED`) are in `selection.md` §Screening runs. Dated inputs use strict `< as_of`; backtest and holdout runs need `as_of`. New cache tables `rdap_lookups` and `reference_files` (not part of the backup export). A census list must be frozen (approval recorded) and belong to the name (`CENSUS_LIST_MISMATCH`); an undated sibling is excluded and counted in `undated_excluded_n` (A2); SURBL only asks servers that passed the control; RDAP is paced per host (defaults `run.rdap_concurrency` 1, `run.rdap_min_ms_between` 1000; `surbl.list_bits` gains DM 4 and CT 32); a 404 must be an RDAP/JSON answer. Names are stored `unknown` on any registry, DNS or source error; nothing is read as available, not listed or not registered by default.

- **Daily reference refresh, TYPO-1, NameBio cache, quote, tier and price checks (CAP-02, CAP-11, CAP-17, CAP-24, CAP-18; new route `GET /selection/namebio`):** the screening checks `typo` (G1), `tier` (G8, gating, DEMAND-2), `namebio` (G8, feature), `quote` (G9) and `price` (G9) replace their `NOT_IMPLEMENTED` rows; fields and reason codes (`TYPO_MATCH`, `STALE_DATA`, `NOT_IN_CACHE`, `NO_QUOTE`, `DEMAND2_FAIL`, `DEMAND2_UNDECIDED`, `EV_NOT_POSITIVE`, `RATIO_BELOW_1`, `LANDER1_FAIL`, `COVERAGE_LOW`, `NO_KEYWORDS`, `BIN_REQUIRED`) are in `selection.md`. New daily job step `referenceRefresh` (between `registrarCheck` and `backupExport`; `jobs.md`): the popularity list, the IANA bootstrap, cache pruning. The popularity list is the **Majestic Million** (CC BY 3.0, terms verified at majestic.com), not Tranco (no licence of its own, one CC BY-NC upstream); the settings switch is `sources.popularity`. **NameBio stays disabled** (`sources.namebio` false; no fetcher; `GET /selection/namebio` answers from a stored cache only, `SOURCE_DISABLED` today) and its score feature is 0 points; any card that uses NameBio numbers shows `Data from NameBio`. `GET /screening/runs/{id}` adds `score` per name and a top-level `ranking` (tier, short names, score). The quote check never calls a create or top-up endpoint; a quote older than `quote.max_age_hours` (live) or `quote.manual_max_age_days` (manual) is UNKNOWN `STALE_DATA` in the quote and price checks; a manual quote is only a fallback for a registrar that cannot be machine-quoted (a live adapter error is `SOURCE_ERROR`); `quote` fields are tagged `quote_source` and `fallback_reason`. `tier` uses FLAG inputs, lists them in `flagged_inputs` and answers PASS_WITH_NOTE `TIER_FROM_FLAGGED_INPUT` when they decided the tier. TYPO-1 compares the registrable label (ccSLD aware). A manual check record posted while a check runs is no longer overridden by that check's own auto row in the worker's stop decision.

- **Screening runs, manual records, evidence, manual quotes (CAP-20, CAP-06, CAP-08, CAP-17; new routes):** `POST /screening/runs`, `GET /screening/runs/{id}`, `POST /screening/runs/{id}/manual`, `GET /screening/evidence/{id}`, `POST /quotes/manual` (`endpoints.md`; checks, statuses, final statuses and reason codes in `selection.md` §Screening runs). A run is persisted per (name, check), resumes after the service slept (hourly tick step `screeningResume` in `jobs.md`, and the next poll) and ends `partial` with every open check UNKNOWN `TIMEOUT` when it outlives `run.time_budget_minutes`. This release ships the offline checks `form`, `brand_lists`, `concentration` and the manual-record checks `web_risk`, `tm_us` (`MANUAL_REQUIRED` until a human result is recorded); every other planned check answers NOT_RUN `NOT_IMPLEMENTED` until it is built. While `buy_hold` is on a name that passes everything is `would_buy`, never a buy card. New codes: `DRAFT_NOT_ALLOWED_LIVE`, `AS_OF_LIVE_REFUSED`, `RUN_NOT_FOUND`, `NAME_NOT_IN_RUN`, `CHECK_NOT_MANUAL`, `EVIDENCE_NOT_FOUND`, `OBSERVED_AT_INVALID`. New tables: `screening_runs`, `screening_results`, `manual_quotes` (and with `selection_settings`, `selection_lists`, `screening_evidence` they are part of the backup export and restore). In a live run a name with an unbuilt gating check (other than `pack`, `leads`) is `unknown`; a backtest never yields `buy_candidate`; a manual record outranks an auto row; a manual `checked_at` must be inside the check's freshness window (`CHECKED_AT_INVALID`); a manual quote's registrar must be a configured name (`REGISTRAR_UNKNOWN`) and never Cloudflare (`REGISTRAR_NOT_ALLOWED`); lane gate lists must agree on gate order (`SETTINGS_INVALID`).
- **History HIST-2 with versioned signature lists, the prior-business guard and the source lane (CAP-07, CAP-03/04/12; no new route):** the screening check `history` (G6, gating) replaces its `NOT_IMPLEMENTED` row. It reads the Internet Archive (CDX index + raw captures, one request per second, retried, never "no history" on a failure) for captures **strictly before** the current registration or `as_of`, classifies the decisive ones with the versioned lists `sig_harmful_strong`, `sig_harmful_weak`, `sig_parked`, `sig_forsale`, and answers PASS / FLAG / FAIL / UNKNOWN by the `history.*` actions. Outputs: `prior_history`, `pre_caps`, `pre_cls` (`harmful`, `redirect_offsite`, `content`, `parked`, `redirect_error_only`, `none`, `unknown`), `hist2`, `hist2_fail_class` (exactly six: `blocklist`, `malware_phishing`, `spam`, `adult`, `scam`, `trademark_abuse`), `captures[]`, `evidence_urls[]`, `archive_span_yrs` (feature only, no E3 rule), `undated_excluded_n`, `as_of`. Prior-business guard (Amendment A1): `prior_business_use`, `prior_business_name` (from the capture's og:site_name, title or a company/copyright line), `prior_business_years`; the name runs through the brand and big-company lists (FAIL `PRIOR_BUSINESS_BRAND_HIT` / `PRIOR_BUSINESS_BIGCO_HIT`, a null name is FLAG `PRIOR_BUSINESS_NAME_UNKNOWN`) and is added to the manual `tm_us` request. New reason codes: `HARMFUL_HISTORY`, `HARMFUL_WEAK`, `REDIRECT_OFFSITE`, `FORSALE_HISTORY`, `PARKED_HISTORY`, `PRIOR_BUSINESS_NAME_UNKNOWN`, `PRIOR_BUSINESS_BRAND_HIT`, `PRIOR_BUSINESS_BIGCO_HIT`, `CAPTURE_UNAVAILABLE`, `BLOCKLIST_UNAVAILABLE` (and `fields.error_code` `ARCHIVE_UNAVAILABLE`). Parked and for-sale prior history is positive and never a reject; an off-site redirect is a FLAG (a redirect to a parking or for-sale marketplace host is parked / for-sale history). **Source lane (inferred from the archive, `source_lane_inferred: true`):** `source_lane` `expired_drop` / `fresh` / `unknown` on the history result and on each name of `GET /screening/runs/{id}`. `com_prior_registration` (`ext_dates`) now reads the history result. New signature classes `pbn` and `trademark` (`POST /selection/lists/sig_harmful_*`), and starter list versions v2 (migration `signature-lists-v2`: PBN and trademark terms, parking and for-sale marketplace hosts). **Fix round 1:** `sources.wayback` ships **false** (the Internet Archive's terms grant access "for scholarship and research purposes only"; superseded by Amendment B1: off for good, history is recorded by hand, see the manual HIST-2 entry above). Parked and for-sale pages are classified before harmful ones (strong words on a thin placeholder or a `sig_parked` page are FLAG `HARMFUL_ON_PARKED_PAGE`, never FAIL; new setting `history.parked_max_text_chars`); a manual `tm_us` record must query the prior business name (UNKNOWN `PRIOR_NAME_NOT_QUERIED`; `result.prior_name_live` is FAIL `TM_LIVE_MARK`); the index is filtered, paged by resume key and never silently cut (UNKNOWN `INDEX_TRUNCATED`; an empty body is UNKNOWN `SOURCE_ERROR`, only `[]` is "no captures"); a no-fetch scan of archived URLs adds FLAG `HARMFUL_PATH` (new setting `history.url_terms`); Web Risk after history: a FLAG history is final and clean, a FAIL history gives UNKNOWN `HISTORY_NOT_CLEAN`; `history.retries` defaults to 2 and `Retry-After` is honoured; prior-business names are read with linear scans, error and navigation titles are not names, a title equal to the domain is used with `prior_business_name_is_domain`, low-confidence names are no name (FLAG); quick meta refreshes are redirects, pages are decoded by their declared charset, `hist2_fail_class` is `blocklist` when a listing caused the FAIL. **Fix round 2:** the parked/for-sale override needs a thin page for both signatures; page text is read by a real tag scanner (quoted attribute values skipped, `<!-->` an empty comment, ASCII-only case folding, meta refresh parsed by position); a script or style block that never closes is UNKNOWN `CAPTURE_UNAVAILABLE` (`TRUNCATED_MARKUP`), a capture cut at the size cap is FLAG `CAPTURE_TRUNCATED`; `hist2_fail_class` is never null on a FAIL (unmapped class: `spam`). Also: `census` answers UNKNOWN when every sibling is undated (never a 0 of 0 share), and a SURBL result's `upstream_calls` now counts the control queries.

## 1.0.1 (2026-10-06): documentation corrections
PATCH. The code is unchanged except one message string; the contract now describes it exactly. Release note: `docs/releases/v1.0.1.md`. From the accuracy review (21 corrections).

**Wrong (would mislead a client):**
- `GET /audit` `request` is a JSON object (or null), not a string.
- An unknown **POST** route answers 403 / 400 (`SCOPE_FORBIDDEN`, `IDEMPOTENCY_KEY_REQUIRED`) before 404; the same for `POST /export/dan/uploaded`. Only GET gets a plain 404.
- `/list`: an off-grade geo BIN needs `approval_ref` (422 `APPROVAL_REQUIRED`); "no approval for any change within the rules" was too broad.

**Incomplete and cosmetic:**
- Money display: whole dollars only in the plan view and preview; `$1,995.00` elsewhere; the plan-view schedule has no `_cents` and no `(private)` suffix.
- `/report` `next_price_event`, upcoming `values`, `applied_7d` are flat `*_cents` + display pairs.
- Offer routing: `unpriced` (non-email) goes to `dvir`. `approval_ref` elsewhere is ignored unless a route says it is validated.
- `POC_CAP_EXCEEDED` and `REGISTRAR_FUNDS` `details` keys listed exactly.
- `pricing_evidence` problems are `COMPS_INVALID`, not `VALIDATION_ERROR`.
- HEAD on the export routes writes an `export_runs` row.
- `offers_by_strategy` scopes (listed names vs all-time); `domains_owned` differs between dry run and 201.
- Failed-auth limiter: 20 or more failures. `POST /jobs/run` with no job token: 503 even unauthenticated.
- `NOT_LISTED` never appears in export warnings. `OFFER_NOT_FOUND` comes after body validation. UTC time-field exceptions. Job step `skipped` only when the summary says so.
- v1.0.0 release note: removed the stale "$500" clause.
- **Message text (the only code change):** the `/buy` 202 `message` now says the bookkeeping resolves on the next hourly reconciler run (it said "within 10 minutes"). Messages are not part of the contract.

## 1.0.0 (2026-10-06): initial contract
The first written contract: the API as built after the 6 Oct 2026 cleanup (DOM handover). Release note: `docs/releases/v1.0.0.md`.

**Changes from the 5 Oct API** (all in this release):
- `POST /sold/{domain}`: the fee for the payout is a top-level `payout_fee` (USD). The `payout {amount, method, received_on}` object is gone (sending it → 422 `VALIDATION_ERROR`), and so are the `payouts` table, `POST /payouts/{id}/received`, `PAYOUT_MISMATCH`, `PAYOUT_OVERDUE` and `/report` `payouts_pending`.
- `POST /offers/import` (offers CSV import) is gone. Record offers one at a time with `POST /offers`.
- **Bots only:** every route except `GET /health/ping` needs a valid token; `GET /health` now needs one too. Unauthenticated requests write nothing. A per-IP failed-auth limiter answers 429 `RATE_LIMITED` after 20 failures in 10 minutes.
- **Exports are always the full file.** `changed_only` is gone; **any** query parameter on `GET /export/*.csv` → 422 `VALIDATION_ERROR`.
- **Jobs** run only through `POST /jobs/run` (`tick` hourly, `daily` 00:05 UTC). A bad body → **422** `VALIDATION_ERROR`. The service has no in-process timers (`JOBS_MODE` is gone).

**Where the contract differs from the inherited specs** (the specs DOM inherited are now `docs/internal/`; the full list with decisions is `docs/internal/gaps.md`). The contract describes the code:
- `POST /buy` still **requires 2–3 comps** (`pricing_evidence`, `COMPS_REQUIRED`) and does **not** accept `screening_pack` (an unknown field → 422). Selection v9.1 says comps are optional and a screening pack is required; that ships with CR-001 P1b.
- Pricing is **`pricing_settings` v2** (x95 BINs, −20% drops, a $399 geo name never drops, floor and walk-away to the nearest $5). The v3 price list, step-down drops and the geo $399 → $299 rung ship in 1.1.0 (see above); `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED` were not emitted in 1.0.0.
- Not built: the selection endpoints (`/check/batch`, `/check/history`, `/check/tm`, `/check/quote`, `/score`, `/screening_pack`, …), `POST /distribution/confirm` and the FT-1 warning `DISTRIBUTION_INCOMPLETE`, `GET /renewal/decision/{domain}`, `POST /renew/{domain}` and the `dt` CLI.
- `POST_BUY_INCOMPLETE` means "bought without stored comps", not "without a screening pack".
- `GET /check` ignores unknown query parameters; every other GET with a query schema is strict.
- Codes the specs didn't list are now documented: `SOLD_AT_IN_FUTURE`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `EXTERNAL_REF_CONFLICT`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OUTCOME_CHANGED_CONCURRENTLY`, `OFFER_SOLD_MISMATCH`, `SEDO_TEMPLATE_INVALID`, `DROP_DATE_UNKNOWN`, `LANDER_INVALID`, `NS_INVALID`, `COMMISSION_UNEXPECTED`, the `/buy` post-buy warnings and the export warnings.
