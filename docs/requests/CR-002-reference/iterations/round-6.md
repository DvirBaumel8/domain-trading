# Round 6: test of pre-registered rules (fresh slice, week(s) of Sep 7)

Test only. No rule was changed after seeing this slice.

**Undecided rows:** names whose prior-history lookup failed, where that lookup would change the decision. Wayback throttled about 165 lookups late in the run. Undecided rows are counted in neither the accepted nor the rejected column.

### Rounds [6] (decidable rows; undecided = prior-history lookup failed AND it matters)

| Rule | Sold accepted | Dropped rejected | Undecided sold/dropped | Prec. @1% | @2% |
|---|---|---|---|---|---|
| v10 | 26/42 = 62% | 29/39 = 74% | 1/1 | 2.4% | 4.7% |
| V1 | 25/43 = 58% | 30/40 = 75% | 0/0 | 2.3% | 4.5% |
| V2 | 21/43 = 49% | 32/40 = 80% | 0/0 | 2.4% | 4.7% |
| V3 | 25/43 = 58% | 31/40 = 78% | 0/0 | 2.5% | 5.0% |

- **v10:** <1k 11/24; 1-2.5k 7/8; >2.5k 8/10; expired sold 9/17 drop-rej 7/10; fresh sold 2/3 drop-rej 9/13; aged sold 11/13 drop-rej 0/0; geo sold 2/4 drop-rej 1/1
- **V1:** <1k 10/25; 1-2.5k 7/8; >2.5k 8/10; expired sold 8/17 drop-rej 7/10; fresh sold 2/3 drop-rej 9/13; aged sold 11/13 drop-rej 0/0; geo sold 2/4 drop-rej 1/1
- **V2:** <1k 9/25; 1-2.5k 6/8; >2.5k 6/10; expired sold 8/17 drop-rej 7/10; fresh sold 2/3 drop-rej 11/13; aged sold 8/13 drop-rej 0/0; geo sold 2/4 drop-rej 1/1
- **V3:** <1k 10/25; 1-2.5k 7/8; >2.5k 8/10; expired sold 8/17 drop-rej 8/10; fresh sold 2/3 drop-rej 9/13; aged sold 11/13 drop-rej 0/0; geo sold 2/4 drop-rej 1/1

**Reading:**
- v10 accepts 62% of sold and rejects 74% of dropped. Both are below target on this slice.
- Sub-$1k acceptance: 11/24.
- V3's history filter adds one dropped reject and costs one sold accept.
