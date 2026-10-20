---
id: BUG-050
kind: BUG
status: parked
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
- 2026-10-21 01:58 IDT (Gavriel): DOM response accepted for R-1. The 2026-10-14 note was never activated, and keeping one renewal matches Dvir's own 2026-10-09 plan (renew-or-drop for D-002/D-003 decided 2027-09-01 on interest) and the 2026-10-03 one-renewal rule. No change to D-002..D-004; AT-1 withdrawn.
- 2026-10-21 01:58 IDT (Gavriel): R-3 parked, not withdrawn. The S8 3-year hold is a recorded business rule (Dvir "your call", 2026-10-14 15:17 IDT, adopted by Gavriel), but it adds a second renewal, so it is a money/horizon change behind Dvir's one-tap yes (CR-069). Gavriel brings it to Dvir at the Sunday review; nothing is due before mineunited.com's first expiry (2027-09-07), which both plans renew. Until then DOM keeps 2028-09-07, and the box README/rulebook get a note that the drop date is pending this decision. AT-2 on hold; AT-3 stands.

<!-- DOM writes below this line -->

## DOM response (2026-10-21): no change. The note was never activated, so the drop dates are as recorded.

- **What the note says:** `NOTE-2026-10-14-drop-at-first-expiry.md` asks DOM to *prepare* the change and says, in its own words, **"Do not activate any setting from this note; activation needs Dvir's own fresh line."**
- **What the repo shows:** no activation line from Dvir for D-002..D-004 anywhere (requests, DOM-TO-GAVRIEL, CR files). "Go lean but keep the scouts daily" is the line the note was written from, not the activation it asks for.
- **The result:** ukcbamcompliance.com, aievalsconsulting.com and roofingvoiceagent.com keep the one-renewal plan, so drop = expiry + 1 year (2028-10-09/09/10) is correct. This follows your R-1: "If DOM has no record … say so here instead of changing anything."
- **To change it,** Gavriel brings Dvir's own line naming the three domains and "drop at first expiry". Renew-or-drop is a keep/sell money decision, and the horizon route that sets it stays behind his one-tap yes (CR-069). With that line in this file, DOM ships the change as a data fix:
  - drop = expiry;
  - the final push and delist move with it (no M6/M18 change for these v3 plans beyond what the schedule recomputes);
  - `/costs/forward` then counts them 0 (`DROPS_AT_FIRST_EXPIRY`).
- **Q1 (for Gavriel):** DOM's S8 contract holds, so mineunited.com drops 2028-09-07 (expiry + 1 year; CR-060, approved by Dvir). The "3-year hold" in the box README comes from the S8 buy window (bought with up to 2 years + 30 days left), not a later drop. The box README and rulebook should match DOM.
