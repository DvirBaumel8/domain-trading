# features.csv — CAP-21a replay feature table (CR-002)

One row per (domain, label), 1,755 rows. Built 2026-10-06 ~05:20 IDT from `research/backtest-sold/` (dataset.csv, controls.csv, holdout/scored.csv, iter/features.csv, r10/pick.csv, r9/geo_all_census.csv, r10/test_rows.csv, r11/old_rows.csv). **Empty cell = unknown or not measured for that slice. Nothing was imputed or guessed.**

| Column | Definition |
|---|---|
| domain | the .com name |
| label | `sold` (sale found) or `dropped` (reached pending-delete, SnapNames list) |
| slice | source: `fit-dataset`, `fit-controls`, `holdout-r1`, `iter-r2`…`iter-r8`, `r9-geo`, `r10-test`, `r11-aged` |
| role | `fit`, `dev`, `test` per iterations/name-log.md. RULE-PICK sets (r9 pick half, r10/pick.csv) and the round-3 DEV set are `dev`. Where a name was used in several rounds the latest role wins (iter rounds 2–8 names re-used in r10/pick.csv are `dev`) |
| registered_share | sibling census share registered (0–1). For `r9-geo` this is the geo census share (`gshare`, city+trade siblings) |
| prior_history | 1 if Wayback shows content before the as_of registration, else 0 |
| pre_cls | pre-registration archive page class (content/parked/forsale/…), where measured |
| alt_tld_before_n | count of alt-TLDs of the same SLD taken before the cutoff |
| n_words | segmented word count |
| sld_chars | SLD length in characters |
| geo_city / geo_trade | city token and trade words; only filled for `r9-geo` |
| archive_first_year | first Wayback capture year (r10/r11 slices only) |
| archive_span_years | Wayback span in years (r10/r11 slices only) |
| as_of | sold: sale date (approx); dropped: RDAP expiry date where recorded (fit-controls), otherwise the SnapNames delete date (`join_by`). Empty for r9-geo drops (no date recorded) |
| v10_decision | accept/reject. Fit slices: recorded `v10_accept`. Others: computed with the v10 rule from r10/r10rules.py (`(share≥0.5 & prior=1) or alt≥1 or (share≥0.6 & words≤2)`); empty if an input needed to decide is missing |
| e3_decision | E3 = v10 AND archive_span ≥ 3 (r10/preregistered.md). Empty if span unknown and v10 not already reject |

## Caveats
- Census (registered_share, alt-TLD counts) was measured **today (2026-10-06)**, not at as_of — except r10 `sibdates` which approximates registration-before-cutoff from sibling creation dates.
- Archive span for young drops stops at their creation date, so short spans are partly structural.
- Dropped controls are **SnapNames backorder inventory** (pending-delete list), not a random sample of unsold names.
- **Hard rejects were not applied**; v10/E3 decisions are the scoring rule only.
- system/census/ currently holds only README.md (no frozen lists yet); copied as-is to `census/`.
- PII/key scan (emails, phone numbers, "Gordon", API keys) over text columns found no matches; no rows removed.
