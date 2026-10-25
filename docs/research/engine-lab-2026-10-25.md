# Engine lab: the real scoring engine on the CR-002 history (DOM, 25 Oct 2026)

Question (Dvir): "what scores we give to historical data". I ran the engine's own code (`src/modules/engine/`) on the CR-002 sold and dropped names, on a local lab database only. No production, no network, no tokens. Scripts and raw outputs are in the session scratchpad (`engine-lab/`: `prep.py`, `load.mts`, `train.mts`, `cv.mts`, `out-cv-*.json`).

## Short answer
- **The engine's own training run fails on this data** (`NOT_ENOUGH_DATA`): every dropped name is dated July to October 2026, so the engine's time split leaves zero dropped names to train on.
- With the engine's model code under a seeded 5-fold cross-validation (CV), the full feature set reaches **AUC 0.94 to 0.96. That number is not real.** Two date leaks cause it (below).
- **With the leaking features removed, the engine scores about 0.74** (CV, 95% interval 0.71 to 0.77). On a time split (sales of 2026-Q3 held out), it scores **0.67 to 0.71**. That is below the lift method (0.80) and the v2 score (0.79) on the same names. Those two use the sibling census and past-website signals, which the engine doesn't have.
- **The other endings help where they were measured**: +0.06 AUC on the 343 names that have a .net/.org answer (0.76 with them, 0.70 without). They were measured for only 20 to 30% of the names, so overall they add little (0.74 against 0.72).

