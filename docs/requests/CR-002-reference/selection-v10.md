# Selection v10.1: spec for Claude Code / DOM

**Author:** Grok Bot (executor) · **Date:** 2026-10-06, ~03:25 IDT (v10 ~02:55 IDT) · **Status:** **v10 ADOPTED** by Gavriel (delegated by Dvir), 2026-10-06 ~02:47 IDT, **with a hold: no real buys until the holdout retest BT10-1 passes** (≥70% of sold accepted, ≥75% of dropped rejected). **v10.1** (this file) is the same decision rule after 8 held-out iterations (`research/backtest-sold/iterations/summary.md`); no variant beat it. v10.1 adds:
- the retail and sub-$1k evidence;
- per-lane and per-band holdout tests (BT10-9…12);
- the geo tokenization fix;
- **BUY-HOLD stays.**

Replaces v9.1. Nothing bought, sent or pushed.
**Prior:** v9.1 (`selection-v9-final.md`, kept unchanged), v9 dated 2026-10-05 ~23:58 IDT.
**v10 evidence:** `research/backtest-sold/` (results.md, v10-delta.md, holdout/). 226 sold vs 224 dropped non-geo names; 28 vs 60 geo.
**Baseline:** `selection-v2-proposal.md` + `selection-v3-review.md` are assumed implemented, plus Dvir's decisions so far: free data only; Web Risk; S7 register-only; no S8; demand proof instead of COMPS-1; lead gate + EV; tranche 15/+10; 20 E1/week.
**Built from:** v8 (`selection-v8-final.md`), R4–R8, and the **R9 deep source sweep** (`selection-r9-deep-sources.md`, 106 sources). Evidence tags `[R9 §Qn]` point there.
**Labels:** **[V]** verified source · **[3P]**/[A] forum or third-party anecdote · **[est.]** estimate · **UNVERIFIED**.

---

## Findings → rules (v10.1, Dvir instruction 2026-10-06)

Each backtest finding (`research/backtest-sold/results.md`, 226 sold vs 284 dropped) maps to one rule with a setting and a test.

