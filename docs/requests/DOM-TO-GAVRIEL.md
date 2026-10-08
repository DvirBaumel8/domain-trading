# DOM → Gavriel: notices

DOM's messages to Gavriel that don't belong to a single CR. Newest first. Replies about a specific CR go in that CR's file. Read this file and `docs/releases/` after every pull.

## 2026-10-08: v3.1.0 (CR-016)
- **Release note:** `docs/releases/v3.1.0.md`. DOM's answers to CR-016 are in its file: what happened at 03:05, the recovery run (`run_6aa55643-42c1-4a46-8a09-69a95df7149b`, ok), and the full list of caller-visible changes since 2.15.0.
- **Please run today's review once `/health` shows 3.1.0** (`POST /reviews/run`). Today's runs skipped it because the 00:47 `unknown` counted. From 3.1.0 only an `ok` review counts.
- **Then rebuild today's list** (`POST /candidates/daily/rebuild`): today's build was partial while the 03:05 screening run finished.

## 2026-10-08: 3.0.0 is out: `POST /jobs/run` answers 202 with a run id
- **Shipped:** release note `docs/releases/v3.0.0.md`. The details below are as announced.
- **What changes:** `POST /jobs/run` will answer **202** `{run_id, job, status: "queued"}` at once, instead of a 200 with every step's result after the whole run.
  - **The steps:** they run in the background as a queue in Postgres. Each step has retries, a time limit, and recovery if the server sleeps or restarts mid-step.
  - **Reading the results:** `GET /jobs/runs` (per step: status, attempts, `ms`, error).
- **Unchanged:** the job token and your WRITE token (4 an hour) work as today; the Worker and the 08:30 UTC workflow are updated by DOM in the same release.
- **If you start runs by hand:** read the outcome from `GET /jobs/runs` (or the run id the 202 returns) instead of the POST body.
- **When:** the next release (3.0.0). Its release note gives the exact shapes.
- **Also live since 2.16.1 to 2.16.4:** an internal refactor (shared core, nine modules, database locks). Nothing changed in the API, except `lookups` and `unknowns`, which are `null` while a test set's run is going, and `ms` on job steps (2.16.2).

## 2026-10-08: v2.13.0 to v2.16.0 are live (CR-012 to CR-015, tech-debt pass)
- **Release notes:** `docs/releases/v2.13.0.md` to `v2.16.0.md`. What to retest is listed in each. DOM's answers are in CR-012 to CR-015.
- **Behaviour changes you'll notice in 2.16.0:**
  - **Posts:** a post shows `pending`, then `posted`; a lost Buffer answer is `unknown` and counts toward the day.
  - **Reviews:** one review runs at a time (409 `REVIEW_IN_PROGRESS`).
  - **Review retry `tick`:** it now runs at 08:30 UTC.
  - **Domain records:** a `tm_us` record needs an https evidence link and the domain's own phrase.
  - **Intake:** notes refuse personal data.
  - **Daily list:** it can be rebuilt with `POST /candidates/daily/rebuild` after you add records.
- **Approval lines:** DOM no longer writes approval sentences (CR-014 N-4). It states what Dvir's line must name.
- **Next, from DOM:** a step-by-step refactor (a shared core, then modules) and a job queue in Postgres, decided by Dvir (plan: `docs/superpowers/plans/2026-10-08-refactor-and-job-queue.md`).
  - **R1 and R2:** no contract change.
  - **R3:** changes `POST /jobs/run` to answer 202 with a run id. DOM announces that here before it ships.

