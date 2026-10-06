# CR-002 — Selection v10 check changes (delta to CR-001)

| Field | Value |
|---|---|
| **CR id** | CR-002 |
| **To** | DOM (vendor; owns and builds the domain-trading software) |
| **From** | Gavriel (chief of staff; DOM's only API user), on behalf of Dvir |
| **Date** | 2026-10-06, ~02:55 IDT; updated ~03:25 IDT for v10.1 |
| **Status** | Approved by Dvir 2026-10-06 03:24 IDT, sent to DOM |
| **Business rules** | Selection **v10.1** (`system/selection-v10.md`, 2026-10-06 ~03:25 IDT; same decision rule as v10 plus wider holdout tests). Rule ids (DEMAND-2, HIST-2, G-FORM-1, BUY-HOLD) and tests (BT10-x, SEL10-x) refer to that document |
| **Builds on** | CR-001 (selection checks as a service). Everything in CR-001 stays unless changed here: status enum (§3.1), per-result fields (§3.2), batches/caching (§3.3), audit (§3.4) |
| **Based on** | Sold-names backtest `research/backtest-sold/` (226 sold T1 + 54 geo reference vs 284 dropped controls; `results.md`, `v10-delta.md`) and holdout retest `research/backtest-sold/holdout/` |
| **Releases hold** | Releases the hold on CAP-07 and CAP-10 placed in `CR-001-HOLD-01.md`. All thresholds in this CR are settings (CAP-00), not hard-coded |
| **Amendments** | Amendment A (v10.2: CAP-07 guard, as-of history, replay gates, CAP-25 forward test) — approved by Dvir 2026-10-06 09:17 IDT, sent to DOM; see end of file |
| **Priority key** | **P1** = needed before any v10 buy or practice run. **P2** = later |

## Findings → rules → capabilities

| # | Finding (sold vs dropped, backtest) | Rule (selection v10) | Setting (default) | Capability | Test |
|---|---|---|---|---|---|
| 1 | **Short:** two words 83% vs 27%; SLD ≤12 chars 75% vs 31% | FORM-2 short preference (score and ranking, not a gate); tier B needs ≤2 words | `short_max_words` 2, `short_max_chars` 12 | CAP-01, CAP-18 | CAP-01 tests (SEL10-4) |
| 2 | **Neighbors:** sibling registered-share median 0.80 vs 0.10 | DEMAND-2: registered_share ≥ 0.50 (tier A), ≥ 0.60 (tier B) | `registered_share_min` 0.50, `registered_share_min_B` 0.60 | CAP-10, CAP-24 | CAP-10/24 tests (BT10-2/3) |
| 3a | **Not fresh, prior history:** 93% vs 42% | HIST-2: prior history = positive signal; reject harmful history only | `hist2_reject_classes`, `redirect_action` FLAG | CAP-07 | CAP-07 tests (BT10-4) |
| 3b | **Not fresh, other extension before the .com:** 39% vs 0% | `alt_tld_before_n ≥ 1` → tier I | `alt_tld_before_min` 1 | CAP-12, CAP-24 | CAP-12 tests (BT10-8) |
| 3c | **Not fresh, expired names:** 93% of "recent" sold names were re-registered drops | Main lane = expired/dropped names with clean history; ≥10 of 15 per tranche | `tranche_min_main_lane` 10 | CAP-04, CAP-03 | CAP-04 tests (SEL10-5) |
| 4 | **Lead count:** 0 of 38 measured geo names reach 8 A/B leads | LEAD-1 removed as a buy gate; leads only after buying, for outreach | `lead_gate_enabled` false | CAP-14/15/16, CAP-20 | CAP-14/15/16 tests (SEL10-2) |
| – | Geo: sold 24/28 two-word vs dropped 57/60 three-word | G-FORM-1 (≤2 words, ≤16 chars), ≤3 geo per tranche | `geo_max_words` 2, `geo_max_chars` 16, `geo_per_tranche_max` 3 | CAP-01, CAP-04 | SEL10-3 |
| – | Holdout: DNW-style 76% / 78% PASS; retail 71% / 74% (misses by 1 pt); expired lane 72% / 62% FAIL | BUY-HOLD until BT10-1 + BT10-9 + BT10-11 pass | `buy_hold` true, 0.70 / 0.75, `holdout_min_n` 50 | CAP-21, CAP-00 | CAP-21 tests |
| 5 | Prior-history type: parked 41–44% of sold vs 12–22% of dropped; for-sale 11–15% vs 4–8% | Parked and for-sale history are positive; never a reject | `hist2_forsale_action` PASS | CAP-07 | CAP-07 tests (BT10-12) |
| 6 | Price band: v10 accepts 63% of sold <$1k, 78% at $1–2.5k, 84% >$2.5k | Report by band | `report_bands` | CAP-21 | BT10-10 |
| 7 | Lane: expired 72% / 62%; geo sold 7/20; geo tokenizer split cities | Lane report gates the hold; a multi-word city = one token | `lane_report`, `geo_city_one_token` true | CAP-21, CAP-01 | BT10-11, SEL10-6 |

---

## 0. Why

The backtest showed v9.1 accepts **0 of 226 names that actually sold** (and 0 of 284 dropped). The blocking gates were DEMAND-1 (89% of winners fail it), HIST-1 (38%) and LEAD-1 (nearly all). The features that do separate sold from dropped names are:

| Feature | Sold | Dropped |
|---|---|---|
| Sibling registered-share (median) | 0.80 | 0.10 (AUC 0.85) |
| Any history before creation | 93% | 42% |
| Two words | 83% | 27% |
| Length (median chars) | 10 | 13 |
| Another extension registered before the .com | 39% | 0% |

v10 rule I (registered-share ≥ 0.50 AND prior history, OR another extension registered first) accepted 188/226 sold (83%) and rejected 186/224 dropped (83%) in-sample. **Ask:** DOM changes or adds the capabilities below. Everything is **what, not how**; reference scripts in `research/backtest-sold/scripts/` are non-binding.

**Buy hold:** v10 buys stay blocked (BUY-HOLD) until the holdout tests pass: ≥70% of held-out sold names accepted AND ≥75% of held-out dropped names rejected, n ≥ 50 per class. DOM enforces this as a setting (CAP-00) and a report (CAP-21). The buy hold is a **business rule owned by Gavriel/Dvir, not DOM**: DOM implements the setting and reports; only Dvir or Gavriel decide to clear it.

v10.1 requires three suites:
- **BT10-1, DNW-style:** 76% / 78%, passed.
- **BT10-9, retail:** 71% / 74%, failed by 1 point.
- **BT10-11, expired lane:** 72% / 62%, failed.
- **So the hold stays.**

## 1. Ground rules (same as CR-001)

- Every check returns the CR-001 status enum. A failed or rate-limited lookup is **UNKNOWN, never PASS**. A missing feature never counts as a pass.
- Every threshold below is a **setting** (CAP-00), not hard-coded.
- In as-of-date mode (CAP-21), no input may use data dated after the as-of date (no leakage).
- **Format:** each capability is a contract (inputs, outputs, business rules, errors/UNKNOWN, acceptance tests), not an implementation. No time estimates are requested.
- **Expired names (rule 5 unchanged):** "expired/dropped names" in this CR means only names that have **fully dropped and are registrable at the normal registration price**. No backorders, drop-catching, expired-name auctions or aftermarket purchases. Rule 5 is unchanged; this answers CR-001-HOLD-01 item 2.
- **Harmful-history sources:** CAP-07 uses only documented/official sources (the CAP-05 and CAP-06 sources plus archive content via its documented API), consistent with DOM's CR-001 §11 positions: no undocumented website endpoints, and Web Risk is `MANUAL_REQUIRED` until a key exists.

---

## 2. Capabilities (new or changed only)

### CAP-00 (changed) Settings defaults for v10 — **P1**
- **Purpose:** v10 thresholds become settings with these defaults.
- **Defaults:** `registered_share_min` 0.50 (tier A), `registered_share_min_B` 0.60, `form_B_max_words` 2; `alt_tld_before_min` 1; `sibling_count` 20; `p_passive` A/I 0.02/yr, B 0.01, geo 0.01; `short_max_words` 2, `short_max_chars` 12; `geo_max_words` 2, `geo_max_chars` 16, `geo_per_tranche_max` 3; `tranche_min_main_lane` 10; `lead_gate_enabled` false; `buy_hold` true; `holdout_sold_accept_min` 0.70, `holdout_drop_reject_min` 0.75; *v10.1:* `holdout_min_n` 50, `geo_city_one_token` true, `hist2_forsale_action` PASS, `report_bands` [1000, 2500], `lane_report` true.
- **Acceptance:** changing a setting changes the decision in the next run without a code change; the run report shows the settings version used.

### CAP-10 (changed) Sibling registered-share — the DEMAND-2 demand signal — **P1**
- **Purpose:** for a name's 20 siblings (same head or tail word, CR-001 CAP-10 method), report the share that are **registered**. This replaces in-use share as the gate. In-use share stays as an output, as a feature only.
- **Input:** domain, optional `as_of` date.
- **Output:** `registered_share` (0–1), `n_registered`, `n_checked`, `n_unknown`, sibling list with per-sibling status and creation date (when known), `in_use_share` (feature only).
- **Rules:** with `as_of` set, count only siblings created before `as_of` when the creation date is known. Siblings with unknown creation dates are counted but flagged (`as_of_exact`: false). If more than 25% of siblings are UNKNOWN, `registered_share` is UNKNOWN. The census list is frozen per name and version (`bt1_<sld>@v1`) so reruns are comparable.
- **UNKNOWN:** registry/RDAP lookups that fail or are rate-limited.
- **Acceptance tests:**
  - netextend.com (sold) → registered_share 0.65 → at or above 0.50.
  - DR-003 `s6_regime_audit@v1` → registered 0.20 → DEMAND-2 FAIL (same outcome as under v9.1).
  - A census with 6 of 20 siblings UNKNOWN → registered_share UNKNOWN, not a number.

### CAP-07 (changed) History — HIST-2, harmful history only — **P1**
- **Purpose:** history no longer rejects a name just because it has a past. Report whether any history exists before creation (a positive signal) and reject **only harmful history**.
- **Output:** `prior_history` (0/1), `pre_caps` (number of archive captures before the current registration), `pre_cls` (class of prior use: `content` / `parked` / `redirect_offsite` / `harmful` / `none` / `unknown`), `hist2` (PASS / FLAG / FAIL / UNKNOWN), plus evidence URLs.
- **v10.1:** `pre_cls` adds `redirect_error_only` (captures exist but never a normal page), reported as a feature, not a gate. For-sale and parked prior pages are **positive** and must never REJECT. On held-out data, excluding them lost 10 of 55 sold names to gain 1 of 55 dropped names.
- **Errors:** archive lookup failure or timeout → UNKNOWN. Web Risk without a key → `MANUAL_REQUIRED` for that source.
- **Rules:** FAIL only for harmful use (adult, pharma/gambling spam, malware/phishing, hacked-site spam, scam). An off-domain redirect is a FLAG, not a FAIL. Ordinary prior business content or parking is PASS and sets `prior_history` = 1. If the archive lookup fails, the result is UNKNOWN (CR-001 DR-003 lesson: never "ambiguous → pass").
- **Acceptance tests:**
  - officeprep.com (sold $2,592; prior business content) → hist2 PASS, prior_history 1.
  - A name whose prior capture is a redirect to another site → FLAG.
  - A name with pharma spam captures → FAIL.
  - Archive timeout → UNKNOWN.

### CAP-12 (changed) Prior registration + other extension registered before the .com — **P1**
- **Purpose:** add a dated feature, `alt_tld_before_n`: the number of other extensions of the same name (.net, .org, .co, .io, .ai, .info, .us and country codes as configured) whose RDAP creation date is **earlier than the .com's current creation date**, or earlier than the buy date for a name being considered. Also report whether the .com itself was registered before (a drop-catch or re-registration).
- **Output:** `alt_tld_before_n`, a list of extension + creation date, `com_prior_registration` (yes / no / unknown), `n_unknown_ext`.
- **Rules:** use creation dates only; an extension registered **after** the comparison date never counts (leakage rule). An extension whose RDAP fails (.co, .io, .ai and .info often do) is UNKNOWN for that extension, not "not registered". If all extensions are UNKNOWN, `alt_tld_before_n` is UNKNOWN.
- **Acceptance tests:** a fixture where .net was created 2015 and .com re-created 2023 → `alt_tld_before_n` ≥ 1. A fixture where .net was created after the .com → 0. A fixture where .io RDAP times out → that extension is UNKNOWN and listed in `n_unknown_ext`.

### CAP-24 (new) Rule tier and DEMAND-2 decision — **P1**
- **Purpose:** one call that assigns the v10 rule tier and the DEMAND-2 result from CAP-10, CAP-07, CAP-12 and CAP-01.
- **Rules (defaults from CAP-00):**
  - Tier **A** = registered_share ≥ 0.50 AND prior_history = 1.
  - Tier **I** = A OR alt_tld_before_n ≥ 1.
  - Tier **B** = registered_share ≥ 0.60 AND ≤ 2 words.
  - Tier **G** = geo name passing G-FORM-1 (CAP-01).
  - DEMAND-2 PASS if tier I, B or G; FAIL if none apply; UNKNOWN if a needed input is UNKNOWN and the other inputs cannot settle it.
- **Output:** `tier` (A / I / B / G / none), `demand2` status, the inputs used, and which clause fired.
- **Acceptance tests (backtest examples):**
  - netextend.com (sold; registered 0.65, prior content) → tier A, PASS.
  - limemob.com and dentstorm.com (dropped, but accepted by rule I in the backtest) → kept as known false positives; the expected output is PASS, recorded as a regression fixture so changes to the error rate are visible.
  - boutworld.com and techaipost.com (sold, rejected by rule I) → FAIL; known false negatives, regression fixtures.
  - registered_share UNKNOWN with alt_tld_before_n = 2 → tier I PASS (the alternative clause settles it).
  - registered_share UNKNOWN with alt_tld_before_n = 0 → UNKNOWN.

### CAP-01 (changed) Name form — FORM-2 short preference and G-FORM-1 for geo — **P1**
- **FORM-2 (all non-geo names):** output `n_words`, `sld_chars`, and `short` = 1 when the name has ≤2 words AND the SLD is ≤12 chars. `short` is a **preference**: it sets the A-Form score to the maximum (CAP-18) and ranks the name first within its tier. It does not reject. Tier B (CAP-24) uses `n_words ≤ formB_max_words`.
- **Backtest:** two words 83% of sold vs 27% of dropped; SLD ≤12 chars 75% vs 31%.
- **v10.1 tokenization fix:** a multi-word city from the city list (los angeles, san antonio, new york) is **one** token, and a compound trade word (countertops, roofers) is **one** trade word. Output the city span and trade span separately.
- **Acceptance tests (v10.1, SEL10-6):** losangelesroofers.com → city "los angeles" + trade "roofers" → words OK, 17 chars → FAIL on length only. sanantoniobuysell.com → city + 2 words → FAIL on words.
- **Acceptance tests (FORM-2):** netextend.com → 2 words, 9 chars, short = 1. A 3-word 14-char name → short = 0, status PASS (not rejected). Two names in the same tier, one short → the short one is ranked first.
- **G-FORM-1 purpose:** geo names (city + trade) pass form only if they are city + **one** trade word, at most 2 words and at most 16 characters (the SLD without .com).
- **Backtest:** sold geo reference names 22/28 accepted; dropped geo names 3/60 accepted.
- **Acceptance tests:** hvacchicago.com → PASS (11 chars, 2 words). A name like "chicagohvacrepairpros.com" → FAIL (4 words, >16 chars).

### CAP-04 (changed) Portfolio concentration — main lane quota and geo cap — **P1**
- **Purpose:** at most `geo_per_tranche_max` (default 3) geo names per buy tranche, and at least `tranche_min_main_lane` (default 10 of 15) expired/dropped names with clean history (S7) or S3 names passing DEMAND-2. This is in addition to the CR-001 rules. CAP-03 marks each candidate's source lane (`expired_drop` / `fresh`) from registry history.
- **Acceptance tests:** a tranche with 4 geo candidates passing everything → the 4th (lowest Ratio) is returned as FAIL `geo_cap`. A tranche of 15 with only 9 main-lane names → refused (`main_lane_quota`).

### CAP-18 (changed) Passive probability from rule tier — **P1**
- **Purpose:** `p_passive` comes from the rule tier (CAP-24) instead of a lead-based estimate: A/I 0.02 per year, B 0.01, G 0.01 (settings). The Ratio and expected profit formulas are otherwise unchanged from CR-001.
- **Acceptance test (fixture):** a tier-A name with list price $1,488 → Ratio 2.28 (list) / 1.48 (floor), expected profit +$28 per year. The same name with the tier changed to B → Ratio halves.

### CAP-14 / CAP-15 / CAP-16 (changed) LEAD-1 demoted to outreach — **P1**
- **Purpose:** lead discovery, verification and tiering still run, but **after** the buy decision and only for outreach planning. LEAD-1 and CAPACITY-1 no longer gate a buy (`lead_gate_enabled` = false).
- **Output:** the lead count and tiers appear on the buy card as information plus an outreach plan; they never change the buy decision.
- **Acceptance test:** hvacchicago.com with 5 A/B leads → same buy decision with `lead_gate_enabled` false whether leads are 5 or 0. With the setting true, the v9.1 behavior returns (for comparison runs).

### CAP-20 (changed) Gate order — **P1**
- **Order (stop at the first FAIL; UNKNOWN stops for a buy, continues in report mode):**
  1. G0 form (CAP-01, including G-FORM-1)
  2. Brand/typo (CAP-02)
  3. Availability (CAP-03)
  4. Concentration (CAP-04, including the geo cap)
  5. SURBL (CAP-05)
  6. Web Risk (CAP-06)
  7. HIST-2 (CAP-07)
  8. Trademark (CAP-08/09)
  9. DEMAND-2 / rule tier (CAP-10, CAP-12, CAP-24)
  10. Price and Ratio (CAP-17/18)
  11. Screening pack (CAP-19)
  12. BUY-HOLD check
  13. After the buy decision only: leads/outreach (CAP-14/15/16)
- **Funnel report:** counts per gate, as in CR-001, plus a tier breakdown.
- **Acceptance test:** a run with `buy_hold` true never outputs a BUY card. It outputs WOULD-BUY with all evidence.

### CAP-21 (changed, now P1) Backtest / holdout mode and the buy hold — **P1**
- **Purpose:** run the full pack as of a past date on labeled sets of sold and dropped names, and report accept/reject rates against the CAP-00 targets. The holdout results set or clear `buy_hold`. Clearing it also needs a recorded human approval (Dvir or Gavriel).
- **Name registry (v10.1):** every labeled name is recorded once as `fit`, `dev` or `test`, with source, slice and date. A test run refuses any name already marked fit or dev. Variants may be chosen on fit/dev only, and are recorded ("pre-registered") before test slices are scored.
- **Holdout suites (v10.1):**
  - **BT10-1:** DNW-style holdout.
  - **BT10-9:** retail multi-slice holdout, ≥5 weekly slices, all price bands.
  - **BT10-11:** expired-lane holdout (sold re-registered drops vs dropped names with prior history).
  - Each needs ≥70% sold accepted, ≥75% dropped rejected and n ≥ `holdout_min_n` (50) per class. **`buy_hold` clears only when all three pass.**
- **Reports:**
  - Per slice and pooled.
  - By price band (<$1k, $1–2.5k, >$2.5k) and by lane (expired, fresh hand-reg, aged, geo).
  - Precision at assumed base rates of 1% and 2%.
  - History-type table (BT10-12).
- **Missing data:** if a lookup fails, the row is **undecided** unless the decision is the same either way. Undecided counts are reported, never silently dropped or counted as pass.
- **Acceptance tests (fixtures from the 2026-10-06 runs, `research/backtest-sold/iterations/`):**
  - Replaying the stored backtest (226 sold / 224 dropped) reproduces 188 accepted / 186 rejected ±2.
  - Replaying round 1 (55 / 55) gives 42 accepted / 43 rejected ±1 → BT10-1 PASS.
  - Replaying rounds 4–8 gives 150/211 sold accepted and 144/195 dropped rejected ±3 → BT10-9 FAIL.
  - Replaying the expired lane gives 52/72 and 26/42 → BT10-11 FAIL, so `buy_hold` stays true.
  - A holdout containing a fit or dev name → the run is refused.
  - A name whose history lookup timed out but whose share is below .5 and has no alt-ext → decided (REJECT). The same name with share ≥ .5 → undecided.

---

## 3. Open questions for DOM
1. Can sibling creation dates be obtained at scale (RDAP or a zone history) so that `as_of_exact` is true for most siblings?
2. Which extensions have reliable RDAP creation dates? (.co, .io, .ai and .info failed often in our runs.)
3. Is a harmful-history classifier available from documented/official sources only, or should CAP-07 return captures for a bot to classify (status UNKNOWN until classified)?

## 4. Evidence
- Backtest: `research/backtest-sold/results.md`, `v10-delta.md`, `dataset.csv`, `controls.csv`, `census/`.
- Holdout and iterations: `research/backtest-sold/iterations/` (round-1…8.md, summary.md, name-log.md).
- Retail sales source: `research/backtest-sold/raw/us_weekly_sales.csv` (UnreportedSales weekly reports [3P]).
- Rules: `system/selection-v10.md` (v10.1: changelog C22–C35; tests BT10-1…12, SEL10-2…6).

---

## 5. DOM response (2026-10-06 03:40 IDT)

**Verdict: accepted with changes.** CR-002 folds into the CR-001 P1 build. The CAP-07/CAP-10 hold is released. Items marked **NEEDED** block only the capability named.

### 5.1 Pushback

| # | Topic | DOM position |
|---|---|---|
| P-1 | **The business rules and evidence are not in the repo** | `system/selection-v10.md` and `research/backtest-sold/**` (`results.md`, `v10-delta.md`, `dataset.csv`, `controls.csv`, `census/`, `iterations/`, the name registry) exist only on Gavriel's side. DOM cannot build to, or test against, files it can't read. **NEEDED:** push them under `docs/requests/CR-002-reference/` (rules + data; no personal data). Until then, DOM builds to the CR-002 text alone, and the CAP-21 replay tests can't be written. |
| P-2 | **Moving rules** | The rules went v9.1 → v10 → v10.1 in about three hours, and BUY-HOLD is on (BT10-9 and BT10-11 fail). DOM builds **stable mechanics** (settings, form, availability, SURBL, archive fetch, sibling registration census, extension dates, the run engine and the evidence store) and keeps **every rule data-driven**: tiers, thresholds and the gate list per lane are settings. A v10.2 is then a settings change, not a rebuild. Gate logic DOM can't express as settings will be called out in the release note. |
| P-3 | **CAP-21 scope** | Re-fetching every check as of a past date for about 500 names is the most expensive part of CR-002. It also duplicates Gavriel's research scripts, which already compute these features. DOM proposes **CAP-21a (P1): a replay over recorded features.** Gavriel uploads a labelled feature table (domain, label, slice, fit/dev/test, `registered_share`, `prior_history`, `pre_cls`, `alt_tld_before_n`, `n_words`, `sld_chars`, geo flags, `as_of`), and DOM applies the **same tier/DEMAND-2 code path** as live screening. That reproduces the 188/186, round-1, rounds 4–8 and expired-lane numbers, and gives the per-slice, per-band and per-lane reports, the name registry (refuses fit/dev names in test runs) and the `buy_hold` decision report. **CAP-21b (P2):** DOM recomputes features as of a date with its own fetchers. |
| P-4 | **BUY-HOLD enforcement** | `buy_hold` is a setting. While it's true, `POST /buy` refuses non-dry-run purchases of names screened under v10 with 409 `BUY_HOLD`, and screening returns WOULD-BUY cards. Clearing it needs a settings activation with Dvir's `approval_ref` (CR-001 P-8): the holdout report must show all three suites passing, **and** a human approval must be recorded. DOM enforces both conditions and never clears it itself. |
| P-5 | **"Tranche" doesn't exist in DOM yet** | CAP-04's quota (≥10 of 15 main-lane, ≤3 geo) needs a definition. DOM proposes: a **tranche** is a named group of screened names that Gavriel opens and closes through the API. The quotas are checked when the tranche is closed, and on every addition for the geo cap. A buy outside an open tranche → 409 `NO_TRANCHE`. Please confirm, or define it differently. |
| P-6 | **Harmful-history classification (§3 Q3)** | No free official source classifies **archived** content. SURBL and Web Risk report current status only. DOM classifies the decisive captures with **deterministic, versioned signature lists** (adult, pharma/gambling spam, casino, malware/phishing kit markers, hacked-site spam patterns; no LLM): a strong match → FAIL, a weak or partial match → FLAG with the excerpt and capture URL for bot judgment, no match → PASS with `pre_cls`. Gavriel maintains the signature lists through the API (versioned and audited, like the brand lists). |

### 5.2 Answers to §3
1. **Sibling creation dates at scale.** RDAP gives the **current** registration's creation date for every registered `.com` sibling. That is exact for siblings still registered whose creation predates `as_of`. **Siblings that were registered at `as_of` but have since dropped can't be seen** without a paid zone-history source (excluded: free data only), so the as-of share is a **lower bound** for older dates. DOM marks `as_of_exact = false` when `as_of` is more than *Setting* `census.as_of_exact_max_days` (default 365) in the past, and reports the measured share of exact siblings per run.
2. **RDAP coverage per extension.** DOM uses the IANA RDAP bootstrap registry. An extension with no RDAP service, or one that fails or rate-limits, is `UNKNOWN` (never "not registered"). DOM measures coverage on the CR-002 extension list in the first build and publishes the per-extension figures (answered / unknown / no service) in the release note. **Expected:** `.com`, `.net`, `.org`, `.info`, `.biz` and `.us` are reliable; `.co`, `.io` and `.ai` are uncertain until measured.
3. **Harmful-history classifier.** See P-6. The classification is DOM's, with FLAG + evidence for anything that isn't a clear match.

### 5.3 Fixture checks (DOM recomputed from the CR text)
- **CAP-18:** tier A, $1,488, `p_passive` 0.02, n = 0, ARA $11.08 → Ratio 2.28 at list and 1.48 at the $967 floor, EV +$27.9. Matches CR-002.

### 5.4 Delivery
CR-001 P1a and CR-002 P1 ship together as **contract v1.1.0**:
- CAP-00 (with the v10 defaults), 01 (FORM-2, G-FORM-1, multi-word cities), 02, 03 (plus the source lane), 04 (plus the tranche quotas, P-5), 05;
- 07 (HIST-2, P-6), 10 (`registered_share` gate input), 12 (`alt_tld_before_n`);
- 24, 17, 18 (pricing v3, `p_passive` from tier), 20 (the v10 order, a settings-driven gate list);
- **21a** (P-3) and the BUY-HOLD enforcement (P-4);
- CAP-06/08 as `MANUAL_REQUIRED` (CR-001 §11).

CAP-14/15/16 (outreach only) and CAP-19 (plus `/buy` pack enforcement) follow in v1.2.0.
Requester note (2026-10-06 04:50 IDT): reference material published in CR-002-reference/ (non-binding).

## Requester answers (2026-10-06 04:50 IDT)

- **P-5 tranche:** confirmed as DOM proposed (a named group of screened names that Gavriel opens and closes through the API; quotas are checked at close and on every addition for the geo cap; a buy outside an open tranche returns `409 NO_TRANCHE`). Additions:
  - Geo cap per tranche is a setting, default 1 (changed from 3 after round 11-12 showed geo lowers expected batch profit).
  - A tranche has an optional spend cap setting.
  - The overall POC caps (50 domains, $1,500 total spend including renewals committed) are checked on every `/buy` across all tranches.
  - A tranche may be closed with fewer names than its target.
  - Closed tranches are read-only and appear in `/report`.
- **P-1 census/:** we'll add the census files and one labelled feature table for the CAP-21a replay (columns as DOM listed) to `CR-002-reference/` after the current test slice completes, within the day.
- **Rule update FYI (non-binding until a CR amendment):** the expired-lane candidate rule E3 = v10 AND at least 3 years of web-archive activity before the drop is the current leader; the buy hold remains. All thresholds stay settings.

Requester note (2026-10-06 05:15 IDT): features.csv and census/ added to CR-002-reference/ per P-1 (non-binding).

**DOM, 2026-10-06 05:30 IDT:** thanks. Received `CR-002-reference/` (rules, data, `features.csv`, census).
- **Tranches:** built as confirmed. The geo cap per tranche is a setting (default **1**), there is an optional per-tranche spend cap, a tranche can close below its target, and closed tranches are read-only and appear in `/report`.
- **`NO_TRANCHE` on `/buy`** ships in **v2.0.0**, together with the P1b screening-pack enforcement. Both break today's `/buy`, so they share one major version and migration note. v1.1.0 stays additive: tranche quotas are checked on add and at close, and `BUY_HOLD` applies to names screened under a `buy_hold` settings version.
- **"$1,500 total spend including renewals committed":** today the POC cap counts spend plus open purchases. Committed renewals are reported separately (`/report` `committed_forward`) and are **not** counted against the cap. Counting them changes a founder-rule cap, which needs a CR amendment with Dvir's approval. Until then the cap is unchanged.
- **E3 (FYI):** CAP-07 will also output `archive_years_before_drop` as a feature, so E3 can become a settings change once it's adopted.

---

## Amendment A — Approved by Dvir 2026-10-06 09:17 IDT, sent to DOM

**Status:** Approved by Dvir 2026-10-06 09:17 IDT, sent to DOM. Source: `system/selection-v10.md` v10.2 (C36–C42, §6a), after Shomer's red-team `research/backtest-sold/iterations/shomer-attack-r12.md`. Only spec changes that affect DOM are listed. The decision rule (v10), BUY-HOLD and rule 5 are unchanged. All thresholds are settings (CAP-00). No delivery dates or time estimates are requested here.

### A1. CAP-07 (changed) HIST-2 + prior-business guard — P1
- **Inputs:** domain, `as_of` (see A2), archive captures, blocklist results (SURBL, Web Risk).
- **Outputs:** `hist2` (PASS/FAIL/UNKNOWN), `hist2_fail_class`, `prior_business_use` (yes/no/UNKNOWN), `prior_business_name`, `prior_business_years`, `evidence_urls[]`.
- **Business rules:** FAIL classes are exactly: SURBL/Web Risk listing, malware/phishing, spam (incl. pharma/gambling spam, hacked-site spam, PBN/link-farm content), adult, scam, trademark abuse. HIST-1 is retired; a same-name business still operating elsewhere is not a CAP-07 FAIL (CAP-08/09 handle it). When `prior_business_use` = yes, CAP-02 (BRAND-1, BIGCO-1) and CAP-08 (TM-1) also run on `prior_business_name`; a hit = FAIL under that gate; otherwise the card shows `prior_business_use` as a disclosed risk, not a reject. Parked/for-sale history = PASS.
- **Errors:** archive or blocklist lookup failure → `hist2` UNKNOWN with `error_code` (`ARCHIVE_UNAVAILABLE`, `BLOCKLIST_UNAVAILABLE`); never PASS by default.
- **Acceptance tests:** (1) prior real business, no hits on prior name → `hist2` PASS, `prior_business_use` yes on the card; (2) same with a live TM on the prior name → FAIL under TM-1, not HIST-2; (3) PBN/link-farm captures → FAIL (spam); (4) parked/for-sale → PASS.

### A2. CAP-07 / CAP-10 / CAP-12 / CAP-21 (changed) history as of the as-of date — P1
- **Inputs:** domain, `as_of` (date), mode (live/backtest/holdout).
- **Outputs:** existing fields (captures, `pre_caps`, span, `pre_cls`, `alt_tld_before_n`, sibling counts) computed as of `as_of`; `as_of` echoed on every result.
- **Business rules:** only data dated strictly before `as_of` is used. Backtest/holdout: `as_of` = drop date for dropped rows, catch/creation date for sold rows. Live: `as_of` = decision date.
- **Errors:** missing `as_of` in backtest/holdout → request rejected (`AS_OF_REQUIRED`); data with undeterminable date → excluded and counted in `undated_excluded_n`.
- **Acceptance tests:** (1) a capture dated after `as_of` is not counted; (2) a leakage lint over a replay reports 0 rows using data dated ≥ `as_of`.

### A3. CAP-21 (changed) hard rejects in every replay + profit reports — P1
- **Inputs:** replay set (backtest, holdout or forward), settings (`bin_price` default $1,488).
- **Outputs:** per row: gate columns for CAP-02 (BRAND-1, BIGCO-1), CAP-08/09 (TM-1, TN-1), CAP-07 (HIST-2 + guard); accept/reject before and after these gates. Profit report: as computed, without the top 3 sales, prices capped at the BIN, and the break-even base sale rate (E3 reference range 0.74–1.75%/yr).
- **Business rules:** gates apply per row in every replay mode.
- **Errors:** a replay without the gate columns → refused (`REPLAY_INVALID_NO_GATES`); a profit report missing the top-3-removed or BIN-capped column → refused (`PROFIT_REPORT_INCOMPLETE`).
- **Acceptance tests:** (1) replay without gate columns is refused; (2) profit report missing either column is refused; (3) complete report shows all four profit figures.

### A4. CAP-25 (new, future) forward test — P2
- **Inputs:** weekly sample of .com names in `pendingDelete` from official/public sources only (CZDS zone-file differences, RDAP status checks).
- **Outputs:** rows matching `research/forward-test/log.csv` (selection-v10.md §6a): v10 and frozen E3 arm scored as of the drop date with A1–A3 applied, drop outcome, 30/60/90-day recheck (re-registered via RDAP; listed via public marketplace pages). Report: re-registered-or-listed rate, accepted vs rejected, Wilson CIs, n per class.
- **Business rules:** capability only; it does not measure sales. Until CAP-25 exists, Gavriel's research runs do this. No requests to ExpiredDomains or the NameBio download URL.
- **Errors:** RDAP failure → row UNKNOWN/undecided, never accepted or rejected.
- **Acceptance tests:** (1) replaying a recorded week reproduces the logged decisions; (2) RDAP failure → UNKNOWN; (3) 0 requests to ExpiredDomains or the NameBio download URL.

### A5. Clarification — E3
- E3 (archive span ≥3 yrs) is frozen and **not** a gate; DOM should not build it as a rule. `archive_span_yrs` (as of `as_of`) may be output as a feature for the forward-test comparison. Acceptance: no setting or gate named E3 changes any decision.

*End of Amendment A.*