| # | Finding (sold vs dropped) | Rule | Setting (default) | Test |
|---|---|---|---|---|
| 1 | **Short:** two words 83% vs 27%; SLD ≤12 chars 75% vs 31%; median length 10 vs 13. *Retail dev slice (v10.1): two words 69% vs 40%; ≤12 chars 56% vs 48%; weaker, so it stays a preference* | **FORM-2** (preference, not a gate): ≤2 words AND SLD ≤12 chars → `short = 1`, top A-Form score, ranked first within its tier. Tier B requires ≤2 words. Geo uses G-FORM-1 (≤16) | `short_max_words` 2, `short_max_chars` 12, `formB_max_words` 2 | SEL10-4 |
| 2 | **Neighbors:** sibling registered-share median 0.80 vs 0.10 (AUC 0.85). *Retail dev slice (v10.1): 0.75 vs 0.15. The strongest single signal; the share cut was tested at .5/.6/.7, and .5 (v10) is best balanced on held-out data* | **DEMAND-2:** `registered_share ≥ 0.50` of 20 frozen siblings (tier A, with prior history); ≥0.60 for tier B | `registered_share_min` 0.50, `registered_share_min_B` 0.60, `sibling_count` 20 | BT10-2, BT10-3 |
| 3a | **Not fresh, prior history:** prior registration/use 93% vs 42% | **HIST-2:** prior history is a **positive** signal (`prior_history = 1` is required for tier A); reject only harmful history; off-domain redirect = FLAG | `hist2_reject_classes` = toxic list; `redirect_action` FLAG | BT10-4 |
| 3b | **Not fresh, other extension first:** another extension registered before the .com 39% vs 0%. *Retail (v10.1): 7% vs 2%. Specific to re-registered names* | **`alt_tld_before_n ≥ 1`** → tier I (positive signal on its own), creation date before the buy date only | `alt_tld_before_min` 1; extensions list | BT10-8 |
| 3c | **Not fresh, expired names:** 93% of "recent" sold names were re-registered drops | **Main lane = S7 expired/dropped names with clean history**; tranche ≥10 of 15 from S7/S3 passing DEMAND-2 | `tranche_min_main_lane` 10 | SEL10-5 |
| 4 | **Lead count:** 0 of 38 measured geo names (sold or dropped) reach 8 A/B leads; no signal | **LEAD-1 removed as a buy gate**; leads built only after buying, for outreach | `lead_gate_enabled` false | SEL10-2 |
| – | Geo form: sold geo 24/28 two-word vs dropped geo 57/60 three-word. *Retail (v10.1): geo sales $125–$499, mostly 17–28 chars; G-FORM-1 accepts 3/17 (D-10.1-B)* | **G-FORM-1** city + one trade word, SLD ≤16; ≤3 geo per tranche | `geo_max_words` 2, `geo_max_chars` 16, `geo_per_tranche_max` 3 | SEL10-3 |
| – | **Holdout (v10.1):** DNW-style 76% sold accepted / 78% dropped rejected (n = 55 / 55), PASS; retail multi-slice 71% / 74% (n = 211 / 195), misses by 1 pt; expired lane 72% / 62%, FAIL | **BUY-HOLD** until BT10-1 **and** BT10-9 (retail) **and** BT10-11 (expired lane) pass | `holdout_sold_accept_min` 0.70, `holdout_drop_reject_min` 0.75, `holdout_min_n` 50, `buy_hold` true | BT10-1, BT10-9, BT10-11 |
| 5 | **Prior-history type (v10.1):** parked 41–44% of sold vs 12–22% of dropped; for-sale 11–15% vs 4–8% | HIST-2 unchanged: **parked and for-sale history are positive** (never a reject). The tested "no for-sale history" filter failed: 58% of sold accepted | `hist2_forsale_action` PASS | BT10-4, BT10-12 |
| 6 | **Price band (v10.1, retail holdout):** v10 accepts 63% of sold names under $1k, 78% at $1–2.5k, 84% above $2.5k | No rule change. Cheap names have weaker neighbourhoods. The EV in §2.1a uses the band-specific acceptance only for reporting | `report_bands` <1k / 1–2.5k / >2.5k | BT10-10 |
| 7 | **Lane (v10.1):** expired 72% / 62%; fresh hand-reg dropped 89% rejected; geo sold 7/20 accepted | Main lane stays expired names (Dvir's decision). The lane result is reported and gates the buy hold (BT10-11). Geo tokenization fix: a multi-word city counts as **one** token in G-FORM-1 | `lane_report` on; `geo_city_one_token` true | BT10-11, SEL10-6 |

## Changelog vs v8

| # | Change | Why (evidence) |
|---|---|---|
| C1 | **RATIO-1 now uses year-1 effective STR** `STRe_eff = 1−(1−p_passive)(1−p_lead)^leads_AB`, not the passive prior alone | In v8, Ratio at the low prior failed every lane (geo $499 → 0.77; non-geo $1,495 → 0.46), so nothing could ever reach Dvir [R9 §Q8] |
| C2 | **Geo p_passive 0.02 → 0.005.** Outbound counted once, via leads | v8 counted outbound twice: the 2% was R4's total geo+outbound rate. Passive geo hand-reg is ~0.5% [R9 §Q1, §Q8] |
| C3 | **Non-geo p_lead_low**: S3/S4 0.004 → **0.002**; S6 0.005 → **0.003** [est.] | Every comparing source says non-geo outbound converts worse than geo [R9 §Q3] |
| C4 | **Default non-geo BIN $1,495 → $1,488**; exception steps $1,988 / $2,488; banned price bands $800–$999 and $1,950–$1,999 | x88 endings convert best; $1,495 is the "worst" [A]. A 31%-of-portfolio-at-$1,988 seller had 8 of 22 sales there [A] [R9 §Q6] |
| C5 | **Geo Ratio-stress floor $399 → $299** | Outbound geo deals close at $100–$500 (69% ≤$399 in the 2018 analysis) [R9 §Q3] |
| C6 | **New gate FT-1**: Afternic Fast Transfer opt-in confirmed within 7 days of buying | Most hand-reg sales come via the registrar network, not the lander (>80%; 17 of 22) [A]; Porkbun requires manual opt-in [V] [R9 §Q6] |
| C7 | **DEMAND-1 / `/comps/keyword`** reads a nightly NameBio retailstats **CSV cache** with attribution; API for spot checks only (≤4/min) | NameBio API docs [V] |
| C8 | **S7: no ExpiredDomains automation.** Candidates from the zone/RDAP route only. ED stays an optional manual tool for Dvir | ED has no API and bans bots/AI agents [V] [R9 §Q5] |
| C9 | **Geo score:** D-Liquidity comes from NameBio trade-term counts; A-Form by length bands; **city + lawyer/attorney = FLAG** | NameBio CSV (hvac 11 vs roofing 95 sales); WTB ≤12 chars, no lawyer/attorney [A] [R9 §Q1] |
| C10 | Leads: new `lead_priority` and `prospect_type` fields; `exact_sld_other_tld` recorded but **not counted** unless Dvir approves D1 | Best outbound buyers are exact-name owners on .net/.co [A] [R9 §Q3] |
| C11 | Timing: tranche 1 listed and E1 lists verified **by 2026-12-31** (soft target). No passive-sale KPI before month 6 | Jan–Apr strongest [A]; median hold of sold names 11 months [V-analysis] [R9 §Q1, §Q6] |
| C12 | No price A/B tests during the POC beyond the fixed endings | Too few names; randomized ≥3-month tests needed [R9 §Q6] |
| C13 | Tests SEL9-1…SEL9-8 added; implementation order updated | — |

---

## Changelog v9 → v9.1 (2026-10-06)

| # | Change | Why (evidence / approval) |
|---|---|---|
| C14 | **D1 ON with strict limits:** `exact_sld_other_tld` / `prefix_suffix_variant` may count toward LEAD-1 only when the SLD is plainly descriptive, ≥3 unrelated businesses use the term as their **business or service description** (record URLs; **product-name use does not count**), TM-1 clean, and the price shown is the standard BIN | Dvir approval 2026-10-06; DR-002 V9-20 |
| C15 | **Tier B / medium lead:** `info@` / `contact@` (role inbox) at a firm of **≤10 people** counts as tier **B** (medium). Re-check the rule after the first 60 outreach emails | Dvir approval 2026-10-06; DR-002 V9-01 |
| C16 | **WEB-RISK-1 interim pass:** until the backend has a Web Risk / Safe Browsing API key, PASS iff Transparency Report status ∈ {no unsafe content, no data} **and** HIST-1 shows a clean history | Dvir approval 2026-10-06; DR-002 V9-06 |
| C17 | **ARA = live registrar renewal** from `/check/quote` at the name's current registrar; Gate F also compares transfer-to-cheapest-FT-capable (incl. 1 yr) when eligible. No fixed $11.08 | DR-002 V9-05 |
| C18 | **Price drops step the allowed BIN set** (non-geo 2488→1988→1488→1088→788; geo 499→399→299). Floor = 65% of new BIN (≥$750 non-geo / geo floor rule). Not −20% | DR-002 V9-10 |
| C19 | **Sibling census:** frozen name lists in `system/census/` (`pattern_id@version`); `/census/run` refuses bot-supplied lists. Written `in_use` definition (HTTP 200, final host = sibling, not parking list, ≥200 chars visible text) | DR-002 V9-03, V9-04 |
| C20 | **NameBio free CSV:** nightly cached under `system/data/namebio/retailstats-YYYYMMDD.csv` (+ tldstats); bots/agents forbidden to hit the download URL | DR-002 V9-07 (strengthens C7) |
| C21 | Tests **SEL9-9…SEL9-15** (and SEL10-1) added for C14–C20 | — |


## Changelog v9.1 → v10 (2026-10-06)

| # | Change | Why (evidence: `research/backtest-sold/results.md`) |
|---|---|---|
| C22 | **Main lane = expired/dropped names with clean history (S7)**. S3/S4/S6 fresh strings allowed only via rule tier B (§2.1a) | 93% of "recently registered" sold names were re-registered drops |
| C23 | **DEMAND-1 → DEMAND-2:** sibling `registered_share ≥ 0.50` (20 frozen siblings) replaces `in_use_share ≥ 0.25`. `in_use_share` and NameBio counts become **score features only** | in_use ≥0.25 passed 10% of winners; registered ≥0.5 passes 81% of winners vs 23% of dropped (AUC 0.85) |
| C24 | **HIST-1 → HIST-2 (harmful history only):** REJECT only toxic history (SURBL/Web Risk listing, adult/pharma/gambling/malware/spam content) or a prior same-name business still operating; off-domain redirect → FLAG; plain prior content/parking → PASS + `prior_history = 1` | v9.1 HIST-1 rejected 38% of winners; prior history is the #2 separator (93% vs 42%) |
| C25 | **New feature `alt_tld_before_n`:** exact SLD registered on another extension **before** our buy date (RDAP creation) | 39% of winners, 0% of dropped |
| C26 | **LEAD-1 demoted:** no longer a buy gate. Leads are built after purchase for outreach only (E1 rules unchanged) | 0 of 38 measured geo names (sold or dropped) reach 8 A/B; no signal |
| C27 | **EV/Ratio driven by rule tier** (§2.1a); leads add only through `p_lead` once ≥60 E1 exist per lane | lift ≈4.6× over the 0.5–1%/yr base [est.] |
| C28 | **Geo:** form rule G-FORM-1 (city + one trade word, SLD ≤16) and **≤3 geo per tranche** | geo sold 24/28 two-word vs dropped geo 57/60 three-word (small n) |
| C29 | **Buy hold** until BT10-1 holdout passes; tests BT10-1…BT10-8 added | Gavriel decision 2026-10-06 |
| C30 | **FORM-2 short preference:** ≤2 words AND SLD ≤12 chars → `short = 1`, A-Form 15/15, ranked first within tier (not a hard gate); Findings → rules table added | two words 83% vs 27%; ≤12 chars 75% vs 31% |

## Changelog v10 → v10.1 (2026-10-06, ~03:25 IDT): 8 held-out iterations (`research/backtest-sold/iterations/`)

| # | Change | Why |
|---|---|---|
| C31 | **Decision rule unchanged.** DEMAND-2 keeps share ≥ .50 with prior history, OR alt-ext-before, OR tier B, OR G-FORM-1 | On pooled held-out rounds 4–8, v10 scored 71% / 74%. V1 (share ≥ .6 without prior history) scored 68% / 75%, V2 (share ≥ .7) 57% / 79%, and V3 (V1 minus redirect/error-only history) 67% / 76%. No variant dominates |
| C32 | **Holdout tests widened:** BT10-9 retail multi-slice, BT10-10 price-band report, BT10-11 expired-lane gate, BT10-12 history-type report. BUY-HOLD needs BT10-1 + BT10-9 + BT10-11 | v10 passes the DNW-style holdout (76% / 78%) but is borderline on retail (71% / 74%) and fails in the expired lane (72% / 62%) |
| C33 | **History type:** for-sale and parked prior pages confirmed positive. The "no for-sale history" idea was rejected | Round 1: excluding for-sale history cost 10 sold accepts to gain 1 dropped reject |
| C34 | **G-FORM-1 tokenization fix:** a multi-word city (e.g. "los angeles", "san antonio") counts as one token; a compound trade word ("countertops", "roofers") is one trade word | The tokenizer split cities and trades, so G-FORM-1 accepted only 3 of 17 real geo sales. The ≤16-char cap is **unchanged and untested on the fix** (decision D-10.1-B) |
| C35 | **Retail/sub-$1k evidence source** for backtests: UnreportedSales weekly reports [3P] (unreportedsales.com; same tables on NamePros). NameBio daily CSVs are still only via the backend nightly job | Only 3 sub-$1k names existed in the DNW/DNJ cache |

**v10 overrides v9.1 wherever the text below still describes v9.1 behaviour** (lines marked *v10*).

---

## 0. One-page summary (≤150 words)

Selection works like underwriting software. The backend builds features, censuses and lead lists. Bots only invent strings and run a short judgment checklist. A name reaches Dvir only if all of these pass (*v10*):
- the hard gates, with **HIST-2** (harmful history only) and **DEMAND-2** (registered_share ≥0.50 + rule tier A/I/B)
- a complete screening_pack
- one P(sale) EV > 0 and Ratio ≥ 1 at BIN and floor, with **p_passive from the rule tier** (§2.1a)
- Afternic Fast Transfer distribution

Leads are **outreach only**, not a gate. Tranche 1 = 15 names: **≥10 S7/S3 names passing DEMAND-2**, **≤3 geo** (G-FORM-1). **No real buy until BT10-1 passes.** Score 0–100 is a tiebreaker only. Every rule has a pass/fail test. Token budgets are hard caps.

---

## 1. Rules

### 1.1 Hard gates (any fail = reject, no digest)

| ID | Rule | Delta vs v8 |
|---|---|---|
| SPELL-1 | No hyphens or numbers. Ambiguous tokenization → FLAG (not auto-reject) | — |
| BRAND-1 / BIGCO-1 / TM-1 / TN-1 | Unchanged in spirit. BIGCO web check limited to non-geo tokens | — |
| HIST-2 (*v10*, replaces HIST-1) | **REJECT** only for harmful history: SURBL/Web Risk listing at any time, adult/pharma/gambling/malware/phishing/spam content, or a prior same-name business **still operating** elsewhere (TM-1 / never_pitch). Off-domain redirect → **FLAG** (bot judgment). Plain prior content or parked/for-sale → **PASS + `prior_history = 1`** (no −10). No captures → PASS, `prior_history = 0`. **Incomplete → cannot pass Gate A** | **C24** |
| WEB-RISK-1 | Google Web Risk / Safe Browsing must be clean. **Until an API key exists:** PASS iff Transparency Report status ∈ {no unsafe content, no data} **and** HIST-1 is clean; record the raw status. With a key: Lookup API no-match = PASS | **v9.1 C16** |
| SURBL-1 | Listed → REJECT | — |
| DEMAND-2 (*v10*, non-geo; replaces DEMAND-1) | Census from **frozen** `system/census/<pattern_id>.csv` (20 siblings; `pattern_id@version` on card). PASS iff **rule tier ∈ {A, I, B}** (§2.1a): A = `registered_share ≥ 0.50` **and** `prior_history = 1`; I = A **or** `alt_tld_before_n ≥ 1`; B (fresh string) = `registered_share ≥ 0.60` **and** ≤2 words. `in_use_share` (≥0.10 +, ≥0.25 strong flag) and NameBio counts are **score features only**. Census `registered_share` uses **as-of-date** sibling RDAP creation where available | **C23, C25** |
| G-FORM-1 (*v10*, geo) | ≤2 tokens including the city (city + one trade word), SLD ≤16 chars; 3-word geo (city+trade+pros/co) → REJECT unless it is an S7 drop with clean history | **C28** |
| ~~LEAD-1~~ (*v10*) | **Not a buy gate.** Lead lists (§1.2 definition unchanged) are built after purchase for outreach. `leads_AB` is logged for calibration | **C26** |
| CAPACITY-1 | Applies to outreach planning only (*v10*): ≤20 E1/week | C26 |
| RATIO-1 | `renew_ratio ≥ 1` at `bin_eff = min(BIN, lane_cap)` **and** at the floor price, **with `STRe_eff_y1`** (§2.1) | **Formula fixed (C1)** |
| LANDER-1 | `lander = BIN` and (BIN ≤ 1,488 OR exception: rule tier I with `in_use_share ≥ 0.25` ∧ retailstats end ≥ 20 (*v10*; replaces the ≥30 A/B clause)). BIN must be in the **allowed price set** (§1.5). No Make-Offer-only landers | x88 set (C4) |
| FT-1 | Registrar supports Afternic Fast Transfer; opt-in + Afternic listing with the same BIN confirmed **≤7 days after `/buy`**. Missing → name flagged `distribution_incomplete`; counts as failed in pattern health | **New (C6)** |
| EV-1 | `EV = P_sale × net_price − lifetime_cost > 0` at **low** priors, with BIN (not floor); p_passive from rule tier (§2.1a) | C27 |
| SCREEN-1 | `screening_pack` complete | — |
| EVENT-1 | Sensitive-event blocklist | — |
| TYPO-1 | Tranco edit-distance screen | — |
| S7-ONLY | Fully dropped + RDAP 404 ×2; no auctions; **no automated ExpiredDomains access**. *v10:* S7 is the **main lane** | + C8, C22 |
| BUY-HOLD (*v10*) | No real `/buy` until BT10-1 (holdout) passes and Gavriel records it | C29 |

### 1.2 Qualified lead definition

A lead counts only if **all** of these hold:
1. Its own site copy shows it sells the exact service.
2. `weaker_domain_reason ∈ {hyphen, long_sld, non_com, free_subdomain, no_site}` ("Facebook only" does not count).
3. Published email + `source_url`.
4. Not the trademark owner, **not trading under the exact SLD** (pending **D1**), and not on `never_pitch`.
5. Not an enterprise or funded brand that already owns a strong primary .com (bot judgment + Shomer).
6. `lead_tier ∈ {A,B,C}`: A = owner/founder/GM; B = marketing/ops **or** a role inbox (`info@` / `contact@` / similar) at a firm with **≤10 people** (team/about page or LinkedIn company size; record URL) — this is a **medium** lead (**v9.1 C15**); C = generic / role inbox at larger firms. **Only A/B count toward gate minima.** Re-check the ≤10 role-inbox→B rule after the first **60** outreach emails.

**New fields (C10)** in leads.csv:
- `prospect_type ∈ {similar_name_weaker_domain, generic_same_service, exact_sld_other_tld, prefix_suffix_variant}`. The last two **may count** toward LEAD-1 (**D1 ON**, v9.1 C14) only when **all** of these hold:
  - the SLD is **plainly descriptive** (geo + generic trade, or a generic 2-word term — not a coined brand)
  - ≥3 unrelated businesses use the term as their **business name or service description** on their own site (record ≥3 URLs). **Product-name use does not count** (`exact_phrase_product_name` → not a prospect)
  - TM-1 is clean on the term (no trademark)
  - the price shown is the **standard BIN** only (never raised after interest)
- `lead_priority` (sending order, not a gate):
  1. similar-name business on .net/.co/other weaker TLD
  2. hyphen
  3. long_sld
  4. free_subdomain
  5. no_site

  Ties are broken by tier A > B [A, R9 §Q3].

### 1.3 Portfolio and tranche rules

| Rule | Value |
|---|---|
| Tranche 1 | *v10:* 15 names: **≥10 S7 (drops) / S3 passing DEMAND-2**, **≤3 S2 geo** (G-FORM-1), ≤2 S6. Not before BT10-1 passes |
| Tranche 1 timing (soft) | Listed on Afternic with FT and E1 lists verified **by 2026-12-31** (Jan–Apr high season [A]) |
| Tranche 2+ | +10 only after ≥60 E1 **and** 30 days of Afternic data logged |
| Concentration | ≤2 per city, trade, regime or keyword; ≤40% in one lane |
| Pattern double-down | +1 only after an inquiry, an E1 yes, or an offer ≥ min in that pattern |
| Pattern pause | ≥60 E1 and 0 yes → pause buys; STRe ×0.5 |
| Email | ≤20 E1/week total; ≤10 per deal; personalized, from a warmed separate sending domain with SPF/DKIM/DMARC (playbook) |
| KPI timing | Months 1–6 judged on views, inquiries and E1 labels. **Zero passive sales before month 6 is not a failure signal** (median hold of sold names 11 months [V-analysis]) |

### 1.4 Renewal (Gate F)

Renew **once at most**, and only if `GET /renewal/decision` = RENEW:
- `renew_ratio ≥ 1` using STRe_renew = 1−(1−STRe_passive_updated)(1−p_lead)^(A/B leads not yet contacted), where the passive rate is Beta-updated from our labels; **or**
- Dvir has flagged an open negotiation.
- Not enough on their own: "trend still rising", "I like it", sunk cost, "I'd hate to drop it". Test question: would we register it today? [O, R9 §Q2]
- Renew by expiry−31 to keep Fast Transfer [playbook / Afternic].
- **ARA (v9.1 C17):** use the **live** renewal price from `/check/quote` at the name's **current registrar** (not a fixed $11.08). Gate F also evaluates transfer to the cheapest Fast-Transfer-capable registrar (cost = transfer including 1 year) when today ≥ creation+60 d and ≤ expiry−31 d, and picks the cheaper option that still passes Ratio.

### 1.5 Pricing interaction (selection side only)

| Lane | BIN used for EV/Ratio/LANDER | Floor used in Ratio stress |
|---|---|---|
| S2 geo | $499 strong / $399 weaker (pending **D2**) | **$299** |
| S3/S4/S6 hand-reg | Default **$1,488**. Exception steps **$1,988 / $2,488** only via the LANDER-1 exception | 65% of BIN, rounded to ≥$750 per the playbook floor rule ($1,488 → $967) |
| S7 | Same as matched pattern | Same |

**Allowed BIN set (C4):** {299, 399, 499, 788, 1088, 1488, 1988, 2488}.
**Forbidden bands:** $800–$999 and $1,950–$1,999. Endings ×95/×99 are not allowed for non-geo [A, R9 §Q6].
**No price A/B testing during the POC** beyond this fixed set (C12).
**Scheduled drops (v9.1 C18):** step **down the allowed set**, not −20%. Non-geo ladder: 2488 → 1988 → 1488 → 1088 → 788. Geo ladder: 499 → 399 → 299. After each step, floor = 65% of the new BIN (non-geo floor still ≥ $750; geo follows the geo floor rule). Every scheduled price must remain ∈ the allowed set (test SEL9-9).

Outbound price haircut shown for display only: `0.7 × BIN` vs walk-away. EV uses one P_sale × **net_price**, with `net_price = BIN × (1−0.15)` for the Afternic path (15% with Afternic NS; 25% otherwise [V, Afternic]).

---

## 2. Scoring and probability formula

### 2.1 P(sale), EV and Ratio (gate, not the 0–100 score)

```
p_passive = STRe_passive_low[lane]     # annual, table below
p_lead    = p_lead_low[lane]           # per A/B lead contacted once (no drip)
n         = leads_AB                   # qualified, contactable within CAPACITY-1

# 2-year hold, leads contacted in year 1:
P_sale    = 1 - (1 - p_passive)^2 * (1 - p_lead)^n
net_price = BIN * 0.85
lifetime_cost = first_year + renewal   # both from /check/quote live at the chosen/current registrar (v9.1 C17); do not hard-code $11.08
EV = P_sale * net_price - lifetime_cost

# Year-1 effective STR for RATIO-1 at buy:
STRe_eff_y1 = 1 - (1 - p_passive) * (1 - p_lead)^n
renew_ratio(price) = price * 0.85 * STRe_eff_y1 / ARA     # ARA = live renewal $ at current registrar (/check/quote)
RATIO-1 passes iff renew_ratio(bin_eff) >= 1 AND renew_ratio(floor) >= 1
```

### 2.1a Rule-tier priors (*v10*, C27) — replaces the lead-driven STRe at buy time

| Rule tier (DEMAND-2 / G-FORM-1) | p_passive_low /yr [est.] | Basis |
|---|---|---|
| A or I (registered_share ≥0.50 + prior history, or alt_tld_before ≥1) | **0.02** | backtest lift ≈4.6× on 0.5–1%/yr base, low end |
| B (fresh string, registered_share ≥0.60, ≤2 words) | **0.01** | lift ≈3.7× [est.] |
| Geo G-FORM-1 pass | **0.01** | small n; aged reference only |
| None | v9.1 table below (fails EV/Ratio) | — |

`n` (A/B leads) = 0 at buy time until a lane has ≥60 E1; then p_lead per the v9.1 table applies to uncontacted A/B leads.
Worked check (ARA $11.08, lifetime $22.16): tier A @ $1,488 → Ratio 2.28 at BIN, 1.48 at $967 floor, EV(2y) +$28 ✓. Tier B @ $1,488 → Ratio 1.14 / 0.74 ✗ at floor → tier B names need BIN $1,488 with floor exception or wait for data (no tier-B buys in tranche 1). Geo @ $499 → 0.38 ✗ → geo needs leads data or p update before any buy.
Priors move only by Beta updates from labels (§6). Bots may not edit them.

**Low priors (v9.1 table, still used for p_lead and for names with no tier).** Tune only through Beta updates on labelled data. Bots may not edit them.

| Lane | STRe_passive_low /yr | p_lead_low per A/B lead | Notes |
|---|---|---|---|
| S2 geo | **0.005** | 0.005 | Outbound counted only via leads (C2) |
| S3/S4 | 0.004 | **0.002** [est.] | C3 |
| S6 | 0.005 | **0.003** [est.] | C3 |
| S7 | match pattern | match pattern | |

**Worked checks [est.]** (illustrative ARA $11.08 / lifetime $22.16 when that is the live quote; recompute when the registrar quote differs):

| Case | Ratio at BIN | Ratio at floor | EV at BIN |
|---|---|---|---|
| Geo, 8 A/B, $499 / floor $299 | 1.69 | 1.01 ✓ | −$1.4 ✗ |
| Geo, 10 A/B, $499 | 2.05 | 1.23 | **+$2.6 ✓** |
| Geo, 12 A/B, $399 | 1.93 | 1.45 | **+$0.8 ✓** |
| Geo, 10 A/B, $399 | 1.64 | 1.23 | −$2.4 ✗ |
| S3/S4, 5 A/B, $1,488 / $967 | 1.59 | 1.03 ✓ | +$0.4 ✓ |
| S3/S4, 10 A/B | 2.71 | 1.76 | +$12.8 |
| S6, 5 A/B | 2.26 | 1.47 | +$9.1 |
| Any lane, 0 leads | ≤0.57 | — | <0 ✗ |

**Practical consequence (v9.1, superseded by §2.1a in v10):** geo needed ≥10 A/B leads at $499. v10 does not use lead counts at buy time. This matches the "20+ end users" and "30–100 prospects" practice [A].

### 2.2 Score 0–100 (tiebreaker only)

Renormalise **every lane to weights summing to 100**. An UNKNOWN or null feature scores **0 points**. Require `data_coverage ≥ 0.70` or fail the gate.

| Factor | Base weight | Measurement 0–10 |
|---|---|---|
| A Form | 15 | *v10 FORM-2:* non-geo with ≤2 words AND SLD ≤12 chars → 15. Otherwise non-geo: mean(length, words, pronounceability); ≤8 letters and ≤3 syllables score best [V-marketplace]. **Geo (C9): SLD ≤12 chars → 10; 13–16 → 7; 17–20 → 4; >20 → 1** [est. bands] |
| B Buyers | 25 | From leads_AB: 0 → 0; <gate → fail; at gate → 6; 1.5× gate → 8; ≥2× gate → 10 |
| C Intent | 10 | CPC/volume from Planner export; null → 0 |
| D Liquidity | 10 | Non-geo: retailstats counts + census in_use (**max 10% of score from retailstats alone**). **Geo (C9): trade term start+end retail count ≥30 → 9; 10–29 → 6; <10 → 2** [est. bands; NameBio CSV] |
| E Timing | 15 | Lane signals; crowding velocity ≥3× → cap raw at 5 |
| F ExtTaken | 10 | **business_use** on alt TLDs (not raw registration count). Raw TLDs-taken count is logged as a feature for calibration [R9 §Q2] |
| G Risk | 15 | Clean 10; FLAG 5. **City + lawyer/attorney/law-firm = FLAG** (C9) |

**Lane weights** (sum to 100):
- S2: A15 B30 C5 D10 E10 F5 G25
- S3/S4: A15 B20 C15 D10 E25 F10 G5
- S6: A15 B25 C10 D10 E20 F5 G15
- S7: A10 B20 C5 D15 E10 F5 G35

Score = Σ (raw_i × weight_i / 10), rounded half-up, clipped to 0–100. **Prior parked-only:** subtract 10 after the sum (clip at 0).
**Reaching Dvir** depends on gates + EV > 0 + Ratio ≥ 1 + FT-1 eligibility, **not** on score ≥ 70. The score only sorts the digest.

### 2.3 features_v1 (required JSON)

From R5: `sld_len`, `word_count`, `tokens`, leads A/B/C, census shares, retailstats counts, ext business_use, cpc/vol, hist flags, crowding, `competing_forsale_n`, lane, bin, renew_ratio, stre_prior, model_version, predicted labels.
**Added in v9:**
- `stre_eff_y1`
- `ratio_at_floor`
- `tlds_taken_n` (logged, not a gate)
- `trade_retail_count` (geo)
- `prospect_type_counts`
- `exact_sld_other_tld_active` (bool)
- `ft_eligible` (bool)
- `bin_in_allowed_set` (bool)
- `retailstats_cache_date`

**Forbidden gate features:** govalue_usd, estibot_value, humbleworth_usd, alexa/DA traffic appraisals.

---

## 3. Pipeline order

```
GENERATE (bot)
 → S0 form local (+ geo length band)
 → S1 POST /check/batch          # RDAP
 → S2 blocklists + TYPO-1 + EVENT-1
 → S3 POST /check/history        # must complete
 → S4 /census (registered_share as-of) + prior-history + alt_tld_before + /comps/keyword (features)
 → S5 POST /check/tm (+ EUIPO manual flag for S6)
 → S6 rule tier (DEMAND-2 / G-FORM-1)   # v10; leads moved post-buy
 → S7 POST /score (features, P_sale, EV, STRe_eff_y1, Ratio@BIN/floor, coverage)
 → S8 bot judgment ≤5 survivors (van test, TN edge, lead spot-check)
 → S9 screening_pack assemble (incl. registrar FT capability)
 → S10 Shomer 12-item checklist
 → S11 Dvir Gate A
 → post-buy: FT-1 confirmation ≤7 days; /leads/build for outreach (v10)
```

---

## 4. Backend endpoints

| Endpoint | In → out | Notes |
|---|---|---|
| `POST /check/batch` | names → rdap | Keep |
| `POST /check/history` | names → cdx, surbl, web_risk, hist1 | **Blocking**: complete or fail. WEB-RISK-1 interim (C16) until API key |
| `POST /check/tm` | phrases → uspto + control | Keep |
| `GET /check/quote` | name → $ | Keep |
| `GET /tokenize?sld=` | → tokens, ambiguous | Keep |
| `GET /census/siblings` | pattern → 20 names from `system/census/<pattern_id>.csv` | **Frozen lists only** (v9.1 C19); returns `pattern_id@version`; refuses bot-supplied lists |
| `POST /census/run` | siblings → registered/in_use/forsale shares + evidence paths | `in_use` = HTTP 200, final host = sibling (no off-domain redirect), not on parking list, ≥200 chars visible text; also log `forsale_share` / `registered_share` |
| `GET /comps/keyword` | kw → retailstats counts | **v9.1 C20:** nightly job writes `system/data/namebio/retailstats-YYYYMMDD.csv` (+ tldstats), never deleted; `cache_date` in every response. Bots/agents **forbidden** to call the NameBio download URL. Spot API ≤4/min server-side only; attribution "Data from NameBio" |
| `GET /exttaken?sld=` | → business_use counts + `tlds_taken_n` | + raw count logged |
| `POST /leads/build` | domain, lane, geo params → leads.csv draft | + prospect_type, lead_priority |
| `POST /leads/verify` | leads → tier, weaker enum, never_pitch | Keep |
| `POST /score` | features_v1 → score, P_sale, EV, STRe_eff_y1, Ratio@BIN, Ratio@floor, coverage, pass bools | **Change** (C1) |
| `POST /screening_pack` | domain → pack / validate | + `registrar_ft_capable`, `bin_in_allowed_set` |
| `POST /distribution/confirm` | domain → ft_optin_at, afternic_listed_at, bin | **New** (FT-1); Dvir/ops pastes evidence; job flags >7 days |
| `GET /renewal/decision/{domain}` | → RENEW/DROP + Ratio (STRe_renew) | Formula per §1.4; ARA = live `/check/quote` renewal; compare renew-in-place vs transfer (C17) |
| `GET /patterns/{id}/health` | → pause/promote flags | Keep |
| `POST /labels` | domain, label, at | Calibration |
| `GET /signals/keywords` | from Dvir CSV | Keep |
| `GET /market/geo` | city, trade → firms, weak share, trade_retail_count | + trade count |
| `GET /regimes` | S6 table | Keep |
| `GET /s7/candidates` | dropped-only filter | **Change:** sources = Verisign/CZDS zone diff + RDAP 404×2 (pending **D3**), or names Dvir pastes. **Never** requests to `expireddomains.net` member pages, from backend or bots |

Everything here is mechanical. Bots do not call Verisign, CDX, NamePros, NameBio or ExpiredDomains directly (evidence hosts are allowlisted).

**S7 manual recipe for Dvir (optional; human-only, ≤15 min/week)** [est. thresholds, R9 §Q5]:
- ED "Deleted .com" list
- no hyphens or digits; LE ≤15; Reg (TLDs taken) ≥5; SG > 0 or CPC > 0
- sort by Reg, then LE
- note the Marketplace-tab competing listings
- any BL/DP/ACR > 0 → history check is mandatory

Paste ≤10 names into `/s7/candidates`. Those names then go through the full pipeline.

---

## 5. Bot judgment only (Stage 8)

- Invent candidate strings for the strategy brief. Avoid hype strings, 3-word leftovers and city+lawyer [R9 §Q2, §Q7].
- Van test: yes/no + one line.
- Confirm 3 random leads match the service on their site.
- Interpret TN-1 / BIGCO edge cases.
- One-line reason not to buy.
- **No** comps search, **no** writing census lists, **no** STRe/p_lead edits, **no** raw RDAP loops, **no** ExpiredDomains or NameBio web access.

### Token budgets (hard; unchanged)

| Step | Max tokens |
|---|---|
| Brief read | 5k |
| Scout batch total | 35k (cap 50k) |
| Judgment per surviving name | 8k |
| Card prose | ≤500 chars + JSON from API |
| Shomer per card | 8k |
| Target per carded name reaching Dvir | ≤28k combined scout + judgment + Shomer |

---

## 6. Calibration and backtest

**Labels:** reg_90d, use_365d, afternic_view_60d, inquiry_any, e1_positive, offer_ge_min, sale_24m, **distribution_incomplete** (new). Brier score **per label**. Months 1–6 optimise inquiries, E1 and views.
**Beta updates:** p_passive and p_lead update per lane from labels. A lane needs ≥60 E1 before p_lead moves off the prior [R9 §Q3].
**BT10 pass bars (v10, supersede BT-001):** holdout accept ≥70% of sold T1 and reject ≥75% of dropped (BT10-1). **BT-001 pass bars (v9.1, kept as minimum):**
- BT-1a: median Ratio/score of sold names > control.
- BT-1c: ≤30% of controls pass proxy Gate A.
- No AUC ≥ 0.7 claims until n ≥ 50 shadow outcomes.

**Shadow book:** every rejected or unbought scored name is rechecked at 90 and 365 days. `tlds_taken_n` and `trade_retail_count` are tested there before any promotion to a gate.

---

## 7. Test plan (pass/fail): Dvir rule

| ID | Spec | Pass |
|---|---|---|
| SEL-1 | Pipeline order, 30-name fixture | RDAP before history 100% |
| SEL-2 | /check/batch | google.com registered; random name available; timeouts → errors |
| SEL-3 | /check/history | Parked → PASS+note; business → REJECT; incomplete blocked |
| SEL-4 | /check/tm | VSME control OK |
| SEL3-1 | Lane weights | Each lane sums to 100 |
| SEL3-2 | DR-001 replay | Shortlist logic + amlr ranks lower |
| SEL3-4 | leads.csv gate + 3-row audit | 100% |
| SEL4-1 | Ratio <1 blocked at Gate A | 100% |
| SEL4-3 | Tier-C-only fails | 100% |
| SEL5-1 | features_v1 validates | 10/10 DR cards |
| SEL5-2 | $ appraisal gate features rejected | 100% |
| SEL5-4 | BT-001 runs | BT-1a/c reported |
| SEL6-1 | weeks_to_cover | Blocks over-cap |
| SEL6-2 | Tranche 1 ≥10 geo | Simulator pass |
| SEL6-3 | Lander fit | High BIN without exception fails |
| SEL7-1 | screening_pack required on /buy | 400 if missing |
| SEL7-2 | Tranco typos | 10 reject / 10 pass |
| SEL7-3 | never_pitch blocked at Gate C | 100% |
| SEL7-4 | Renewal DROP if Ratio <1 | 100% |
| SEL8-1 | Bot census list ignored | Backend list wins |
| SEL8-2 | BIN inflation fails floor Ratio | Pass |
| SEL8-3 | Facebook-only leads fail enum | Pass |
| SEL8-4 | Single P_sale only | No additive EV API fields |
| **SEL9-1** | Ratio uses STRe_eff_y1 | Fixtures: geo 8 A/B @ $499 / floor $299 → Ratio pass (1.69 / 1.01) but EV fail (−1.4); geo 10 A/B @ $499 → all pass; geo 0 leads → Ratio fail; S3/S4 5 A/B @ $1,488 → pass; S3/S4 4 A/B → EV fail. Values ±0.02 |
| **SEL9-2** | Geo priors | `/score` uses p_passive 0.005 for S2; API rejects any 0.02 passive config |
| **SEL9-3** | Allowed BIN set | BIN ∉ set (e.g. 1495, 999, 1999) → LANDER-1 fail |
| **SEL9-4** | Retailstats cache | `/comps/keyword` serves from CSV with cache_date ≤48 h; no more than 4 API calls/min; card shows NameBio attribution |
| **SEL9-5** | No ED automation | Egress log/allowlist: 0 requests to `*.expireddomains.net` from backend or bot sandboxes over a 7-day run |
| **SEL9-6** | FT-1 | Bought name without `/distribution/confirm` after 7 days → flagged + counted in pattern health |
| **SEL9-7** | prospect_type gating (D1 ON) | `exact_sld_other_tld` / `prefix_suffix_variant` count toward LEAD-1 only when plainly descriptive + ≥3 business/service-description URLs + TM-clean + standard BIN; **product-name-only** URLs → count 0 |
| **SEL9-8** | Geo score tweaks | City+lawyer → G FLAG; 21-char geo → A raw 1; hvac trade count <10 → D raw 2 |
| **SEL9-9** | Price drops ∈ allowed set | From BIN $1,488, next scheduled prices are $1,088 then $788 (not −20% → $1,190/$952); floor = 65% of new BIN (≥$750); every price ∈ {299,399,499,788,1088,1488,1988,2488} |
| **SEL9-10** | ARA live renewal | `/score` and `/renewal/decision` use `/check/quote` renewal at the current registrar; a fixture with GoDaddy renewal ≠ $11.08 changes Ratio vs the old hard-coded ARA; transfer option considered when lock cleared |
| **SEL9-11** | Frozen census lists | `/census/siblings` serves only `system/census/*.csv`; bot-supplied sibling list → rejected (SEL8-1 still holds); response includes `pattern_id@version` |
| **SEL9-12** | `in_use` definition | Sibling with parking page or off-domain redirect → not in_use; HTTP 200 + on-domain + ≥200 chars visible + not parking list → in_use |
| **SEL9-13** | NameBio nightly cache | `/comps/keyword` reads `system/data/namebio/retailstats-YYYYMMDD.csv` with `cache_date`; egress: 0 bot/agent calls to NameBio download URL |
| **SEL9-14** | WEB-RISK-1 interim | Without API key: status "no unsafe content" or "no data" + clean HIST-1 → PASS; unsafe status → FAIL; with key: Lookup no-match → PASS |
| **SEL9-15** | D1 strict use | Three product-name URLs only → exact_sld lead count 0; three business/service-description URLs + descriptive SLD + TM clean → count toward LEAD-1 |
| **SEL10-1** | Role inbox ≤10 → tier B | Fixture: `info@` / `contact@` at firm documented ≤10 people → tier B (medium); same inbox at >10 → tier C; rule flagged for re-check after 60 outreach sends |
| SEL-T | Token budgets | Scout ≤50k; Shomer ≤8k on a mock batch |

| **BT10-1** | Holdout replay on sales/drops not used to fit v10 (frozen census before scoring) | accept ≥70% sold, reject ≥75% dropped, n ≥50 per class; **gates the buy hold**. 2026-10-06 full run (55 + 55): **76% / 78%, PASS** (`research/backtest-sold/iterations/round-1.md`). The hold also needs BT10-9 and BT10-11 (v10.1) |
| **BT10-2** | DEMAND-2 on `system/census/` curated pattern lists (same 226/224) | registered_share median gap ≥0.3; recall ≥70% |
| **BT10-3** | As-of census: siblings counted only if registered before the name's own registration date (30 sold + 30 dropped) | recall ≥65%, reject ≥70% |
| **BT10-4** | HIST-2 safety: 20 toxic fixtures + 20 benign prior-content names | 100% toxic REJECT; ≥90% benign PASS |
| **BT10-5** | ≥30 sub-$1k named sales scored | report recall; <50% → v10 is a $2.5k+ rule only; geo needs its own model |
| **BT10-6** | Shadow book 8 weeks, labels 90/365 d | Brier per label; no AUC claim before n ≥50 outcomes |
| **BT10-7** | Rule-tier EV/Ratio fixtures (tier A @ $1,488, 0 leads → pass 2.28/1.48/+$28; no tier → fail) | 100% |
| **BT10-8** | Leakage lint: `alt_tld_before_n` uses creation < buy date; `tlds_taken_n` today never a gate | unit test |
| **BT10-9** (*v10.1*) | Retail multi-slice holdout: ≥5 weekly slices of retail sales (all bands, 2–3 words) vs fresh dropped slices; names logged as test in the name registry before scoring | accept ≥70% sold, reject ≥75% dropped, n ≥50 per class pooled; **gates the buy hold**. 2026-10-06: 71% / 74%, n = 211 / 195, **FAIL by 1 pt** |
| **BT10-10** (*v10.1*) | Price-band report on the BT10-9 data | Report only. 2026-10-06: <$1k 63%, $1–2.5k 78%, >$2.5k 84% accepted |
| **BT10-11** (*v10.1*) | Expired-lane holdout: sold re-registered drops vs dropped names with prior history | accept ≥70% sold, reject ≥75% dropped, n ≥50 per class; **gates the buy hold**. 2026-10-06: 72% (n = 72) / 62% (n = 42), **FAIL** |
| **BT10-12** (*v10.1*) | History-type report (content / parked / for-sale / redirect-error-only / none) by label | Report only; parked and for-sale must never cause REJECT |
| **SEL10-2** | LEAD-1 not a buy gate | a name with 0 leads and tier A reaches Gate A |
| **SEL10-3** | Geo tranche cap | 4th geo name in a tranche refused |
| **SEL10-4** | FORM-2 short preference | `netextend.com` (2 words, 9 chars) → short = 1, A-Form 15; a 3-word 14-char name → short = 0, not rejected; within the same tier the short name ranks first |
| **SEL10-5** | Main-lane quota | tranche of 15 with only 9 S7/S3 DEMAND-2 names → refused (`tranche_min_main_lane` 10) |
| **SEL10-6** (*v10.1*) | G-FORM-1 city tokens | `losangelesroofers.com` → tokens [los angeles][roofers] = city + 1 trade word, 17 chars → FAIL on ≤16 (not on words); `sanantoniobuysell.com` → city + 2 words → FAIL; `hvacchicago.com` → PASS |

v9.1 tests that assert LEAD-1 as a gate (SEL4-3 at Gate A, SEL9-1 lead fixtures as buy conditions) now apply to **outreach scoring only**.

Any fail → no live Gate A until fixed (or a documented Dvir waiver). **BT10-1, BT10-9 or BT10-11 fail → buy hold stays** (v10.1: BT10-9 and BT10-11 currently fail).

---

## 8. Implementation order for Claude Code

1. features_v1 + `/score` with **STRe_eff_y1, Ratio@BIN/floor, new priors** + SEL3-1, SEL9-1, SEL9-2
2. `/check/history` blocking + Web Risk interim (SEL9-14)
3. `/comps/keyword` nightly `system/data/namebio/` cache + attribution (SEL9-4, SEL9-13)
4. `/census/siblings` from `system/census/` + `/census/run` + `in_use` (SEL9-11, SEL9-12)
5. `/leads/build` + verify + never_pitch + prospect_type/lead_priority + role-inbox≤10→B (SEL9-7, SEL9-15, SEL10-1)
6. `screening_pack` + `/buy` enforcement + allowed BIN set + step-down drops (SEL9-3, SEL9-9) + `/distribution/confirm` (SEL9-6)
7. `/renewal/decision` with live ARA + transfer compare (SEL9-10) + pattern health
8. `/tokenize` + Tranco typo job
9. Slim briefs + evidence allowlist lint + ED egress block (SEL9-5)
10. Labels + shadow book jobs + BT-001 notebook + measurement wiring (inquiry source, Afternic paste fields)

---

## 9. Decisions for Dvir

**v10.1 decisions (2026-10-06):**
- **D-10.1-A Buy hold vs main lane.** The expired-name lane rejects only 62% of dropped names (target 75%), so a buy there has roughly a 2–4% chance of selling per year (lift about 1.9× if the base is 1–2%). Options:
  - (a) keep the hold and collect more expired-lane data (as-of-date census, larger n);
  - (b) waive BT10-11 and buy a small test tranche, accepting the weaker separation.
- **D-10.1-B Geo lane.** Real geo sales here were $125–$499, mostly city + trade at 17–28 chars, and G-FORM-1 accepts only 3 of 17. Options:
  - (a) keep geo capped at ≤3 per tranche with ≤16 chars;
  - (b) test a longer geo form (≤24 chars) priced at $299–$499 in the next backtest before any geo buys.


**New in v9 (from R9):**
- **D1. Exact-name prospects.** **APPROVED 2026-10-06 (v9.1 C14)** with strict limits: plainly descriptive SLD; ≥3 unrelated businesses using the term as business/service description (URLs on file; product-name use does not count); TM-1 clean; standard BIN only.
- **D2. Geo BIN schedule.** Keep $499/$399, or switch to $788/$299? *Recommendation:* keep $499/$399 for tranche 1. Revisit after ≥60 E1.
- **D3. S7 source.** *Recommendation:* the backend uses only zone diff + RDAP. ExpiredDomains is an optional manual tool for Dvir.

**Still open / follow-ups:**
- Keyword Planner monthly export
- screening_pack retention
- p_lead review point (now: after ≥60 E1 per lane)
- whether a strong geo grade needs his G9 confirmation
- Web Risk / Safe Browsing **API key** (until then C16 interim applies)
- Re-check role-inbox→tier B (≤10 people) after the first **60** outreach emails (C15)

---

## 10. Source index (high-signal; full list in R9 §5)

1. Hawkes, NamePros reported-sales analysis H1 2024 (median $1,300; 62.5% hand-reg; 3.8:1 BIN; 124 inbound vs 9 outbound) [V-analysis]
2. Hawkes portfolio Ratio, NamePros blog 2026 [V-method]; Hawkes STR 2019 [V-analysis]
3. NameBio API docs + retailstats/tldstats CSVs [V, downloaded 2026-10-05]
4. Afternic: 2025 recap (priced 3–4× more likely), Sell Smarter, LTO +35%, top keywords [V-vendor]
5. Sedo/InterNetX GDR 2025 (median $549, 69% BIN) via DNW [V]; Dynadot 54k sales (DNW 2026) [V]
6. NamePros outbound threads 1117029, 1204046, 1189675, 1271956, 1324821, 1391814 [3P]
7. NamePros pricing threads 1252087, 1325539, 1374729, 1367745, 1292660 [3P]
8. ExpiredDomains FAQ (no API; bots banned) [V]; Hawkes ED guide [V-tool]
9. DomainSherpa: Levi, Reason, Silver [3P]; DNW #472, #579 show notes [3P]
10. Porkbun KB 163, How to Connect Your Domain to Afternic (Fast Transfer opt-in): https://kb.porkbun.com/article/163-how-to-connect-your-domain-to-afternic [V]
11. WIPO Overview 3.0; WIPO D2024-3177; 15 U.S.C. §1117(d) [V]
12. Internal: v2, v3, R4–R8, R9, playbook, DR-001, DR-002, cfo-ledger (ARA = live registrar renewal as of v9.1)

*End of v10 spec.*
