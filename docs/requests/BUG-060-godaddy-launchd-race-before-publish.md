---
id: BUG-060
kind: BUG
status: done
owner_bot: dom-architect
approval: "none-needed (datasave schedule / seal correctness; no money; daily GoDaddy path broken when publish lags launchd)"
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
repro_test: "Given GoDaddy inventory Last-Modified still yesterday at 15:05 UTC and today's files appear ~15:07 UTC, When Mac launchd datasave runs at ~15:05 UTC, Then godaddyInventory must not report a lasting ok for yesterday's sealed day as today's save — either wait/retry until data_date is today UTC, or start at ~15:30 UTC so today's files are present; /snapshots/missing must not list today after a successful morning save."
---
> Status: Approved — BUILD NOW (maintenance; daily GoDaddy seal race)

# BUG-060: Mac datasave at 15:05 UTC seals yesterday when GoDaddy publishes ~15:07 UTC

| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot) |
| Date | 2026-10-28 ~18:25 IDT |
| Type | Bug / maintenance (allowed under freeze) |
| Build | Fix launchd / godaddyInventory timing so today's GoDaddy inventory is sealed without a manual WRITE rerun. No money. |

## Call made / expected / got
- **Call:** scheduled Mac datasave `run_9a1ec5a7-008f-45c5-97cc-f3e42c1671a3` started **2026-10-28T17:05:05+02:00** (= 15:05 UTC) on live **5.72.1**.
- **Expected:** `godaddyInventory` for **data_date 2026-10-28** with five `complete` sealed files; `/snapshots/missing` does not list 2026-10-28.
- **Got:**
  - Step `ok: true` in ~3 s (re-read of **already sealed 2026-10-27**): summary `data_date: 2026-10-27`, all five files `last_modified` on 2026-10-27 (~16:49–16:50 IDT).
  - No retry queued (step looked successful).
  - `/snapshots/missing` listed **2026-10-28** until Gavriel's WRITE rerun `run_e83e1a19-…` (~18:02 IDT) fetched today's files (`last_modified` ~17:07–17:08 IDT = ~15:07–15:08 UTC).
  - GoDaddy's publish today was **after** 15:05 UTC; launchd fired on the early side of the window.

## Why (working hypothesis — confirm in DOM response)
`com.domaintrading.datasave` triggers at minute 5 from 15:00 UTC (`runbook.md` v5.46.0). Contract said 15:00 UTC is "after GoDaddy's inventory rebuild (about 14:40 UTC)", but today's publish was ~15:07 UTC. When the host still sees yesterday's `metadata.json` / files, `godaddyInventory` treats sealed yesterday as success (`SNAPSHOT_SEALED` / complete), so the 60-minute retry never runs and Buyer has no today path until a human WRITE datasave.

## Rules
- R-1 A datasave whose wall-clock UTC day is **D** must end with GoDaddy `data_date == D` sealed (five expected files complete), or `ok: false` / explicit miss that queues retry — never a lasting `ok: true` whose only sealed day is **D−1** while D is still unpublished or missing.
- R-2 Lasting fix (pick one or both, document in `runbook.md` + `jobs.md`): start Mac trigger at **~15:30 UTC**, and/or **retry** when `godaddyInventory` summary `data_date` ≠ today UTC (or today's files absent from the official host) — same 60-minute retry path as a hard fetch failure, once per day.
- R-3 Do not invent backfill for past missing days; only fix forward timing/retry for the current UTC day.
- R-4 No money / no registrar buy / no settings activation beyond schedule + retry behavior.

## Acceptance tests
- AT-1 **Fixture / clock:** at 15:05 UTC with host metadata still on D−1, step does **not** finalize the day as success for D; either waits, fails open for retry, or is not scheduled yet (15:30).
- AT-2 **Retry:** when `data_date` ≠ today UTC (or today's five files missing), one retry run is queued (or the later hourly catch-up) and seals **today** once GoDaddy publishes — without WRITE from a bot.
- AT-3 **Live intent:** after ship, a normal morning save leaves `/snapshots/missing` without **today**; `GET /jobs/runs?job=datasave` `godaddyInventory.summary.data_date` equals today UTC.
- AT-4 **Negative:** no money routes; secrets never logged; sealed yesterday is never rewritten.

## Out of scope
- Backfilling 2026-10-15..10-19 (still missing; leave as missing).
- Dynadot aftermarket / dqMarket (BUG-061 / BUG-062).

## DVIR items
None.

## Evidence
- Primary run `run_9a1ec5a7-…` 17:05–17:27 IDT; GD files dated 2026-10-27.
- WRITE repair `run_e83e1a19-…` sealed 2026-10-28 five files ~18:03 IDT.
- Lesson line 2026-10-28 ~18:05 IST in `lessons/dom-architect.md`.

## BUILD NOW — Claude Code (Architect kickoff 2026-10-28 ~18:25 IDT)
Gavriel: Dvir does not kick off Claude Code; Architect drives this. **Build immediately.** Max 2 rounds. No money. Report when live on `/health`. Stamp `## DOM response` in this file + one line in `DOM-TO-GAVRIEL.md`.

Focus: Mac datasave must seal **today's** GoDaddy inventory — start later (~15:30 UTC) and/or retry when `data_date` is not today.

## DOM response (28 Oct 2026, ~19:40 IDT): fixed in 5.73.0

**Verdict:** accepted, built. Root cause confirmed: GoDaddy's files were dated 15:07 UTC, and the Mac trigger ran at 15:05.
- **Fix (R-2, the retry option):** `godaddyInventory` now fails when the newest file day is older than the run's UTC day. The summary gets `failed: [{file: "metadata.json", status: "error", error: "GODADDY_NOT_PUBLISHED: newest file day D-1, run day D"}]`, and the existing 60-minute `datasave-retry` run seals today. No bot WRITE is needed (AT-1, AT-2).
- **Not changed:** the trigger time. With the retry in place, 15:05 stays, so on time days lose nothing. Yesterday's sealed day is never rewritten (AT-4).
- **Tests:** DS573-1. DS550-1 and RPY81-6 fixtures now publish files dated on the run day.
- **AT-3 (live):** check after the next datasave: `/snapshots/missing` should not list today, and `godaddyInventory.summary.data_date` should equal today (after the retry, when GoDaddy is late).
