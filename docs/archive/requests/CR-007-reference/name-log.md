# Running log: names used for fitting vs testing

| Set | File | n | Role | Used in |
|---|---|---|---|---|
| Fit: sold T1 (≤36 m reg→sale) + geo ref | `dataset.csv` | 280 | **FIT** (v10 rules derived here) | backtest |
| Fit: dropped controls | `controls.csv` (from `raw/sn_sample.csv`) | 284 | **FIT** | backtest |
| Holdout sold (37–60 m) | `holdout/sold_holdout.csv` | 55 | TEST | Round 1 |
| Holdout dropped (fresh SnapNames slice) | `holdout/drop_holdout.csv` | 55 | TEST | Round 1 |
| Retail sold, round 2 (weeks Jul 27, Aug 3) | `iter/sold_iter.csv` round=2 | 45 | TEST (v10 as-is) | Round 2 |
| Retail sold, round 3 (Aug 10, Aug 17) | round=3 | 45 | **DEV** (variant search) | Round 3 |
| Retail sold, rounds 4–8 (Aug 24 … Sep 28) | round=4..8 | 212 | TEST (pre-registered v10, V1, V2; V3 from round 5) | Rounds 4–8 |
| Fresh dropped (SnapNames list, created 2021–2025), 7 × 40 | `iter/drop_iter.csv` round=2..8 | 280 | round 3 = DEV, others TEST | Rounds 2–8 |

Source of retail sales: UnreportedSales weekly reports (unreportedsales.com; same tables posted on NamePros), parsed to `raw/us_weekly_sales.csv` (1,912 rows; 1,345 .com). Exclusions: any name in the fit set, holdout, `raw/candidates.csv`, `raw/sn_sample.csv`, or `holdout/drop_slice.csv`.

## Rounds 9–10 (2026-10-06, ~03:24–04:00 IDT)

| Set | File | n | Role | Used in |
|---|---|---|---|---|
| Geo sold, pick slice: sale date < 2025-07-01, plus the 11 geo names already used in earlier rounds | `r9/geo_all.csv` (label=sold, slice=pick) | 39 (28 new + 11 re-used) | **RULE-PICK** | Round 9 |
| Geo sold, test slice: sale date ≥ 2025-07-01, never used before | `r9/geo_all.csv` (label=sold, slice=test) | 36 | **TEST** | Round 9 |
| Geo dropped (fresh SnapNames deleting list 2026-10-06, US city + trade, RDAP created 2021–2025), random half A | `r9/geo_all.csv` (label=dropped, slice=pick) | 81 | **RULE-PICK** | Round 9 |
| Geo dropped, random half B | `r9/geo_all.csv` (label=dropped, slice=test) | 81 | **TEST** | Round 9 |
| Geo dropped candidates that failed the RDAP 2021–2025 filter | `r9/dropG_parsed.csv`, `r9/dropG2.csv` | 36 | screened, not scored (treat as used) | Round 9 |
| Expired-lane sold + dropped from earlier iteration rounds 2–8 (previously TEST/DEV) | `r10/pick.csv` | 103 sold / 75 dropped | **RULE-PICK** (variants E1–E3 chosen here; `r10/preregistered.md`) | Round 10 |
| Fit-set expired lane (already FIT) | `raw/features_all.csv` + `raw/wb_*.jsonl` | 209 / 94 | consistency check only | Round 10 |
| Retail sold, new weeks (UnreportedSales Jun 2024–Jul 2026), RDAP created ≤36 m before sale, non-geo, segmentable | `r10/soldB.csv` | 307 | **TEST (reserved)**: only the names with a Wayback result were scored (see round-10 note). Never use for fitting | Round 10 |
| Retail sold candidates screened out (age >36 m, brandable/unsegmentable, geo) | `r10/soldB_cand.csv` minus `soldB.csv` | 593 | screened, not scored (treat as used) | Round 10 |
| Fresh dropped non-geo (SnapNames 2026-10-06, unused part of `sn_target_like`, RDAP created 2021–2025) | `r9/dropB.csv` | 343 | **TEST (reserved)**, same as above | Round 10 |

New raw sales file: `r9/us_weekly_sales_old.csv` (119 weekly reports including the 10 old ones; 11,536 rows). Exclusion list used for every new set: `r9/excluded.txt` (8,836 names).

## Rounds 11–12 (2026-10-06, ~03:56–04:55 IDT)

