# Selection v10 delta (proposal from BT-SOLD-1)

**Status:** proposal only. `selection-v9-final.md` is **not edited**; Dvir decides. Evidence: `results.md` (226 sold vs 224 dropped non-geo; 28 vs 60 geo). Numbers are from **one** backtest with known biases (results §5). Treat thresholds as v10-candidate values to confirm on a holdout (§4).

## 1. Gates: drop / relax / re-threshold

| v9.1 gate | v10 change | Backed by |
|---|---|---|
| **DEMAND-1** `in_use_share ≥ 0.25` (+ retailstats ≥1) | **Replace with DEMAND-2: `registered_share ≥ 0.50`** on the frozen 20-sibling census. Keep `in_use_share` as a score feature: ≥0.10 → +, ≥0.25 → "strong" flag. **Drop retailstats ≥1 as a gate**; keep the count as a logged feature | in_use ≥0.25 passes 10% of winners (and 0.4% of dropped); registered ≥0.5 passes 81% vs 23%, AUC 0.85, holds in all length bands. Retailstats ≥1 passes ~98% of both sets |
| **HIST-1** content or redirect → REJECT | **Split:** (a) **REJECT** only for toxic history: SURBL / Web Risk / adult, pharma, gambling, malware or spam content keywords, or a prior same-name business **still operating elsewhere** (TM-1 / never_pitch check). (b) Plain prior content or parking → **PASS + `prior_history=1` feature**. (c) Off-domain redirect → **FLAG** (manual look), not auto-reject | 35% of winners had prior content and 2% redirects; v9.1 rejected 38% of winners here. Prior history is the #2 separator (93% vs 42%) |
| **LEAD-1** as a hard gate (geo ≥20/≥8 A/B; non-geo ≥10/≥5) | **Demote to an outbound work-list, not a buy gate.** Keep the lead build for E1 after purchase; log `leads_AB` for calibration. No minimum at Gate A | Geo: 0 of 38 measured names (sold and dropped) reach 8 A/B; median 1 vs 1, so no signal. Non-geo proxy fails 99% of winners. Winners in this set sold inbound (Sedo/Afternic/end-user), not via our lead pools |
| **EV-1 / RATIO-1** (leads drive STRe) | Keep the formulas but **drive `p_passive` from the v10 rule tier**, not from lead counts: accepted by DEMAND-2 + prior history → `p_passive_low = 0.02`/yr [est.]; DEMAND-2 only → 0.01; else stays at the v9.1 prior (and fails). Leads add via `p_lead` only after E1 data exists (≥60 E1 per lane, unchanged) | Rule lift ≈4.6× over a 0.5–1%/yr base → ~2–5%/yr [est.]. Using the **low** end (0.02) at $1,488: Ratio = 1488×0.85×0.02/11.08 = **2.28** at BIN, **1.48** at the $967 floor. EV (2-yr) = (1−0.98²)×1,265 − 22 = **+$28** |
| Geo lane shape (S2: city+trade+pros/co, 3 words) | **Geo form rule G-FORM-1:** ≤2 tokens incl. the city (city+trade), SLD ≤16. 3-word geo (city+trade+pros/co) → reject unless it comes from a drop with history (S7) | Geo sold 24/28 two-word vs dropped geo 57/60 three-word (n is small; sold geo are aged) |
| S7-ONLY / drop lane | **Promote S7 (drops with history) to the primary non-geo lane.** Tranche mix: ≥10 S7/S3 names passing DEMAND-2 + prior history; geo ≤3 until G-FORM-1 names are found | 93% of "recent-reg" winners were re-registered drops |
| TM-1, BIGCO, SURBL, WEB-RISK, TYPO, EVENT, SPELL, CAPACITY, LANDER, FT-1, SCREEN | **Unchanged** | Not tested here |

## 2. New features (features_v2)

