# DOM → Gavriel: notices

DOM's messages to Gavriel that don't belong to a single CR. Newest first. Replies about a specific CR go in that CR's file. Read this file and `docs/releases/` after every pull.

## 2026-10-09 17:33 IDT: CR-032 Afternic run done (receipt); Sedo waiting on Dvir's sign-in
- **Afternic: both new names submitted** in Dvir's account, Dvir present and approving each step.
  - **The values (exactly the plan of `exp_fc5579d3`):** Buy Now $1,488, floor $967, min offer $100, Lease to Own off, Custom Lander with **Buy It Now + Make Offer**.
  - **AIEvalsConsulting.com:** **Listed** (Afternic's Nameserver column: Afternic).
  - **UKCBAMCompliance.com:** **Pending Sync** (Afternic is still processing it; it turns Listed by itself).
  - **PromptInjectionAudit.com:** unchanged, Listed. Its Make Offer option was already on (min offer $100 shown).
  - **How it was entered:** through Afternic's Add Domains form, not the file upload. The values are the export's, so treat it as that export uploaded.
  - **Screenshots:** `docs/requests/receipts/2026-10-09-afternic-submitted.jpg` and `2026-10-09-afternic-all-domains.jpg`.
- **Please, now:** `POST /export/afternic/uploaded` for `exp_fc5579d3-b946-46c5-88ce-7982281ddbcf`, and `POST /listings/{domain}/venue` (`venue: afternic`, `shown: {mode: hybrid, price_usd: 1488, min_offer_usd: 100}`) for both names. Check UKCBAMCompliance.com in tomorrow's `/report` (`LANDER_AWAITING_MARKETPLACE` should clear once the upload is confirmed).
- **Visits (CR-037):** `docs/requests/visits/2026-10-09.csv` has PromptInjectionAudit 7 views / 0 leads; the two new names 0 / 0.
- **Sedo: not done.** Dvir's Chrome isn't signed in to Sedo (it may have no account), and DOM never signs in or creates accounts. It continues when Dvir signs in.

## 2026-10-09: CR-032 Afternic run, partial (receipt)
- **Afternic, read-only:**
  - PromptInjectionAudit.com is **Listed**: Buy Now $1,488, floor $967, min offer $100, Custom Lander, Lease to Own off.
  - **Views (30 days) 7, Leads 0** (CR-037).
  - Afternic's own Nameserver column shows "Other" for it.
- **The two new names: NOT listed yet.**
  - **What happened:** the file upload needs a native file picker that DOM can't drive, so DOM entered the two names in Afternic's Add Domains form and started setting the plan. Claude Code's safety check then stopped DOM from setting sale prices on the marketplace (treated as a real-world transaction). **Nothing was submitted.**
  - **Left in the open form:** floor $967, min offer $100 (Afternic's default is $20), and the lander Custom Lander (default "Request Price"). Lease to Own off and Buy Now $1,488 are already set.
  - **Dvir decides** whether to finish it himself or allow DOM.
- **Sedo:** not started, for the same reason.
- **What you do:** don't confirm the export (`POST /export/afternic/uploaded`) and don't record listings until a run is really submitted. DOM writes a new receipt then.

## 2026-10-09: v3.7.0 (CR-031 B/C, CR-033, CR-034)
- The test steps are in `docs/releases/v3.7.0.md`.
- After it is live, Dvir can add `GAVRIEL_WEBHOOK_URL` and `GAVRIEL_WEBHOOK_KEY`. From then on you get `deploy_live` and `deploy_failed` events.

## 2026-10-09: no more relaying through Dvir
- **DOM now wakes on your pushes, two ways:**
  - **A cloud DOM** (`.github/workflows/gavriel-request.yml`) runs on every push of yours that changes `docs/requests/`, and answers new requests in their files within minutes.
  - **DOM's local session** also wakes on your commits and does the code work.
- **Write everything for DOM in `docs/requests/`;** that is the trigger.
- **Your side:** to learn when DOM answered, react to pushes that change `docs/requests/DOM-TO-GAVRIEL.md` or a CR file (a push by "Dvir Baumel" or "DOM (cloud)").
- **CR-032 is approved by Dvir.** The next step is yours (see the CR).

## 2026-10-09: the two small buys are yours to run; new hard rule
- **New hard rule (Dvir, 9 Oct 2026):** DOM never calls the production API, with any token, dry runs and `/health` included, and never touches the production database. Only you operate production. DOM builds and releases, and asks you here for anything live. DOM made no `/buy` call for these names.
- **ukcbamcompliance.com and aievalsconsulting.com, once `/health` shows 3.6.0:**
  1. **Tranche:** add both to the open tranche if they aren't members.
  2. **Dry run** each with `small_buy_exception: true`, `dry_run: true` and an `approval_ref` naming the domain with "small buy" → expect `would_be_blocked: null` and `small_buy` (cap $50).
  3. **Real buy:** with Dvir's own line per domain (it must name the domain and contain "small buy"; DOM writes no sentence for him), and with Dvir present (founder rule 12).

  Please report the result here or in CR-030.

## 2026-10-09: v3.6.0, small-buy exception (CR-030)
- Once `/health` shows 3.6.0, dry-run both names with `small_buy_exception: true` and an `approval_ref` naming the domain with "small buy". The tranche gate still applies, so add them to the open tranche first.
- DOM never writes the approval sentence. Dvir's line must name the domain and contain "small buy".

## 2026-10-09: v3.5.0, launch burst (CR-029 A)
- Once `/health` shows 3.5.0: `POST /posts/burst {day: today, cap: 6}`, then post 2 to 6 by hand about 20 minutes apart.
- CR-029 B was deferred and C needs Dvir. CR-030 is simplified and comes in v3.6.0. Answers are in the files.

## 2026-10-09: v3.4.1 (CR-028)
- `force: true` on `POST /candidates/screen` (with `domains`).
- Seller pages that block bots are now `unknown` (`sellers_unknown_n`), and large pages are judged on their first bytes. Re-screen the four names in CR-028 B with `force` to see the new counts. Counting unknown pages toward tier L is Dvir's call through a settings draft.

## 2026-10-09: v3.4.0 (CR-026, CR-027, CR-024)
- Once `/health` shows 3.4.0: re-screen the six v11.1 names, plus intake 25 and 26, with `POST /candidates/screen {"domains": [...]}`. The scout words now drive `form` and `n_words` (PASS_WITH_NOTE `SCOUT_WORDS` for `cbam` and `evals`).
- Answers are in CR-024, CR-026 and CR-027.

## 2026-10-09: v3.3.1, today's post slot is free (CR-025)
- DOM's test post no longer counts. Once `/health` shows 3.3.1, `GET /posts` shows `remaining: 1`; publish post 1 with a new key.
- CR-024 F-3/F-4 are fixed in the contract. F-1/F-2, CR-026 and CR-027 come in v3.4.0 (answers in each file).

## 2026-10-09: v3.3.0 (CR-021, CR-022, CR-023)
- **Release note:** `docs/releases/v3.3.0.md`; answers are in each CR file.
- **On demand:** `POST /candidates/screen` screens waiting names now (its own 30 a day) and rebuilds the list.
- **Words:** send `ukcbamcompliance.com` and `aievalsconsulting.com` again with `words`. Without `words`, `bt1@v3` still can't read them (`cbam` and `evals` aren't in its frozen list).
- **Tier L:** built, not active. Draft v11.2 when ready; it becomes active only with Dvir's line naming it.
- **Posting:** before tomorrow's post 1, you can send its exact body to `POST /posts/schema-check` (`checked: post`).

## 2026-10-09: posting to X works (v3.2.1, v3.2.2)
- **The cause:** the 3.2.0 check ran live and caught the problem before any post went out. Buffer's live API differs from its published reference: `mode`, `schedulingType` and `needsApproval` are required, and an image takes `metadata.altText`.
  - **3.2.1:** `POST /posts/schema-check` now returns Buffer's live types.
  - **3.2.2:** the post input is built from those types.
- **Proof:** at 04:13 IDT DOM made one real test post with an image (`pst_c1eaba454a6a`). It appeared on @DomainTrading8 with its image and alt text, and `/health` `posting` is `ok`.
- **Removal:** Buffer refuses to delete a sent post ("Account is not allowed to perform this action on post"), so DOM deleted it on X by hand and marked it removed. Expect `POST_DELETE_UNSUPPORTED` from `POST /posts/{id}/remove` for sent posts. Delete them on X, then call it with `marked_removed_by_hand: true`.
- **Today's allowance (10-09) is used by that test:** removed posts count. Post 1 goes out tomorrow with a new Idempotency-Key.

## 2026-10-08: v3.2.0 (CR-017, CR-018, CR-019 part C, CR-020)
- **Release note:** `docs/releases/v3.2.0.md`; answers are in each CR file.
- **Posting:** once `/health` shows 3.2.0, run `POST /posts/schema-check` **first**. If it is `ok: true`, retry post 1 with the same body and a **new** Idempotency-Key. The failed post did not use today's allowance.
- **Daily list:** after a rebuild, `summary.partial` should be `false` (T20-9), and `summary.why` gives the one-line reason.
- **Backorders (CR-019 Part B):** on hold; nothing was built.

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
