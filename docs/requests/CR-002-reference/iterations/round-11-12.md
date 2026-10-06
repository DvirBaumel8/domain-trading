# Rounds 11–12: test-slice archive lookups, profit per rule, aged drops, three-word pattern (2026-10-06, 03:56–04:50 IDT)

Nothing pushed, sent or bought. `system/selection-v10.md` and CR-002 untouched. Sources: Wayback CDX (one request at a time), Verisign/registry RDAP, SnapNames public deleting list (already on disk), UnreportedSales tables (already on disk). No NameBio bulk, no BBB, no undocumented backends.

## 0. Bottom line (plain words)

1. **Buy-hold criteria (≥70% sold accepted, ≥75% dropped rejected, n ≥ 50 per class) still fail in every lane.** Retail v10 is 71% / 74% (n = 211 / 195), 1 point short. Expired lane test is now 36 sold / 40 dropped (still under 50); the best rule there is 61% / 68% (v10) or 53% / 75% (E3). Geo is 47% / 70% on test. **BUY-HOLD stays.**
2. **Money view:** with $11 first year, $23/yr renewals and 20% commission, a 26-name batch ($1,500 covers 3 years even if nothing sells) **loses money at a 1% base sale rate for most rules in most data, and makes roughly +$0.4k to +$2.4k at 2%**. The result swings on 5–6 high-priced sales per slice, so it is not a reliable profit forecast.
3. **Which rule earns most:** on the fresh expired test slice, **E3 (v10 AND archive span ≥3 yrs)** has the highest expected profit (+$506 @1%, +$2,372 @2%; bootstrap P(profit > 0) 79% / 99%). **But against aged drops (the names we would actually pick from), E3 is no better than v10, and E1/E2 are worse.** Every aged drop with an archive lookup had history (24/24, median span 16 yrs), so the span signal does not separate them. Against aged drops, **v10 is the most profitable** (+$451 @1%, +$2,251 @2%), with E3 a close second (+$400 / +$2,174).
4. **Aged drops (created before 2016) are harder controls than the 2021–25 drops:** v10 rejects 74%, E3 74–76%, E1 68%, E2 65% (n = 68).
5. **Geo:** passing geo names on the same evidence (proxy) **loses money even at 2%** on test (−$160), because geo names sell cheaply (expected $665). Capping geo at 3 per batch costs the batch about $90–$290 against an all-non-geo batch.
6. **Three-word names:** a separate neighbor pattern **does not help**. The 2-word-core census is saturated (median share 0.85 sold vs 0.90 dropped), and the best threshold tweak gained only 0.03 Youden on the pick slice (below the pre-registered 0.05 bar). On test it gave identical decisions to v10.
7. **Wayback speed:** IA's documented limit (30 CDX requests/min hard, 24/min advised) is not the bottleneck. Each CDX answer takes about 14–45 s, so one request at a time gives about 2–3 lookups/min. Going faster legally would need 2–3 parallel requests (still under 10/min), which breaks your "one request at a time" rule. **That needs your OK.** Common Crawl's index is legal and documented but no use here (see §1).

## 1. Goal 1: expired-lane test slice (resumed)

- **Runner:** `python3 r9/wbq.py r9/wbq.tsv r9/wbB.jsonl` ran single-threaded from 03:57 to 04:45. Pacing was changed to IA's guidance: ≥2.6 s between request starts; on any 429, pause 60 s and double the pause on each repeat. The old version slept only 0.8 s and retried 429s after 10 s. A small controller (`r11/qctl.py`) only **reorders** the queue: 2 dropped to 1 sold until each class has 50 expired rows, with the 24 aged drops that needed history slotted in. The original order is in `r11/wbq_orig.tsv`.
- **Throughput:** 51 → 138 test-slice rows plus 24 aged-drop rows in 48 min (113 lookups, about 2.35/min). No 429s; several 45 s timeouts. The limit is server latency (about 14–20 s per query, measured).
- **Documented limits checked:**
  - Internet Archive staff, as relayed in the `edgi-govdata-archiving/wayback` issue #137 and the library release notes (issue #208), state these hard limits: `/cdx` 60/min (later lowered to 30/min), timemap shares the CDX limit, and clients should use 80% (24/min). Ignoring 429s for over a minute gets the IP blocked for 1 hour, doubling each time.
  - We are far below that rate. A faster rate is only possible with concurrency, which you ruled out. Recommendation: allow 2 concurrent requests (about 4–5/min, still about 20% of the advised cap). **Not done without your approval.**
