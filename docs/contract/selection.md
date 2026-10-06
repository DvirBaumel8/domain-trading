# Selection checks (contract v1.1.0, unreleased)

This file grows with each v1.1.0 task. It lists the statuses, codes and shapes of the selection and screening features. Routes are in `endpoints.md`.

## Name form (CAP-01): result and codes

The name-form check is pure (no network, no clock). It reads one `.com` name, a lane (`S2` geo, `S3`, `S4`, `S6`, `S7`), the word lists (with their versions) and the form settings, and returns:

`tokens` (best split), `token_types` (`city`, `state`, `trade`, `regime`, `tech`, `generic_head`, `legal`, `dictionary`, `unknown`), `alternative_splits` (up to 3 other readings that cross the best split's word boundaries and cost at most `ambiguity_margin` more), `ambiguous`, `unknown_tokens`, `word_count`, `sld_len`, `has_digit`, `has_hyphen`, `city` and `city_span`, `trade` and `trade_span`, `regime`, `keywords`, `geo_length_band` (the A-Form raw score for the SLD length), `city_plus_legal`, `short` (FORM-2: at most `short_max_words` words and `short_max_chars` characters; a preference, never a rejection), `gform1_pass` (G-FORM-1; `null` unless the lane is `S2`), `status` (`PASS`, `FLAG`, `FAIL`) and `reason_code` / `reason`.

A place name from the gazetteer that is also a dictionary word (`dent`, `lime`, `mobile`) is **not** a city unless it is in `form.city_word_allowlist` or in the `city_extra` list. The default allowlist holds the 126 major cities that the dictionary also contains (chicago, tulsa, phoenix, austin ...). A multi-word city from the city list (los angeles, san antonio) is **one** token when `geo_city_one_token` is true; a compound trade word (roofers, countertops) is one trade word. Only the first reason found is reported, in this order:

| Status | `reason_code` | When |
|---|---|---|
| `FAIL` | `HAS_DIGIT` | the SLD contains a digit (also for regime names such as NIS2) |
| `FAIL` | `HAS_HYPHEN` | the SLD contains a hyphen |
| `FAIL` | `UNKNOWN_TOKEN` | a run of letters is neither a word nor a city nor a listed term (`unknown_token_fails` true); `unknown_tokens` names it, a stray letter stays with its word (`cincinnatio`) |
| `FAIL` | `GFORM1_WORDS` | lane `S2` and `word_count` is above `geo_max_words` |
| `FAIL` | `GFORM1_LENGTH` | lane `S2` and `sld_len` is above `geo_max_chars` |
| `FLAG` | `GEO_ATTR_MISSING` | lane `S2`, shape within the limits, but no city token or no trade token |
| `FLAG` | `CITY_PLUS_LEGAL` | a city token and a legal term (lawyer, attorney, law) |
| `FLAG` | `AMBIGUOUS_SPLIT` | `alternative_splits` is not empty, **or** the split has at least `form.short_token_flag_min` (default 2) dictionary-only 2-letter tokens (`animalitos` → `animal·it·os`); `ambiguous` is then true |
| `PASS` | none | none of the above |


## Selection settings (CAP-00)

One JSON document per version (`values`). A version is immutable; a draft is made by dotted paths (`POST /selection/settings`), activated with Dvir's `approval_ref` (`POST /selection/settings/{label}/activate`); the active version is the one with the highest activation number. The first version, `v1`, is seeded by the migration: CR-001 as approved (Dvir 2026-10-06 02:05 IDT) with the CR-002 v10.1 defaults (Dvir 2026-10-06 03:24 IDT). `GET /selection/settings` returns the active document, so it is the live reference; this table is the meaning of each key.

**Locked** keys cannot be changed by a draft (SEL9-2): `tier.p_passive`, `lead.p_lead`, `priors_v91` and `holdout` (the gate that clears `buy_hold` cannot be redefined by the draft that clears it). Only a migration changes them. The lock compares the result with both the draft's base and the **active** version, so a draft based on an old version cannot bring old priors back.

**Approvals are bound to the thing approved.** Activating a version needs an `approval_ref` whose text **names the settings label** (label-boundary match, as `/buy` does for a domain: `v1b` is not named by `v1bb`). Freezing a census list needs a text that names the **list name** or, for `bt1_<sld>`, the target name (`<sld>` or `<sld>.com`). A valid but unrelated approval → 422 `APPROVAL_INVALID`. The frozen list stores the approval text. The buy-hold check receives the **active** version's `holdout` settings and must use them (never the target's).