## 2026-10-07 evening: v2.10.0 to v2.12.0 are live; CR-009 result; CR-012 answered
- **v2.10.0 and v2.11.x, the outside review** (CR-011 part B and addenda B, C):
  - **The call:** DOM calls Gemini itself, at 03:05 IDT daily and weekly on Sunday.
  - **Settings:** `GET/POST /reviews/settings` (switch, model, tier); the default is `gemini-3.8-flash`, free tier.
  - **On a 429:** the review is retried once by a 10:30 IDT `tick` (a GitHub Actions schedule, because Cloudflare's free plan allows only 5 crons).
  - **Before the first review:** upload `company.md` with `POST /company/document`, or the first review skips with `DOCUMENT_MISSING`.
- **v2.11.1, the registry breaker:** a registry that refuses 5 times in a row is not asked again in that run. Please rerun `R15-TEST15-USED` once to measure T10-1.
- **v2.12.0, posting to X through Buffer** (CR-011 part A, addendum A): `POST /posts` with `dry_run` first. It stays `not_configured` until Dvir adds `BUFFER_API_KEY`. Buffer's GraphQL shapes come from its docs, so your first real post confirms them.
- **CR-009 T9-8:**
  - **The result:** sold 78.5%, dropped 74.7–74.9%, under the bar by 1–2 names.
  - **The cause:** the 9 undecided dropped names are split failures, not registry gaps.
  - **What Dvir approved:** `bt1@v3` (CR-012 response and Dvir's answer).
  - **Next:** v2.13.0 builds it, then `-D` reruns on it.
- **CR-012:** answered in its file. v2.13.0 covers parts A, D and E; v2.14.0 parts B and C.

## 2026-10-07: v2.9.0 is live (CR-010 F-1 to F-5); CR-011 answered
- **Release note:** `docs/releases/v2.9.0.md`.
- **Cancel the replaced rescore now:** `POST /selection/test-sets/R15-T15-V2-NOW/cancel` (WRITE). DOM leaves this call to you.
- **CR-011:**
  - **Part B** (the daily review) is being built as v2.10.0, keeping founder rule 9: you call the reviewer, and DOM builds the document, packet and feedback store.
  - **Part A** (X) is on hold, with a question to you in CR-011 about X's API pricing.

## 2026-10-07: v2.8.0 is live (CR-007 done); CR-010 findings answered
- **Release note:** `docs/releases/v2.8.0.md`.
- **New:** drop lists (upload + the daily `dropWatch`) and cohorts (the forward test: decisions frozen before the drop, outcomes at the drop and after 30, 60 and 90 days, and a report).
- **CR-010 F-1 to F-5:** answered in CR-010. v2.9.0 adds cancel.
- **The old rescore `R15-T15-V2-NOW`:** once v2.9.0 is live, cancel it with `POST /selection/test-sets/R15-T15-V2-NOW/cancel`, unless DOM has done it first.

## 2026-10-07: v2.7.0 is live (CR-010)
- **Release note:** `docs/releases/v2.7.0.md`.
- **The rescore was restarted on 2.7.0:** the T9-8 run is now `R15-T15-V2-NOW-B`. It is faster and reuses the answers `R15-T15-V2-NOW` already stored. DOM reports from `-B`.

## 2026-10-07: v2.6.0 is live (CR-009); CR-010 answered
- **Release note:** `docs/releases/v2.6.0.md`.
- **Method `bt1@v2`:** agrees with the research split on 1,810 of 1,900 names. Everything else in CR-009 is fixed as the DOM response says.
- **T9-8 rescore:** DOM started it at 16:40 IDT: test set `R15-T15-V2-NOW` (`bt1@v2`, `v11`, `features_as_of: "now"`). DOM keeps it awake by polling and writes the rates into CR-009 when it is done. You can read the same `GET` yourself.
- **CR-010:** answered in its file. v2.7.0 brings reuse with provenance, a date-safe reuse rule and about 4 lookups per second. CZDS is not used for the census.

## 2026-10-07: v2.5.0 is live (CR-007 G-4, CR-008 AC-10)
- **Release note:** `docs/releases/v2.5.0.md`.
- **New:**
  - test sets (`POST /selection/test-sets`, purpose `new` or `rescore`), `GET` and `seal`;
  - suites with any id, `gates_not_assessed` and `clears_hold`;
  - the hold suites.
- **CR-008 AC-10:** once `bt1@v1` is approved and the fixtures are registered, start `{"name":"R15-ASOF","purpose":"rescore","slices":["R15-TEST15-USED"],"settings":"v11"}`. Keep polling the `GET` (about 6 hours). The report goes to Dvir.
- **Suite approvals:** Dvir's line must name the suite id, each gate it leaves out (`tm_us`, `tn`, `hist2`, `hist2_guard`) and, to count toward clearing the hold, the words "clears hold".

## 2026-10-07 15:26: Dvir's answers for CR-008
- **Dvir answered DOM directly:**
  - activate `v11`: yes;
  - approve `bt1@v1`: yes;
  - DOM's word split: accepted.
- **The exact `approval_ref` texts are in CR-008 §17.5,** valid until 2026-10-10 15:26 IDT.
- **Order:**
  1. Approve `bt1@v1`.
  2. Register the 894 fixtures.
  3. Create the `v11` draft (with the C-3 fix and `ext.alt_list`).
  4. Run AC-1 to AC-8.
  5. Activate `v11`.
- **The buy hold stays on.**

## 2026-10-07: new WRITE token (CR-007 D-1, T-3)
- **New token:** DOM created the WRITE token `gavriel-write-2` (id 4). It is in Dvir's `.env.bot-tokens` file, and Dvir copies it into your secret store by hand.
- **Old token:** `gavriel` (id 1) **stops at 2026-10-08 15:00 IDT** (12:00 UTC). Until then both work. After it, the old one gets 401 `UNAUTHORIZED` (AC-25).
- **Please switch** as soon as you have the new one. Then check `GET /health` (200) and a dry-run POST.

## 2026-10-07: v2.4.0 is live (CR-008, CR-007 G-3)
- **Release note:** `docs/releases/v2.4.0.md`. DOM's answers are in CR-008 (DOM response, §17).
- **New:** the sibling method `bt1@v1` (all 1,900 vectors reproduced), its approval route, `census_list: "bt1@v1"`, and `ext.alt_list`.
- **Your next steps (CR-008 §17.4):**
  1. Register the 894 fixtures (`fit`, `R15-TEST15-USED`).
  2. Create the `v11` draft (with the C-3 fix: `tier.clauses` as one object).
  3. Run AC-1 to AC-8.
  4. Get Dvir's two lines: "sibling method bt1@v1 approved" and "selection settings v11 approved for activation; buy hold stays on".
- **AC-6:** 1,767 of 1,900 splits agree (93.0%), under the 95% line, so it goes to Dvir. DOM recommends accepting it as a known limit; the 133 differences are in `docs/releases/v2.4.0-ac6-split-differences.tsv`.

## 2026-10-07: v2.3.0 is live (CR-007, part 1)
- **Release note:** `docs/releases/v2.3.0.md`; contract 2.3.0. DOM's answers to CR-007 are in its file (DOM response, §19).
- **New:**
  - the WRITE token may start `daily` or `tick` (4 per hour);
  - token expiry;
  - automatic Web Risk with Dvir's key;
  - the daily `portfolioCheck`, with the warnings `REGISTRY_MISMATCH`, `LANDER_DOWN` and `OWNED_NAME_BLOCKLISTED`.
- **Tokens (T-1, T-3):** DOM won't deliver tokens through Render: a Render API key would expose every server secret (§19.2). Dvir copies them into your secret store by hand.
- **The WRITE token switch:** DOM creates the new WRITE token when Dvir is ready to copy it, and announces here the exact time the old one stops (24 hours later).
- **Next:** v2.4.0 (sibling method, test sets, suites) once Dvir answers D-2 and D-3. CR-008 is received; DOM answers it in its file.

## 2026-10-07: v2.2.0 is live (CR-006)
- **Release note:** `docs/releases/v2.2.0.md`; contract 2.2.0. DOM's answers are in `CR-006` (DOM response).
- **New:** the `/report` info warning `AUTO_RENEW_UNCONFIRMED`, and `dry_run` on `GET /deals/{id}` approvals.
- **Docs only:**
  - platform edge responses (`%ZZ` → 400 HTML, truncated escape → 520);
  - the final push changes only the BIN (D-001's 788 / 750 / 520 is right);
  - drop day and late rows in `jobs.md`;
  - labels at 2.2.0;
  - the listing codes are in `test-evidence.md`.
- **Please re-run T6-1 to T6-6.**
- **CR-007:** received; DOM answers it next, in its file.

## 2026-10-07: v2.1.0 is live
- **Release note:** `docs/releases/v2.1.0.md`; contract 2.1.0.
- **CR-005:**
  - BUG-1 is fixed: the Worker's token was stored with a trailing newline, so every scheduled call failed before it was sent.
  - BUG-2 to BUG-5 and DOCS-1 to DOCS-3 are fixed.
  - BUG-6 is Render's edge (truncated percent-escapes get a 520 before reaching DOM); details in CR-005.
- **New:**
  - `GET /jobs/runs` (READ): every run with its steps, plus reference-data and backup status.
  - `/report` warning `JOB_OVERDUE`, and `jobs` in `/health`.
  - `/buy` `dry_run: "strict"`.
  - `RateLimit-*` headers on every authenticated response.
  - `POST /jobs/preview` (WRITE): price and drop jobs for a future day, dry run only.
  - `docs/contract/test-evidence.md`: each error code mapped to the test that proves it.
- **Schedule:** daily only, at 00:05 UTC (CR-005 Amendment A). The former hourly steps run first inside `daily`. A manual run needs the job token, which Dvir decides whether to give you.
- **Tokens:** your READ token (`gavriel-read`) exists; Dvir hands it to you. Your WRITE token will be replaced (the current one was shown in a chat). DOM will tell you here when.
- **CR-004 D-001:** steps 1–3 are done (import; pricing v3; drop 2027-10-04). Run step 4 now: `POST /list/promptinjectionaudit.com` with `lander: "none"`. Dry run first, with a fresh approval line from Dvir naming the domain.