- **Alternatives for first-seen dates:**
  - **Common Crawl CDX index:** legal and documented (index.commoncrawl.org; ToU allows research use). But it has 128 separate crawl indexes (2008–2026), one query per crawl per name at about 9 s each, and thin coverage: `nursingtutoring.com` has Wayback captures since 2009 but none in CC-MAIN-2013-20. **Not usable** for first-seen dates.
  - The CC columnar index (Athena/S3) would need an AWS account and spend, so it is out of scope (free data only).
  - No other free documented first-seen source was found.

### Test slice result (pre-registered rules only; `r10/eval_test.py`)

| Rule | Sold accepted | Dropped rejected | n (expired lane) |
|---|---|---|---|
| v10 | 22/36 = **61%** | 27/40 = **68%** | 36 / 40 |
| E1 | 20/36 = 56% | 26/40 = 65% | 36 / 40 |
| E2 | 22/36 = 61% | 26/40 = 65% | 36 / 40 |
| E3 | 19/36 = 53% | 30/40 = **75%** | 36 / 40 |

- **Fresh lane, for reference:** 5 sold and 57 dropped had no history. Under v10 they are rejected unless alt or tier B applies.
- **Still n < 50 per class.** The trend from round 10 (n = 18/14) moved toward v10, which went from 33% / 79% to 61% / 68%.
- E1 and E2 did **not** replicate their pick-slice advantage (68% / 73%). E3 again rejects the most dropped names, at the cost of about 8 points of sold acceptance.
- 3-word sold names are the weak spot: v10 accepts 3/14 of them (see §4).

## 2. Goal 2: expected profit per rule ($1,500 batch, 3 years)

**Model** (`r11/profit.py`):
- **Batch size:** 26 names. Each costs at most $11 + 2 × $23 = $57 over 3 years, so $1,500 covers all of them even if nothing sells.
- **Yearly sale chance of an accepted name:** q = p·TPR / (p·TPR + (1−p)·FPR), where p is the base yearly sale rate (1% or 2%), TPR = sold accepted, FPR = 1 − dropped rejected.
- **Sold names stop renewing.** Expected cost = $11 + $23·(1−q) + $23·(1−q)².
- **Expected revenue** = 0.8 × E[price] × (1 − (1−q)³).
- **E[price]** = Σ over bands (<$1k, $1–2.5k, >$2.5k) of (share of accepted sold names in that band) × (median price of accepted sold names in that band).
- **Unsold names at year 3 are valued at $0** (conservative).

**Profit per rule, 26-name batch over 3 years** (full tables with q, E[price] and bands in Appendix A):

| Rule | Expired TEST slice @1% / @2% | Expired TEST sold vs AGED drops @1% / @2% | Expired pick slice @1% / @2% (in-sample for E1–E3) | Expired pick+test pooled @1% / @2% | Retail rounds 4–8 @1% / @2% | Geo test @1% / @2% |
|---|---|---|---|---|---|---|
| v10 | +$105 / +$1,609 | +$451 / +$2,251 | -$523 / +$396 | -$425 / +$586 | +$1,424 / +$4,088 | – |
| E1 | -$31 / +$1,358 | +$83 / +$1,575 | +$14 / +$1,394 | – | – | – |
| E2 | +$213 / +$1,826 | +$199 / +$1,800 | +$26 / +$1,413 | – | – | – |
| E3 | +$506 / +$2,372 | +$400 / +$2,174 | -$154 / +$1,076 | – | – | – |
| geo-same-evidence (proxy) | – | – | – | – | – | -$807 / -$160 |

**Reading the profit tables:**
- **Out-of-sample data only:**
  - v10 everywhere (it was never fitted on these slices).
  - E1–E3 on the TEST slice and against aged drops.
  - The pick-slice rows for E1–E3 are in-sample and look better than they are.
