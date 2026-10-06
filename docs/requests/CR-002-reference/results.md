# Backtest-sold · v9.1 gates vs real sold .com names (BT-SOLD-1)

**Author:** Grok Bot (executor) · **Run:** 2026-10-06, ~01:50–02:40 IDT · **Status:** research only. Nothing bought, sent or posted. No spec files edited.
**Labels:** [V] = measured from a public source by script · [est.] = estimate · **UNVERIFIED** = not checked · **PROXY** = stand-in for a v9.1 measurement we could not reproduce.
**Files:** `dataset.csv` (sold, with sources) · `controls.csv` (dropped) · `v10-delta.md` · `cost.md` · `scripts/` (all code) · `raw/` (all source pulls + intermediate JSONL) · `census/` (frozen sibling lists `bt1_<sld>@v1.csv`) · `evidence/leads/` (geo lead runs).

---

## 0. Headline

1. **v9.1 accepts 0 of 226 real sold names** (and 0 of 28 geo sold names). It also accepts 0 of 284 dropped names. **As a classifier it has no recall.** It does not separate winners from losers. It rejects everything.
2. Gates that kill winners: **DEMAND-1 in_use ≥ 0.25 fails 89% of winners** (in_use is ≥0.25 for only 10% of them). **HIST-1 rejects 38%**, because winners usually had a previous life. **LEAD-1 fails ~all of them**, both the geo BBB method (0/17 measured sold geo names reach 8 A/B) and the non-geo proxy.
3. What *does* separate sold from dropped, measured at registration time: **sibling `registered_share`** (median 0.80 vs 0.10) and **prior registration history** (93% vs 42%). Then come **≤2 words**, **SLD length** and **an alt-TLD of the exact SLD registered before the .com**.
4. Simplest rule found: **`registered_share ≥ 0.50` AND (prior history OR exact SLD already registered on another TLD)**. It accepts **83% of sold** (188/226) and rejects **83% of dropped** (186/224). Over 200 half-samples: recall 0.76–0.89, reject 0.78–0.90.
5. Biggest caveat: in this sold set, "hand-registered" mostly means **re-registered expired names** (93% had Wayback history before their current creation date). Only 15 of 226 were fresh strings. Public free data shows almost **no sub-$1k or $300–500 geo outbound sales**, which is the tier v9.1's geo lane targets.

---

## 1. Datasets

### 1.1 Sold set (`dataset.csv`, 280 rows)

| Step | Count | Source / method |
|---|---|---|
| DomainNameWire end-user sales posts, 2022-01 → 2026-09-30 (WP REST API, 314 posts) | 1,968 sale lines | `raw/dnw_full_*.json` → `scripts/parse_dnw.py` [V] |
| DNJournal weekly reports, 2022–2025 (102 archived report pages) | 5,353 .com rows | `raw/dnj/` → `scripts/parse_dnj.py` [V] |
| Target-like filter: .com, no digits or hyphens, **$300–$10k** (EUR ×1.10 / GBP ×1.27 [est.]), 2–3 dictionary tokens (wordfreq zipf ≥3.0), sale ≥2022 | 2,617 | `scripts/filter.py`, `scripts/seg.py`, `scripts/lex.py` |
| RDAP (Verisign) creation date ≤36 months before the sale date (and ≥ −1.5 m) | 324 | `raw/rdap_cand.jsonl` [V] |
| + every token zipf ≥3.6 (descriptive, not coined) → **T1 primary set** | **226** | `scripts/build_sold.py` |
| Geo reference (city/state + keyword, **any age**, NOT hand-reg); 26 brand/mis-parsed names excluded by hand (flag column) | 54 rows / **28 analysed** | same pipeline |

