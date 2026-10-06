# Round 2: v10 as-is on fresh retail sales incl. sub-$1k (test only)

**Data (new, never used to fit v10):**
- **Sold:** UnreportedSales weekly reports (unreportedsales.com, mirrored on NamePros), weeks of Jul 27 + Aug 3 2026. 45 .com names, 2–3 dictionary words, $100+, stratified 25 <$1k / 10 $1–2.5k / 10 >$2.5k (`iter/sold_iter.csv`, round = 2).
- **Dropped:** 40 names from a fresh SnapNames deleting-list slice created 2021–2025 (`iter/drop_iter.csv`, round = 2), excluding every earlier sample.
- **Venues:** mostly Afternic and Spaceship (retail marketplaces).
- **Not usable:**
  - The NameBio daily CSV is not cached; the v9.1 README forbids bots from calling the download URL, so it was not used.
  - NamePros returned 403 to curl, so the same reports were pulled from unreportedsales.com.

**Features:** same method as the backtest.
- 20 frozen siblings checked today (not as-of-date).
- Wayback captures before the .com creation date.
- Other extensions with RDAP creation before the .com creation date.

**Results:** see `iter/r2.txt` for full tables.

| Rule | Sold accepted | Dropped rejected | Prec. @1% | @2% |
|---|---|---|---|---|
| v10 rule I | 20/45 = 44% | 35/40 = 88% | 3.5% | 6.8% |
| v10 full (I or B or G-FORM-1) | 27/45 = 60% | 32/40 = 80% | 2.9% | 5.8% |

**v10 full by band (sold accepted):**
- <$1k: 12/25 = 48%
- $1–2.5k: 9/10
- >$2.5k: 6/10

**v10 full by lane:**
- Aged (>36 m old at sale): 15/22 accepted.
- Expired re-reg: 9/16 sold accepted vs 11/16 dropped rejected.
- Fresh hand-reg: 1/4 sold vs 21/24 dropped rejected.
- Geo: 2/3.

**Reading:**
- v10 generalises worse to the broad retail market than to the DNW/DNJ set it was fit on. Sold acceptance falls from 83% to 60%.
- Sub-$1k sales are accepted least (48%).
- The alt-extension-first signal nearly vanishes: 7% of sold names here vs 39% in the fit set. Most sold names here are aged originals, not re-registrations.
