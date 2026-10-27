---
id: CR-084
kind: CR
status: building
owner_bot: dom-architect
approval: "D-2026-10-27 §10 A via Gavriel ~02:44 IDT: ONE place per durable data = DOM database; consumers via DOM API only; kill dual writers. Money still Dvir yes per change; price writer = DOM after yes."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-084: DOM sole durable store (API-only reads; kill dual writers)

**Approval:** Dvir §10 A FINAL 2026-10-27 ~02:44 IDT via Gavriel. Build right away. Maintenance under freeze. Max **2 rounds**. No Dvir setup. Report when live on `/health`.

## BUILD ORDER (Dvir t981u GO AHEAD ~03:48 IDT)
**Queue position 2** (after Afternic real-push receipt). Includes **decisions store + X-Caller** (Gavriel reply `9e92b3f`). Claude Code: start when Afternic NOTE `## Receipt` filled and push ATs pass. Max 2 rounds. Report live on `/health`. Money still Dvir yes per action — this CR does not push prices. **§5 Security A already decided — do not re-ask Dvir.**


## Why
Dual writers for prices and other durable facts (DOM books vs company `ledger/portfolio.csv` vs chat) caused BUG-053-class waste. Dvir adopted **stronger than books-only**: every durable data piece lives in the **DOM database**; every consumer reads via the **DOM API only**.

## Rules
- R-1 **Canonical store = DOM DB.** Owned-name prices (BIN / floor / walk-away / min offer), listing_history / approval_text, listed_venues / observed_venues, ledger money rows that DOM already owns, and other facts already in DOM portfolio/books — **DOM is the only write target** after Dvir’s yes for money-adjacent fields.
- R-2 **API-only consumers.** Bots and digests that need those facts call DOM (`GET /portfolio`, `/portfolio/{d}`, `/books.csv`, `/report`, …). They must not treat company-box CSVs as live truth.
- R-3 **Company CSV = lagging export at most.** If a file under `ledger/` remains, it is an explicit **export/mirror** of DOM (dated lag note), never a second writer. Path to **remove** dual-maintained fields is in scope; bots stop writing BIN/floor/walkaway into company CSV as source of truth.
- R-4 **Money unchanged.** Any price / list / buy / bid / renew spend still needs **Dvir’s own yes**; Gavriel executes; DOM records. This CR does not auto-change prices.
- R-5 **No new dual store.** New durable fields land in DOM (CR) first; do not invent parallel box CSVs for the same fact.
- R-6 **Document the map.** Release note / contract lists which endpoints are the sole read path for: prices, listing provenance, costs/receipts already in DOM.
- R-7 **Decisions store (Gavriel AGREE §3.2, reply 9e92b3f):** `POST/GET /decisions` (or equivalent) so D-IDs from company decisions-log are readable in DOM; sole durable home for decision ids bots/Claude cite. No money auto-action.
- R-8 **X-Caller (Gavriel AGREE §3.3):** shared-token requests should send `X-Caller: <bot-or-dom>` (or agreed header); DOM logs it for attribution. Do not mint per-bot tokens.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-7; no money auto-action; dual-write paths for prices documented as removed or refused; decisions + X-Caller. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1 **Books = portfolio:** For each owned domain, `GET /books.csv` BIN/floor/walkaway/min match `GET /portfolio/{d}` (same cents).
- AT-2 **Write path named:** Contract/docs state DOM is sole writer for those price fields after approval; company CSV is mirror/export or absent for live writes.
- AT-3 **Negative — no silent dual write API:** There is no bots route that updates company-box files; bots that POST price changes use existing DOM money/list routes only (still gated by approval rules).
- AT-4 **Export optional:** If a `GET` export of books/ledger snapshot exists or is added for offline mirror, it is clearly labeled export (not a second write API).
- AT-5 **Negative — no price change without approval rules:** This CR’s release does not weaken existing approval gates on `/list` / price changes.
- AT-6 **Decisions:** `POST /decisions` then `GET /decisions` (or by id) round-trips a sample D-id without touching prices.
- AT-7 **X-Caller:** A shared-token call with `X-Caller` is accepted; missing header does not break READ (document default); logged when present.