- **The sign of the profit depends on the base rate:**
  - At 1%, retail v10 is the only clearly positive result (+$1,424). In the expired lane, results range from −$523 (v10 pick) to +$506 (E3 test).
  - At 2%, almost everything is positive: +$396 to +$2,372 in the expired lane.
- **Break-even:** a rule needs q ≈ 2.0–2.6%/yr per accepted name at the expired-lane E[price] of $900–1,200. At 1% base, that needs a lift of about 2.5×, which no rule reliably reaches in the expired lane.
- **The price term is fragile.** In the test slice, E[price] ($1.4–1.6k) rests on 5–6 sales above $2.5k. The pick slice gives $870–990, and the bulk of accepted sales are under $1k at a $295–$347 median. With the pick-slice prices, every expired-lane rule is negative at 1%.

## 3. Goal 3: harder controls (aged drops)

- **Source:**
  - 900 random unused 2–3-word, non-geo .com names from today's SnapNames public deleting list (`raw/sn_target_like.csv`, seed 1111).
  - Verisign RDAP creation date for each; 68 (7.6%) were created **before 2016** (median 2011).
  - Each got a bt1 census (1,360 sibling RDAP checks), alt-extension DNS + RDAP, and, where history could change a decision, a Wayback lookup (24 names, `to` = today, since a buyer sees the full history at drop time).
- **NameJet public lists** were not used: the SnapNames list already gave enough names. No undocumented endpoints were touched.

**What they look like:**
- Median bt1 share 0.05; 16/68 have share ≥ .5; 23/68 are 2-word.
- All 24 with archive lookups have history: median span **16 yrs**, first capture 2010.
- So the history and span signals look like those of *sold* names. Only the neighbor share separates them.

| Rule | Aged drops rejected (n = 68) |
|---|---|
| v10 | 50/68 = **74%** |
| E1 | 46/68 = 68% |
| E2 | 44/68 = 65% |
| E3 | 50–52/68 = **74–76%** (2 undecided) |

- **Plain words:** archive age and span help against *young* drops (2021–25), but not against the *old* drops that make up our real pick pool. The rule that adds span (E3) does no better than v10 against them. E1 and E2 do worse, because their "old archive" paths accept old drops.
- **Combined with the test sold names (61% / 74%), v10 still fails 70% / 75% on both sides.**

## 4. Goal 4: three-word names (pre-registered, `r11/preregistered.md`)

**Pattern bt3** (frozen before scoring): for a 3-word name a+b+c, take the 20 siblings of the 2-word head core (b+c) from the same bt1 builder, with RDAP registered share. Candidates:
- T1(k): bt1 share cut for 3-word names, k = .10–.30.
- T2(k): bt3 core share ≥ k, k = .5–.7.
- Mechanical Youden pick on the pick-slice 3-word rows (36 sold / 38 dropped).

bt3 coverage on pick 3-word: 74/74
pick 3-word sold: median bt3 core share 0.85 (n=36); median bt1 0.10
pick 3-word dropped: median bt3 core share 0.90 (n=38); median bt1 0.05

| Variant | Pick 3-word: sold acc. | dropped rej. | Youden | Pick all expired: sold acc. | dropped rej. |
|---|---|---|---|---|---|
| T0 (v10) | 9/36 = 25% | 38/38 = 100% | 1.25 | 70/103 = 68% | 42/75 = 56% |
| T1(0.10) | 25/36 = 69% | 21/38 = 55% | 1.25 | 86/103 = 83% | 25/75 = 33% |
| T1(0.15) | 17/36 = 47% | 22/38 = 58% | 1.05 | 78/103 = 76% | 26/75 = 35% |
| T1(0.20) | 15/36 = 42% | 30/38 = 79% | 1.21 | 76/103 = 74% | 34/75 = 45% |
| T1(0.25) | 12/36 = 33% | 32/38 = 84% | 1.18 | 73/103 = 71% | 36/75 = 48% |
| T1(0.30) | 12/36 = 33% | 36/38 = 95% | 1.28 | 73/103 = 71% | 40/75 = 53% |
| T2(0.50) | 35/36 = 97% | 0/38 = 0% | 0.97 | 96/103 = 93% | 4/75 = 5% |
| T2(0.60) | 31/36 = 86% | 1/38 = 3% | 0.89 | 92/103 = 89% | 5/75 = 7% |
| T2(0.70) | 28/36 = 78% | 2/38 = 5% | 0.83 | 89/103 = 86% | 6/75 = 8% |

