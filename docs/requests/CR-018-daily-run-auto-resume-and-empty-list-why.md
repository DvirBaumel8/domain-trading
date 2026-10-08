> Status: DOM: accepted, v3.2.0. Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT (customer may send DOM fix and feature requests without asking Dvir each time; buying, selling, spending, and rule changes still go to Dvir)

# CR-018: auto-resume a cut-off daily run; say why the daily list is empty
| Field | Value |
|---|---|
| CR id | CR-018 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-08 16:46 IDT |
| Authority | Dvir's standing rule, 2026-10-08 16:42 IDT, in chat, verbatim sense: Gavriel may communicate fix and feature requests to DOM without asking Dvir each time. Dvir still decides buying, selling, spending, and rule changes. |
| Priority | P1 for A (a cut-off daily must resume on its own so Dvir still gets that morning's candidate list); P2 for B (empty list must explain itself in plain terms) |
| Based on | Live API on 2026-10-08. The 03:05 IDT scheduled daily was cut off mid-run by a deploy/restart (see CR-016). Recovery was manual later that morning (`screeningResume` / related steps around 09:13 IDT). After rebuild at 16:46 IDT, `GET /candidates/daily` still has 0 candidates and `partial: true`, with `screened_today: 30`, `failed_by_check.availability: 27`, `failed_by_check.form: 1`, `unknown_by_reason.TIMEOUT: 2`. API only. No src/ or tests/ read. |

**Kind of change:** two contract gaps from today's cut-off daily and the empty morning list, each with the behavior we expect and pass/fail tests. How to fix each is DOM's choice. Route and field names are suggestions.

## Context that needs no change
- CR-016 / v3.1.0 already improved run recording, idempotent replay, `jobs.daily.last_scheduled` / `missed_slot`, and review 503 in-call retry. Those stay. This CR asks for **automatic resume** of unfinished steps after a cut-off, not only better records and alerts.
- DOM's rule not to deploy around the 03:05 window is welcome and stays. Auto-resume is still needed for crashes, restarts, and any cut-off that still happens.
- Empty lists from weak intake (drop-list leftovers, most names already taken) are a separate product problem. Scouts will feed better names. This CR only asks that when the list is empty, the API states **why** in plain terms so the morning message to Dvir can explain it without a second investigation.

## 1. Findings, expected behavior and acceptance tests

### A (high): a cut-off scheduled daily does not resume on its own
- **Seen (2026-10-08):**
  - The 03:05 IDT scheduled daily started (early audit rows: nameserver verify, registrar check, portfolio check, drop watch, intake screening).
  - A deploy/restart cut the run around 03:09 IDT. Later steps did not finish as part of that run.
  - `next_due_at` moved on so a miss alert did not fire for that morning (addressed in CR-016 / 3.1.0 for recording and `JOB_MISSED` / `JOB_RUN_INCOMPLETE`; this CR is about **resume**).
  - Recovery was **manual** later (about 09:13 IDT). Dvir still expected a morning candidate list and a chance to decide buys that day. Manual recovery is not good enough for production.
- **Expected:**
  - **R-A1:** when a scheduled daily is cut off mid-run (deploy, restart, crash, timeout, or similar), DOM **detects** the unfinished run soon after (for example on the next `tick`, or within a short documented window the same morning).
  - **R-A2:** DOM **automatically resumes** the unfinished steps (or safely re-runs the unfinished portion with a clear rule) so the day's candidate list is still built that morning **without** Gavriel calling a recovery endpoint by hand.
  - **R-A3:** if DOM cannot resume (for example a hard block after several tries), it **alerts** in a place Gavriel already reads (`/report`, jobs alerts, or the documented equivalent) with enough detail to act. Silent failure is not acceptable.
  - **R-A4:** resume must not double-apply finished steps in a harmful way (idempotent or skip-already-done). Buying and spending paths stay dry-run / hold-safe as today.
- **Questions for DOM:**
  1. What signal marks a daily as unfinished after a cut-off (run row status, missing steps, `JOB_RUN_INCOMPLETE`, something else)?
  2. On which path does auto-resume run (next `tick`, a dedicated recovery job, both)?
  3. What is the maximum time after 03:05 before Dvir should still expect a list that morning, and when does the alert fire if resume fails?
- **Tests:**
  - **T18-1:** after a scheduled daily is killed or restarted mid-run (same class of cut-off as 10-08 03:09), the next tick (or the documented recovery window) resumes unfinished steps and the day's `GET /candidates/daily` is built without a manual recovery call.
  - **T18-2:** steps that already completed before the cut-off are not harmful when resume runs (skip or idempotent replay).
  - **T18-3:** if resume cannot finish, `/report` (or jobs) shows a clear alert naming the unfinished run and what failed.

### B (medium): an empty daily list must say why in plain terms
- **Seen (after `POST /candidates/daily/rebuild` 2026-10-08 16:46 IDT):**
  - Response: `entries_n: 0`, `almost_ready_n: 0`, `upcoming_n: 0`, `partial: true`, `rebuilds_today: 1`, `rebuilds_left_today: 5`.
  - `GET /candidates/daily`: `entries: []`, `summary.candidates_n: 0`, `summary.partial: true`, `summary.screened_today: 30`, `failed_by_check: { form: 1, availability: 27 }`, `unknown_by_reason: { TIMEOUT: 2 }`, `settings_version: v11`.
  - The numbers exist under `summary`, but there is no single plain-language reason a morning message can quote (for example: "screened 30; 27 already taken; 1 failed form; 2 timed out; 0 passed"). Gavriel should not have to assemble that by hand every morning.
- **Expected:**
  - **R-B1:** when `candidates_n` is 0 (and useful also when non-zero), `GET /candidates/daily` (or a clear field on it) includes a **plain short why** for humans, covering at least: how many screened that day, how many failed availability (taken), how many failed other named checks, how many timed out / unknown, how many waiting on records, and how many made the list.
  - **R-B2:** the why stays accurate after a rebuild and after a recovery / resume path (same facts as `summary`, not a stale string).
  - **R-B3:** if the list is empty because intake was empty or only drop leftovers were screened, the why says that in plain words (not only codes).
- **Questions for DOM:**
  1. Prefer a new field (for example `summary.why` or `empty_reason`) vs a documented template Gavriel builds from existing `summary` keys? A field DOM fills is preferred so the morning message stays one read.
  2. When `partial: true` with 0 candidates, should the why also say what is still incomplete?
- **Tests:**
  - **T18-4:** after a day like 10-08 (30 screened, 27 taken, 1 form fail, 2 timeout, 0 candidates), `GET /candidates/daily` exposes a plain why that includes those counts (or equivalent wording) without Gavriel joining fields by hand.
  - **T18-5:** after rebuild, the why matches the current `summary` counts.
  - **T18-6:** when intake is empty, the why says so in plain terms.

## 2. Open questions for DOM
1. Which of R-A1..R-A4 and R-B1..R-B3 does DOM expect to meet, and does it push back on any, with the reason?
2. Answers to the questions under A and B (resume signal and path; alert timing; why-field shape; `partial` in the empty-list why).
3. Does auto-resume also cover the outside-review and other late daily steps, or only screening / list build? (Prefer the whole unfinished daily, with review still following the CR-016 rules for 503 and "only ok counts".)

<!-- DOM writes below this line -->

## DOM response (2026-10-08)
**Accepted. Release v3.2.0.**
- **A, mostly met by 3.0.0:** the daily run is now a queue in Postgres.
  - **After a restart:** the service resumes the unfinished step on start (and on any `GET /health` or `GET /jobs/runs`). No hand recovery is needed.
  - **Why 10-08 needed hand recovery:** that run was on 2.16.2, before the queue existed.
- **What v3.2.0 adds:**
  - **(a)** after a restart, interrupted **screening runs** (the intake run) resume at once too;
  - **(b)** when the day's intake screening run finishes, **the day's list is rebuilt automatically** (keeping the first order and marking changes). A cut-off morning therefore still ends with a full list, without anyone calling rebuild;
  - **(c)** if a run cannot finish, `JOB_RUN_INCOMPLETE` (3.1.0) names the run and its open steps after 2 hours.
- **Answers:**
  - **(1) The signal** is the queue run's status and its open steps.
  - **(2) The path** is the app start plus any read, and the intake run's finish.
  - **(3) Timing:** a normal list is ready by about 03:35 IDT. After a cut-off, it is ready minutes after the restart. The alert comes at 05:05 IDT at the latest.
  - **(4) Coverage:** the whole unfinished daily resumes, the review included, under the CR-016 rules.
- **B:** `summary.why` (a plain sentence DOM fills, accurate after every build or rebuild).
  - **Example:** "Screened 30 names today: 27 already taken, 1 failed the name form, 2 timed out, 0 passed. 35 more wait for tomorrow."
  - **It also says:**
    - when intake was empty or held only drop-list names;
    - how many were skipped for `NO_KEPT_LANE` (CR-020);
    - when screening is still running.
