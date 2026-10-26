# Backtest on retail labels: Gavriel's D2 dev split (DOM, 26 Oct 2026)

**Data:** `docs/requests/research/d2-names-labels-2026-10.csv` (Gavriel, 26 Oct): 3,631 aged .com names sold at retail for $500+ (public weekly reports: UnreportedSales, DNJournal, Domain Name Wire; no NameBio) and 14,524 GoDaddy closeout leftovers (0 bids, $50 or less). Only the **dev** split was used (2,532 sold, 10,112 not sold); the sealed split stays closed for one final check. Measure: AUC (0.5 = a coin toss). Scripts: scratchpad `pass1026/d2.mts`, `spell.mts`.

| Signal | AUC (dev) |
|---|---|
| **Shorter name** | **0.84** |
| v1 shape (length + words) | 0.84 |
| **Lift, length + words (the live seed table)** | **0.82** |
| Fewer words | 0.67 |
| v3/v4 name part (word quality x lift) | 0.62 |
| All words common (0/1) | 0.51 |
| Word quality | 0.47 |

By lane the name part (quality x lift) was 0.58 on short brandables and 0.74 on descriptive names: word quality hurts most where brandables sell.

**SPELL-1 (the form check, offline lists only, an upper bound):** fails 34% of sold names and 31% of unsold: almost no separation overall. Descriptive lane: 13% of sold vs 26% of unsold fail (it removes junk at twice the rate); short brandables: 43% vs 56% (it drops many 4-letter and coined names that sold: nxxl, taxvy, ghostry-type names).
**PERSON_NAME (v5.56.0):** 11 sold, 53 unsold hits: rare and neutral.

## What it means and what changed
- Word quality does not predict sales on retail labels (0.47) nor on our auction labels (0.48, `backtest-production-2026-10-26.md`). Multiplying it into the lift costs 0.20 of AUC. **v5.57.0:** auction-v4's name part is the lift alone and v4 has no uncommon-word cap. v2/v3 unchanged.
- The lift's length + words table (Dvir's method, trained on CR-002) holds on 12,644 retail outcomes (0.82).
- Not tested here: `developedTlds` and age as of the sale date (GoDaddy's file only covers names in its inventory now, and today's value would leak post-sale changes). Gavriel's own D2 tests found age-matched age and .org registration not predictive (`gavriel-backtests-2026-10.md`); DOM's auction-label test found developed endings and age strongest. The paper trading decides between them on our own outcomes.
- SPELL-1 stays for now (it halves junk among descriptive names); a short-name exception is a candidate to test (F41).
