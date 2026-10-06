# Round 8: test of pre-registered rules (fresh slice, week(s) of Sep 21 + Sep 28)

Test only. No rule was changed after seeing this slice.

**Undecided rows:** names whose prior-history lookup failed, where that lookup would change the decision. Wayback throttled about 165 lookups late in the run. Undecided rows are counted in neither the accepted nor the rejected column.

### Rounds [8] (decidable rows; undecided = prior-history lookup failed AND it matters)

| Rule | Sold accepted | Dropped rejected | Undecided sold/dropped | Prec. @1% | @2% |
|---|---|---|---|---|---|
| v10 | 32/45 = 71% | 23/36 = 64% | 0/4 | 2.0% | 3.9% |
| V1 | 32/45 = 71% | 27/40 = 68% | 0/0 | 2.2% | 4.3% |
| V2 | 26/45 = 58% | 30/40 = 75% | 0/0 | 2.3% | 4.5% |
| V3 | 32/45 = 71% | 27/40 = 68% | 0/0 | 2.2% | 4.3% |

- **v10:** <1k 15/25; 1-2.5k 9/10; >2.5k 8/10; expired sold 0/0 drop-rej 0/0; fresh sold 0/0 drop-rej 0/0; aged sold 15/18 drop-rej 0/0; geo sold 2/7 drop-rej 1/1
- **V1:** <1k 15/25; 1-2.5k 9/10; >2.5k 8/10; expired sold 0/0 drop-rej 0/0; fresh sold 0/0 drop-rej 0/0; aged sold 15/18 drop-rej 0/0; geo sold 2/7 drop-rej 1/1
- **V2:** <1k 13/25; 1-2.5k 7/10; >2.5k 6/10; expired sold 0/0 drop-rej 0/0; fresh sold 0/0 drop-rej 0/0; aged sold 12/18 drop-rej 0/0; geo sold 2/7 drop-rej 1/1
- **V3:** <1k 15/25; 1-2.5k 9/10; >2.5k 8/10; expired sold 0/0 drop-rej 0/0; fresh sold 0/0 drop-rej 0/0; aged sold 15/18 drop-rej 0/0; geo sold 2/7 drop-rej 1/1

**Reading:**
- v10 accepts 71% of sold and rejects 64% of dropped. 4 dropped names are undecided.
- V1 matches v10 on sold and rejects 68% of dropped.
- Returns have flattened. No variant beats v10 consistently, so iterations stop here; no new variants were tried.
