
**Result:**
- **On the pick slice, v10 already rejects 38/38 three-word dropped names.** Its problem is the sold side: it accepts only 9/36 on pick and 3/14 on test.
- **The core census is saturated:** two-word cores like "energy solution" have nearly all siblings registered, for sold and dropped names alike (0.85 vs 0.90). It carries no signal.
- **The best threshold tweak** (bt1 ≥ .30 for 3-word names) improved pick Youden by only 0.03, below the 0.05 bar.
- **On test it made identical decisions** to v10 (3/14 sold, 23/23 dropped).
- **Conclusion: no separate three-word pattern.** In this data, three-word names are rarely the sold kind and are almost never accepted. Leave them to v10, which in practice rejects them.

## 5. Buy-hold criteria status (≥70% sold accepted AND ≥75% dropped rejected, n ≥ 50 per class)

| Lane | Best evidence | Sold acc. | Dropped rej. | n | Status |
|---|---|---|---|---|---|
| Retail (all lanes, rounds 4–8) | v10 | 71% | 74% | 211 / 195 | **FAIL** (by 1 pt on dropped) |
| Expired (fresh test slice) | v10 / E3 | 61% / 53% | 68% / 75% | 36 / 40 | **FAIL** (and n < 50) |
| Expired vs aged drops | v10 / E3 | 61% / 53% | 74% / 74–76% | 36 / 68 | **FAIL** |
| Geo (test slice) | geo-share ≥ .5 proxy | 47% | 70% | 36 / 81 | **FAIL** (sold n < 50) |
| DNW-style holdout (round 1) | v10 | 76% | 78% | 55 / 55 | PASS (unchanged) |

## 6. Which rule maximizes expected profit

- **Expired lane, young-drop controls (test slice):** E3 > E2 > v10 > E1. E3 makes +$506 @1% and +$2,372 @2%.
- **Expired lane, aged-drop controls (closer to real picks):** v10 ≥ E3 > E2 > E1. v10 makes +$451 @1% and +$2,251 @2%; E3 makes +$400 and +$2,174.
- **Retail:** only v10 is measurable (span not built), at +$1,424 @1% and +$4,088 @2%.
- **Geo add-on (max 3 per batch):** negative per name. It lowers every batch by about $90–$290.
- **My pick: E3 = v10 + archive span ≥3 yrs.** It wins or ties on every out-of-sample comparison and is the most stable in the bootstrap. The gain over v10 is small and not significant against aged drops. **No rule makes a 1%-base batch reliably profitable.**

## 7. Proposed spec changes (not applied)

1. **Expired lane:** require **archive span ≥3 yrs** in addition to v10 (E3). This is a small, consistent gain against young drops and neutral against aged ones. Drop E1 and E2: they failed to replicate and do worse against aged drops.
2. **Add an aged-drop suite (BT10-13):** the dropped class for buy-hold should include names created **before 2016** from the live deleting list, since that is our pick pool. Target ≥50 with full archive lookups.
3. **Report expected profit per tranche:** add the §2 model as a required output of the holdout report, with p = 1% as the decision case and p = 2% as the upside. Show E[price] with and without the >$2.5k band. Proposed buy gate: **profit at p = 1% > 0 on out-of-sample data with E[price] taken from the pick slice**.
4. **Geo:** drop G-FORM-1 as an accept path (round 9) and **cap geo at 0–1 per tranche, not 3**, until a geo signal reaches positive profit at 2%. Today it is negative.
5. **Three-word names:** no new census pattern (bt3 is saturated). Keep FORM-2's ≤2-word preference. Optionally make "3 words" a soft negative in ranking.
6. **Wayback concurrency:** allow 2 concurrent CDX requests, paced at ≤24 requests/min total with a 60 s stop on any 429. That would roughly double the speed of filling the ≥50-per-class test slices. **Needs Dvir's approval** (it changes the "one request at a time" rule).
7. **Keep BUY-HOLD.**

## 8. Attack brief (for the risk-check bot)

**Rule under attack:**
- **E3** = v10 AND archive span ≥3 years.
  - v10 = (bt1 sibling share ≥ .50 AND prior archive history) OR another extension registered before the .com OR (share ≥ .60 AND ≤2 words).
  - Span = years from first to last Wayback capture before the current registration.
- Claim: E3 earns the most expected profit per $1,500 batch at a 1–2% base sale rate.

