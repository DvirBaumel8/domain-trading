> Status: Open

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