## Out of scope
- Sedo delist (CR-085) — **KEEP-4**; scrapes-off only.
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
- 2026-10-27 ~03:50 IDT (DOM Architect): folded decisions store + X-Caller per Gavriel JOINT-OPS reply (`9e92b3f`); §5 closed (Security A).
- 2026-10-27 ~03:48 IDT (DOM Architect): Dvir t981u — queue #2 after Afternic push; status building.
- 2026-10-27 ~02:46 IDT (DOM Architect): filed from Dvir §10 A.

## DOM response (Claude Code, 2026-10-27, built for v5.63.0, not yet released)
Verdict: accepted and built as written. Money is untouched: no route added here changes a price, a listing or a spend, and no approval gate changed.

- **R-1/R-2/R-6 (the map):** `docs/contract/sources-of-truth.md`, linked from the contract README: per durable fact the only writer and the only read endpoints (prices and plan, listing provenance and venues, marketplace live state, costs and receipts, decisions, knowledge base, market sales, offers and sales, audit). It says plainly that company-box CSVs are not a source of truth. Marketplace live state has **no raw read route yet** (`afternic_listings_daily` shows through the `/report` warnings and `GET /visits`); ask with a CR if you want one. Market sales are written by `POST /data/sales` and read by `/market/*` and `GET /engine/rows` (there is no `GET /data/sales`).
- **R-3/R-5 (AT-3, AT-4):** DOM has no route that touches a company-box file; the bots stop writing BIN/floor/walk-away into box CSVs on their side. `GET /books.csv` is the offline mirror (answers question 1: no new ledger-mirror route); it is GET-only and the docs call it an export of DOM data, not a write path. Question 2: no durable field lives only on the company box that must move in now.
- **R-7 decisions (AT-6):** table `decisions` (append-only, in the nightly backup), `POST /decisions` (WRITE or bots, 1..500 rows, `dry_run`), `GET /decisions` (`q`, `scope`, `domain`, `since`, `limit`, `offset`, `total_n`), `GET /decisions/{id}`. Same id and same content = duplicate, same id and other content = 409 `DECISION_EXISTS`; a correction is a new id with `supersedes` (the old row shows `superseded_by`). `@` is refused (422 `NO_PII`). Rules and tests: `docs/internal/decisions.md` (DEC-1..10). Differences from your text: new codes `DECISION_EXISTS` (409) and `DECISION_NOT_FOUND` (404); a duplicate is a 201 with `accepted_n` 0 (not an error); `supersedes` must exist already or be earlier in the same batch.
- **R-8 X-Caller (AT-7):** optional header `X-Caller` (1..40 of `a-z 0-9 _ -`); stored in `audit_log.caller` next to the token, shown by `GET /audit`, added to the request log lines. Missing or invalid is ignored, never an error. No per-bot tokens. Tests XC-1..4. It sits next to the older `X-Bot-Name` (`bot_name`), which is unchanged.
- **AT-1:** `CR084-AT1` checks `/books.csv` against `/portfolio/{d}` and `/portfolio` for every owned name (BK525-7 already compared the list view).
- **AT-5:** approval gates unchanged; `CR084-AT5` re-checks that a bots token cannot really list or buy and that a WRITE price change needs its approval.
- **CR-085 money-free part:** `pendingDomains(.., 'sedo')` is always empty (a new listing never makes a name pending for Sedo), `POST /list/{domain}` has no Sedo checklist step, `GET /export/sedo.csv` stays and documents "Sedo is off for new work, 27 Oct 2026"; existing Sedo records untouched. Five old tests that expected Sedo pending were changed to the new rule (CR085-AT4).
- **Migration:** `1768300000000_v5-63-0.sql` (`decisions`, `audit_log.caller`). Release still to do (version bump, CHANGELOG, release note, tag).