**Data:**
- Sold: UnreportedSales weekly tables [3P], ≥$100, .com, non-geo, created ≤36 m before sale (`r10/soldB.csv`; 36 expired-lane test rows).
- Dropped: SnapNames deleting list 2026-10-06. Young controls are created 2021–25 (`r9/dropB.csv`; 40 expired-lane test rows); aged controls are created before 2016 (`r11/old_rows.csv`, n = 68).
- Pick slice: `r10/pick.csv`.
- Profit model: `r11/profit.py`. Scripts: `r11/eval11.py`, `r11/eval3w.py`.

**Weak spots to try:**
1. **n is small:** 36 / 40 test rows and 68 aged drops. Profit swings with 5–6 sales above $2.5k (test E[price] $1.4–1.6k vs pick $0.9k).
2. **The base rate p (1–2%/yr) is assumed, not measured.** The sign of the profit flips between those two values.
3. **Sold prices are other sellers' realised prices,** not our BIN ($1,488 default). Survivorship: unreported and failed sales are invisible.
4. **The census is as of today, not the sale date.** The round 10 check found no leakage on the pick slice, but sold names from 2024 are older.
5. **Span is weak against aged drops** (median span 16 yrs). E3's gain over v10 may be only "young vs old drop".
6. **Wayback coverage:** names with no captures count as "no history". 45 s timeouts were retried, but any name still failing after retries stays an error and is excluded.
7. **Dropped ≠ unsellable:** some deleted names would have sold at a lower price.
8. **Geo rule is a proxy** (geo census share, no history check).
9. **The queue reorder** (2 dropped : 1 sold, pre-registered aged list) changes which test names were looked up first. Within each class the order is the original random order.

## 9. Files
- New: `r11/` (`profit.py`, `eval11.py`, `eval11.out.md`, `eval3w.py`, `eval3w.out.md`, `preregistered.md`, `old_cand.csv`, `old.csv`, `old_rows.csv`, `rdap_old.jsonl`, `creg_old.jsonl`, `exttaken_old.jsonl`, `alt_rdap_old.jsonl`, `bt3_sibs.json`, `creg_bt3.jsonl`, `qctl.py`, `wbq_orig.tsv`, `eval_test_final.txt`).
- Updated: `r9/wbB.jsonl` (more rows), `r10/test_rows.csv`, `r9/wbq.py` (pacing; old copy `r9/wbq_r10.py.bak`), `r9/wbq.tsv` (reordered), `iterations/name-log.md`.
- **Resume:** `python3 r9/wbq.py r9/wbq.tsv r9/wbB.jsonl` (optionally `python3 r11/qctl.py` for the 2:1 order), then `python3 r10/eval_test.py && python3 r11/eval11.py && python3 r11/eval3w.py test`.


## 10. Repo read (DvirBaumel8/domain-trading, main; read-only)
1. **3ab2953** (03:24 IDT) DOM's note in `CR-001-HOLD-01.md`: published `docs/contract/` v1.0.0 (+CHANGELOG), `docs/releases/v1.0.0.md`, `docs/internal/gaps.md`, and request/release templates. The inherited specs moved to `docs/internal/` (DOM-internal; "the contract is the interface").
2. **34946a5** (03:24) CR-002 (v10 checks) published, and the CAP-07/CAP-10 hold released. **9ad2374** (03:28) DOM's response to CR-002 (§5): **accepted with changes**. It folds into CR-001 P1 and ships together as contract v1.1.0.
3. **DOM pushback:** P-1 the rules and evidence (`selection-v10.md`, `research/backtest-sold/**`) are not in the repo. NEEDED: push them under `docs/requests/CR-002-reference/`, or DOM builds to the CR text only and can't write the CAP-21 replay tests. P-2: every threshold, tier and gate list becomes a setting, so v10.2 is a settings change.
4. **Also in the response:** P-3 CAP-21a replays an uploaded labelled feature table through the live tier code (CAP-21b, which recomputes features as of a date, comes later). P-4 `buy_hold` is a setting: `/buy` returns 409 `BUY_HOLD` until all three suites pass **and** Dvir's `approval_ref` is recorded. P-5 asks to confirm a "tranche" API object (409 `NO_TRANCHE`). P-6 harmful history is decided by versioned signature lists (FAIL/FLAG/PASS).
5. **Answers and later commits:** as-of sibling share is a lower bound (`as_of_exact=false` beyond 365 days); RDAP coverage is per extension (.co/.io/.ai unknown until measured); the CAP-18 fixture matched (Ratio 2.28/1.48, EV +$27.9). Later commits: **e6db969** contract v1.0.1 (21 accuracy-review corrections, 202 reconciler wording) and **af7de8c** package-lock 1.0.1. Nothing newer.

## Appendix A: full profit tables (`r11/eval11.out.md`)
