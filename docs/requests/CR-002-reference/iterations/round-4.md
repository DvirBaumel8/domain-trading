# Round 4: test of pre-registered rules (fresh slice, week of Aug 24)

**Data:** 43 sold (25 <$1k, 8 $1–2.5k, 10 >$2.5k) + 40 dropped (fresh SnapNames slice). Test only.

| Rule | Sold accepted | Dropped rejected | Prec. @1% | @2% |
|---|---|---|---|---|
| v10 full | **33/43 = 77%** | **30/40 = 75%** | 3.0% | 5.9% |
| V1 share ≥ .6 OR alt OR geo-form | 31/43 = 72% | 31/40 = 78% | 3.1% | 6.1% |
| V2 share ≥ .7 OR alt OR geo-form | 24/43 = 56% | 32/40 = 80% | 2.7% | 5.4% |

**Sold accepted by band:**

| Band | v10 | V1 | V2 |
|---|---|---|---|
| <$1k | 18/25 | 16/25 | 11/25 |
| $1–2.5k | 5/8 | 5/8 | 4/8 |
| >$2.5k | 10/10 | 10/10 | 9/10 |

**By lane:**
- Expired lane, v10: sold 20/26 accepted vs dropped 9/17 rejected. This is the weak spot: dropped names that once had a site also have high-share neighbourhoods.
- Fresh hand-reg dropped names: 19/21 rejected.

**Reading:**
- Round 4 is much kinder to v10 than round 2 (60% / 80%). Slice-to-slice noise at n ≈ 40 is about ±15 pts.
- V2 is too strict on cheap names. It is dropped from consideration only after the pooled result (rounds 4–8), not on this round alone.

Full table: `iter/r4.txt`.
