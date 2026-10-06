# Round 7: test of pre-registered rules (fresh slice, week(s) of Sep 14)

Test only. No rule was changed after seeing this slice.

**Undecided rows:** names whose prior-history lookup failed, where that lookup would change the decision. Wayback throttled about 165 lookups late in the run. Undecided rows are counted in neither the accepted nor the rejected column.

### Rounds [7] (decidable rows; undecided = prior-history lookup failed AND it matters)

| Rule | Sold accepted | Dropped rejected | Undecided sold/dropped | Prec. @1% | @2% |
|---|---|---|---|---|---|
| v10 | 27/41 = 66% | 27/40 = 68% | 0/0 | 2.0% | 4.0% |
| V1 | 26/41 = 63% | 27/40 = 68% | 0/0 | 1.9% | 3.8% |
| V2 | 23/41 = 56% | 29/40 = 72% | 0/0 | 2.0% | 4.0% |
| V3 | 26/41 = 63% | 27/40 = 68% | 0/0 | 1.9% | 3.8% |

- **v10:** <1k 13/21; 1-2.5k 8/10; >2.5k 6/10; expired sold 5/8 drop-rej 1/2; fresh sold 0/2 drop-rej 3/3; aged sold 14/17 drop-rej 0/0; geo sold 1/3 drop-rej 1/2
- **V1:** <1k 12/21; 1-2.5k 8/10; >2.5k 6/10; expired sold 4/8 drop-rej 1/2; fresh sold 0/2 drop-rej 3/3; aged sold 14/17 drop-rej 0/0; geo sold 1/3 drop-rej 1/2
- **V2:** <1k 11/21; 1-2.5k 7/10; >2.5k 5/10; expired sold 3/8 drop-rej 1/2; fresh sold 0/2 drop-rej 3/3; aged sold 12/17 drop-rej 0/0; geo sold 1/3 drop-rej 1/2
- **V3:** <1k 12/21; 1-2.5k 8/10; >2.5k 6/10; expired sold 4/8 drop-rej 1/2; fresh sold 0/2 drop-rej 3/3; aged sold 14/17 drop-rej 0/0; geo sold 1/3 drop-rej 1/2

**Reading:**
- v10 accepts 66% of sold and rejects 68% of dropped. This is the weakest slice.
- Only 5 of the 40 dropped names have a decided lane: most dropped-name history lookups for this slice failed. The overall dropped numbers are still decidable through share and alt.
