> Status: DOM: accepted, v3.3.0. Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT (customer may send DOM fix and feature requests without asking Dvir each time; buying, selling, spending, and rule changes still go to Dvir). Business need stated by Dvir on 2026-10-08 ~18:00 IDT (below).

# CR-021: on-demand screening so we can run the full flow without waiting for 03:05
| Field | Value |
|---|---|
| CR id | CR-021 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-08 18:25 IDT |
| Dvir's need | 2026-10-08 ~18:00 IDT, in chat, sense: he wants to trigger our full flow now (scouts → intake → screening → daily list → his decision) and not wait for the next 03:05 daily run. He also said to wait for DOM to adjust the software, then try. |
| Authority to send | Dvir's standing rule, 2026-10-08 16:42 IDT. |
| Priority | P1. Without this, an on-demand full flow cannot finish the same day once the 03:05 run has used the screening budget, and a morning with no good names leaves Dvir with nothing until tomorrow. |
| Based on | Live API and contract docs only (`jobs.md` daily row, `endpoints.md` intake / candidates / jobs). No src/ or tests/ read. |
| Related | CR-018 (auto-resume and empty-list why), CR-020 (scout names first in the budget). This CR does not change those; it adds a separate on-demand path. |

**Kind of change:** behavior we expect, with pass/fail tests. How to build it is DOM's choice. Route and field names are suggestions.

## Why this is needed
Today, screening of pending intake names only happens inside the scheduled daily run (about 03:05 IDT). That run has a 30-name-a-day limit. Once it has used that limit, we cannot screen more names the same day through the normal path. Dvir wants to be able to run our full company flow on demand: scouts send finds, we intake them, DOM screens them, the daily list rebuilds, and he decides. Waiting until the next 03:05 breaks that.

We need a way to say "screen what is waiting now, and refresh the list," with its own small daily allowance that does not steal from the 03:05 run's quota and does not use the outside-review slot.

## A (P1): on-demand screening endpoint
- **Seen:** screening runs as a step of the scheduled daily. There is no documented caller path to screen pending intake names and rebuild the daily list outside that run. After the 03:05 budget is used, new scout names wait until the next day.
- **Expected:**
  - **R-A1:** a write endpoint, for example `POST /candidates/screen`, that screens pending intake names right away (oldest first, same order rules as the daily intake screening, including CR-020 scout-first when that is live) and then rebuilds the daily list so `GET /candidates/daily` shows the new results.
  - **R-A2:** it has its **own** daily allowance, separate from the scheduled daily's screening quota. Suggested default: **30 extra names a day**, stored in settings (for example `intake.on_demand_screen_daily_max`, default 30). Changing the default later is a settings draft that needs Dvir's line; shipping the key with default 30 is fine.
  - **R-A3:** using this endpoint does **not** reduce the 03:05 run's screening quota, and does **not** use or trigger the outside-review slot (or any other late daily step that is not screening + list rebuild).
  - **R-A4:** every call requires an `Idempotency-Key` (same rule as other POSTs). Replaying the same key is safe: same result, no double-spend of the on-demand allowance, no second harmful side effect.
  - **R-A5:** each on-demand screening is recorded in `/jobs/runs` (or the documented jobs run list) with a clear kind or step name (for example `onDemandScreen` / `intakeScreeningOnDemand`) so we can see it started, finished, how many names it took, and any errors.
  - **R-A6:** if there are no pending intake names, the call still succeeds in a documented way (empty screen + rebuild or a clear no-op response), does not invent names, and does not burn the allowance for names it did not screen (or documents clearly if a call with zero pending still counts as one run against a run-count cap — prefer counting only names actually screened).
  - **R-A7:** if the on-demand allowance is already used up for the day, the call returns a clear error (for example 409 with a reason like `ON_DEMAND_SCREEN_CAP`) and screens nothing.
  - **R-A8:** buying, spending, and the buy hold stay untouched. This path only screens and rebuilds the list.
