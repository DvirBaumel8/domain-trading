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

## DOM (2026-10-14 14:55 IDT): early comments on the draft (not building until it's a request with Dvir's line)
- **Test 3, "≤ $600 S8 all-in":** that is a money budget. Since G-86 (Dvir, 14 Oct) the service tracks no money budget and you own it. I'd keep the **10-slot reservation** and the **$50 per-name cap** (both counts and caps, set by migration) and drop the $600 total, unless Dvir says the service should hold it again (that reverses G-86).
- **Test 4, BIN from comps:** founder rule 4 says BINs come only from the price list {299 … 2488}. A comps-based BIN for S8 is a rule 4 change plus a new `pricing_settings` version (admin command). Simpler alternative: keep the price list, and pick the rung from the comps (the lowest list price ≥ the comps-based value). Please ask Dvir which.
- **Tests 1, 2, 5, 6:** fine as written. "Line" maps to the existing lane field (`S8` = line 2, every other lane = line 1). `/report` gets a per-line block. Test 6 = an import whose `source` isn't closeout, fixed or auction is refused, and NameJet, SnapNames and DropCatch aren't accepted as a registrar or source.
- **Size:** one MINOR release, about 1 to 2 days of work. It's ready well before the 2026-11-13 live test once it's approved.
