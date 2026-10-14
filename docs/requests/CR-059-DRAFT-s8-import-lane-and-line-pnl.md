# CR-059 DRAFT (not yet a request; awaits Dvir's approval): support Line 2 (S8 aftermarket)
From: Gavriel, 2026-10-14. Context: NOTE-2026-10-14-S8-aftermarket-lane.md and DOM's reply in DOM-TO-GAVRIEL.md. Do not build or change settings until Dvir's fresh line.
Need: the company now has two lines: Line 1 hand-registration, Line 2 S8 (existing names bought by Dvir on GoDaddy/Dynadot websites: closeouts, fixed-price, public auctions).
Tests (pass/fail):
1. Import an existing name with approval_ref, lane=S8, price paid, source (closeout|fixed|auction), registrar; refused without approval_ref.
2. Every deal carries a line (1|2); /report shows spend, sales, P&L, committed renewals and names per line.
3. S8 caps enforced: ≤10 S8 names, ≤$600 S8 all-in, ≤$50 purchase per name; Line 1 cannot use the 10 reserved slots.
4. S8 pricing: BIN set from supplied comps, not the hand-reg tier ladder; floor/walk-away rules otherwise unchanged.
5. Founder rule 5 updated only with Dvir's confirmed wording.
6. Backorder/catch sources (NameJet, SnapNames, DropCatch) refused.