- **Acquisition evidence (T1).** RDAP creation ≤36 months before the sale means the seller registered it, or re-registered it after a drop, shortly before selling: cheap to acquire. Wayback before the creation date shows which: **211/226 (93%) had prior captures**, so they are re-registered expired names. **15 had none**, so they are plausibly fresh hand-regs. Whether a NamePros seller called a name "hand reg" is **UNVERIFIED** per name.
- **Composition.** 183 DNJournal / 43 DNW. Sale years: 2022 71, 2023 59, 2024 35, 2025 49, 2026 12. Types: descriptive 183, tech/compliance 33, service keyword 8, geo-other 2. Price median **$3,710** (p25 $3,100, p75 $4,600). **0 below $1,000; 13 at $1,000–2,499.** DNJ charts rarely list <$2.5k, which biases the set upward.
- **NamePros "hand reg sold" threads:** reachable via WebFetch, but I tested 2 pages and got 0 usable rows (name + price + reg date, 2022+). Too token-costly page by page, so not used. NameBio per-sale search is Cloudflare-blocked; the free NameBio API only gives keyword aggregates. **No Afternic per-sale public feed exists** (DNW's Atom/Afternic posts are included).

### 1.2 Control set (`controls.csv`, 284 rows)

| Step | Count | Source |
|---|---|---|
| SnapNames public **deleting list** (`deletinglist.zip`, downloaded 2026-10-06 ~02:08 IDT; copy in `raw/`) | 375,291 .com pending delete | [V] |
| Same target-like filter as sold | 51,325 | `scripts/sn_filter.py` |
| Stratified sample → RDAP | 1,070 | |
| **Created 2021–2025** (held 1–5 years, then not renewed). Non-geo matched 1:1 on type to T1 + 60 geo | **284** (224 non-geo + 60 geo) | `raw/controls_base.csv` |

- The meaning of a control: the owner registered the name and is letting it drop (the owner did not sell it). Creation years skew to **2025 (one-year regs)**. Whether it gets backordered after the drop is **UNVERIFIED**. "Never sold before" is only checked against our sold set.
- **Tried and dropped:** finding "already dropped" names via generated siblings, RDAP 404 and a Wayback for-sale lander. That yielded about 1 per 29 names at ~20–30 s per Wayback call, so I stopped at 37 checks (`raw/wb_ctl.jsonl`, mode=window).

---

## 2. How v9.1 gates were replayed (at registration time where possible)

| Gate | How measured here | Fidelity |
|---|---|---|
| SPELL-1 | No digits or hyphens (filter) | exact |
| HIST-1 | Wayback CDX **before the RDAP creation date**. Latest 200/html capture classified content / parked / forsale; any 3xx without parking → REJECT_REDIRECT (DR-003 logic). `scripts/wb.py` | at reg time ✓. Content classification is regex-based [est.] |
| DEMAND-1 (non-geo) | **Frozen** 20-sibling list per name, built deterministically (10 first-token swaps + 10 last-token swaps from type-matched token pools; `scripts/census_build.py` → `census/bt1_*@v1.csv`, written before scoring). Run with the v9.1 C19 `in_use` definition (`scripts/census_run.py`). NameBio retailstats end/start ≥1 via the **free API at ≤4/min** (not the CSV download URL, per C20) | Census measured **today**, not at reg time. Sibling lists are a generic method, not hand-made patterns |
| LEAD-1 geo | DR-003 `geo_leads.py` functions (BBB API + firm sites, C15 role-inbox≤10→B) via `scripts/bt_geo_leads.py`. Only change: Nominatim coords and BBB plural category queries | Same method, today's market. Run on 16 sold geo + 25 dropped geo city-level names |
| LEAD-1 non-geo | **PROXY:** the exact SLD on 10 alt TLDs + the hyphen .com, live sites with `in_use` (D1 prospects only; generic_same_service not crawled). `scripts/exttaken.py` | weak proxy. Sold names may gain alt TLDs after the sale (leakage), so this **overstates** winners' leads |
| EV-1 / RATIO-1 | §2.1 formulas with the estimated A/B count; S3/S4 priors @ $1,488 / floor $967; geo @ $499 / $299; ARA $11.08 | exact formula, est. inputs |
| TM-1, BIGCO, SURBL, Web Risk, TYPO, EVENT, CAPACITY, LANDER, FT, SCREEN | **not replayed**: status at reg time can't be rebuilt cheaply, or the gate is process-only | — |

---

## 3(a). Share of real winners v9.1 rejects, by gate

**T1 sold, non-geo-dominant (n=226):** v9.1 accepts **0**.

| Gate | First fail (DR-003 order) | Any fail |
|---|---|---|
| HIST-1 (80 prior content, 5 redirects) | 85 (37.6%) | 85 (37.6%) |
| DEMAND-1 | 130 (57.5%) | **202 (89.4%)**. The census part alone (in_use ≥0.25) fails 90%; retailstats ≥1 fails ~2% |
| LEAD-1 (non-geo PROXY ≥5) | 10 (4.4%) | 224 (99.1%) |
| EV-1 / RATIO-1 (from proxy leads) | — | 224 (99.1%) |
| Unmeasured | 1 | — |

**Geo sold reference (n=28, aged names, sold $1,988–$8,500):** v9.1 accepts **0**. LEAD-1 ran on 17 and failed all 17. The best was hvacchicago.com with **5 A/B** (needs ≥8 plus ≥20 qualified). Median A/B = **1**. 11 were not run (non-US or no BBB category).

**Dropped controls:** v9.1 also accepts 0 of 224 non-geo (DEMAND-1 fails 223) and 0 of 60 geo. **v9.1 can't separate the two sets.**

## 3(b). Features that separate sold (T1, n=226) from dropped (non-geo, n=224)

AUC = P(random sold value > random dropped value); 0.5 = no signal; <0.5 = lower is better for sold. `raw/feature_auc.json`.

| # | Feature (at registration unless noted) | Sold | Dropped | AUC | Notes |
|---|---|---|---|---|---|
| 1 | **Census `registered_share`** (20 frozen siblings) | median **0.80**; ≥0.5 in 81% | median **0.10**; ≥0.5 in 23% | **0.85** | Holds in every length band (≤9: 0.82 vs 0.54; 10–12: 0.75 vs 0.32; 13–15: 0.48 vs 0.20; 16+: 0.52 vs 0.07). Measured today [time bias, both sets] |
| 2 | **Prior registration history** (Wayback captures before the .com's creation) | **93%** (median 31 monthly captures) | **42%** (median 0) | 0.76 (pre_caps 0.86) | 35% of winners had prior *content*, which v9.1 HIST-1 rejects |
| 3 | **Word count** | 2 words in **83%** | 2 words in **27%** | 0.78 (inverted) | Median 2 vs 3. Three-word names look like the dropped set |
| 4 | **SLD length** | median **10**; ≤12 in 75% | median **13**; ≤12 in 38% | 0.73 (inverted) | Partly a DNJ price-floor bias |
| 5 | **Exact SLD on an alt TLD registered *before* the .com** (.net/.org/.us/.biz/.ca dates via RDAP) | **39%** | **0%** | 0.70 | Zero false positives. Coverage: .co/.io/.ai/.info dates not retrievable (RDAP endpoints failed) |
| — | Census `in_use_share` | median 0.10; ≥0.25 in **10%** | median 0.00; ≥0.25 in 0.4% | 0.76 | Separates, but the v9.1 threshold sits far too high |
| — | Census `forsale_share` | ≥0.05 in 62% | 23% | 0.71 | Investor crowding ≠ bad |
| — | `tlds_taken_n` today (DNS) | median 2 | 0 | 0.86 | **Leakage** (buyers register alt TLDs after the sale). Not usable as-is |
| — | NameBio retailstats end-count, own sale −1 | ≥1 in 98% (n=112 measured) | ≥1 in 100% (n=21 measured) | 0.25 | **No useful signal.** Dropped names use *more* popular keywords (median 175 vs 64). Coverage partial and dropped n small (see §5) |
| — | Geo A/B lead count (BBB method) | median **1** (n=15) | median **1** (n=23) | ~0.5 | **No signal.** 0 of 38 names reach 8 A/B |
| — | Token commonness (zipf) | 4.28 min | 4.17 | 0.56 | weak |
| — | CPC / search volume | — | — | — | Not available free; not measured |
| — | Trend timing | reg→sale median **5 months** (p25 1.8, p75 18.7) | n/a | — | Fast flips. Consistent with drop-catch resale |
| — | Geo form (geo sold ref n=28 vs geo dropped n=60) | 2 words 86%, len median 13 | 3 words 95%, len median 18 | — | Tiny, mismatched sample (aged vs hand-reg) |

## 3(c). Price bands achieved (sold, USD)

| Type | n | Median | p25–p75 | Bands |
|---|---|---|---|---|
| Descriptive 2–3 word (T1) | 183 | $3,699 | 3,100–4,550 | 1–2.5k: 12 · 2.5–5k: 145 · 5–10k: 26 |
| Tech / compliance (T1) | 33 | $3,911 | 3,105–4,990 | 1–2.5k: 1 · 2.5–5k: 24 · 5–10k: 8 |
| Service keyword (T1) | 8 | $3,633 | 3,499–3,925 | 2.5–5k: 7 · 5–10k: 1 |
| Geo + service / geo other (aged reference) | 30 | ~$3,900–4,000 | 3,330–5,500 | mostly 2.5–5k |
| Fresh hand-regs (no prior history, n=15) | 15 | $4,000 | — | 2k–5.5k |
| 2-word vs 3-word (T1) | 188 / 38 | $3,611 / $4,000 | | |

The public record holds **no $300–$999 sales in this class**, so it can't confirm or refute v9.1's $499 geo / $1,488 non-geo bands. The R9 sources (outbound geo $100–$500) stay the only evidence for the low tier [3P].

## 3(d). Simplest separating rules (non-geo T1 vs dropped non-geo)

Searched single thresholds and 2-condition conjunctions on 8 at-registration features (`scripts/rules.py`): 30 random split-halves, best train rule with recall ≥0.7.

| Rule | Recall (sold accepted) [95% bootstrap] | Dropped rejected | Lift (recall/FPR) | Precision if 1% of candidates would sell [est.] |
|---|---|---|---|---|
| v9.1 DEMAND-1 census part: in_use ≥0.25 | 0.10 [0.06–0.14] | 1.00 | ~22 (1 FP; unstable) | ~18% |
| **A: registered_share ≥0.50 AND prior history** | **0.78** [0.73–0.84] | **0.83** [0.78–0.88] | 4.6 | ~4.4% |
| **I: A OR exact-SLD alt-TLD registered before the .com** | **0.83** (half-samples 0.76–0.89) | **0.83** (0.78–0.90) | 4.9 | ~4.7% |
| E: registered_share ≥0.50 alone | 0.81 [0.77–0.87] | 0.77 [0.72–0.82] | 3.6 | ~3.5% |
| B: registered_share ≥0.60 AND ≤2 words (no history needed) | 0.77 [0.71–0.82] | 0.79 | 3.7 | ~3.6% |
| G: in_use ≥0.10 | 0.58 | 0.80 | 2.9 | ~2.8% |

- **Split-half (out of sample) for the auto-picked rule** (registered_share ≥0.5 AND prior history, chosen 12 of 30 times): test recall **0.76**, test reject **0.81** (mean). Rule A across 200 half-samples: recall 0.71–0.84, reject 0.78–0.90.
- Rule A does **0/15** on fresh hand-regs by construction. Rule B passes 7/15, so B is the hand-reg-lane variant.
- By type (rule I): descriptive 155/183 sold vs 37/183 dropped; tech/compliance 24/33 vs **1/33**; service keyword 8/8 vs 0/8.
- **Precision honesty:** sold and dropped were sampled ~1:1. In the real candidate stream winners are rare (hand-reg STR 0.5–1%/yr [R9]). A 4–5× lift turns ~1%/yr into **~4–5%/yr** [est.], not "most names sell".

**Geo:** only the 2-word form separates (geo sold 24/28 two-word vs dropped 3/60). A v10 geo form rule (≤2 tokens incl. city, SLD ≤16) accepts 22/28 sold ref and 3/60 dropped geo. **But the sold geo names are aged, not hand-regs.** Two-word city+trade .coms are rarely hand-registrable. This mostly says **3-word geo hand-regs (city+trade+pros/co, the DR-003 shape) look like dropped names.**

---

## 4. Old vs new backtest scores

| Set | v9.1 accepts | v10 rule I / geo-form accepts |
|---|---|---|
| Sold T1 (226) | **0 (0%)** | **188 (83%)** |
| Dropped non-geo (224) | 0 (0%) → rejects 100% | 38 (17%) → **rejects 83%** |
| Sold geo ref (28) | 0 (0%) | 22 (79%) |
| Dropped geo (60) | 0 | 3 (5%) → rejects 95% |

(Rule A alone: 177/226 = 78% sold; 38/224 dropped.) v9.1's BT-1c bar (≤30% of controls pass) is met trivially by rejecting everything; v10 meets it at 17%.

---

## 5. Caveats (read before acting)

1. **Selection bias in the sold set:** DNJ/DNW report end-user and Sedo-heavy sales, mostly ≥$2.5k. The $300–$1k tier and outbound geo sales are invisible, and v9.1's geo lane lives there.
2. **"Hand-reg" ≈ re-registered drops:** 93% of T1 had a prior life. The data supports **buying dropped names with history**, the S7 lane. It does not support fresh-string invention, where n=15 is too small to model.
3. **Controls are 1:1 sampled and skew to one-year 2025 regs** from a GoDaddy-heavy drop list. They are dropped names, not proof the name could never sell.
4. **Census measured today** for both sets (siblings registered since). Sold names are older, so their siblings had more time to be registered. That inflates `registered_share` for sold somewhat; the length-band check suggests it doesn't explain the gap.
5. **Generic sibling method** (token-pool swaps), not Dvir's hand-curated pattern lists. Thresholds must be re-checked on `system/census/` patterns.
6. **Non-geo LEAD-1 is a PROXY**, so treat its 99% fail as directional. Geo LEAD-1 used the real DR-003 method but today's BBB data and n=15/23.
7. **NameBio retailstats coverage partial:** 134 keywords fetched (free API, effective ~1–3/min with 429 back-off); sold 112/226 and dropped 21/224 names have a last-token count. Conclusion "≥1 end/start count passes nearly everything" is stable; exact AUC is not.
8. **HIST-1 content classification is regex** (parked/for-sale words, ≥200 chars). Some "content" may be thin pages.
9. **TM-1 / Web Risk / SURBL not replayed.** Some winners would also fail those, so the true v9.1 reject rate is the same (100%) and a v10 accept rate would be a bit lower.
10. Small samples everywhere: geo n=15/23 for leads, fresh hand-regs n=15. **No AUC ≥0.7 claims beyond this backtest** (spec §6 rule) until shadow outcomes exist.
