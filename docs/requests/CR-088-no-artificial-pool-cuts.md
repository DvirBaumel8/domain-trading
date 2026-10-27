---
id: CR-088
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir Oct 28 ~01:17 IDT via Gavriel: no artificial size cuts anywhere on buy/discovery/data; scale with batches, indexes, queues, correct storage, retention. Serve every hard-filter auction passer."
priority: P0
depends_on: []
supersedes: []
max_rounds: 2
---

# CR-088: no artificial pool cuts — serve all hard-filter auctions

**One-line purpose:** Stop throwing away buy candidates because a list feels big; store and serve every GoDaddy auction that passes hard filters, and remove other intentional pool-size caps the same way.

**Approval:** Dvir 2026-10-28 ~01:17 IDT (Gavriel chat). **BUILD NOW** (phase 1 below). No money. Max **2 rounds**.

## Why
Discovery was cutting ~500–750 hard-filter passers/day down to `shortlist_size` **25** (GET max **100**). That was a human tip-sheet habit (G-127), not a DB limit. Dvir: big data → batches, indexes, queues, right store, retention — never shrink the pool.

## Standing rule (company)
- **No artificial size cuts** on buy / discovery / data paths.
- Scale = infrastructure + refactor (batches, indexes, message queues, correct DB/storage, retention).
- Hundreds or thousands/day is fine. If a single day exceeds **10,000** hard-filter passers, pause and talk with Dvir before changing the pipe.

## Phase 1 (this CR — auctions discovery)
- R-1 **Store the full hard-filter field** for each data date (every name that passes offline hard filters / `field_n`), ranked. Do **not** cut to top 25.
- R-2 **Serve the full field** on `GET /auctions/shortlist` (raise or remove the max-100 limit; pagination / cursor OK if response size needs it).
- R-3 **Expensive side work** (other-endings RDAP `shortlist_endings_n`, auto-prebid `shortlist_prebid_n`) may stay on a **top slice for step time**, but must **not** hide the rest of the field from Buyer (those names still appear on GET with rank/score).
- R-4 **Settings / migration:** `shortlist_size` either becomes “serve all” (0 / null / sentinel) or is raised above any realistic daily field; remove CHECK that caps at 100 if it blocks R-1/R-2.
- R-5 **No money / no browser.** Read path + datasave shortlist step only.
- R-6 **Contract + release note** with one-sentence purpose (git-commit style).

## Phase 2 (follow-up brief, same rule — do not sneak into phase 1)
Audit and propose removal/raise for: closeouts GET max 200, `GET /candidates/daily` max 25, intake 30/day, Dynadot page/call caps that hide inventory, other rows in DOM’s 2026-10-28 cut table. New CR per cluster if needed.

## Acceptance tests (phase 1)
- AT-1 After datasave, stored shortlist row count for the day ≈ `field_n` / hard-filter passers (not 25).
- AT-2 `GET /auctions/shortlist?limit=` (or paginated) can return **more than 100** when the field is larger.
- AT-3 Names ranked below former top-25 appear on the route with score/rank.
- AT-4 Datasave step still finishes within its timeout when endings/prebid stay top-slice.
- AT-5 `/health` version bumps; contract documents the change.

## Out of scope
- Changing S8 $250 per-name money cap or portfolio 40-name POC cap (those are money/POC rules, not “list feels big” cuts).
- Unpausing closeout money cards.
- Buyer SOP text (Gavriel owns under `docs/requests/bot-logic/`).

## Changes
- 2026-10-28 ~01:18 IDT (Gavriel): filed from Dvir standing rule + DOM Architect counts (field_n ~500–750).