| Set | File | n | Role | Used in |
|---|---|---|---|---|
| Expired-lane test slice, further Wayback rows (same reserved names as round 10; no new names) | `r10/soldB.csv`, `r9/dropB.csv` → `r10/test_rows.csv` | see round-11-12.md | **TEST** (only pre-registered v10, E1, E2, E3; and T0/T* for 3-word) | Rounds 11, 12 |
| Aged-drop candidates: random 900 (seed 1111) from the unused part of `raw/sn_target_like.csv` (SnapNames deleting list 2026-10-06, 2–3 words, non-geo), none in `r9/excluded.txt` or any earlier file | `r11/old_cand.csv`, RDAP `r11/rdap_old.jsonl` | 900 | screened (treat all as used) | Round 11 |
| **Aged drops**: the candidates above with RDAP creation **before 2016** | `r11/old.csv` → `r11/old_rows.csv` | 68 | **TEST** (extra dropped class; never fit or pick) | Round 11 |
| bt3 core-census siblings (2-word cores of 3-word names) | `r11/bt3_sibs.json`, `r11/creg_bt3.jsonl` | 9,172 sibling strings | census only (not test names) | Round 12 |
| bt1 census siblings for aged drops | `census/bt1_<name>@v1.csv`, `r11/creg_old.jsonl` | 1,360 | census only | Round 11 |
| 3-word pick rows | `r10/pick.csv` (words = 3) | 36 sold / 38 dropped | **RULE-PICK** (already pick) | Round 12 |

## Round 13 (2026-10-06, ~09:30–10:15 IDT)

| Set | File | n | Role | Used in |
|---|---|---|---|---|
| Existing FIT/DEV/TEST rows of CR-002 `features.csv` (non-geo), re-scored with ranking metrics; no role changes | `r13/rows.csv`, `r13/scored_rows.csv` | 1,518 | as before (FIT for LR fitting, DEV for variant choice, TEST reported once) | Round 13 |
| TEST-LANE / TEST-HANDREG: subsets of existing TEST rows (no new names) | `r13/gap_rows.csv` | 153 / 70 sold | TEST | Round 13 |
| **FWD-13**: random 120 (seed 13) of 17,056 eligible SnapNames 10/06/2026 join-by .com names (2–3 words, non-geo, alphabetic, not in any earlier file; exclusion scan of 119,898 names) | `r13/fwd13.csv`, `r13/rdap_fwd13.jsonl` | 120 | **FORWARD** (scored before drop and frozen; outcome after 10/08; never fit/dev) | Round 13 → FWD |
| FWD-13 census siblings (bt1) | `census/bt1_<name>@v1.csv` (120 files), `raw/census_sibs_fwd13_typed.txt`, `r13/creg13.jsonl` | 2,400 | census only (not test names) | Round 13 |
| Sealed holdout remainder (soldB 244 / dropB 204, not in r13 rows) | `r14/test14_rows.csv` | 448 | **TEST, USED ONCE in r14** (rule C1 FAIL 61.1%/75.0%). Now burned: never use as untouched test again | Round 14 |

## Round 15 (2026-10-07, from ~12:35 IDT)

| Set | File | n | Role | Used in |
|---|---|---|---|---|
| Sold candidates: every .com sale ≥ $100 in `r9/us_weekly_sales_old.csv` + `raw/us_weekly_sales.csv` + new week Oct 5 2026 (`r15/us_sales_oct5.csv`), not in any earlier file (`r15/excluded15.txt`, 17,525 names), 2–3 dictionary words (same form filter as the SnapNames list), non-geo | `r15/sold_pool.csv`, RDAP `r15/rdap_sold.jsonl` | 2,001 | screened (treat all as used) | Round 15 |
| Dropped candidates: random 1,100 (seed 15) of 10,785 unused SnapNames 10/06/2026 join-by names (2–3 words, non-geo) | `r15/drop_sample.csv`, RDAP `r15/rdap_drop.jsonl` (checked 2026-10-07 ~12:40 IDT) | 1,100 | screened (treat all as used) | Round 15 |
| **DEV15**: half of eligible (sold: RDAP created ≤36 m before sale; dropped: RDAP 404 = fully dropped and nobody caught it) | `r15/all15.csv` role=dev | 400 sold / 493 dropped | **DEV** (tuning) | Round 15 |
| **TEST15 (sealed)**: other half, split by random seed 15 before any feature was computed | `r15/test15.frozen.csv` (read-only), sha256 in `r15/test15.sha256` (`86aef898…`) | 400 sold / 494 dropped | **TEST, reserved for r15**, scored once | Round 15 |
| Caught by drop-catchers on 10/06 (RDAP created ≥ 2026-10-06) | `r15/all15.csv` role=caught_report_only | 113 | report only | Round 15 |
