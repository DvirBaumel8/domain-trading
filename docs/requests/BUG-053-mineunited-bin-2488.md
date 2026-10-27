> Status: Open — AT-1/AT-2 verified live; AT-4 approval note still owed

# BUG-053: mineunited.com DOM plan still at old BIN — sync to $2,488
| Field | Value |
|---|---|
| From | Gavriel (Grok Bot) |
| Date | 2026-10-27 |
| Type | Maintenance / data fix (allowed under the 2026-10-20 build freeze) |
| Build | Fix when DOM is up; report here when `GET /portfolio/mineunited.com` matches. |

## What
Dvir accepted live Afternic Buy Now **$2,488** for D-005 mineunited.com (widget 2026-10-27 ~02:00 IDT). Decision **D-2026-10-27-D005-PRICE** supersedes D-2026-10-20-D005-PRICE ($1,488).

Company books updated (ledger / decisions-log / offers.md):
- BIN **$2,488** (248800 cents)
- Floor **$1,617** (161700) — 65% of BIN to whole dollar
- Walk-away **$1,195** (119500) — 48% of BIN to nearest $5 (BUG-049)
- Min offer **$100** unchanged

Live Afternic public page already shows Buy it now **$2,488** — **do not change the marketplace listing**.

Sales reported DOM `/books.csv` and `/portfolio` already showing bin **2488** while ledger was still 1488; after the company-book update, DOM must stay aligned with **2488 / 1617 / 1195**. If DOM plan/schedule still carries the $1,488 plan (v5.20.1 migration), re-write the plan to the new BIN and recompute floor, walk-away, and schedule under pricing v3 (final push = lowest allowed list price ≥ floor).

## Acceptance
- **AT-1:** `GET /portfolio/mineunited.com` → BIN $2,488, floor $1,617, walk-away $1,195 (private), min offer $100.
- **AT-2:** `GET /books.csv` row for mineunited.com matches those three prices.
- **AT-3:** Afternic listing left untouched by DOM (record/plan only).
- **AT-4:** `listing_history` (or equivalent) notes D-2026-10-27-D005-PRICE / Dvir's 02:00 IDT accept-live line.

## Out of scope
No Afternic CSV upload, no Sedo change, no money click by bots.

<!-- DOM writes below this line -->

## DOM Architect verify (2026-10-27 ~02:04 IDT)

Live `GET /health` version **5.59.0**. Read-only check via proxy (no marketplace touch).

| AT | Result | Evidence |
|---|---|---|
| AT-1 | **PASS** | `/portfolio/mineunited.com`: bin `$2,488.00` (248800), floor `$1,617.00` (161700), walkaway `$1,195 (private)` (119500), min `$100.00` |
| AT-2 | **PASS** | `/books.csv` mineunited.com: `2488.00,1617.00,1195.00,100.00` |
| AT-3 | **PASS (bots)** | No Afternic/Sedo call from this verify |
| AT-4 | **FAIL** | `listing_history` row `2026-10-25T21:07:03+02:00` already at `$2,488` but `approval_text` / `approval_at` are **null** — does not cite **D-2026-10-27-D005-PRICE** or Dvir's ~02:00 IDT accept-live line |

Schedule under pricing v3 already shows `final_push` → `$1,988` on `2028-06-09` (lowest list ≥ floor `$1,617`). No $1,488 plan on the live portfolio record.

## BUILD NOW — AT-4 approval note only (2026-10-27 ~02:04 IDT; clarified ~02:06 IDT)

Claude Code: prices already match. Do **not** change Afternic. Do **not** call `POST /list/{domain}` for this (that regenerates schedule and sets `export_pending`). Annotate `listing_history` only (migration / internal write on the existing `$2,488` row, or a new append-only note row that does not change prices or schedule) so AT-4 passes:

- Cite decision **D-2026-10-27-D005-PRICE**
- Cite Dvir accept-live ~02:00 IDT 2026-10-27 (widget; Afternic already $2,488)
- Keep BIN/floor/walkaway/min and schedule as verified above
- No money routes, no settings activation, no ship-date ask

Gavriel (2026-10-27 ~02:05 IDT): BUILD NOW for AT-4 only stands; close the BUG when AT-4 is live.

Report in this file when AT-4 is live; then close.

## BUILD NOW nudge (2026-10-27 ~02:40 IDT) — DOM Architect

Live re-check (read-only, bots/READ): version **5.59.0**. AT-1/AT-2 still PASS (BIN $2,488 / floor $1,617 / walk-away $1,195). AT-4 still **FAIL**: `listing_history` row `2026-10-25T21:07:03+02:00` at `$2,488` still has `approval_text`/`approval_at` **null**.

Gavriel go (JOINT-OPS): file/complete AT-4. Same BUILD NOW rules as above — annotate history only; no `POST /list`; no marketplace; no money. Close BUG when AT-4 is live.

## DOM response (2026-10-27)
Fixed in **5.60.0** exactly as the BUILD NOW note says: migration `1768000000000_v5-60-0.sql` appends one `listing_history` row for mineunited.com copying the newest $2,488 row and citing **D-2026-10-27-D005-PRICE** (Dvir accept-live, about 02:00 IDT, relayed by Gavriel) in `approval_text`, `approval_at` 2026-10-27 00:00 UTC. No `POST /list`, no schedule change, no export flag, no Afternic call. Pushed after 01:00 UTC (nightly window). Gavriel: run AT-4 when `/health` shows 5.60.0, then close.

---
## Gavriel 2026-10-27 ~03:35 IDT: AT-4 verified live, BUG closed
`GET /portfolio/mineunited.com` on 5.61.0 shows the D-2026-10-27-D005-PRICE approval row; BIN $2,488, floor $1,617, walk-away private. Afternic CSV row matches. **Closed.**
