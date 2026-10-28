---
id: BUG-062
kind: BUG
status: done
owner_bot: dom-architect
approval: "none-needed (datasave dqMarket integer overflow; no money; marks whole datasave ok=false)"
priority: P1
depends_on: [CR-075]
supersedes: []
max_rounds: 2
repro_test: "Given sealed market sources for the current data day, When datasave step dqMarket runs, Then it completes without 'integer out of range', stores DQ results, and does not alone force the datasave run ok=false; integer columns use types/clamps that fit observed aggregates."
---
> Status: Approved — BUILD NOW (maintenance; dqMarket overflow fails datasave)

# BUG-062: dqMarket fails with "integer out of range" and fails the datasave run

| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot) |
| Date | 2026-10-28 ~18:25 IDT |
| Type | Bug / maintenance (allowed under freeze) |
| Build | Fix dqMarket so integer fields cannot overflow Postgres; step stores checks; datasave is not ok=false solely from this. No money. |

## Call made / expected / got
- **Call:** datasave steps on **5.72.1**:
  - Primary `run_9a1ec5a7-…`: `dqMarket` **17:16:38–17:16:42+02:00** → `ok: false`, `error: "integer out of range"`, `status: failed`.
  - WRITE rerun `run_e83e1a19-…`: same failure again while other steps progressed.
- **Expected:** per contract (`jobs.md` / market DQ): `dqMarket` runs checks and stores `{status: "ok"|"alert", failed_checks, checks_n}`; a failed **check** is data (step stays ok) and may set `/health.dq_market` to `alert` / `/report` `DQ_MARKET_FAIL`. Step should not throw a DB integer overflow.
- **Got:** Postgres (or driver) **`integer out of range`**; step failed; whole datasave `ok: false` even when GoDaddy/Dynadot seals otherwise usable. `/health.dq_market` can still read `ok` from an older stored result — misleading vs the day's failed step.

## Why (working hypothesis — confirm in DOM response)
An aggregate or stored metric (counts, cents, episode stats, coverage totals) exceeds a signed 32-bit `integer` column or intermediate. Aftermarket/closeout scale (~hundreds of thousands of rows) makes this likely as sealed history grows. Needs wider type (`bigint`), clamp, or compute in bigint and store safely — plus a test with oversized fixtures.

## Rules
- R-1 `dqMarket` must never fail the step with raw `integer out of range`; use `bigint` (or clamp/document max) for every integer metric written by this step.
- R-2 Failed **DQ checks** remain data (`status: "alert"`, step `ok: true` per existing contract); only true infra errors may set step `ok: false`, and those must be coded (not opaque driver text alone).
- R-3 Add a regression test that would have overflowed int4 and now passes (AT below).
- R-4 No money / no venue calls from this step (unchanged).

## Acceptance tests
- AT-1 **Fixture:** DQ inputs with aggregates above `2^31-1` (or the offending column’s max) → step finishes `ok: true`, result stored, no `integer out of range`.
- AT-2 **Contract:** failed business checks → summary `status: "alert"`, step still `ok: true`.
- AT-3 **Live:** next datasave `dqMarket` on production completes without that error; `GET /jobs/runs?job=datasave` shows step ok; `/health.dq_market` matches the new result.
- AT-4 **Negative:** no money routes; no secrets in errors.

## Out of scope
- Redesigning DQ check definitions (unless required to pick safe types).
- GoDaddy launchd race (BUG-060); aftermarket lock (BUG-061).

## DVIR items
None.

## Evidence
- `run_9a1ec5a7-…` and `run_e83e1a19-…` both: `dqMarket` error `integer out of range`.
- Prior day `run_b775e654-…` (2026-10-27) `dqMarket` ok — regression with scale/new data.

## BUILD NOW — Claude Code (Architect kickoff 2026-10-28 ~18:25 IDT)
Gavriel: Dvir does not kick off Claude Code; Architect drives this. **Build immediately.** Max 2 rounds. No money. Report when live on `/health`. Stamp `## DOM response` + one line in `DOM-TO-GAVRIEL.md`.

Focus: stop `integer out of range` in `dqMarket`; bigint/clamp + test; step must not fail the daily datasave for overflow.

## DOM response (28 Oct 2026, ~19:40 IDT): fixed in 5.73.0

**Verdict:** accepted, built. Cause: the `price_sanity` check computed `prevp * 10` on `dynadot_rows.price_cents`, which is int4. A Dynadot listing over about $2.1M (214,748,365 cents) overflowed in Postgres.
- **Fix (R-1):** the per-day price is read as `min(price_cents)::bigint`. Every other number in the step is already bigint (`market_names`, `market_sales`) or a count.
- **R-2:** unchanged and still true: a failed check is `status: "alert"` with the step ok.
- **R-3 / AT-1:** test MK562-1 uses a $20M listing; without the fix it fails with `integer out of range`.
- **AT-3 (live):** the next datasave's `dqMarket` should be `ok`, and `/health.dq_market` should follow its result.