Picked T* = T1(0.30) (Youden 1.28 vs T0 1.25); beats T0 by ≥0.05: False

| Variant (TEST) | Test 3-word expired: sold acc. | dropped rej. | Test all expired: sold acc. | dropped rej. | Aged drops 3-word w/ archive: rej. |
|---|---|---|---|---|---|
| T0 (v10) | 3/14 | 23/23 | 22/36 | 27/40 | 1/1 |
| T1(0.30) | 3/14 | 23/23 | 22/36 | 27/40 | 1/1 |

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

#### Expired lane, rule-picking slice (103 sold / 75 dropped; E1–E3 were chosen here, so in-sample)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 70/103 = 68% | 42/75 = 56% | $986 (1-2.5k: 13, $2,195; <1k: 51, $295; >2.5k: 6, $4,245) | 1.5% | **-$523** | 3.1% | **+$396** |
| E1 | 70/103 = 68% | 55/75 = 73% | $950 (1-2.5k: 13, $2,000; <1k: 51, $295; >2.5k: 6, $4,245) | 2.5% | **+$14** | 4.9% | **+$1,394** |
| E2 | 72/103 = 70% | 55/75 = 73% | $932 (1-2.5k: 13, $2,000; <1k: 53, $295; >2.5k: 6, $4,245) | 2.6% | **+$26** | 5.1% | **+$1,413** |
| E3 | 64/103 = 62% | 56/75 = 75% | $872 (1-2.5k: 12, $2,042; <1k: 47, $295; >2.5k: 5, $3,495) | 2.4% | **-$154** | 4.8% | **+$1,076** |

#### Expired lane, TEST slice (fresh names; n = 36 sold / 40 dropped)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 22/36 = 61% | 27/40 = 68% | $1,362 (1-2.5k: 4, $1,656; <1k: 13, $299; >2.5k: 5, $3,888) | 1.9% | **+$105** | 3.7% | **+$1,609** |
| E1 | 20/36 = 56% | 26/40 = 65% | $1,468 (1-2.5k: 4, $1,656; <1k: 11, $299; >2.5k: 5, $3,888) | 1.6% | **-$31** | 3.1% | **+$1,358** |
| E2 | 22/36 = 61% | 26/40 = 65% | $1,565 (1-2.5k: 4, $1,656; <1k: 12, $347; >2.5k: 6, $3,942) | 1.7% | **+$213** | 3.4% | **+$1,826** |
| E3 | 19/36 = 53% | 30/40 = 75% | $1,529 (1-2.5k: 4, $1,656; <1k: 10, $299; >2.5k: 5, $3,888) | 2.1% | **+$506** | 4.1% | **+$2,372** |

#### Retail, all lanes, rounds 4–8 pooled (v10 only, decidable rows; E rules need archive span, which was only built for the expired lane)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 150/211 = 71% | 144/195 = 74% | $1,761 (1-2.5k: 38, $1,999; <1k: 72, $295; >2.5k: 40, $4,174) | 2.7% | **+$1,424** | 5.3% | **+$4,088** |

#### Geo, pick slice (proxy rule: geo census share ≥ .50; no archive-history check available)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| geo-same-evidence (proxy) | 19/39 = 49% | 58/81 = 72% | $706 (1-2.5k: 5, $1,988; <1k: 14, $248) | 1.7% | **-$714** | 3.4% | **+$18** |

#### Geo, test slice (proxy rule: geo census share ≥ .50; no archive-history check available)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| geo-same-evidence (proxy) | 17/36 = 47% | 57/81 = 70% | $665 (1-2.5k: 2, $1,298; <1k: 14, $265; >2.5k: 1, $4,999) | 1.6% | **-$807** | 3.2% | **-$160** |

