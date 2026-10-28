---
id: CR-090
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir t1067u via Gavriel 2026-10-28 ~21:10 IDT: GO health datasave step/GAP detail; Claude Code maintenance; freeze-ok."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-090: `/health` datasave step / GAP detail

**Approval:** Dvir t1067u via Gavriel. **No money.** Maintenance under freeze. No CloudAgents — Claude Code only.

## Why
Tonight discovery ran with `datasave: "partial"` but `/health` only returns that string. Buyer/Gavriel cannot see which step failed (e.g. Dynadot closeouts pages 46–48, aftermarket lock/GAP, GoDaddy race) without digging logs. Blocks clear L&L and dual-runner backup decisions.

## Rules
- R-1 Keep top-level `datasave` enum as today (`ok` | `partial` | `error` | `overdue`) — additive only.
- R-2 Add a structured detail object on `GET /health` (name e.g. `datasave_detail` or expand under `datasave` if backward-compatible object form is chosen carefully — **prefer additive sibling field** so old string clients keep working: keep `datasave: "partial"` and add `datasave_detail: {…}`).
- R-3 Detail must name, for the latest datasave run (or last 26h): per configured step (at least GoDaddy inventory / `auctionShortlist` / Dynadot closeouts / Dynadot aftermarket when configured) → `ok` | `partial` | `error` | `skipped` | `not_configured`, plus short `error` / GAP reason string when not ok, and `data_date` when known.
- R-4 Dynadot `not_configured` must not flip top-level `datasave` by itself (existing rule).
- R-5 Document in `endpoints.md` §`GET /health` and `datasave.md` / gaps. Tests for ok vs partial with one step failing.
- R-6 No money routes; no new WRITE; READ on health only.

## Acceptance tests
- AT-1 With all configured steps ok → `datasave: "ok"` and detail every step `ok` (or equivalent).
- AT-2 With one configured step failed/partial → `datasave: "partial"` (or `error` per existing rules) and detail names that step + reason.
- AT-3 Dynadot-only `not_configured` does not alone force non-ok top-level when GoDaddy half ok.
- AT-4 Contract docs list the new field; OpenAPI/route table stay in sync if required by repo tests.
- AT-5 Old clients reading only string `datasave` still work.

## Out of scope
Fixing the underlying Dynadot page failures / aftermarket lock (separate BUGs if still open); CloudAgents; run-pack persist (CR-089).

## Questions (≤1)
1. Sibling `datasave_detail` vs replace string with object? **Default: keep string + additive `datasave_detail`.**
