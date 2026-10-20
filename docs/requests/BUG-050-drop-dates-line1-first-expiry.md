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
# BUG-050: drop dates wrong: Line 1 one year late (D-002..D-004); S8 should be a 3-year hold

## Why
`GET /books.csv` (v5.25.0, read 2026-10-21 ~02:00 IDT) shows drop_date 2028-10-09 (ukcbamcompliance.com, aievalsconsulting.com) and 2028-10-10 (roofingvoiceagent.com). The lean rule (NOTE-2026-10-14-drop-at-first-expiry.md; ledger/portfolio.csv rows D-002..D-004) is drop at first expiry: 2027-10-09, 2027-10-09 and 2027-10-10. promptinjectionaudit.com is already correct (2027-10-04). The drop date is set by the horizon route, a money route, so I can't fix it with the bots token.

## Rules
- R-1: set drop_date = expiry_date for the three names, with an audit row citing the note. If DOM has no record that the 2026-10-14 note was activated, say so here instead of changing anything.
- R-3: S8 (fixes CR-060's `drop_date = expiry + 1 year`): an S8 name has a 3-year hold, so drop_date = buy_date + 3 years, aligned to the registration expiry: mineunited.com 2029-09-07. Final push at drop − 90 (2029-06-09), delist at drop − 7. Business rule: S8 lane README §2 item 7, rulebook line 373; Gavriel ruling 2026-10-21 01:49 IDT.
- R-2: the derived events (final push at drop−90, delist at drop−7, m6 drop) follow the new date.

## ATs
- AT-1: books.csv drop_date 2027-10-09, 2027-10-09 and 2027-10-10; `GET /costs/forward?from=2027-10&to=2027-10` counts these three names 0 with `DROPS_AT_FIRST_EXPIRY`.
- AT-2: mineunited.com books.csv drop_date 2029-09-07, next_event final_push 2029-06-09; new S8 imports get the 3-year rule.
- AT-3 (negative): a Line 1 name is never given the S8 3-year date (promptinjectionaudit.com stays 2027-10-04).

## Out of scope
Walk-away and BIN changes.

## Questions (max 3)
1. Answered (Gavriel 2026-10-21 01:49 IDT): the business rule wins, a 3-year hold with drop 2029-09-07 (see R-3).

## Changes
- 2026-10-21 02:05 IDT: filed (DOM Architect).
- 2026-10-21 01:52 IDT: added R-3 (S8 3-year hold, fixes CR-060's expiry + 1 year), AT-2 replaced, AT-3 added, Q1 closed (Gavriel ruling 2026-10-21 01:49 IDT).

<!-- DOM writes below this line -->
