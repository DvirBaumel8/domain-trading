# Round 10: expired lane, added signals (2026-10-06, 03:24–03:57 IDT)

**Goal:** raise dropped-rejected in the expired lane (v10: 62%) to ≥75% while keeping sold-accepted ≥70%, using one or two simple added signals.

## Rule-picking slice (no test names)
- **Source:** `r10/pick.csv`, the expired lane (prior Wayback history before the current creation) of iteration rounds 2–8: **103 sold / 75 dropped**. These names were used as TEST/DEV earlier, so they are allowed for picking but never again as test names.
- **Signals built** (`r10/fe.py`, all from files already on disk):
  - first archive capture year
  - archive span (years from first to last capture before the current creation)
  - number of captures
  - .net/.org registered (now, and before the .com)
  - alt-TLD count
  - dictionary status (zipf ≥ 3 for every token; this was 100% in both groups, so no signal)
  - length and words
- Sold vs dropped, medians:

| Signal | Sold | Dropped |
|---|---|---|
| First capture | **2012** | **2018** |
| Archive span | **12 yrs** | **4 yrs** |
| Captures | 12 | 4 |
| Sibling share | .60 | .30 |
| Chars | 12 | 12 |
| Words | 2 | 3 |

- .net/.org registered: mean 0.21 sold vs 0.04 dropped.

| Variant (on pick slice) | Sold acc. | Dropped rej. |
|---|---|---|
| v10 | 70/103 = 68% | 42/75 = 56% |
| v10 AND first capture ≤2012 | 39/103 = 38% | 64/75 = 85% |
| v10 AND first capture ≤2016 | 48/103 = 47% | 62/75 = 83% |
| v10 AND span ≥3 (**E3**) | 64/103 = 62% | 56/75 = 75% |
| v10 AND span ≥5 | 56/103 = 54% | 58/75 = 77% |
| v10 AND captures ≥5 | 59/103 = 57% | 58/75 = 77% |
| alt OR (share ≥.4 AND span ≥3) (**E1**) | 70/103 = 68% | 55/75 = 73% |
| E1 OR (share ≥.2 AND first capture ≤2010) (**E2**) | 72/103 = 70% | 55/75 = 73% |

- **Pre-registered before any test data was scored** (`r10/preregistered.md`): v10, E1, E2, E3.
- **Consistency check on the fit set** (expired lane, 209 sold / 94 dropped; already FIT; alt not available, so alt = 0):

| Variant | Sold acc. | Dropped rej. |
|---|---|---|
| v10 | 84% | 60% |
| E1 | 78% | 67% |
| E2 | 83% | 62% |
| E3 | 75% | 72% |
| share ≥.4 AND span ≥6 (exploratory) | 74% | 73% |

- Archive span separates in the fit set too (median 18 vs 6 yrs; first capture 2003 vs 2016).

## Test slice (fresh; NOT enough data)
- **Candidates:**
  - 307 sold: new UnreportedSales weeks June 2024–July 2026, RDAP created ≤36 m before sale, non-geo.
  - 343 dropped: fresh SnapNames 2026-10-06, created 2021–2025.
  - Sibling census (RDAP registered, 12,820 + 180 lookups) and alt-extension checks (exttaken + alt RDAP) were completed for all of them.
- **Bottleneck:** Wayback CDX, run one request at a time with retries/backoff as instructed, was heavily throttled. It returned **51 lookups in ~29 min** (03:27–03:56), sometimes stalling for minutes. The runner was stopped at 03:56. It can be resumed with `python3 r9/wbq.py r9/wbq.tsv r9/wbB.jsonl`, then re-score with `python3 r10/eval_test.py`.
- **Lane split of the 51:** sold 18 expired + 3 fresh; dropped 14 expired + 16 fresh.

| Variant | Test sold acc. | Test dropped rej. | n |
|---|---|---|---|
| v10 | 6/18 = 33% | 11/14 = 79% | 18 / 14 |
| E1 | 7/18 = 39% | 11/14 = 79% | 18 / 14 |
| E2 | 9/18 = 50% | 11/14 = 79% | 18 / 14 |
| E3 | 6/18 = 33% | 12/14 = 86% | 18 / 14 |

- **n is far below 50 per class, so nothing here is conclusive.**
- In this small slice, sibling share for older (2024–25) sold names is low (median 0.20 vs 0.075 dropped). Many are 3-token names, and the bt1 census swaps the first/last token of those, which gives low shares. So v10 accepts only a third of them.
- Archive span still separates: sold median 15 yrs vs dropped 4.5; first capture 2009.5 vs 2018.5.

## Similar names as of the sale date
- **Approximated cheaply:** RDAP creation dates of the 20 frozen siblings for 98 pick-slice sold names (1,971 lookups, `r10/sibdates.jsonl`). A sibling counts if it is registered now **and** was created before the sale date. This is a lower bound: siblings that dropped after the sale are not visible.
- **Result:** median share as of the sale date is 0.60, the same as today. v10 decisions did not change (67/98 both ways).
- **So the share signal is not leakage from registrations made after the sale.**

## Conclusion
- No simple added signal reached ≥75% dropped-rejected **and** ≥70% sold-accepted on the pick slice.
- **Archive span ≥3 yrs (E3) is the most consistent lever:** +7 to +19 pts dropped-rejected, at a cost of 6–9 pts sold-accepted, on the pick and fit sets. On the tiny test slice it was the best at rejecting dropped names.
- **Expired-lane buy-hold criteria: still FAIL / untested** (test n = 18 / 14).

## Proposed changes (not applied; selection-v10.md and CR-002 untouched)
1. **Expired lane:** add **archive span ≥3 years** (first to last Wayback capture before the current registration) as a required second signal, next to share ≥.50 / prior history. Expected effect: about 75% dropped-rejected at about 62% sold-accepted (pick slice). This does not meet the 70% sold-accepted target, so **BUY-HOLD stays**.
2. Record `first_capture_year` and `archive_span_years` on every S7 card as **ranking features**: a 2012-or-earlier first capture is a strong preference.
3. Before any buy, re-run the frozen test slice (`r10/soldB.csv`, `r9/dropB.csv`; resume `r9/wbq.py`) until there are ≥50 expired names per class. Score only the pre-registered v10, E1, E2 and E3.
4. The bt1 census gives very low shares for 3-token names. Consider a separate census pattern for 3-token names; this is untested.
