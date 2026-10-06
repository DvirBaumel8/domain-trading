# Round 5: test (fresh slice, week of Aug 31) + geo look

**Data:** 39 sold (19 <$1k, 10 $1–2.5k, 10 >$2.5k) + 38 dropped. Complete features only. V3 is first tested here.

| Rule | Sold accepted | Dropped rejected | Prec. @1% | @2% |
|---|---|---|---|---|
| v10 full | **31/39 = 79%** | **34/38 = 89%** | 7.1% | 13.4% |
| V1 | 30/39 = 77% | 34/38 = 89% | 6.9% | 13.0% |
| V2 | 25/39 = 64% | 34/38 = 89% | 5.8% | 11.1% |
| V3 | 28/39 = 72% | 34/38 = 89% | 6.4% | 12.2% |

**Sold accepted by band, v10:**
- <$1k: 14/19
- $1–2.5k: 7/10
- >$2.5k: 10/10

**Expired lane, v10:** sold 17/20 accepted vs dropped 9/12 rejected.

**V3's history filter** removed 3 sold names and 0 dropped names. That is no gain here.

## Geo, all rounds 2–6 so far (descriptive, not a fit)

- **17 geo sales:**
  - 14 are under $1k, at $125–$499.
  - Most are city + trade names of 17–28 chars, which the tokenizer splits into 3 tokens: los angeles roofers, spokane counter tops, bathroom remodeling omaha.
  - **G-FORM-1 (≤2 tokens, ≤16 chars) accepts only 3 of 17 geo sales.**
  - Under v10, 5/17 are accepted. The other 2 pass a non-geo clause.
- **8 dropped geo names:** all rejected.
- **Sibling registered-share for geo names** is near 0 for both sold and dropped, so it does not separate them.
- **Conclusions:**
  - The real geo market in this data is cheap ($150–$500) and longer-form.
  - G-FORM-1 as written mostly rejects it. The ≤16 cut uses tokens, so a two-token city such as "los angeles" counts against it.
  - Too few names to refit. This is flagged as a decision for Dvir, not changed.
