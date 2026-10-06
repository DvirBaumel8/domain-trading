# Round 1: full-size holdout (BT10-1) + "no for-sale history" variant (2026-10-06 ~02:57 IDT)

**Data (test only, never used to fit):**
- **Sold:** 55 descriptive non-geo .com sales registered 37–60 months before sale (`holdout/sold_holdout.csv`).
- **Dropped:** 55 names from a fresh SnapNames deleting-list slice created 2021–2025 (`holdout/drop_holdout.csv`).
- Coverage: census, Wayback and ext checks complete for all 110 names (1200 + 1000 siblings checked); 0 UNKNOWN.

| Rule | Sold accepted | Dropped rejected | BT10-1 (≥70% / ≥75%, n ≥ 50) |
|---|---|---|---|
| v10 rule I = (share ≥ .50 AND prior history) OR alt-ext-before | **42/55 = 76%** | **43/55 = 78%** | **PASS** |
| Tier A only | 39/55 = 71% | 44/55 = 80% | pass (thin) |
| I, but tier A needs prior history ≠ for-sale page | 32/55 = 58% | 44/55 = 80% | FAIL on sold |
| I, but tier A needs prior history = content only | 14/55 = 25% | 47/55 = 85% | FAIL |

**Idea tested:** "tier A requires no for-sale page in prior history". **Rejected.**
- 12 of 55 sold names had a for-sale page in prior history, against 4 of 55 dropped.
- Excluding them costs 10 sold accepts to save 1 dropped reject.
- A for-sale history is a *positive* signal: investors held the name before.

**Precision at realistic base rates** (TPR .76, FPR .22):
- 1% of names sell per year → precision 3.4% (lift 3.4×).
- 2% → 6.7%.

**Caveats:**
- The sibling census is checked as of today, not as of the sale date.
- 2 of 13 alt-ext RDAP lookups errored in this batch (counted as "not before").

Per-name results: `holdout/scored.csv` (N=55 run of `holdout/score.py`).
