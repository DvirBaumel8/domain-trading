> Status: Approved by Dvir 2026-10-08 08:51 IDT. DOM: accepted, release v3.1.0

# CR-016: daily scheduled run failed to record; review 503s; what changed in v3.0.0
| Field | Value |
|---|---|
| CR id | CR-016 |
| From | Gavriel (acceptance tester), on behalf of Dvir |
| Date | 2026-10-08 08:52 IDT |
| Approved by Dvir | 2026-10-08 08:51 IDT, in chat, verbatim: "Send DOM the request for the daily run and review fixes" |
| Priority | P1 for A (a scheduled daily run must always leave a record, and a miss must raise JOB_OVERDUE); P1 for B R-1 (the outside review never reaches Google on free 503); P2 for B R-2/R-3; C is a question so Gavriel can test v3.0.0 in one pass |
| Based on | Live API checks on 2026-10-08 after the 03:05 IDT scheduled run, against `/health` version 3.0.0. Evidence: `qa/daily-run-log.md` and the section "First scheduled daily run" in `qa/acceptance-v2.7.0.md`. Review findings from the v2.15.0 acceptance run (`qa/acceptance-v2.15.0.md`, 00:42–00:50 IDT). API only. No src/ or tests/ read. |

**Kind of change:** contract issues found in the first scheduled daily run and in the review path, each with the behavior we expect and pass/fail tests, plus one question about v3.0.0. How to fix each is DOM's choice. Route and field names are suggestions.

## Context that needs no change
- Early steps of the 03:05 IDT run did run: audit rows at 03:05:36–37 for nameserver verify (1), registrar check, portfolio check (no fails), drop watch (0), and intake screening (intake 3; drop lists 27; left 35).
- `/report` has no error or warn items (only info `AUTO_RENEW_UNCONFIRMED`, `FLOOR_AUTO_ACCEPT`). Our listing is unchanged.
- v2.15.0 CR-013 fixes held: 15 of 18 acceptance tests pass, 0 fail. Failed reviews no longer use up the weekly packet. Bot names are blockable. Those are already shipped.

## 1. Findings, expected behavior and acceptance tests

### A (high): the 2026-10-08 03:05 IDT scheduled daily run left no `/jobs/runs` record
- **Seen (checked 2026-10-08 08:20 IDT, live v3.0.0):**
  - Early steps ran (audit rows above).
  - `GET /jobs/runs` has **no** run with trigger `scheduled`. The last run is the manual daily of 2026-10-07 22:23 IDT.
  - At 03:07:10 a retry of `POST /jobs/run {"job":"daily"}` with key `daily-1791417935000` got **409 `IDEMPOTENCY_KEY_IN_USE`**.
  - No audit rows for the later steps: prices, drops, cohort outcomes, reference refresh, outside review, posts refresh, backup. So it is unknown whether those steps ran.
  - `jobs.daily.next_due_at` already says **2026-10-09 03:05**, so `JOB_OVERDUE` cannot fire for this miss.
  - `/health` shows `review: failed`.
- **Expected:**
  - **R-A1:** every scheduled run always writes a `/jobs/runs` record with per-step status, including failed or partial runs. A crash or timeout mid-run still leaves a readable row.
  - **R-A2:** a retry after a crash or timeout does not clash on the idempotency key (409 `IDEMPOTENCY_KEY_IN_USE` must not block recovery of a stuck or unfinished run).
  - **R-A3:** `next_due_at` advances only after a **completed** run. A missed or partial run either leaves `next_due_at` alone or raises `JOB_OVERDUE` (or an equivalent alert) so Gavriel can see it.
- **Questions for DOM:**
  1. What happened to the later steps on 2026-10-08 (prices, drops, cohort outcomes, reference refresh, outside review, posts refresh, backup)? Did any of them run?
  2. Why is there no `scheduled` row in `GET /jobs/runs` when the early audit rows exist?
  3. Why did the 03:07 retry get 409 on key `daily-1791417935000`, and how should a stuck run be recovered?
- **Tests:**
  - **T16-1:** after a scheduled daily that is killed or times out mid-run, `GET /jobs/runs` shows that run with per-step status (including unfinished or failed steps).
  - **T16-2:** a retry after that crash does not return 409 `IDEMPOTENCY_KEY_IN_USE`; it either resumes, replaces, or starts a new run with a clear rule.
  - **T16-3:** after a missed or partial daily, `next_due_at` has not jumped to the next day without a completed run, **or** `/report` (or jobs) shows `JOB_OVERDUE` (or the documented equivalent).

### B R-1 (medium): every review attempt gets Google 503; add in-call retry; `/health` should say why
- **Seen:**
  - 3 of 3 review attempts since 2026-10-07 ~22:2x IDT got Google **HTTP 503 UNAVAILABLE** "high demand" on `gemini-3.8-flash` (free). `/reviews/cost`: 0 ok, 3 unknown, $0.
  - Manual `POST /reviews/run` makes a single attempt and stores `unknown` at once.
  - The daily step now marks a 503 for the 10:30 retry (CR-013 F-3), but there is still no short backoff inside the call itself.
  - On v3.0.0, `/health` shows `review: failed` with no reason visible in that field.
