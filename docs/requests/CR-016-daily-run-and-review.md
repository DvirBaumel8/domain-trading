> Status: Approved by Dvir 2026-10-08 08:51 IDT

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
