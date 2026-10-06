# Round 9: geo form test, longer names (2026-10-06, 03:24–~04:00 IDT)

**Question:** v10's G-FORM-1 (city + 1 trade word, SLD ≤16) accepted only 7/20 real geo sales. Do longer caps (≤20, ≤24) or "city + up to 2 trade words" do better while still rejecting dropped geo names?

## Data (all legal, public)
- **Sold geo .com (US city + trade):** UnreportedSales weekly report tables (unreportedsales.com, public posts; fetched one page at a time). This round added **109 more weekly reports (June 2024 → July 2026)** to the 10 used before. Raw files: `r9/np/`, parsed to `r9/us_weekly_sales_old.csv` (7,131 rows, 4,767 .com). Sales under $100 excluded.
- **Geo parser** (`r9/geo.py`, frozen before scoring): a US city from `lex.CITIES` (non-US cities removed; a multi-word city counts as one token, per C34) as prefix or suffix. The rest must split into trade words (lex.TRADES + a written list of trade words/plurals) or generic heads (pros, services, company…). At least one real trade word is required.
- **Dropped geo .com:** fresh SnapNames deleting list (2026-10-06): 30 parsed from the unused part of `raw/sn_target_like.csv` and 168 from a full scan of `deletinglist.txt`. Names already used are excluded. Kept only names with RDAP creation 2021–2025, as in earlier controls. That leaves **162**.
- **Result:** **75 sold** (65 new, plus 10 used in earlier rounds, which go only into the pick slice) and **162 dropped**.
- **Slices:**
  - **Pick slice:** sales dated before 2025-07-01, plus the 10 previously used names, plus a random half of the dropped names. n = 39 sold / 81 dropped.
  - **Test slice:** sales from 2025-07-01 on that were never used before, plus the other half of the dropped names. n = 36 sold / 81 dropped.
  - Files: `r9/geo_all.csv` (column `slice`).
- **Pick rule** (mechanical): best Youden score (sold accepted + dropped rejected) on the pick slice.

## Results (form rule only)

| Variant | Pick: sold acc. | Pick: dropped rej. | **Test: sold acc.** | **Test: dropped rej.** |
|---|---|---|---|---|
| G0 current (city+1 word, ≤16) | 8/39 = 21% | 65/81 = 80% | **5/36 = 14%** | **62/81 = 77%** |
| G20 (city+1 word, ≤20) ← picked | 16/39 = 41% | 55/81 = 68% | **11/36 = 31%** | **58/81 = 72%** |
| G24 (city+1 word, ≤24) | 17/39 = 44% | 53/81 = 65% | 12/36 = 33% | 54/81 = 67% |
| city + ≤2 words, ≤16 | 8/39 = 21% | 64/81 = 79% | 7/36 = 19% | 57/81 = 70% |
| city + ≤2 words, ≤20 | 22/39 = 56% | 42/81 = 52% | 17/36 = 47% | 37/81 = 46% |
| city + ≤2 words, ≤24 | 33/39 = 85% | 18/81 = 22% | 29/36 = 81% | 14/81 = 17% |
| city + ≤2 words, any length | 38/39 = 97% | 3/81 = 4% | 36/36 = 100% | 5/81 = 6% |

- G20 and G24 tied on the pick slice (Youden 1.09). G20 was taken as the stricter one.
- **On test, G20 scores 31% / 72%** (Youden 1.03, about chance). No variant comes near ≥70% / ≥75%.
- Caveat: the pick-slice table was printed in the same run as the test table. The pick rule was fixed in advance and applied mechanically.

## Why: the form does not separate sold from dropped geo names

| SLD length | Sold (n = 75) | Dropped (n = 162) |
|---|---|---|
| ≤16 | 15 (20%) | 41 (25%) |
| 17–20 | 24 (32%) | 42 (26%) |
| 21–24 | 23 (31%) | 47 (29%) |
| >24 | 13 (17%) | 32 (20%) |

- **Median length is 20 in both groups.**
- **Trade words:** 1 trade word in 31 sold vs 56 dropped; 2 in 43 vs 98; 3 in 1 vs 8.
- The v10 fit-set result ("sold geo 24/28 two-word vs dropped 57/60 three-word") does not replicate on this larger, cleaner sample. Every rule that accepts more sold names lets through the same share of dropped names.

## Prices of the sold geo names (n = 75)
- Median **$280** (quartiles $130 / $450; range $100–$4,999).
- Bands: under $125: 16; $125–$499: 43; $500–$999: 7; $1,000+: 9.
- Median price by length: ≤16 chars $295 (6 of 15 sold at ≥$500); 17–20 $300 (5/24); 21–24 $200 (5/23); >24 $250 (0/13).
- **Short names do not sell more often, but they make up most of the higher-priced geo sales.** Examples: atlantahvac $1,850, roofingaustin $1,988, naplescooling $915, hoteldetroit $1,000, minneapolisinsurance $4,999, bostonorthodontist $2,200.
- Full list: `r9/geo_all.csv`.

## Conclusion
- **The geo buy-hold criteria fail for every form variant** (n = 36 / 81 on test; sold n < 50 per slice, 75 pooled).
- **Form alone carries no signal for geo.**
- **Proposal** (not applied to selection-v10.md):
  1. Stop treating G-FORM-1 as a positive "accept" path for geo.
  2. Geo names should pass on the same demand evidence as other names (sibling share / prior history / other extension), with ≤16 chars kept only as a **price-tier preference**: aim for $499+ only when ≤16.
  3. Keep ≤3 geo per tranche.
  4. A real geo demand signal (e.g., a city×trade sibling census, or prior history) still needs to be tested; it was not in this round.

## Extra (exploratory): city×trade sibling census for geo
I added a geo-specific sibling census (`r9/geo_census.py`; RDAP registered/unregistered only, checked as of today):
- 10 siblings swap the city for another US city.
- 10 siblings swap the trade for another trade.
- 4,652 lookups in total. Files: `r9/geo_sibs.json`, `r9/geo_creg.jsonl`, `r9/geo_all_census.csv`.

**Median geo share:** sold 0.45 (pick and test) vs dropped 0.20 (pick) / 0.30 (test). The signal is real but weak.

| Rule | Pick: sold acc. / dropped rej. | Test: sold acc. / dropped rej. |
|---|---|---|
| geo share ≥ .25 (best on pick) | 29/39 = 74% / 43/81 = 53% | 25/36 = 69% / 36/81 = 44% |
| geo share ≥ .50 | 19/39 = 49% / 58/81 = 72% | 17/36 = 47% / 57/81 = 70% |
| geo share ≥ .50 and ≤24 chars | 18/39 = 46% / 59/81 = 73% | 14/36 = 39% / 57/81 = 70% |

- **Neither form nor share passes** the buy-hold criteria for geo.
- The geo census is a better lead than form, but it would need a second signal, such as prior history. Wayback was too throttled this round to test that.