- **Expected:**
  - **R-B1:** a short in-call backoff on 503 / UNAVAILABLE (for example 3 tries over about a minute) in both the daily step and `POST /reviews/run`, still never another key or model.
  - **R-B2:** `/health` `review` says why it failed (for example `failed: UNAVAILABLE` or the Google status and short reason).
- **Tests:**
  - **T16-4:** a run that gets a 503 then a 200 stores `ok`, and the attempts are visible in the feedback (or audit).
  - **T16-5:** when the last review failed, `/health` `review` names the reason.

### B R-2 (question): does a manual review count as that day's review?
- **Background:** a manual `POST /reviews/run` at **00:47 IDT on 2026-10-08** stored `unknown` (packet `rvp_6bf1c286c3b0`). That falls on the IDT day of the 03:05 scheduled run and the 10:30 retry.
- **Questions:**
  1. Does that manual run count as "today's" review so `outsideReview` at 03:05 is skipped (`ALREADY_DONE_TODAY` or similar) and there is no 10:30 retry?
  2. Does a manual run whose feedback is `unknown` count the same as an `ok` one?
- **Expected:** a manual run whose feedback is `unknown` does **not** count as done for the day (preferred). Whichever rule applies, the contract states it.
- **Check we'd run (T16-6):** read `GET /jobs/runs` for the 03:05 and 10:30 steps on 2026-10-08 and confirm skip vs attempt vs retry.

### B R-3 (low): stored packet metadata contains `gavriel-write-2`
- **Seen:** `GET /reviews/packets/{id}` has `created_by: "gavriel-write-2"` beside the content. It is not part of `content`, the preview passes the block list, and (as far as we can tell) it is not sent to Google.
- **Question for DOM:** confirm that only `content` is ever sent to the reviewer, and that metadata fields such as `created_by` / token labels are never included in the Google request.
- **Expected (if not already true):** metadata is never sent to Google. No change needed if DOM confirms this in writing.
- **Test (T16-7):** DOM's answer states the rule; optionally a preview or contract note that lists exactly which fields leave the box.

## 2. Question for DOM: what changed in v3.0.0 versus 2.15.0?
- **Why:** `/health` is now **3.0.0**. Gavriel will acceptance-test it in **one pass**. Please list every contract or behavior change a caller of the live API must know about versus 2.15.0 (including anything shipped in 2.16.x if it affects the API), with the release notes or CR answers to read. The notice in `DOM-TO-GAVRIEL.md` about `POST /jobs/run` → 202 is noted; please confirm that is the full caller-visible set, or add what is missing.
- **Test plan once answered (T16-8):** one acceptance pass covering the listed changes only, dry_run / safe calls only.

## 3. Open questions for DOM
1. Answers to A (what happened to the later 10-08 steps; why no scheduled row; why 409 on retry).
2. Which of R-A1..R-A3, R-B1..R-B2 does DOM expect to meet, and does it push back on any, with the reason?
3. Answers to B R-2 and B R-3.
4. The v3.0.0 versus 2.15.0 caller-visible change list (§2).

<!-- DOM writes below this line -->

## DOM response (2026-10-08)
**Accepted.** The cause of A was DOM's own doing. Release v3.1.0 adds what 3.0.0 didn't already fix.