| Key | Default (v1) | Meaning |
|---|---|---|
| `thresholds` | `registered_share_min` 0.50, `registered_share_min_B` 0.60, `form_B_max_words` 2, `alt_tld_before_min` 1 | Named numbers the tier clauses refer to as `"$name"`. New names can be added by a draft. |
| `form.geo_bands` | ≤12 chars 10, ≤16 7, ≤20 4, longer 1 | Geo A-Form raw score by SLD length (`max_chars` null = open end) |
| `form.unknown_token_fails` | true | A run of letters no list explains → `FAIL` `UNKNOWN_TOKEN` |
| `form.ambiguity_margin`, `form.token_costs` | 2; typed 1, dict3 2, dict2 3 | Tokenizer search: how much more a reading may cost and still count as an alternative; cost of a typed term, a dictionary word of 3+ letters, a 2-letter dictionary word |
| `form.short_max_words`, `form.short_max_chars` | 2, 12 | FORM-2 `short` |
| `form.geo_max_words`, `form.geo_max_chars`, `form.geo_city_one_token` | 2, 16, true | G-FORM-1; a multi-word city is one token |
| `form.formB_max_words` | 2 | Tier B word limit (also `thresholds.form_B_max_words`) |
| `form.legal_terms_list` | `legal` | The list whose terms make `city_plus_legal` |
| `form.short_token_flag_min` | 2 | FLAG `AMBIGUOUS_SPLIT` at this many dictionary-only 2-letter tokens; 0 = off |
| `form.city_word_allowlist` | 126 major cities | Gazetteer names that are also dictionary words and still count as cities |
| `typo` | edit distance 1, top 10000, list at most 7 days old | TYPO-1 |
| `concentration` | per attribute 2, lane share 0.40 (`lane_share_enforced` false) | The 40% rule is report-only (ruling R2) |
| `tranche` | size 15, main lane 10, geo max 1 (ruling R6), `required_for_buy` true | Tranche rules |
| `surbl` | zone `multi.surbl.org`, control `test.surbl.org`, blocked answers `["127.0.0.1"]`, bit names, `ns_override`, 3000 ms | SURBL lookup |
| `history` | per-name fetch cap 6, 1000 ms between calls, 20 s timeout, 1 retry, 200 chars of text; actions strong FAIL, weak FLAG, redirect FLAG, for-sale PASS, parked PASS | CAP-07; parked and for-sale prior pages are positive |
| `census` | 20 siblings, at most 25% unknown, as-of exact for 365 days | CAP-10; `sibling_count` is also the size of a census list |
| `ext.list` | net, org, co, io, ai, info, us | CAP-12 extensions |
| `tier` | see §Tier | Order, clauses, DEMAND-2 tiers and `p_passive` (locked) |
| `lead` | `gate_enabled` false; `ab_min` S2 8, S3/S4/S6/S7 5; `p_lead` (locked) S2 0.005, S3 0.002, S4 0.002, S6 0.003, S7 0.002 | v10 turned the lead gate off (LEAD-1 is no buy gate) |
| `priors_v91.p_passive` | S2 0.005, S3 0.004, S4 0.004, S6 0.005, S7 0.004 (locked) | Used when `lead.gate_enabled` is true or the tier is `none` |
| `money` | net factor 0.85 with Afternic nameservers, 0.75 otherwise; `hold_years` 2 | CAP-18 |
| `lander` | exception needs 30 A/B leads and retail end count ≥ 20 | LANDER-1 |
| `price` | forbidden bands $800–$999 and $1,950–$1,999; `geo_default_grade` strong | BIN checks and the default geo BIN |
| `score` | lane weights (each sums to 100), `coverage_min` 0.70 (`coverage_gate` false), `parked_penalty` 0, bands, `retail_only_max_points` 10, `risk_raw` clean 10 / flag 5, `forbidden_feature_keys` | §Money. `parked_penalty` is 0 because v10 treats parked history as positive (v9.1 had −10). `coverage_gate` is off because the intent, timing and external-business inputs do not exist yet. |
| `namebio`, `quote`, `web_risk`, `freshness_hours`, `evidence`, `run`, `holdout` | see `GET /selection/settings` | Used by the screening run and the holdout report (later tasks); `evidence.max_text_bytes` 32768 |
| `buy_hold` | true | The buy hold (CR-002). Clearing it needs a passing holdout report and Dvir's approval. |
| `sources` | surbl, tranco, wayback, rdap_com, rdap_other, iana_bootstrap true; namebio false | A disabled source makes its check `UNKNOWN` `SOURCE_DISABLED`. NameBio is off because its terms could not be read. |

