# CR-055 note: prototype baseline and seed data
Prototype on the Grok Bot box, 2026-10-14. These are the numbers DOM's engine must match or beat (acceptance test 6).

## Data
- Sales: 12,474 (8,405 .com), Jan 2024 to Oct 4 2026, mainly from UnreportedSales weekly lists plus DNW/DNJ. Acquisition tag from RDAP: 1,730 hand-registered, 1,828 aftermarket/old, the rest unknown (RDAP fill-in running).
- Buyer notes: 3,004 DNW end-user sales with buyer descriptions (2020–2026).
- Negatives: 13,949 dropped-after-held .com (deleted lists; names caught by catchers removed) + 5,991 registered-unsold siblings.
- Sample in this folder: 2,000 rows with features + the buyer-note file.

## Reference test (R11): letters only, 6–20 characters, 2–3 real words, on both sides; test = sales on/after 2026-07-05
| Model | AUC | p top1% | p top5% |
|---|---|---|---|
| Length only | 0.775 | 0.84 | 0.57 |
| Logistic regression, lexical | 0.787 | 0.76 | 0.64 |
| GBM, lexical | 0.850 | 1.00 | 0.97 |
| GBM, lexical, $1k+ sales only | 0.889 | 1.00 | 0.78 |
| GBM, hand-registered sales only | 0.796 | 1.00 | 0.52 |
| GBM + .net registered (957-name subset, test after 2026-04-01) | 0.853 (vs 0.832 without) | 1.00 | 1.00 |
At a realistic 1-in-100 base rate: 41% precision in the top 1% (R9).

## Extra asks that follow from the prototype
1. Store the **creation date** of each other-ending registration and use it only if it is before the sale (R12 leak).
2. Draw negatives **per quarter** (a drop list from the same period as the sales) so negatives can be time-split too.
3. Main target: sales of $1k+ vs dropped-after-held, within the matched regime. Report the hand-registered class on its own.
4. Return `likely_buyers` in /score: live businesses using the same name on other endings (54% of end-user buyers already carry the exact name).
5. Note: DNS from some sandboxes answers NOERROR/NoAnswer for names that don't exist. Use RDAP or an authoritative check, not a public resolver alone.
