---
id: BUG-061
kind: BUG
status: done
owner_bot: dom-architect
approval: "none-needed (datasave dynadotAftermarket lock/timeout + GAP on failure; no money; daily panel incomplete)"
priority: P1
depends_on: [CR-080, BUG-057]
supersedes: []
max_rounds: 2
repro_test: "Given dynadotAftermarket needs ~40 minutes of REST v2 paging, When the datasave job or step lock expires mid-pull, Then the step must fail honestly, write a GAP (manifest status gap or box GAP.md), leave the day unsealed for a later run, and never finish with lock expired and neither seal nor GAP."
---
> Status: Approved — BUILD NOW (maintenance; aftermarket long-run lock)

# BUG-061: dynadotAftermarket "lock expired" leaves day with no seal and no GAP

| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot) |
| Date | 2026-10-28 ~18:25 IDT |
| Type | Bug / maintenance (allowed under freeze) |
| Build | Fix lock/timeout for the long aftermarket pull; always record GAP (or seal) so Buyer/Gavriel see the day. No money. |

## Call made / expected / got
- **Call:** datasave `run_9a1ec5a7-008f-45c5-97cc-f3e42c1671a3` step `dynadotAftermarket` on **5.72.1** (aftermarket last in plan since 5.65.0).
- **Expected:** seal for `data_date` 2026-10-28 with `rows_n > 0` (or honest `partial` / explicit `gap` per R-8), and `/snapshots?date=2026-10-28&source=dynadot_aftermarket` shows a manifest.
- **Got:**
  - Step `ok: false`, `error: "lock expired"`, `status: failed`, started **17:21:48+02:00**, finished **17:27:51+02:00** (~6 min; full pull is ~40 min / ~470 pages @ 5 s).
  - `summary: null` — no `gap`, no `rows_n`, no coverage.
  - `GET /snapshots?date=2026-10-28&source=dynadot_aftermarket` → **empty** `snapshots: []` (no seal, no gap manifest).
  - WRITE rerun `run_e83e1a19-…` can still pull/seal (day left open) — good — but primary left a silent hole until someone notices.

## Why (working hypothesis — confirm in DOM response)
Aftermarket is intentionally long (~40 min). The job/step lock (or an advisory lock around the pull) appears shorter than the pull, so the step dies with `lock expired` before seal or GAP. Contract already allows a later run or bot upload to seal a `gap`/`error` day; the bug is dying without either artifact.

## Rules
- R-1 Lock / step timeout for `dynadotAftermarket` must cover a full healthy pull (pages up to the documented cap, spacing `DYNADOT_CALL_SPACING_MS`) with headroom — or the pull must checkpoint/resume without needing the whole job lock for 40+ minutes.
- R-2 On failure (`lock expired`, timeout, crash after pages started): write an aftermarket **GAP** for that `data_date` (manifest `status: gap` with reason, **or** if no Dynadot call completed, still a durable note: box `data/raw/dynadot/<date>/panel/GAP.md` pattern and/or manifest error) so `/snapshots` and ops are not empty-silent.
- R-3 Do not invent rows. A later datasave or bot upload may still seal the day (existing dual-runner / SNAPSHOT_SEALED rules).
- R-4 `ok: false` on the step is fine; the **run** may stay non-ok; Buyer must be able to see "GAP / unsealed" without reading job error strings alone.
- R-5 No money / secrets never logged.

## Acceptance tests
- AT-1 **Fixture:** simulate lock expiry / timeout mid-aftermarket → step fails, **GAP or error manifest** exists for `data_date`, `sealed: false`, no invented rows.
- AT-2 **Timeout budget:** configured lock/timeout ≥ documented full-pull duration (+ margin), or resume/checkpoint is documented and tested.
- AT-3 **Live intent:** a failed aftermarket day is visible via `GET /snapshots?date=D&source=dynadot_aftermarket` (gap/error) or an explicit GAP file; never empty after a finished failed step.
- AT-4 **Recovery:** a later datasave can seal the same day (409 only after real seal).
- AT-5 **Negative:** no money routes; key/secret never in errors.

## Out of scope
- R-8 total-collapse rules (already in CR-080 / BUG-057).
- Closeouts partial pages 46–48 HTTP 500 (known partial seal; separate if needed).
- dqMarket integer overflow (BUG-062).

## DVIR items
None.

## Evidence
- `run_9a1ec5a7-…` aftermarket `lock expired` 17:21–17:27 IDT; snapshots aftermarket 2026-10-28 empty.
- Prior healthy seal: `run_b775e654-…` 2026-10-27 `rows_n: 377122`, `sealed: true`, `status: partial`.

## BUILD NOW — Claude Code (Architect kickoff 2026-10-28 ~18:25 IDT)
Gavriel: Dvir does not kick off Claude Code; Architect drives this. **Build immediately.** Max 2 rounds. No money. Report when live on `/health`. Stamp `## DOM response` + one line in `DOM-TO-GAVRIEL.md`.

Focus: aftermarket lock/timeout must survive a full pull; on failure always leave GAP (or seal), never empty silence.

## DOM response (28 Oct 2026, ~19:40 IDT): fixed in 5.73.0

**Verdict:** accepted, built. **The root cause was a process crash, not the lock length.** The step's budget is already 60 minutes (AT-2: `STEP_TIMEOUT_MS.dynadotAftermarket`, against about 40 minutes for a full pull). Host log `api.log`, 15:27:46 UTC:
- Neon closed a connection with `57P01` ("terminating connection due to administrator command").
- It was the connection that holds the `job:datasave` session lock: checked out from the pool for the whole run, with no error listener.
- Node treated the unhandled `error` event as fatal, and the server restarted.
- The new process found the step still `running` and failed it as `lock expired`.

Fixes:
- **No more crash:** `db/client.ts` `attachPoolErrorHandler` now also listens on every checked-out client. A dropped connection is logged as `db pool: checked-out client error`; the query that used it still fails normally (test DS573-3).
- **R-2 / AT-1 / AT-3, never empty silence:** when a datasave run ends with `dynadotCloseouts` or `dynadotAftermarket` failed (crash, `lock expired`, timeout, thrown error), the queue writes a manifest for the UTC day the step started on: `status: "error"`, `error: "STEP_FAILED: <step error>"`, origin `server`, unsealed, no rows. It never replaces a sealed day or an existing open row (so a `gap` stays a gap). Test DS573-2.
- **AT-4:** a later run or bot upload can still seal the day; the existing seal and 409 rules are unchanged.
- **Not done:** checkpoint/resume of the 40-minute pull. Not needed while the budget covers it; raise a CR if a pull ever runs past 60 minutes.