### Validation (`SETTINGS_INVALID`, `details.issues`)
Checked when a draft is created, never mid-run: every key is known (strict); every `"$name"` in a clause exists in `thresholds`; every clause `f` is a tier feature; every `{"tier": X}` refers to a tier **earlier** in `tier.order`; every tier in `order` has a clause and a `p_passive`; `demand2_pass_tiers` ⊂ `order`; every id in `run.gates.*` and `run.feature_checks` is a check id; `run.feature_checks` only holds feature checks (`census`, `ext_dates`, `namebio`); `run.gates` has a `default` list and only known lanes; each lane's score weights sum to 100 (SEL3-1); history actions are `PASS`, `FLAG` or `FAIL`; shares are within 0..1.

Check ids: `form`, `brand_lists`, `typo`, `availability`, `concentration`, `surbl`, `web_risk`, `history`, `tm_us`, `census`, `ext_dates`, `tier`, `namebio`, `quote`, `price`, `pack`, `leads`.

## Lists

Versioned, append-only; a write adds version n+1 (`POST /selection/lists/{name}`). Terms are lowercase.

| List | Terms | v1 |
|---|---|---|
| `dictionary_extra`, `city_extra` | letters only | none. `city_extra` terms count as cities even if they are dictionary words. |
| `trade`, `regime`, `tech`, `generic_head`, `state`, `legal` | letters only, 2–40 | seeded (DOM-curated from the CR-001 reference lexicon; a term in two lists keeps one type: `lawyer` is `legal`, not `trade`) |
| `brand`, `bigco`, `event` | letters, or phrases of single-space-separated words | none: Gavriel uploads them. Until then the brand check is `UNKNOWN` `LIST_MISSING`. |
| `sig_harmful_strong`, `sig_harmful_weak` | `class:phrase`, class in adult, pharma, gambling, malware, phishing, hacked_spam, scam | DOM starter sets |
| `sig_parked`, `sig_forsale` | `parked:phrase`, `forsale:phrase` | DOM starter sets |
| `bt1_<sld>`, `s6_regime_audit` | `census.sibling_count` distinct `.com` names | frozen per version with Dvir's approval |

**Bot-edited lists change gate outcomes at once.** The fixed lists (`brand`, `bigco`, `event`, the signature lists, `legal`, `trade` ...) are written with a WRITE token and take effect for the next run **without Dvir's approval**; that is deliberate (Gavriel curates them). Every change is a new version, audited (token, time, Idempotency-Key) and readable (`?version=`); a run records the list versions it used. Only census lists need an approval.

## Tier (CAP-24) and DEMAND-2

