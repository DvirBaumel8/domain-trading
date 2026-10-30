---
id: CR-099
kind: CR
status: in_progress
owner_bot: dom-architect
approval: "Gavriel, P1 bug fix, 2026-10-30 18:02 IDT"
priority: P1
priority_note: "Ask (a) (LOW_COVERAGE + carry-forward, and mark Oct 30 LOW_COVERAGE retroactively) must land before tonight's daily run 00:05 UTC Oct 31 so episodes/DQ do not read ~400k missing Oct 30 names as gone; asks (b)-(d) can follow. No same-day re-pull."
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-099: Dynadot aftermarket low-coverage days (coverage floor, retry, re-pull)

## What happened
**Run.** Datasave `run_605e8d5c` (30 Oct, 17:25–17:54 IDT), step `dynadotAftermarket`:
- `sealed: true, status: partial`.
- **91 of 477 pages ok**: 70,725 rows received of `total_listings` 476,207. `listings_read_n` was 91,000, `invalid_n` 99 and `dropped_under_500_n` 20,176.
- **386 pages failed with HTTP 500**: pages 86, 89 and 90, then every page from 95 to 477.
- `elapsed_ms` was 602,916 (about 10 min), so a time cap may be cutting the step short.

**The pattern changed.** Oct 27–29 lost only about 5 pages a day (around every 102nd). On Oct 30 the server stopped answering partway through the run.

**Closeouts are partial too.** `dynadotCloseouts` lost its last 3 pages again (59–61 of 61; 58 ok, 57,684 rows). On Oct 29 it was 48–50 of 50.

## Asks
**(a) Coverage floor.**
- A day with fewer than **90% of planned pages ok** (a setting) is stored as `coverage_status: LOW_COVERAGE`. It shows in `/health` `datasave_detail` and in `/report`.
- On a LOW_COVERAGE day, the steps after the upload (`episodes`, the sold/gone/delist inference, `buildPanel` dynadot gone counts, `dqMarket`, `engineFeed` and training labels) must not read a missing name as gone, delisted or sold.
- For the missing pages, carry the previous day's rows forward and mark them as carried. This can be done by marking the names unknown for that day instead.
- `dqMarket` `coverage` fails on such a day.

**(b) Retry failed pages.**
- Inside the step, retry failed pages with exponential backoff and jitter while time is left.
- Then queue a later retry, like the GoDaddy 60-minute retry, that fetches only the failed pages and adds them to the same `data_date`.
- Stay within the Dynadot call and rate rules in the docs. Today used 97 aftermarket calls and 61 closeout calls.
- State the step's time cap in `jobs.md`. If the cap stopped the step, record that as the reason.

**(c) Documented re-pull.**
- Allow a re-pull of a day that is unsealed or LOW_COVERAGE: a documented `POST /jobs/run` option for this source only, with a WRITE token. It must be audited and must not run GoDaddy or the rest of the datasave.
- A full-coverage sealed day stays frozen.
- Document in `jobs.md` and `endpoints.md` who may run it and when.

**(d) Log closeouts tail 500s.**
- Record the failed closeouts pages per day: Oct 29 48–50, Oct 30 59–61, always the last 3.
- Find out whether the last pages fail because the page count is off by a few (an empty or out-of-range page answering 500) or because the server gives out. If they are just empty pages beyond the end, plan the page count to match and do not count them as failures.

## Note: price_sanity
- The Oct 30 `dqMarket` (run #18, 17:37 IDT) **passed**, with 0 jumps over 10×. The CR-096 samples are empty.
- The earlier 16 jumps (window from 2026-09-29) can't be recovered. They most likely came from Oct 28/29 aftermarket rows that retention has since rotated out.
- The Oct 30 DQ ran **before** the Dynadot steps (17:37 vs 17:38–17:44), so it did not see today's low coverage. Tomorrow's run will, and ask (a) is what stops that run from raising false gone/jump alerts.

## Check
- A day with 91/477 pages → `LOW_COVERAGE`, and episodes do not mark missing names as gone.
- The retry run adds the missing pages and the day's coverage rises.
- A re-pull of a full-coverage day → 409.
- A closeouts page past the end is not counted as failed.

## DOM response (30 Oct 2026, ~19:20 IDT)
**Verdict: accepted, built in 5.80.0.**

- **(a) Built.**
  - LOW_COVERAGE = under 90% of planned pages read.
  - It is a constant (`DYNADOT_MIN_COVERAGE`), not a setting: changing it is a release either way, and the seal guard needs the same number.
  - It is on the manifest and the step summary, in `/health.datasave_detail.dynadot_low_coverage`, and in the `/report` warning `DYNADOT_LOW_COVERAGE`.
  - The rule reads the page lists, so Oct 30 (91/477) is LOW_COVERAGE now, with no backfill.
  - **Instead of carrying rows forward,** the readers leave the day out. `episodes` folds only full days, so a name missing from a low day keeps its episode and stays open. `dqMarket` leaves the day out of survivorship, price sanity and the median, and fails `coverage` for it. The `buildPanel` Dynadot gone count uses full days.
  - `engineFeed` and the training labels: `engineFeed` reads GoDaddy only, and the labels come from `episodes`, so both are covered.
  - **Correction to the CR's risk:** the steps after an upload already tolerated one missing day. An episode survives a 7-day gap, and "open" is measured within 7 days. So Oct 30 alone would not have marked 400k names gone. Several low days in a row would have.
- **(b) Built.**
  - A failed page waits 15/30/60/120 s with jitter. Five in a row end a sweep, then one retry sweep runs.
  - Time budget: 50 min for the aftermarket and 25 min for closeouts, against step timeouts of 60 and 30 min. It is now stated in `jobs.md`.
  - `stopped_by` says why a read stopped. **Oct 30 was not a time cap:** it was three 500s in a row (pages 95–97).
  - A LOW_COVERAGE or error Dynadot step gets one retry run 60 min later that runs just that step. It reads only the missing pages and adds them to the same `data_date`.
  - Calls stay one at a time and 5 s apart.
- **(c) Built.** `POST /jobs/run {job: datasave, only: dynadot_aftermarket | dynadot_closeouts}`:
  - WRITE token only, audited; the job token gets 403;
  - today only, because Dynadot serves just the current lists;
  - 409 `SNAPSHOT_SEALED` for a full-coverage or bot-sealed day.
  - A LOW_COVERAGE server day takes the top-up: rows, sha256 and coverage change; the seal time, status and origin don't. The seal guard migration allows exactly that.
- **(d) Answered and fixed: they are pages past the end.**
  - Oct 29: 46,106 rows = 47 pages; 48–50 failed.
  - Oct 30: 57,684 rows = 58 pages; 59–61 failed.
  - The old loop read until an empty page, and Dynadot answers a page past the end with 500 instead of an empty list.
  - The closeouts pages are now planned from `data.total`, so those pages are never asked.
- **Check:** tests CR099-1..6. After the deploy DOM re-pulls Oct 30's aftermarket today and reports the coverage in `DOM-TO-GAVRIEL.md`.
