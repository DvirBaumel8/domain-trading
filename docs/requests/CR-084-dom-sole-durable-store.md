---
id: CR-084
kind: CR
status: approved
owner_bot: dom-architect
approval: "D-2026-10-27 §10 A via Gavriel ~02:44 IDT: ONE place per durable data = DOM database; consumers via DOM API only; kill dual writers. Money still Dvir yes per change; price writer = DOM after yes."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-084: DOM sole durable store (API-only reads; kill dual writers)

**Approval:** Dvir §10 A FINAL 2026-10-27 ~02:44 IDT via Gavriel. Build right away. Maintenance under freeze. Max **2 rounds**. No Dvir setup. Report when live on `/health`.

## Why
Dual writers for prices and other durable facts (DOM books vs company `ledger/portfolio.csv` vs chat) caused BUG-053-class waste. Dvir adopted **stronger than books-only**: every durable data piece lives in the **DOM database**; every consumer reads via the **DOM API only**.

## Rules
- R-1 **Canonical store = DOM DB.** Owned-name prices (BIN / floor / walk-away / min offer), listing_history / approval_text, listed_venues / observed_venues, ledger money rows that DOM already owns, and other facts already in DOM portfolio/books — **DOM is the only write target** after Dvir’s yes for money-adjacent fields.
- R-2 **API-only consumers.** Bots and digests that need those facts call DOM (`GET /portfolio`, `/portfolio/{d}`, `/books.csv`, `/report`, …). They must not treat company-box CSVs as live truth.
- R-3 **Company CSV = lagging export at most.** If a file under `ledger/` remains, it is an explicit **export/mirror** of DOM (dated lag note), never a second writer. Path to **remove** dual-maintained fields is in scope; bots stop writing BIN/floor/walkaway into company CSV as source of truth.
- R-4 **Money unchanged.** Any price / list / buy / bid / renew spend still needs **Dvir’s own yes**; Gavriel executes; DOM records. This CR does not auto-change prices.
- R-5 **No new dual store.** New durable fields land in DOM (CR) first; do not invent parallel box CSVs for the same fact.
- R-6 **Document the map.** Release note / contract lists which endpoints are the sole read path for: prices, listing provenance, costs/receipts already in DOM.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-5; no money auto-action; dual-write paths for prices documented as removed or refused. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1 **Books = portfolio:** For each owned domain, `GET /books.csv` BIN/floor/walkaway/min match `GET /portfolio/{d}` (same cents).
- AT-2 **Write path named:** Contract/docs state DOM is sole writer for those price fields after approval; company CSV is mirror/export or absent for live writes.
- AT-3 **Negative — no silent dual write API:** There is no bots route that updates company-box files; bots that POST price changes use existing DOM money/list routes only (still gated by approval rules).
- AT-4 **Export optional:** If a `GET` export of books/ledger snapshot exists or is added for offline mirror, it is clearly labeled export (not a second write API).
- AT-5 **Negative — no price change without approval rules:** This CR’s release does not weaken existing approval gates on `/list` / price changes.

## Out of scope
- Sedo delist (CR-085).
- Named READ tokens (rejected; one shared token — separate handoff).
- Bak archive (CR-086 / box).
- Moving judgment SOPs into code.
- Auto-sync Afternic Portfolio API (follow-on; money-free sync OK as separate CR).

## Questions (≤3)
1. Prefer documenting “bots must stop writing ledger CSV prices” only, vs adding a DOM `GET /export/ledger-mirror.csv` for optional offline copies? Default: document stop-write + existing `/books.csv` is enough unless you see a cheap mirror endpoint already.
2. Any durable field today **only** on the company box that must move into DOM in this release? List or say none — default **none** beyond price/listing fields already in DOM.

## DVIR items
None (already decided in §10 A).

## Changes
- 2026-10-27 ~02:46 IDT (DOM Architect): filed from Dvir §10 A.