`tier.order` lists the tiers in evaluation order (`A`, `I`, `B`, `G`). `tier.clauses.<tier>` is `{"all": [cond, ...]}` or `{"any": [cond, ...]}`; a condition is `{"f": <feature>, "op": ">="|"<="|">"|"<"|"=="|"!=", "v": <number or "$threshold">}` or `{"tier": <earlier tier>}` (that tier's result). Features: `registered_share`, `prior_history`, `alt_tld_before_n`, `n_words`, `sld_chars`, `is_geo`, `gform1_pass`, `short`.

Three-valued: a condition on a missing (null) feature is `unknown`. `all` is false if any condition is false, else unknown if any is unknown, else true. `any` is true if any is true, else unknown if any is unknown, else false. The result `tier` is the first clause in `order` that is true (`none` if none is). `tier_exact` is false when an earlier clause was `unknown` (a later tier decided, but the earlier one could still have applied). `demand2` is `PASS` if any tier in `demand2_pass_tiers` is true, `UNKNOWN` if none is true but one is unknown, else `FAIL`. `fired` is the tier that was chosen. A missing input is never a pass.

Default clauses: **A** = registered_share ≥ `registered_share_min` and prior_history == 1; **I** = A, or alt_tld_before_n ≥ `alt_tld_before_min`; **B** = registered_share ≥ `registered_share_min_B` and n_words ≤ `form_B_max_words`; **G** = is_geo and gform1_pass. DEMAND-2 passes for I, B or G. `p_passive` per tier: A 0.02, I 0.02, B 0.01, G 0.01 (locked).

## Money (CAP-18)

```
p_passive = tier.p_passive[tier]            when lead.gate_enabled is false and tier is not none
          = priors_v91.p_passive[lane]      otherwise
p_lead    = lead.p_lead[lane];  n = leads_ab
P_sale    = 1 - (1 - p_passive)^hold_years * (1 - p_lead)^n
stre_eff_y1 = 1 - (1 - p_passive) * (1 - p_lead)^n
net_price = round(BIN * net_factor)          # 0.85 Afternic nameservers, else 0.75
lifetime_cost = first_year + renewal         # both from a live quote
EV        = round(P_sale * net_price) - lifetime_cost
ratio(price) = price * net_factor * stre_eff_y1 / renewal
```

`money` fields: `p_passive`, `p_lead`, `n`, `P_sale`, `net_price_cents`, `lifetime_cost_cents`, `ev_cents`, `stre_eff_y1`, `ratio_at_bin`, `ratio_at_floor` (4 decimals), `floor_cents`, `bin_in_allowed_set`, `forbidden_band`, `lander1 {pass, reason, message}`, `score_0_100`, `factors {A..G: {raw, weight, points}}`, `data_coverage`, `passes {ev1, ratio1, lander1, coverage}`, `model_version`, and `display` (strings for `bin`, `floor`, `net_price`, `lifetime_cost`, `ev`). Money is integer cents.

- **Floor for the ratio.** Non-geo: the pricing floor of the BIN under the **current** `pricing_settings` (the same formula as `/list`: 65% of the BIN, never below its minimum, whole dollars in v3). **Geo: the bottom of the geo ladder** (the lowest price-list value inside the geo band, $299 in v3), not the pricing floor, which for a geo name is its BIN (founder rule 4). `floor_cents` shows the figure used.
- **`passes`:** `ev1` = EV > 0; `ratio1` = ratio ≥ 1 at **both** the BIN and the floor; `coverage` = `data_coverage` ≥ `score.coverage_min` (reported, not gating while `coverage_gate` is false). `ev1` and `ratio1` are null when the quote is missing.
- **LANDER-1 (`lander1`):** the BIN must be on the lane's price list (the same lane lists as `/list` and the price job: non-geo from the minimum non-geo BIN, geo inside the geo band) (`BIN_NOT_IN_PRICE_LIST`; `PRICE_LIST_MISSING` when the current pricing version has no list, which fails every non-geo name: fail closed; the message says "pricing_settings v3 not created yet"); a non-geo BIN above the highest non-exception list price needs the exception (`lander.exception_ab_min` A/B leads and a retail-end count ≥ `lander.exception_retail_end_min`, else `LANDER_EXCEPTION_NOT_MET`). A geo BIN only has to be on the list (or the list is missing: the grade price is fixed).
- **Score (0–100, a tiebreaker only):** per lane weights (each sums to 100). Raw 0–10: A-Form = 10 when `short` is 1 (non-geo, FORM-2), else the mean of the length, word-count and syllable bands (non-geo; the syllable count is left out of the mean when unknown) or the geo length band (geo); B Buyers from `leads_ab` against `lead.ab_min` (0 → 0, below the gate → 0, at the gate 6, ×1.5 → 8, ×2 → 10); C Intent and E Timing as given; D Liquidity from the retail counts (`d_bands`, capped at `retail_only_max_points` points); F External business is not available yet (null); G Risk = `risk_raw.flag` or `risk_raw.clean`. A null raw is 0 points and not counted in `data_coverage` (the share of weights with data). Score = Σ raw × weight / 10, rounded half up, clipped to 0–100.
- **No appraisal input:** `score.forbidden_feature_keys` (default `govalue_usd`, `estibot_value`, `humbleworth_usd`, `alexa_rank`, `appraisal_usd`) are refused anywhere in an evaluate body (`FORBIDDEN_FEATURE`; SEL5-2).

## Evidence

Each outside source read is stored once in `screening_evidence`: `source`, `url`, `retrieved_at`, `http_status`, `content_type`, `sha256` (of the **full response body**), the **extracted visible text** (gzip, cut to `evidence.max_text_bytes` bytes on a character boundary; `truncated` says so, `text_bytes` is the stored length). The raw HTML is never stored. Rows are append-only. Evidence is read with `GET /screening/evidence/{id}`; a screening result cites it in `evidence`.

## Screening runs (CAP-20)

A run screens up to 50 names through the lane's gate list (`run.gates.<lane>`, else `run.gates.default`, in that order). Every (name, check) is a stored row; the newest row of a (name, check) is its result (a manual record, or a re-run, adds a row and never changes one). Gate by gate, names in `rank` order.

**Result status** (`PASS`, `PASS_WITH_NOTE`, `FLAG`, `FAIL`, `UNKNOWN`, `MANUAL_REQUIRED`, `NOT_RUN`): only PASS has no reason code. `source` is `auto` (the check ran), `cache` (copied from an earlier result inside `freshness_hours.<check>`, same settings label, same backtest flag and same list versions; `cached: true`, the original `checked_at`; a result that is UNKNOWN, NOT_RUN or MANUAL_REQUIRED is never reused) or `manual`.

**Checks built in this release** (`gate` is the label shown on each result):

| Check | Gate | Rules | Lists | Result |
|---|---|---|---|---|
| `form` | G0 | SPELL-1, FORM-2, G-FORM-1, CAP-01 | trade, regime, tech, generic_head, state, legal, city_extra, dictionary_extra | the form result above as `fields`; `INPUT_INVALID` (written when the run is created) |
| `brand_lists` | G1 | BRAND-1, BIGCO-1, EVENT-1 | brand, bigco, event | `fields`: `brand_hits[]`, `bigco_hits[]`, `event_hits[]` (each `{term, tokens}`), `lists_missing[]`, `list_versions`. A term matches when it equals a token or its space-stripped form equals consecutive tokens. Brand and bigco ignore `city` and `state` tokens; event does not. FAIL `BRAND_HIT` / `BIGCO_HIT` / `EVENT_HIT` (first in that order); else UNKNOWN `LIST_MISSING` when a list has no uploaded version (never a clean result); else PASS |
| `concentration` | G3 | CONCENTRATION-1 | the form lists | `fields`: `city`, `trade`, `regime`, `keywords`, `cap`, `lane_share {lane, in_lane, total, share, max, enforced}`; on a FAIL also `details {attribute, value, count, cap, blocking[]}`. The attributes come from the name's `form` result; the portfolio is the names in `domains` with status `pending_purchase`, `owned`, `listed` or `delisted`, tokenised the same way, plus the names ranked ahead in this run that have no FAIL at a gating check. "Ahead" means lower `rank` first (unranked after ranked, then submission order); a name ranked ahead that already failed any gating check, including its own concentration check, does not count, and a name ranked behind never counts. A count at or above `concentration.max_per_attr` → FAIL `CONCENTRATION_CITY`, `CONCENTRATION_TRADE`, `CONCENTRATION_REGIME` or `CONCENTRATION_KEYWORD` (in that order); a geo name when the run has a `tranche_id` and tranche geo members + geo names ahead reach `tranche.geo_max` → FAIL `GEO_CAP` (tranche members count as 0 until tranches exist); `LANE_SHARE` only when `concentration.lane_share_enforced` (off by default; the share is always reported); a geo name without a city or a trade → FLAG `GEO_ATTR_MISSING`; else PASS |
| `web_risk` | G5 | WEB-RISK-1 | none | always MANUAL_REQUIRED `MANUAL_SOURCE` until a record is posted (`fields`: `lookup_name`, the safe and unsafe statuses, `requires_clean_history`). Record rules: `endpoints.md` `POST /screening/runs/{id}/manual` |
| `tm_us` | G7 | TM-1 | the form lists | always MANUAL_REQUIRED `MANUAL_SOURCE` until a record is posted; `fields.phrases_to_query` lists what to search: the exact phrase (`TULSA ROOFING CO`), city + trade, the distinctive core (generic heads removed), and each generic-head pair (`ROOFING CO`); `control_required: true` |

| `availability` | G2 | S1 (CAP-03) | none | `lookupCached` on the .com registry's RDAP (Verisign; cache `rdap_lookups`, window `freshness_hours.availability`, default 1 h; only registered / not-registered rows are reused). `fields` always `availability` (`available` / `registered` / `unknown`) and `checked_at`. 404 → PASS `available`. 200 with an RDAP domain object for the same name → FAIL `REGISTERED` with `registrar`, `created_at`, `expires_at`, `updated_at`, `registry_statuses[]`, `nameservers[]`. Anything else → UNKNOWN with the reason: `TIMEOUT`, `RATE_LIMITED` (one retry after `Retry-After` when it is at most 10 s), `SOURCE_ERROR` (any other HTTP status, a network error, or a 200 whose body is not JSON or names another domain: never "registered", never "available"). `sources.rdap_com` false → UNKNOWN `SOURCE_DISABLED`. Evidence: the RDAP JSON (capped) or the 404 note. In a live run an UNKNOWN stops the name before the later gates |
| `surbl` | G4 | SURBL-1 (CAP-05) | none | DNS A lookups `<domain>.<surbl.zone>` sent **directly to the zone's authoritative servers** (never a public resolver). Server discovery, first group that works: `surbl.ns_override` (IPs or hostnames); the zone's own NS records; SURBL's documented query hosts `a`..`j` of the zone's parent (`a.surbl.org` ... for `multi.surbl.org`, which has no NS records of its own). Once per run a **control** lookup of `surbl.control_name` must answer a listed `127.0.0.x` (not in `blocked_answers`, with a bit in `list_bits`); otherwise every name of the run is UNKNOWN `CONTROL_FAILED` (`control_ok: false`). Per name: NXDOMAIN → PASS `listed: false`; `127.0.0.x` → FAIL `SURBL_LISTED` with `lists[]` decoded from the last octet by `surbl.list_bits` (and `answer`); an answer in `blocked_answers` (127.0.0.1) or rcode REFUSED → UNKNOWN `QUERY_REFUSED`; no server answers → UNKNOWN `TIMEOUT` (the next server is tried first); any other answer → UNKNOWN `SOURCE_ERROR`. `fields`: `listed`, `lists`, `control_ok`, `server`. At most 5 queries per second. Evidence: the query and the answer text. `sources.surbl` false → UNKNOWN `SOURCE_DISABLED`. Not dated: it is today's list, whatever `as_of` is |
| `census` | G8 | DEMAND-2 input (CAP-10) | the item's census list | Feature check. The item's `census_list` (`name@vN`, or `name` for the newest version) must exist (UNKNOWN `CENSUS_LIST_MISSING` otherwise, also when the item has none) and have exactly `census.sibling_count` names (UNKNOWN `CENSUS_LIST_SIZE`). Each sibling is looked up in the RDAP cache (window `freshness_hours.census`, default 30 days) through the shared pacer (`run.rdap_concurrency`, `run.rdap_min_ms_between`). A registered sibling counts when its creation date is **strictly before `as_of`** (the item's `as_of`, else now); a registered sibling with no creation date is counted and makes `as_of_exact` false. More than `census.max_unknown_share` unknown siblings → UNKNOWN `TOO_MANY_UNKNOWN`, `registered_share: null`. Otherwise PASS with `registered_share = n_registered / n_checked` (unknown siblings stay in the denominator). `fields`: `registered_share`, `n_registered`, `n_checked`, `n_unknown`, `siblings[{domain, status registered / not_registered / unknown, created_at, counted, reason_code?}]`, `list` (`name@vN`), `as_of`, `as_of_exact` (false with an undated counted sibling or an `as_of` older than `census.as_of_exact_max_days`), `registered_after_as_of_n`, `undated_counted_n`, `undated_excluded_n` (0: undated siblings are counted, per CAP-10), `in_use_share: null` (not built). A backtest or holdout run (draft settings) without `as_of` → UNKNOWN `AS_OF_REQUIRED`; `sources.rdap_com` false → UNKNOWN `SOURCE_DISABLED` |
| `ext_dates` | G8 | CAP-12 | none | Feature check. For each `ext.list` extension the RDAP base comes from the IANA bootstrap (stored in `reference_files`, refreshed when older than 7 days; a failed refresh keeps the old copy). The comparison date is the `.com`'s `created_at` from this run's `availability` result when it is registered, else `as_of` (the item's, else now). `alt_tld_before_n` = extensions whose creation date is **strictly before** it (a later or equal date never counts: leakage rule). Per extension: registered, not_registered, or unknown with `NO_REGISTRY_SERVICE` (no base in the bootstrap: `.co`, `.io`, `.us`), `SOURCE_DISABLED`, `TIMEOUT`, `RATE_LIMITED` or `SOURCE_ERROR` (also when the bootstrap cannot be read). A registered extension with no creation date cannot be shown to be earlier: excluded and counted in `undated_excluded_n`. PASS with `alt_tld_before_n` (a count of the proven ones; `n_unknown_ext` says how many could not be checked); all extensions unknown → UNKNOWN `ALL_EXT_UNKNOWN`, `alt_tld_before_n: null`. `fields`: `alt_tld_before_n`, `extensions[{tld, status, created_at, counted?, reason_code?}]`, `n_unknown_ext`, `undated_excluded_n`, `comparison_date`, `comparison_basis` (`com_created_at` / `as_of`), `as_of`, `com_prior_registration` (`yes` / `no` from the `history` result's `prior_history` when that check exists, else `unknown`). Backtest or holdout without `as_of` → UNKNOWN `AS_OF_REQUIRED`; `sources.rdap_other` false → UNKNOWN `SOURCE_DISABLED` |

**Not built yet:** every other check id in a lane's gate list (`typo`, `history`, `tier`, `namebio`, `quote`, `price`, ...) answers NOT_RUN with reason code `NOT_IMPLEMENTED`, with its gate label (`G1` typo, `G6` history, `G8` tier / namebio, `G9` quote / price, `G10` pack, `G12` leads). It is listed in the name's `not_implemented` and never counts as a pass or a fail. **In a live run a name with an unbuilt gating check is `unknown`** (never `would_buy` or `buy_candidate`), except for `pack` and `leads`, which stay unbuilt in v1.1.0; in a `full` (report) run the check is only listed. Each is replaced by a real result when its check ships.

**Time budget and resume.** `deadline_at = created + run.time_budget_minutes`. A running run with no new row for 120 s is continued by the next `GET` or the hourly tick; a run past its deadline ends `partial`: every open check of a name that is not already stopped becomes UNKNOWN `TIMEOUT` (`SOURCE_ERROR` when the worker itself kept failing). A manual record always outranks an automatic or cached row for the same name and check, whatever the order they were written in. A check that throws is UNKNOWN `SOURCE_ERROR` (message cut to 200 characters). A (name, check) is never written twice by a run.

**Final status** per name (`final_status`):

| Value | Meaning |
|---|---|
| `invalid` | the name could not be read (`INPUT_INVALID`) |
| `rejected` | a gating check FAILed; `first_fail` is the first in plan order. In `live` mode later checks were not run |
| `unknown` | a gating check is UNKNOWN, or the run has ended and a planned gating check has no result |
| `running` | no FAIL or UNKNOWN yet and a gating check is still to come |
| `pending_manual` | everything else passed but a check is MANUAL_REQUIRED (`pending_manual` lists them) |
| `would_buy` | everything passed and the settings' `buy_hold` is on, **or the run is a backtest, or its settings version is not (any longer) the active one**: never a buy card while the hold is on (CR-002 CAP-20) |
| `buy_candidate` | everything passed, `buy_hold` is off and the run is live on the active version |

Feature checks (`run.feature_checks`: census, ext_dates, namebio) never reject or stop a name; their UNKNOWN leaves a feature unknown. `flags` lists the checks that answered FLAG; a FLAG does not block (a bot judges it).

**Funnel** (per run, stored as `summary` when the run ends and refreshed after a manual record; an unreadable name is counted once as `invalid`, not at the form stage or in `first_fail`): `{names, by_final_status {<status>: n}, first_fail {<check>: {gate, count}}, by_lane {<lane>: {names, final {<status>: n}, stages [{check, gate, reached, passed, flagged, failed, unknown, manual_required, not_run}]}}}`.

**Cache and as-of.** A result is never reused for a name that is as of a past date (a full run with `as_of`), and a result from a run with an explicit `as_of` is never a source for reuse.

**As-of.** Each stored name carries `as_of`: a live run sets it to the request time; a full run keeps the `as_of` sent (none otherwise). The checks that use dated sources (`census`, `ext_dates`; the archive check in a later task) read only data dated strictly before it, echo it as `fields.as_of`, and count data they cannot date in `undated_excluded_n` (or, for census siblings, `undated_counted_n`, with `as_of_exact` false). A backtest or holdout run (a run on draft settings) that has a name without `as_of` answers UNKNOWN `AS_OF_REQUIRED` for the dated checks.

**Sources and pacing.** Every outside source is read only when its `sources.<name>` flag is true (else UNKNOWN `SOURCE_DISABLED`) and with the User-Agent `domain-trading-api/1.1.0 (+https://github.com/DvirBaumel8/domain-trading)`. RDAP queries share one pacer per run (`run.rdap_concurrency` in flight, `run.rdap_min_ms_between` between starts); answers are cached in `rdap_lookups` (not in the backup export: re-fetchable) and the IANA bootstrap in `reference_files`. An error, a timeout, a non-conforming 200 body or a missing source is always UNKNOWN with a reason code, never stored as available, not listed, not registered, or zero.

## Status and reason codes (so far)

| Code | Where |
|---|---|
| `HAS_DIGIT`, `HAS_HYPHEN`, `UNKNOWN_TOKEN`, `GFORM1_WORDS`, `GFORM1_LENGTH`, `GEO_ATTR_MISSING`, `CITY_PLUS_LEGAL`, `AMBIGUOUS_SPLIT` | name form (above) |
| `BIN_NOT_IN_PRICE_LIST`, `PRICE_LIST_MISSING`, `LANDER_EXCEPTION_NOT_MET` | `money.lander1.reason` |
| `PRICING_V3_MISSING` | `POST /selection/evaluate` `warnings` |
| `INPUT_INVALID` (causes `DUPLICATE`, `NOT_COM`, `DOMAIN_INVALID`), `LIST_MISSING`, `BRAND_HIT`, `BIGCO_HIT`, `EVENT_HIT`, `CONCENTRATION_CITY`, `CONCENTRATION_TRADE`, `CONCENTRATION_REGIME`, `CONCENTRATION_KEYWORD`, `GEO_CAP`, `LANE_SHARE`, `MANUAL_SOURCE`, `UNSAFE`, `HISTORY_NOT_FINAL`, `STATUS_UNRECOGNISED`, `CONTROL_FAILED`, `TM_LIVE_MARK`, `TM_GENERIC_HITS`, `TIMEOUT`, `SOURCE_ERROR`, `NOT_IMPLEMENTED` | screening results (above) |
| `REGISTERED`, `SOURCE_DISABLED`, `RATE_LIMITED`, `QUERY_REFUSED`, `SURBL_LISTED`, `CENSUS_LIST_MISSING`, `CENSUS_LIST_SIZE`, `TOO_MANY_UNKNOWN`, `ALL_EXT_UNKNOWN`, `NO_REGISTRY_SERVICE`, `AS_OF_REQUIRED` | registry, DNS and dated-extension checks (`availability`, `surbl`, `census`, `ext_dates`; `CONTROL_FAILED` as above) |
