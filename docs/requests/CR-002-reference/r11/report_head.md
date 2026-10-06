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
