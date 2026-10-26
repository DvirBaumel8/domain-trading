---
id: CR-080
kind: CR
status: approved
owner_bot: dom-architect
approval: "Gavriel 2026-10-26 (Dvir widget yes: write bot-logic stubs for top 3 jobs + dual-runner lock rule)"
priority: P1
depends_on: [CR-079]
supersedes: []
max_rounds: 2
---
# CR-080: bot-logic stubs home + dual-runner lock + DOM-primary daily seals

## Approval
Dvir answered yes on the widget "Start this plan?" — write bot-logic stubs for the top 3 jobs and the dual-runner lock rule (2026-10-26). Freeze override for this resilience item (token outage stopped daily seals). No money, no Dvir setup, no secrets.

## Why
Thin `company-state` is not enough for DOM to know when a step should be code. Grok token exhaustion (Oct 23–26) left GoDaddy/Dynadot/panel gaps. Dual performers need a lock so two runners never double-seal.

## What Gavriel already wrote (draft under docs/requests/)
Move these **verbatim** to `docs/bot-logic/` (create the folder):

| Source (this CR's draft) | Target |
|---|---|
| `docs/requests/bot-logic/README.md` | `docs/bot-logic/README.md` |
| `docs/requests/bot-logic/00-dual-runner-lock-rule.md` | `docs/bot-logic/00-dual-runner-lock-rule.md` |
| `docs/requests/bot-logic/01-godaddy-dynadot-daily-seal.md` | `docs/bot-logic/01-godaddy-dynadot-daily-seal.md` |
| `docs/requests/bot-logic/02-dynadot-panel-r8-watch.md` | `docs/bot-logic/02-dynadot-panel-r8-watch.md` |
| `docs/requests/bot-logic/03-missing-name-portfolio-check.md` | `docs/bot-logic/03-missing-name-portfolio-check.md` |

After the move, leave a one-line pointer in `docs/requests/bot-logic/README.md` to the new path (or delete the draft folder in the same commit — either is fine).

## Changes
1. **Place** the five files under `docs/bot-logic/` as above.
2. **Implement dual-runner lock (file first):**
   - Path (**chosen**): `docs/locks/<action>-<YYYY-MM-DD>.json` (documented in `docs/bot-logic/00-dual-runner-lock-rule.md` + `docs/locks/README.md`).
   - Schema: `{who, action, date, until_idt, key}` as in the stub / example.
   - Datasave step (Claude Code): claim / release / no-op-if-held. Same Idempotency-Key for same day+action.
3. **Make DOM primary for daily seals** (jobs 01 and 02):
   - Datasave (or equivalent) runs GoDaddy freeze + Dynadot closeout seal + R-8 panel watch with GAP rule, using the lock.
   - On success write lock for that day so Grok backup no-ops.
   - Do **not** invent backfill; write GAP for missing days.
4. Job 03 stays CR-079 (`portfolioCheck`); this CR only places its bot-logic stub — no second ownership check.

## Changes (round 1 — DOM Architect, 2026-10-26 ~23:45 IDT)

Bot-side done in this round (no `src/`):
1. Moved five stubs verbatim to `docs/bot-logic/` (pointer left at `docs/requests/bot-logic/README.md`).
2. Chose lock store: `docs/locks/<action>-<YYYY-MM-DD>.json`. Documented claim/no-op/release + same Idempotency-Key per day+action in `docs/locks/README.md`; worked example format only at `docs/locks/EXAMPLE-closeout-seal-YYYY-MM-DD.json` (not a live claim).
3. Job 03 remains documentation only; CR-079 stays folded into `portfolioCheck` (no `ownershipCheck`).
4. Oct 23–25 stay GAP — no invented backfill.

**Claude Code still owes (datasave-primary, still round ≤2):**
- Enforce file lock in datasave for actions `closeout-seal` and `panel-r8-watch` (claim before work; no-op if held by other; release on failure; keep on success; reuse same Idempotency-Key for day+action).
- Make DOM datasave **primary** for jobs 01 (GoDaddy freeze + Dynadot closeout seal) and 02 (R-8 panel watch + GAP). Grok is backup only behind the lock.
- GAP rule unchanged: do not upload collapsed panel totals; do not invent backfill; R-8v2 still needs 2 consecutive small-total days.
- Do **not** activate settings, money routes, prices, or listings. Do **not** ask for a ship date.
- Pass marks: AT-1…AT-5. When `/health` (or equivalent) shows datasave can run 01–02 without Grok and AT-2 lock behavior is testable, tell Gavriel.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | `docs/bot-logic/` has the five files; lock claim works (second claim same day+action no-ops); datasave can run jobs 01–02 without Grok; AT below pass. |
| **Stop condition** | At most **2 rounds**. Further gaps = new CR/BUG. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1: `docs/bot-logic/01-*.md`, `02-*.md`, `03-*.md`, `00-*.md`, `README.md` exist on main.
- AT-2: Runner A claims `closeout-seal-YYYY-MM-DD`; runner B gets no-op "lock held by A"; after clear/expiry, B can claim.
- AT-3: Datasave path for closeout seal + GoDaddy freeze is documented as primary in job 01 stub (or README) and does not require a Grok routine to start.
- AT-4: Panel watch still writes GAP (does not upload) when totals collapse; R-8v2 still needs 2 consecutive small-total days (no change to that rule in this CR).
- AT-5: No money routes, prices, listings, or settings activation touched.

## Out of scope
- Buy cards, Challenger, three-way Dvir decisions.
- `/locks` HTTP API (file lock is enough for round 1).
- Changing CR-079 codes or building a separate ownershipCheck.
- Backfilling Oct 23–25 gaps.

## DVIR items
None.

## Decisions (Gavriel, 2026-10-26)
1. Stubs live under `docs/bot-logic/` after DOM places them.
2. File-based lock first; optional API later.
3. DOM primary for jobs 01–02; Grok backup with lock; job 03 remains DOM portfolioCheck.