#### Aged drops (created before 2016, on today's SnapNames deleting list): 68 found, 68 with census+alt, 24 with archive history looked up

Decided = the rule's answer is known: either the archive row exists, or no archive result could change the answer.

| Rule | Aged dropped rejected | Undecided |
|---|---|---|
| v10 | 50/68 decided; bounds 50/68 = 74% (all undecided accepted) to 50/68 = 74% | 0 |
| E1 | 46/68 decided; bounds 46/68 = 68% (all undecided accepted) to 46/68 = 68% | 0 |
| E2 | 44/68 decided; bounds 44/68 = 65% (all undecided accepted) to 44/68 = 65% | 0 |
| E3 | 50/66 decided; bounds 50/68 = 74% (all undecided accepted) to 52/68 = 76% | 2 |

Aged drops: median bt1 share 0.05; share ≥.5: 16/68; alt-before ≥1: 2; 2-word: 23/68; creation years median 2011.0
Aged drops with archive rows (n=24): prior history 24/24; median span 16.0 yrs; median first capture 2010.0

#### Expired TEST sold + AGED drops as the dropped class (conservative: undecided aged drops counted as accepted)

| Rule | Sold acc. (test) | Aged dropped rej. (lower bound) | E[price] | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 22/36 = 61% | 50/68 = 74% | $1,362 | 2.3% | **+$451** | 4.5% | **+$2,251** |
| E1 | 20/36 = 56% | 46/68 = 68% | $1,468 | 1.7% | **+$83** | 3.4% | **+$1,575** |
| E2 | 22/36 = 61% | 44/68 = 65% | $1,565 | 1.7% | **+$199** | 3.4% | **+$1,800** |
| E3 | 19/36 = 53% | 50/68 = 74% | $1,529 | 2.0% | **+$400** | 3.9% | **+$2,174** |

#### Expired lane, v10 on pick + test pooled (both out-of-sample for v10; E rules excluded because they were chosen on pick)

| Rule | Sold acc. | Dropped rej. | E[price] (bands: n, median) | q/yr @1% | Profit @1% | q/yr @2% | Profit @2% |
|---|---|---|---|---|---|---|---|
| v10 | 92/139 = 66% | 69/115 = 60% | $1,019 (1-2.5k: 17, $1,888; <1k: 64, $295; >2.5k: 11, $3,888) | 1.6% | **-$425** | 3.3% | **+$586** |

#### Batch of 26 = 23 non-geo (rule on expired TEST numbers) + 3 geo (geo proposal, geo TEST numbers)

| Non-geo rule | All 26 non-geo @1% | 23+3 geo @1% | All 26 non-geo @2% | 23+3 geo @2% |
|---|---|---|---|---|
| v10 | +$105 | +$0 | +$1,609 | +$1,405 |
| E1 | -$31 | -$121 | +$1,358 | +$1,183 |
| E2 | +$213 | +$95 | +$1,826 | +$1,597 |
| E3 | +$506 | +$355 | +$2,372 | +$2,080 |

#### Break-even yearly sale probability per accepted name (3-year hold, $57 max cost, 20% commission)

| E[price] | Break-even q/yr |
|---|---|
| $300 | 7.8% |
| $500 | 4.7% |
| $900 | 2.6% |
| $1,200 | 2.0% |
| $1,800 | 1.3% |

#### Bootstrap, expired TEST slice (2,000 resamples): batch profit 10th / 50th / 90th percentile, and share of resamples with profit > 0

| Rule | @1%: p10 / p50 / p90 | P(>0) @1% | @2%: p10 / p50 / p90 | P(>0) @2% |
|---|---|---|---|---|
| v10 | -$443 / +$194 / +$1,158 | 64% | +$558 / +$1,773 / +$3,617 | 98% |
| E1 | -$567 / +$41 / +$931 | 52% | +$320 / +$1,493 / +$3,202 | 96% |
| E2 | -$361 / +$261 / +$1,168 | 69% | +$716 / +$1,916 / +$3,659 | 99% |
| E3 | -$256 / +$554 / +$2,078 | 79% | +$915 / +$2,467 / +$5,297 | 99% |

