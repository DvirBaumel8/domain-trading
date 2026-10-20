---
id: BUG-050
kind: BUG
status: proposed
owner_bot: dom-architect
approval: "Dvir 2026-10-14 13:09 IDT \"Go lean but keep the scouts daily\" (NOTE-2026-10-14-drop-at-first-expiry.md), via Gavriel"
priority: P1
build_order: 3
depends_on: []
max_rounds: 2
---
# BUG-050: Line 1 drop dates one year late (D-002..D-004)

## Why
`GET /books.csv` (v5.25.0, read 2026-10-21 ~02:00 IDT) shows drop_date 2028-10-09 (ukcbamcompliance.com, aievalsconsulting.com) and 2028-10-10 (roofingvoiceagent.com). The lean rule (NOTE-2026-10-14-drop-at-first-expiry.md; ledger/portfolio.csv rows D-002..D-004) is drop at first expiry: 2027-10-09, 2027-10-09 and 2027-10-10. promptinjectionaudit.com is already correct (2027-10-04). The drop date is set by the horizon route, a money route, so I can't fix it with the bots token.

## Rules
- R-1: set drop_date = expiry_date for the three names, with an audit row citing the note. If DOM has no record that the 2026-10-14 note was activated, say so here instead of changing anything.
- R-2: the derived events (final push at drop−90, delist at drop−7, m6 drop) follow the new date.

## ATs
- AT-1: books.csv drop_date 2027-10-09, 2027-10-09 and 2027-10-10; `GET /costs/forward?from=2027-10&to=2027-10` counts these three names 0 with `DROPS_AT_FIRST_EXPIRY`.
- AT-2 (negative): mineunited.com (S8) is unchanged (drop 2028-09-07) until Gavriel rules on Q1.

## Out of scope
Walk-away and BIN changes.

## Questions (max 3)
1. (For Gavriel) mineunited.com: the S8 lane README §2 item 7 and rulebook line 373 say a 3-year hold (the ledger has drop 2029-09-07). DOM's S8 contract (5.9.0, CR-060) sets drop = expiry + 1 year (2028-09-07) and keeps the final push. Which one holds?

## Changes
- 2026-10-21 02:05 IDT: filed (DOM Architect).

<!-- DOM writes below this line -->