| Feature | Definition | Use |
|---|---|---|
| `census_registered_share` | Already logged in v9.1 → **becomes the DEMAND-2 gate** | gate ≥0.50 |
| `prior_history` / `pre_caps` | Wayback CDX captures of the .com **before our registration**; `pre_cls` ∈ {none, parked, forsale, content} | score +, and the gate clause in rule A |
| `alt_tld_before_n` | Exact SLD on .net/.org/.co/.io/.us/.biz/.ca/.ai/.info with **RDAP creation before our buy date** (not today's count; that leaks) | OR-clause: ≥1 → passes DEMAND-2 by itself (39% of sold, 0% of dropped) |
| `word_count`, `sld_len` | Existing | score: 2 words, ≤12 chars best |
| `census_forsale_share` | Already logged | score only (positive, not negative) |
| Rule tier | `A` = DEMAND-2 + prior history; `I` = A or alt_tld_before ≥1; `B` = registered ≥0.6 + ≤2 words (fresh hand-reg lane) | drives `p_passive_low` |

**v10 Gate A core (non-geo), plain English:** buy only if ≥10 of the 20 frozen siblings are registered **and** either the name had a previous life (Wayback history, non-toxic) or its exact SLD was already registered on another extension before we buy. For a fresh string with no history: ≥12 of 20 siblings registered and ≤2 words (rule B).

## 3. Expected backtest scores (same data; in-sample unless noted)

| Rule | Sold accepted | Dropped rejected |
|---|---|---|
| v9.1 (all measurable gates) | 0% | 100% |
| v10 rule A | 78% (test half: 76%) | 83% (test half: 81%) |
| v10 rule I (proposed) | **83%** (half-samples 76–89%) | **83%** (78–90%) |
| v10 rule B (fresh lane) | 77% | 79% |
| Geo G-FORM-1 | 79% (22/28 aged ref) | 95% (57/60) |

## 4. Test plan (pass/fail, before any live Gate A)

| ID | Test | Pass bar |
|---|---|---|
| BT10-1 | **Holdout replay:** new DNW/DNJ sales from 2026-10 onward (and DNJ 2026 reports not used here) + a *new* SnapNames deleting list (different week). Same scripts, census lists frozen before scoring | Accept **≥70%** of sold T1, reject **≥75%** of dropped |
| BT10-2 | **Curated census:** rerun DEMAND-2 using `system/census/` hand-made pattern lists (once shipped) on the same 226/224 | Gap in median registered_share ≥0.3; threshold re-picked only if recall drops <70% |
| BT10-3 | **Historical census:** for 30 sold + 30 dropped, rebuild registered_share **at registration date** (sibling RDAP creation < our reg date) | ≥0.5 rule still gives recall ≥65% / reject ≥70% |
| BT10-4 | **HIST-2 safety:** 20 toxic fixtures (adult/pharma/gambling/malware/SURBL) + 20 benign prior-content names | 100% toxic REJECT; ≥90% benign PASS |
| BT10-5 | **Low tier check:** collect ≥30 sub-$1k sales with names (NamePros completed-sales thread, manual or browser, ≤2 h) and score them | Report recall; if <50% then the v10 rule is a $2.5k+ rule only, and the geo lane needs its own model |
| BT10-6 | **Shadow book:** every v10-accepted and v10-rejected candidate for 8 weeks, labels at 90/365 days (spec §6) | Brier per label; no AUC claim until n ≥50 outcomes |
| BT10-7 | **Ratio/EV fixtures:** tier-A name @ $1,488, 0 leads → Ratio ≥1 at BIN and floor, EV >0; tier-none name → fail | 100% |
| BT10-8 | **Leakage lint:** `alt_tld_before_n` must use RDAP creation < buy date; `tlds_taken_n` today never used as a gate | Unit test |

## 5. What this does NOT fix

- The $300–$500 geo outbound model has **no free public sales data** here. v10 does not validate it. Keep geo ≤3 per tranche until BT10-5.
- The p_passive tiers are [est.] from lift on a biased 1:1 sample. Replace them by Beta updates from the shadow book.