- **Tests:**
  - **T21-1:** with pending intake names and on-demand allowance left, `POST /candidates/screen` (with Idempotency-Key) screens up to the on-demand max, rebuilds the list, and those names can appear on `GET /candidates/daily` the same day without waiting for 03:05.
  - **T21-2:** after the scheduled daily has already screened its 30, an on-demand call can still screen up to its own allowance; the next 03:05 run still gets its full scheduled quota.
  - **T21-3:** replaying the same Idempotency-Key returns the same run result and does not screen more names or use more allowance.
  - **T21-4:** a new key after the on-demand allowance is exhausted gets a clear cap error and screens 0.
  - **T21-5:** the run appears on `/jobs/runs` with status and counts.
  - **T21-6:** the call does not create or consume an outside-review attempt.

## B (P1): daily list shows which screening run each candidate came from
- **Why:** when we mix the 03:05 run and one or more on-demand runs the same day, Dvir's message and our QA need to know which run produced each name.
- **Expected:**
  - **R-B1:** each entry on `GET /candidates/daily` (and useful also on `almost_ready` / `upcoming` if those share the same shape) includes a clear link to the screening run that produced it, for example `screening_run_id` and/or `screened_in` matching the `/jobs/runs` id (or step id) from R-A5.
  - **R-B2:** names from the scheduled daily and from on-demand runs are both labeled this way. Missing only when a name was never screened (should not appear as a candidate).
  - **R-B3:** a rebuild does not wipe or invent the run link; it keeps the run that actually screened the name.
- **Tests:**
  - **T21-7:** after an on-demand screen that produces at least one candidate, that entry's run id matches the on-demand run on `/jobs/runs`.
  - **T21-8:** after the next scheduled daily, candidates from that daily show the scheduled run id; earlier on-demand candidates keep theirs.
  - **T21-9:** after `POST /candidates/daily/rebuild`, the run links on existing candidates stay the same.

## C (P2): settings shape (no secret activation)
- **Expected:**
  - **R-C1:** the on-demand daily max is a settings key with default 30. Shipping the key does not change any other active setting.
  - **R-C2:** activating a draft that changes that max still needs Dvir's own line naming the draft, same as other selection settings.
- **Tests:**
  - **T21-10:** after deploy, `GET /selection/settings` (or the documented settings read) shows the new key at default 30 and the previously active settings version otherwise unchanged.

## What we need back
1. Which of R-A1 to R-C2 you expect to meet, and any you push back on, with the reason.
2. The exact route, request body (if any), settings key names, and how `/jobs/runs` labels the on-demand run.
3. Whether on-demand screening may run while a scheduled daily is in progress, or must wait (prefer a clear 409 over silent interleaving).
4. The release version and its caller-visible change list, as before.

<!-- DOM writes below this line -->

## DOM response (2026-10-09)
**Accepted. Release v3.3.0.**
- **A, the route:** `POST /candidates/screen` (WRITE, Idempotency-Key, audited, body `{}` or `{max_names?}`).
  - **What it does:** screens the waiting intake names right away, in the same order as the daily run (scout names first, then drop-list leftovers that fit a kept lane), then rebuilds the day's list.
  - **The answer:** 202 `{run_id, names_n, allowance: {daily_max, used_today, remaining}}`.
  - **The allowance:** its own, at most `intake.on_demand_screen_daily_max` names a day. The key is new in the settings schema with default 30, the active settings are unchanged, and a different value is a draft Dvir activates.
  - **What it doesn't touch:** the 03:05 run's quota, the outside review and every other late step, buying, spending and the buy hold.
  - **Only names screened count** toward the allowance. With nothing waiting, it answers 200 `{run_id: null, names_n: 0, skipped: "NO_NAMES"}`, uses no allowance and still rebuilds the list.
  - **Errors:** an empty allowance → 409 `ON_DEMAND_SCREEN_CAP` (`details.next_allowed_at`), nothing screened. A replay with the same key returns the first answer and screens nothing more.
- **R-A5:** each call is a job run on `GET /jobs/runs` with `job: "screen"` (trigger `manual`, `triggered_by` the token name) and the steps `onDemandScreen` and `buildDailyList`, with counts and errors.
- **Q3:** while a daily run or another screening run is going, the call answers 409 `ALREADY_RUNNING` (`details.run_id`). No interleaving.
- **B: already there.** Every list entry has `run_id`, the screening run that produced it, and a rebuild keeps it. From 3.3.0 the `almost_ready` and `upcoming` rows carry it too, and `summary.screening_run_ids` lists every run of that day's builds.
- **C:** as above (T21-10).
