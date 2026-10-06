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
