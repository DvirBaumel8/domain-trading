---
id: CR-089
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir t1067u via Gavriel 2026-10-28 ~21:10 IDT: GO persist run pack; standing commit after every discovery seal; Claude Code (no CloudAgents)."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-089: persist discovery run packs in-repo

**Approval:** Dvir t1067u via Gavriel. **No money.** No CloudAgents — Claude Code only.

## Why
Workspace remount ~19:04 UTC wiped local `sourcing/buyer-first/2026-10-28-v3/` until rematerialize. Run packs must land in git before exit.

## Rules
- R-1 **Tonight's pack is already under** `docs/requests/discovery-runs/2026-10-28-v3/` (bot-committed; includes `MERGED-AIs.md`, `DOM-improve-notes.md`, funnel/REVIEW/kills/shortlist/evidence). Keep that path as the **bot-writable durable store** (requests-only guard).
- R-2 **Mirror into `sourcing/buyer-first/`** when that tree is part of this repo (or document that company tree stays box-only and git path is `docs/requests/discovery-runs/`). Prefer adding `sourcing/buyer-first/2026-10-28-v3/` as a copy of the discovery-runs pack **if** `sourcing/` is an accepted top-level in this repo; otherwise leave packs only under `docs/requests/discovery-runs/` and update Buyer SOP to that path.
- R-3 **Standing:** after every discovery seal, commit that day's folder **before exit** (Buyer/Gavriel/DOM as who sealed). Stamp in `docs/bot-logic/04-buyer-shortlist-to-card.md` and `docs/requests/bot-logic/04-…` + day-timeline: “seal → commit run pack → then L&L”.
- R-4 Do not invent a new DOM WRITE API for run packs under freeze.
- R-5 Large evidence HTML is OK in git for now (<5 MB/day typical); if a day exceeds ~20 MB, keep funnel/REVIEW/PASSERS/kills/MERGED-AIs/DOM notes and tarball evidence separately (note in README).

## Acceptance tests
- AT-1 `docs/requests/discovery-runs/2026-10-28-v3/` exists on main with at least funnel.md, REVIEW.md, PASSERS.md, DOM-improve-notes.md, MERGED-AIs.md.
- AT-2 `docs/requests/discovery-runs/README.md` states the standing commit-before-exit rule.
- AT-3 Buyer SOP (`docs/bot-logic/04` after CR-091 sync, and requests copy) mentions commit run pack after seal.
- AT-4 If `sourcing/buyer-first/` is added: same day's folder matches discovery-runs contents (or README says single canonical path).

## Out of scope
Money; CloudAgents; shape features; health datasave detail (CR-090); closeouts pagination (paper only unless follow-up).

## Questions (≤1)
1. Canonical path: `docs/requests/discovery-runs/` only (bot-friendly) vs also `sourcing/buyer-first/`? **Default: discovery-runs canonical; mirror sourcing only if already company-standard.**
