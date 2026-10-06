# Iterations summary: v10 retest on held-out data (2026-10-06, 02:53–~03:25 IDT)

**Rule tested:** v10 = (registered-share ≥ .50 AND prior history) OR other extension registered before the .com OR tier B (share ≥ .60 AND ≤2 words) OR geo form G-FORM-1.

**Variants:**
- V1 = share ≥ .6 OR alt OR geo-form.
- V2 = share ≥ .7 OR alt OR geo-form.
- V3 = V1, but history that is redirect/error-only does not count.
- All three were chosen on DEV data only: the fit set plus round 3.

**Name registry:** `iterations/name-log.md`.

## Per round

| Round | What | Sold accepted (v10) | Dropped rejected (v10) | Note |
|---|---|---|---|---|
| 1 | Full DNW-style holdout (aged 37–60 m), plus a test of "no for-sale history" | 42/55 = **76%** | 43/55 = **78%** | Passes BT10-1. The for-sale exclusion fails (58% sold accepted); for-sale history is a positive signal |
| 2 | First retail slice, includes sub-$1k | 27/45 = 60% | 32/40 = 80% | Sub-$1k 12/25 |
| 3 | DEV: feature refinement and grid search | (49% / 68%) | | Picked V1, V2 and later V3. Parked prior history 44% sold vs 12% dropped |
| 4 | Test | 33/43 = 77% | 30/40 = 75% | V1 72% / 78% |
| 5 | Test (V3 first tested here) | 31/39 = 79% | 34/38 = 89% | V3 72% / 89% |
| 6 | Test | 26/42 = 62% | 29/39 = 74% | |
| 7 | Test | 27/41 = 66% | 27/40 = 68% | Weakest slice |
| 8 | Test | 32/45 = 71% | 23/36 = 64% | Flat; stopped |

## Pooled test results, rounds 4–8 (`iter/pooled_4_8.txt`)

| Rule | Sold accepted | Dropped rejected | Precision if 1% of names sell | if 2% |
|---|---|---|---|---|
| **v10** | **150/211 = 71%** | **144/195 = 74%** | 2.7% | 5.3% |
| V1 | 145/212 = 68% | 150/200 = 75% | 2.7% | 5.3% |
| V2 | 120/212 = 57% | 158/200 = 79% | 2.7% | 5.2% |
| V3 | 141/212 = 67% | 151/200 = 76% | 2.7% | 5.2% |

Adding round 2 to the pool, v10 is 177/256 = 69% sold accepted and 176/235 = 75% dropped rejected.

**Winner: v10, unchanged.** No variant beats it on held-out data; the variants only move along the same trade-off curve.

**Lift:** about 2.7× over the base rate. An accepted name sells at roughly 2.7%/yr if the base is 1%/yr. This is consistent with the v10 tier prior of 0.02/yr [est.].

## v10 by price band (pooled rounds 4–8, sold accepted)

| Band | Accepted |
|---|---|
| **<$1k** | **72/115 = 63%** |
| $1–2.5k | 36/46 = 78% |
| >$2.5k | 42/50 = 84% |

## v10 by lane (pooled rounds 4–8)

| Lane | Sold accepted | Dropped rejected | Precision @1% / @2% |
|---|---|---|---|
| **Expired** (re-registered drop with prior history) | 52/72 = 72% | **26/42 = 62%** | **1.9% / 3.7%** |
| Fresh hand-reg (no prior history) | 2/6 | 55/62 = 89% | n too small for sold |
| Aged originals (>36 m) | 66/79 = 84% | (no aged dropped controls) | – |
| Geo | **7/20 = 35%** | 7/8 | – |

## Findings

1. **v10 holds on the DNW-style holdout but is borderline on the broad retail market.** Retail misses the dropped-reject target by 1 point pooled (74% vs 75%), and slices vary by ±10–15 points.
2. **The main lane (expired names) is where v10 separates worst** (72% / 62%). Most of v10's separation comes from rejecting fresh hand-registered drops that have no history.
   - Within the expired lane, the fit-set separators did not replicate on the dev slice: there the dropped names had higher share and were shorter.
3. **Sub-$1k sales are accepted least** (63%). Cheap names have weaker neighbourhoods.
4. **Geo:**
   - Real geo sales in this data are $125–$499.
   - Most are 3 tokens and 17–28 chars, e.g. "losangelesroofers", "bathroomremodelingomaha". G-FORM-1 accepts only 3 of 17.
   - The tokenizer counts a two-word city as 2 tokens, which works against the rule's intent.
5. **Prior-history type** (fit set and dev slice):
   - **Parked** (41–44% of sold vs 12–22% of dropped) and **for-sale** (11–15% vs 4–8%) are positive signals.
   - Plain content is mixed.
   - "Never had a normal page" (redirect/error only) leans dropped, but adding it as a filter did not help on test data.
6. **Short and two-word names:**
   - Strong in the fit set (two words 86% vs 48% in the expired lane).
   - Weaker in retail data (dev slice: two words 69% vs 40%; ≤12 chars 56% vs 48%).
   - It stays a ranking preference, not a gate.
7. **Other extension registered first:**
   - 39% of sold vs 0% of dropped in the fit set, but only 7% vs 2% in retail. The signal is specific to recently re-registered names.
8. **Not available free in the time:** CPC proxy, NameBio daily CSVs (not cached; the bot download is forbidden by the v9.1 README), and NamePros direct fetch (403 to curl). The same report tables were taken from unreportedsales.com.

## Buy hold

**BT10-1 as written (≥70% / ≥75%, n ≥ 50):**
- **Passes** on the round-1 holdout: 76% / 78%, n = 55 / 55.
- **Narrowly fails** on the larger retail holdout: 71% / 74%, n = 211 / 195.
- **Fails in the main lane:** 72% / 62%.

**Recommendation:** keep BUY-HOLD. The lane we would actually buy from (expired) rejects only 62% of dropped names.

## Caveats

- The sibling census is checked as of today, not as of the sale date, for all sets.
- Dropped controls are names being deleted now (created 2021–2025). Sold names are mixed ages, and there are no aged dropped controls.
- About 165 Wayback lookups were throttled late in the run. Those rows count only where the decision does not depend on history: 6 undecided (1 sold, 5 dropped) for v10 in rounds 4–8.
- Retail sales come from a third-party weekly compilation [3P]. Sub-$100 sales were excluded.