## Setup
- DB: local docker Postgres, new databases `dt_engine_lab` (endings from RDAP only, the engine's rule) and `dt_engine_lab_dns` (RDAP plus DNS "nxdomain" read as "not registered" for .net/.org only). Both were migrated with `npm run migrate -- up`.
- Rows were loaded with the engine's `storeSales` / `storeUnsold`. `engine_endings` was filled by direct inserts in the shape `saveAnswer` writes (`checked_at` 2026-10-06, the day of the research). Training: `EngineTrainer.start` + `runById`. CV: `computeFeatures`, `fitGbm`, `fitLogit`, `aucWithCi`, `precisionAtTop`, `reasonsFor` with the `dataset.ts` row rules and the `train.ts` feature-inclusion rules (the .com-date 30% rule included). Folds are seeded (56), grouped by domain and stratified by label.

## Data that went in
| | Sold | Dropped |
|---|---|---|
| features.csv | 767 | 988 |
| Left out: no price found (all from `iter-r2`..`iter-r8`) | **192** | |
| Left out: no date (r9-geo, no `as_of` or `join_by`) | | 22 |
| Rejected by `storeUnsold`: `DATE_IN_FUTURE` (`as_of` = an expiry after today) | | 5 |
| Stored | 575 | 961 |
| **After the regime filter (letters only, 6..20 chars, 2..3 words) = rows used** | **497** | **806** |

- Prices came from dataset.csv (280), r10/pick.csv (99, no date: features.csv `as_of` was used), r9/geo_all_census (74), r10/soldB (63), holdout s30 (30) / s25 (25), and us_weekly_sales_old (4). In 5 rows the file's sale date differs from features.csv `as_of`; the file date was used.
- 140 r9-geo dropped rows had no `as_of`; their SnapNames `join_by` date (r9/dropG2.csv) was used instead.

**Endings coverage** (name rows with an answer):
| Ending | RDAP: sold / dropped | Added by DNS nxdomain (variant): sold / dropped |
|---|---|---|
| .com own creation date | 398 / 708 answered | |
| .net | 38 / 4 registered with date | +80 / +258 not registered |
| .org | 25 / 5 | +93 / +257 |
| .co, .io, .ai | 17-21 / 1-4, all **unanswered** (RDAP `err` in every file) | not used (it would turn "null" into "taken") |

Only three slices have endings data at all: holdout-r1, r10-test and r11-aged (380 names). The research asked RDAP only for the .net/.org names that DNS showed as taken, so in RDAP-only mode an unregistered ending simply has no row. That's why the DNS variant is the meaningful one for endings. The census `registered_share`, Wayback history and `alt_tld_before_n` from features.csv are not engine features and were not used. The `demand` feature is empty (no keyword data loaded).

## 1. The engine's own training (time split)
`EngineTrainer` → failed `NOT_ENOUGH_DATA`: sold eligible 497, unsold eligible 806, test quarter 2026-Q3, train sold 383, **train unsold 0**, test sold 114, test unsold 247. The dropped rows span more than 90 days (July to October 2026), so `dataset.ts` picks `dated` mode, and no dropped row is older than the test quarter. This is the engine working as designed on data with one batch of drop dates. I made two documented alternatives:

**1a. Engine-like split (same code, unsold side in the engine's `hash` mode):** test = 114 sold of 2026-Q3 + 178 dropped (seeded 20% hash, capped at 3 per sale); train = 383 sold before Q3 + 628 dropped.
| Features | AUC (95% CI) | Logistic AUC | Precision top 5% / 10% |
|---|---|---|---|
| Full | 0.70 (0.64-0.76) RDAP+DNS; 0.71 (0.65-0.77) RDAP | 0.63 | 1.00 / 0.73 |
| Without endings | 0.67 (0.60-0.73) | 0.60 | 0.93 / 0.70 |
| Without .com date and token history ("clean") | 0.70 (0.63-0.76) | 0.73 | 0.73 / 0.63 |
| Clean, without endings | 0.66 (0.59-0.73) | 0.68 | 0.73 / 0.50 |
(The top 5% is about 15 names, so those precisions are very noisy.)

## 2. 5-fold CV (every name gets an out-of-fold score), RDAP+DNS variant
Base rate: 38% sold (497 of 1,303).
| Features | AUC (95% CI) | Logistic AUC | Prec. top 5% (66) | Prec. top 10% (131) | Prec. top 1% at 1:100 base |
|---|---|---|---|---|---|
| Full (all engine features) | **0.957** (0.947-0.967) | 0.79 | 1.00 | 1.00 | 0.51 |
| Without endings (the engine's ablation) | 0.947 (0.936-0.958) | 0.78 | 1.00 | 1.00 | 0.49 |
| Without .com date (`acq_*`, `com_age_years`) | 0.840 (0.817-0.860) | 0.80 | 0.89 | 0.85 | 0.13 |
| Without token history (`trend_pit_*`, `tok_rate_pit`) | 0.939 (0.925-0.951) | 0.77 | 1.00 | 1.00 | 0.56 |
| **Clean: without .com date and token history** | **0.740 (0.711-0.767)** | 0.77 | **0.83** (0.73-0.90) | **0.77** (0.69-0.83) | 0.07 |
| Clean, without endings | 0.721 (0.690-0.749) | 0.74 | 0.73 | 0.68 | 0.05 |
| Shape only | 0.737 (0.709-0.765) | 0.74 | 0.71 | 0.70 | 0.07 |
| Clean, only the 343 names with a .net/.org answer (101 sold / 242 dropped) | 0.759 (0.702-0.815) | | | | |
| Clean without endings, same 343 names | 0.697 (0.640-0.761) | | | | |

The RDAP-only database gives the same picture (full 0.94; clean 0.735, 0.71-0.76). There, the endings-covered subset is only 45 sold / 6 dropped, too few to read.

**Top features (clean CV, mean gain):** n_words 0.38, vowel_share 0.14, seg_cost_per_char 0.13, len 0.11, n_endings_pit 0.08, zipf_mean 0.08, zipf_max 0.03, net_pit 0.02. **Logistic (standardised, + = toward sold):** n_words −1.12, seg_cost_per_char +0.54, net_pit +0.53, n_endings_pit +0.41, zipf_max +0.33, zipf_min +0.27, len +0.15. In plain words: two words beat three, rarer or brandable words beat plain phrases, and a registered .net helps. In the full model, `com_age_years` alone takes **52% of the gain**, ahead of trend_pit_max (9%) and tok_rate_pit (9%).

**Score distribution (clean CV, deciles of the out-of-fold score, top first):**
| Decile | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| Score range | 0.70-1.00 | 0.60-0.70 | 0.51-0.60 | 0.41-0.51 | 0.34-0.41 | 0.25-0.34 | 0.21-0.25 | 0.18-0.21 | 0.13-0.18 | 0.01-0.13 |
| Sold | 100 | 84 | 70 | 56 | 45 | 43 | 27 | 31 | 17 | 24 |
| Dropped | 30 | 46 | 60 | 75 | 85 | 87 | 104 | 99 | 113 | 107 |

Score quantiles p10/p25/p50/p75/p90: sold 0.18 / 0.31 / 0.53 / 0.68 / 0.80; dropped 0.11 / 0.17 / 0.24 / 0.42 / 0.60. For comparison, the full (leaky) model puts 130/0 and 126/4 in the top two deciles and 0/130 in the bottom two.

**20 examples (clean CV, out-of-fold score; reasons = the fold's logistic model through `reasonsFor`):**
| Score | Label | Name | Date | Price | Top reasons |
|---|---|---|---|---|---|
| 0.996 | sold | forgegeo.com | 2025-05-14 | $2,595 | + two words; + rare words (cost 5.3/letter); + 1 other ending before the date |
| 0.972 | sold | tulsapro.com | 2025-06-17 | $3,599 | + two words; + rare words |
| 0.964 | sold | mediaaisle.com | 2022-02-23 | $2,885 | + two words; + 60% vowels |
| 0.963 | sold | azaleacounseling.com | 2026-04-02 | $149 | + two words; + 1 other ending before |
| 0.960 | sold | icontile.com | 2026-07-14 | $6,800 | + .net registered before; + two words |
| 0.951 | sold | cyberwales.com | 2026-08-22 | $199 | + two words |
| 0.918 | sold | betdelhi.com | 2022-11-02 | $4,750 | + two words; + rare words |
| 0.918 | sold | perutrek.com | 2026-09-01 | $2,400 | + two words; + rare words |
| 0.917 | dropped | jackczech.com | 2026-10-08 | | + two words; + rare words |
| 0.898 | dropped | thecanvascafe.com | 2026-10-08 | | + .org and 1 other ending before; − three words |
| 0.010 | dropped | climatechangeltd.com | 2026-10-07 | | − three words; − common words |
| 0.009 | dropped | ironarmourgroup.com | 2026-10-08 | | − three words |
| 0.008 | dropped | victoryoverdebts.com | 2026-10-06 | | − three words; − common words |
| 0.007 | dropped | legacylifeadvisory.com | 2026-10-08 | | − three words; − common words |
| 0.007 | dropped | opencartexperts.com | 2026-10-07 | | − three words |
| 0.007 | sold | bluedogcoin.com | 2024-08-28 | $5,499 | − three words |
| 0.007 | dropped | deanlovesam.com | 2026-10-06 | | − three words |
| 0.006 | dropped | booktvmovie.com | 2026-10-07 | | − three words |
| 0.006 | dropped | rolesgohire.com | 2026-10-09 | | − three words |
| 0.006 | dropped | propertyscanreport.com | 2026-10-07 | | − three words; − common words |

The top ten names are 8 sold and 2 dropped; the bottom ten are 9 dropped and 1 sold. The model mostly reads "two words, unusual words": it's a shape model plus a little .net signal.

## 3. Comparison
| Method (same CR-002 names) | AUC |
|---|---|
| Lift, 4 patterns, 5-fold (backtest-score-methods-2026-10-25) | 0.80 |
| v2 proposal (Shape + Registered elsewhere) | 0.79 |
| **Engine, clean features, 5-fold** | **0.74** (0.71-0.77) |
| Engine, clean, time split 2026-Q3 | 0.70 (0.63-0.76) |
| Engine, full features, 5-fold (leaky) | 0.96 |
| "0.85" | see below |

- **The 0.85 is not an engine result on this set.** In `CR-002-reference/results.md` (line 86), 0.85 is the single-feature AUC of the sibling census `registered_share`. In CR-056, 0.850 is Gavriel's prototype GBM with lexical features (0.809 with the point-in-time trend). The backtest note labels 0.85 "CR-002 engine model (gradient boosting)"; that label should be corrected.
- The engine is weaker than lift because its feature set has neither the sibling census (the strongest CR-002 signal) nor the past-website signal, and the endings it does have were measured for only a quarter of the names.

## 4. Caveats and leaks
1. **Leak in `com_age_years` (and the acq_* features), by construction:** a dropped name's `as_of` is its expiry date (fit-controls) or its SnapNames delete date (about expiry + 75 days). So its .com age is always a whole number of years plus 0.0 or about 0.2: 389 of 686 dropped at a fraction of 0.2, 289 at 0.0/1.0, and the rest scattered. Sold ages are spread evenly. The GBM finds this pattern (52% of the gain, about +0.12 AUC). **This also matters in production:** the daily `engineFeed` dates a dropped closeout name by the day it left the list, which is also tied to its expiry anniversary. So the live engine can learn the same shortcut. Suggested fix (for gaps.md, DOM to decide): use only whole years of age (or the `handreg` flag alone), or date unsold rows independently of expiry.
2. **Token-history features are date-confounded:** all dropped rows are dated July to October 2026, while sold rows run from 2022 to 2026. `tok_rate_pit` counts unsold rows before `as_of`, so for any sale before July 2026 it sees zero unsold rows, and the dates alone separate the classes. `trend_pit_*` depends on the sales window the same way. Together they add about +0.10 AUC on top of the clean set. The engine turns `tok_rate_pit` on once the unsold rows span 90 days; here they do (July to October), but only as two batches.
3. **Label sources:** sold = reported sales (DNW / DNJournal / social posts). These skew high, and dataset.csv was picked for recent hand-registrations (≤36 months). Dropped = the SnapNames pending-delete list, heavy in three-word names (mean 2.66 words against 2.25 for sold), so `n_words` partly measures how the two lists were collected. Both sides are mostly hand-registrations, not S8 auctions, so the results apply only indirectly to our main buying line.
4. **Endings:** state as of 6 Oct 2026, not at `as_of` (the RDAP-only bias the engine accepts). DNS nxdomain is not an RDAP 404 (a name registered without nameservers also gives nxdomain). Endings exist only for 3 slices, so whether a name has them depends on its slice.
5. Missing prices removed 192 sold names (25%), all from the iteration rounds.

## What I couldn't do
- Train a model with the engine's own split (zero dropped rows before 2026-Q3), so no `engine_models` row, no `/score` (Scorer) output and no drift or bars report. The lab model rows were deleted after each run.
- .co / .io / .ai endings: every reference answer is an RDAP error, so they stay unknown.
- Price the 192 iteration-round sold names, and date 22 r9-geo drops.
- `demand`: no keyword data in the reference set.