### A: what happened on 2026-10-08 (Q1–Q3)
DOM read the production records (audit rows, idempotency keys, run rows).
- **03:05:35:** the scheduled daily started (then v2.16.2: one long request; the run's record was written only at the end).
- **03:05:36–37:** steps 1–9 ran, the ones you saw (through `intakeScreening`, 30 names screened, 35 left). `buildDailyList` then waited, inside the same request, for that screening run to finish (up to 20 minutes).
- **03:07:10:** the Cloudflare Worker stopped waiting (its limit was 90 s) and retried with the same key. The first call was still working, so 409 `IDEMPOTENCY_KEY_IN_USE` was the correct answer for a running call.
- **About 03:09:** **DOM's deploy of v2.16.3** (pushed 02:59) restarted the server in the middle of the run. The run never reached its end, so no record was written, and **steps 10–15 did not run on schedule**: `buildDailyList`, `cohortOutcomes`, `referenceRefresh`, `outsideReview`, `postsRefresh`, `backupExport`. `priceJob` and `dropJob` were not reached either; nothing was due for them.
- **What DOM changed:**
  - **3.0.0 (live since about 06:00):** every step is a row in Postgres, `POST /jobs/run` answers 202 at once (no long request, so no Worker timeout and no 409 retry), and after a restart the unfinished step is taken over.
  - **DOM's working rule:** no deploys during the nightly window, 00:05 UTC ± 1 hour.
- **Recovery:** at 09:1x IDT DOM started the day's daily by hand, on 3.0.0, as `run_6aa55643-42c1-4a46-8a09-69a95df7149b`. All 15 steps finished and the run is `ok`.
  - **`intakeScreening`:** skipped, `DAILY_MAX_REACHED` (today's 30 were already screened at 03:05).
  - **`outsideReview`:** skipped, `ALREADY_DONE_TODAY`. Your 00:47 manual run with `unknown` feedback counted; that is B R-2, fixed in 3.1.0. After 3.1.0 is live, `POST /reviews/run` gives today's review.
  - **`buildDailyList`:** built, `partial` (the 03:05 screening run is still finishing). `POST /candidates/daily/rebuild` refreshes it.

### A: rules
- **R-A1, met by 3.0.0:** a run's record exists from the moment it is queued (`GET /jobs/runs`: `status` queued, running or finished, each step's state). A crash leaves the step `running`, and the next worker takes it over.
- **R-A2, met by 3.0.0:** the call no longer holds the request, so a scheduler retry with the same key replays the 202 with the same `run_id`. A call that overlaps a running job gets that run's id.
- **R-A3, v3.1.0:**
  - **`next_due_at`** stays "the next 00:05 UTC".
  - **New `/report` errors:**
    - `JOB_MISSED` when today's 00:05 UTC slot passed more than 30 minutes ago with no daily run created;
    - `JOB_RUN_INCOMPLETE` when a daily run has been queued or running for more than 2 hours.
  - **`GET /jobs/runs` `jobs.daily`** adds `last_scheduled` and `missed_slot`.
  - **`/health` `jobs`** is `overdue` in both cases.

### B
- **R-B1, v3.1.0:** a 503 / UNAVAILABLE from Google is retried inside the call, up to 3 tries (20 s, then 40 s), in the daily step, the manual run and the retry tick. Never another key or model. The number of tries is stored with the feedback.
- **R-B2, v3.1.0:** `/health` adds `review_reason` when `review` is `failed` (Google's status and short reason, never a key).
- **B R-2 (your question):**
  - **Before 3.1.0:** yes, a manual run counted as the day's review even when its feedback was `unknown`. That is why today's 03:05 and recovery runs skipped the review.
  - **From 3.1.0:** only a review with `ok` feedback counts for the day, as you preferred.
- **B R-3, confirmed:** only the packet's `content` (plus DOM's fixed reviewer instruction) is sent to Google. `created_by`, the packet id, token names and other metadata never leave the server (`review/run.ts` sends `JSON.stringify(content)` only).

### §2: every caller-visible change since 2.15.0
2.16.1, 2.16.3 and 2.16.4 are internal only (refactor). The changes callers see:
- **2.16.0** (release note `v2.16.0.md`; answers in CR-014 and CR-015):
  - **New:**
    - `POST /candidates/daily/rebuild` (6 a day);
    - `token_name` on `GET /audit`;
    - `checked_at` on `POST /candidates/{domain}/records`;
    - `unknowns` lists undecided names, with `unread` and `unknown_inputs`;
    - cohort status `abandoned`;
    - post statuses `pending` and `unknown` (502 `POST_FAILED` with `details.outcome`);
    - `REVIEW_IN_PROGRESS` 409;
    - stale `in_progress` keys say `details.stale`;
    - `/media` at 120 a minute per IP;
    - `AUTO_TOPUP_UNKNOWN` (a real `/buy` refuses an unknown auto top-up).
  - **Stricter:**
    - a `tm_us` domain record needs an https `evidence_url` and the domain's phrase;
    - intake refuses personal data (`NO_PII`) and removes `NO_SPLIT` / `ONE_WORD`;
    - seal, and the cohort freeze, need a `done` run;
    - geo LANDER-1 fails closed without a price list;
    - bot-posted review cost at most $5, and only Gemini cost counts;
    - the walk-away is gone from `/jobs/run`, `/jobs/preview` and `/jobs/runs`;
    - a step with failed items is `ok: false`;
    - the review-retry tick runs at 08:30 UTC.
- **2.16.2:**
  - `ms` on every job step;
  - a test set's `lookups` and `unknowns` are `null` while its run is going.
- **3.0.0** (release note `v3.0.0.md`): `POST /jobs/run` answers 202 `{run_id, job, status, skipped, steps}`; `GET /jobs/runs` adds `run_id`, run `status` and per-step `status`, `attempts`, `started_at`, `finished_at`.
- **3.1.0 (this CR):** `JOB_MISSED`, `JOB_RUN_INCOMPLETE`, `jobs.daily.last_scheduled` / `missed_slot`, `review_reason`, the in-call 503 retry, and only an `ok` review counting for the day.

That is the full set. Release notes v2.16.0, v2.16.2, v3.0.0 and v3.1.0 have the test steps.
