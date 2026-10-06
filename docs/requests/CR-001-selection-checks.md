> **Requester note (2026-10-06 03:00 IDT): HOLD CAP-07 and CAP-10 pending CR-002; see `CR-001-HOLD-01.md`.**

> **DOM, 2026-10-06: shipped in v1.1.0 (CR-001 P1a; `docs/releases/v1.1.0.md`). Not shipped: the screening pack and `NO_TRANCHE` (2.0.0), CAP-14/15/16/19 (1.2.0), CR-002 Amendment B (gaps G-55), CAP-25 and CAP-21b (P2).**

>
> **DOM response: §11 (2026-10-06): accepted with changes; P1a/P1b plan; DVIR decisions in §11.3.**
>
> **Approved by Dvir 2026-10-06 02:05 IDT. Priority: P1 first; please reply with answers to the open questions in this file or docs/releases/ before building.**

# CR-001 — Selection checks as a service (screening API)

| Field | Value |
|---|---|
| **CR id** | CR-001 |
| **To** | DOM (vendor; owns and builds the domain-trading software) |
| **From** | Gavriel (chief of staff; DOM's only API user), on behalf of Dvir |
| **Date** | 2026-10-06, 02:05 IDT |
| **Status** | **APPROVED by Dvir 2026-10-06 02:05 IDT, sent to DOM** |
| **Business rules** | Selection v9.1 (`docs/internal/selection.md` (v9.1; was `docs/specs/selection.md`), 2026-10-06). Rule ids (HIST-1, LEAD-1, …) and test ids (SEL9-x) refer to that document |
| **Based on** | Practice runs DR-002 (2026-10-06 00:05–00:32 IDT) and DR-003 (~00:50–01:45 IDT), plus the sold-names backtest in progress (`research/backtest-sold/`) |
| **Priority key** | **P1** = needed for the next practice run (DR-004). **P2** = later |

---

## 0. Why

In both practice runs Gavriel's workers did every mechanical check by hand because the screening functions do not exist in the API yet.

| Run | Names generated | Passed availability | Fully screened | Buy cards | Tool calls | Tokens (est.) | Wall clock |
|---|---|---|---|---|---|---|---|
| DR-002 | 60 | 34 | 9 | 0 | ~81 | ~140k in + ~20k out | ~27 min (≈8 min waiting on rate-limited sources) |
| DR-003 | 134 | 45 | 45 (stop at first failure) | 0 | ~100 | ~140k in + ~25k out | ~55 min (history checks alone ~17 min) |

- About **75% of the bot effort was mechanical** work that should be a service (DR-002 `cost.md`). The v9.1 scout budget is 35k tokens per batch (cap 50k); both runs blew it.
- Hand checks were also **inconsistent**: one history result passed as "ambiguous" instead of UNKNOWN, a rate-limited Web Risk call was carried forward as "unverified", trademark phrases were tokenized wrongly ("TULSA ROOF ING CO"), and junk addresses (`jane@test.com`, a state regulator's inbox) entered lead lists.
- **Ask:** DOM provides each check below as an API capability, plus one call that runs the full screening pack in the right order, so bots only do judgment (§2).

---

## 1. Ground rules for this CR

1. **What, not how.** This CR states inputs, outputs, business rules, error behaviour, performance/cost limits, evidence and acceptance tests. Language, storage, file layout, data model, libraries, endpoint naming and internal design are **DOM's choice**. Where this CR mentions an observed data-source behaviour (e.g. "the web archive often takes >12 s to answer"), that is information, not a design instruction.
2. **Reference scripts (Appendix A) are non-binding.** They show what was done by hand, including mistakes. DOM must not treat them as a spec.
3. **Free data only.** No paid data source or paid tier without Dvir's written approval. Any credential or account (API key, developer account) is Dvir's decision (§9).
4. **Respect source terms.** Honour documented rate limits, robots.txt and terms of use; identify honestly; never bypass CAPTCHAs, bot protection or login walls; **no automated access at all** to sites that ban bots (known: ExpiredDomains; NameBio website/CSV download beyond the allowed cadence; EUIPO/WIPO/UK IPO/TMview web UIs; LinkedIn). See §9 Q1 about BBB.
5. **Only Gavriel calls the API.** Scout bots never hold a token; they go through Gavriel.
6. **Read-only toward the outside world.** No capability in this CR buys, lists, sends or changes DNS.

---

## 2. Who does what

| Stays with Gavriel / bots (judgment) | Moves to DOM (mechanical or rule-based) |
|---|---|
| **Inventing candidate names** for each lane brief (incl. avoiding hype strings, 3-word leftovers, city + lawyer — v9.1 §5) | Every check in §4: form, brand lists, typo screen, availability, blocklists, Web Risk, history, trademarks, census, NameBio counts, extensions, leads, tiers, quotes, scoring, screening pack |
| Choosing lanes, patterns and target markets (using DOM's market data, CAP-13) | Running checks in the agreed order, stop-at-first-failure or run-all (CAP-20) |
| Authoring and approving **sibling census lists** as versioned pattern lists (Gavriel authors, Dvir approves, DOM freezes) — v9.1 C19 | Storing/versioning census lists, refusing ad-hoc lists, running the census |
| **Judging finalists** (≤5 survivors per batch): van test, TN-1 / BIGCO edge cases, confirm 3 random leads sell the service, one-line reason not to buy, resolving FLAGs (ambiguous tokens, partial trademark hits, franchise/enterprise doubts) | Producing those FLAGs with evidence attached so judgment takes ≤8k tokens per name |
| Non-geo seller discovery **until DOM has a compliant free source** (bots supply candidate seller URLs; §9 Q2) | Verifying every lead mechanically (service on page, email + source, weaker-domain reason, tier, never_pitch, size evidence) |
| Shomer's 12-item checklist, card prose (≤500 chars), ranking for Dvir's digest | All arithmetic: P_sale, EV, STRe_eff_y1, Ratio at BIN/floor, allowed-price checks, score 0–100, data coverage |
| **Writing outreach** (Sochen drafts; Dvir approves sends) | Lead lists with `lead_priority`, tier and evidence (input to outreach; DOM sends nothing) |
| Proposing threshold changes after calibration (Gavriel); approving them (Dvir) | Holding all thresholds as **versioned settings**, enforcing who may change them, stamping the settings version on every result (CAP-00) |
| Manual EUIPO/WIPO/UK IPO searches (Dvir) until CAP-09 automation exists | Requiring a recorded manual result in the screening pack and refusing the pack without it |
| Buy/sell decisions (Dvir only) | Refusing a buy without a complete screening pack (existing buy action, SEL7-1) |

**Bots must no longer:** call RDAP, the web archive, SURBL, USPTO, NameBio, BBB or registrar price pages directly; write census lists; edit priors; compute EV/Ratio by hand (v9.1 §5).

---

## 3. Conventions that apply to every capability

### 3.1 Result status (one enum everywhere)

| Status | Meaning | Counts as pass at Gate A? |
|---|---|---|
| `PASS` | Rule met, with evidence | Yes |
| `PASS_WITH_NOTE` | Met, with a scored consequence (e.g. HIST-1 parked-only → −10 score) | Yes |
| `FLAG` | Mechanically met but needs bot judgment (e.g. ambiguous tokenization, partial trademark hit) | Only after a bot verdict is recorded with a reason |
| `FAIL` | Rule broken | No |
| `UNKNOWN` | Could not complete or data inconclusive (timeout, rate limit, source error, control query failed, no registry service for that extension) | **No.** Unknown never counts as a pass unless a v9.1 rule says so — today only WEB-RISK-1 interim (CAP-06), and only for a positive status, never for an error |
| `MANUAL_REQUIRED` | Source cannot be automated (e.g. EUIPO web); a human result must be recorded | No, until recorded |
| `NOT_RUN` | Skipped because an earlier gate failed (stop-at-first-failure mode) or the gate does not apply to the lane (e.g. DEMAND-1 for geo) | n/a — shown as skipped, never as passed |

Every non-PASS status carries a **reason code** (e.g. `TIMEOUT`, `RATE_LIMITED`, `SOURCE_ERROR`, `CONTROL_FAILED`, `NO_REGISTRY_SERVICE`, `INPUT_INVALID`, `STALE_DATA`) and a plain-English reason. An error must **never be stored as a zero, "clean", "not listed" or "available"**.

### 3.2 Every per-name, per-check result includes
- domain, lane, check id, the v9.1 rule ids it decides, status, reason code / reason
- the business fields listed in each capability
- **evidence list**: source name, exact URL or query, retrieved-at timestamp, raw response or page snapshot kept by DOM (retrievable through the API), content fingerprint
- `checked_at` (ISO 8601 with offset; displays in Asia/Jerusalem) and **`data_as_of`** (freshness of the source data, e.g. NameBio cache date, Tranco list date)
- `settings_version` and the version of any frozen list used (e.g. `s6_regime_audit@v1`, BIGCO list version)
- duration and number of upstream calls (for cost tracking)

### 3.3 Batches, modes, caching
- **Batch size:** 1–50 names per request (P1). Requests run asynchronously with per-name progress visible while running; **partial results are returned** if the time budget runs out (unfinished checks = UNKNOWN `TIMEOUT`).
- **Modes:** `live` (default; stop at first FAIL/UNKNOWN per name), `full` (run every gate regardless — for backtests and diagnostics), `as_of` (CAP-21, P2).
- **Idempotent:** resubmitting the same batch within a freshness window returns the cached results, labelled as cached with their original timestamps. Freshness windows are settings (defaults in each capability).
- **Input validation:** malformed names (not `.com`, illegal characters, empty) are rejected per name with `INPUT_INVALID`; the rest of the batch still runs.

### 3.4 Audit
- Every request is kept: caller (token identity), time, input, mode, settings version, result.
- Results are append-only; a re-run creates a new result, never overwrites.
- Evidence retention: at least life of the name + 3 years after drop/sale for any name that reached a buy card; rejected names ≥400 days (for the 90/365-day shadow-book rechecks, v9.1 §6). Final retention is a pending Dvir decision (§10).

### CAP-00 Settings and thresholds — **P1**
- **Purpose.** A backtest is recalibrating thresholds now, so **no threshold may be hard-coded**. Every number marked *Setting* in this CR (with its v9.1 default) must be a named, versioned setting.
- **Input.** Read current settings; read any past version; propose a new version (Gavriel); activate a version (only with a Dvir approval reference, as with pricing settings).
- **Output.** Settings version id, values, who/when changed, approval reference.
- **Rules.** Bots cannot change priors or thresholds (v9.1 §2.1). Live results always use the active version. `full`/`as_of` runs may use a named **draft** version for backtests; those results are labelled `backtest` and can never feed a buy card.
- **Acceptance.** Given settings v1 with `demand.in_use_share_min = 0.25`, when Gavriel runs a backtest with draft v1b = 0.20, then live results still use 0.25 and backtest results show `settings_version = v1b`, `backtest = true`. Given no approval reference, activation is refused. Given a request to set the S2 passive prior to 0.02, it is refused (SEL9-2).

---

## 4. Gate order

Cheapest and most decisive first. In `live` mode a name stops at its first FAIL or UNKNOWN; in `full` mode every gate runs. The order is part of the contract; DOM may propose a different order based on measured cost, but changes need Gavriel's sign-off.

| # | Gate | Capability | v9.1 rules | Cost class | Applies to |
|---|---|---|---|---|---|
| G0 | Form & tokens | CAP-01 | SPELL-1, form, geo length band | Free, no network | All |
| G1 | Brand / big-co / event / typo lists | CAP-02 | BRAND-1, BIGCO-1, EVENT-1, TYPO-1 | Free, local lists | All |
| G2 | Availability | CAP-03 | S1 (RDAP) | 1 call | All |
| G3 | Concentration | CAP-04 | §1.3 concentration (CONCENTRATION-1) | Internal data | All |
| G4 | Blocklists | CAP-05 | SURBL-1 | 1 DNS lookup | All |
| G5 | History | CAP-07 | HIST-1 | Slow (web archive) | All |
| G6 | Web Risk | CAP-06 | WEB-RISK-1 (interim rule needs G5) | 1 call, throttled | All |
| G7 | Trademarks | CAP-08 (+CAP-09) | TM-1 (+EU manual flag for S6) | 3–6 queries | All |
| G8 | Demand | CAP-10 + CAP-11 | DEMAND-1 | ~20 site fetches per pattern, cached per pattern | Non-geo (S3/S4/S6); geo uses NameBio count only (score feature) |
| G9 | Extensions / same name elsewhere | CAP-12 | D1 input, feature F, TN-1 input | ~10 lookups | All |
| G10 | Leads | CAP-14 → CAP-15 → CAP-16 | LEAD-1, CAPACITY-1 | Most expensive | All |
| G11 | Price quote | CAP-17 | ARA / lifetime cost (C17) | 1 call (existing check) | All |
| G12 | Score, EV, Ratio, price set | CAP-18 | EV-1, RATIO-1, LANDER-1, coverage | Arithmetic | All |
| G13 | Screening pack | CAP-19 | SCREEN-1 | Assembly | Survivors |
| post-buy | Distribution confirmation; renewal decision | CAP-22, CAP-23 | FT-1, Gate F | — | Owned names |

The full run is CAP-20. G4 and G6 may run alongside G5 for speed, but WEB-RISK-1 interim cannot be decided before HIST-1 is final.

---

## 5. Capabilities — name screening (G0–G9)

### CAP-01 Name form and tokenization — **P1**
- **Purpose.** Reject malformed or misspelled names before spending anything, and give every later check (trademark phrases, census stems, geo city/trade) the right words.
- **Seen in practice.** DR-002: the bot's own typo `cincinnatioroofpros.com` passed RDAP and SPELL-1; `nis2complianceaudit.com` (digit) was generated; `mcpentest.com` was dropped by eye as ambiguous. DR-003: trademark phrases built from bad splits ("TULSA ROOF ING CO", "TAMPA POOL S CO"). Backtest: `animalitos` split as "ani mali tos".
- **Input.** `names[]` (1–50 `.com` names); optional `lane`; for geo optional `city`, `state`, `trade` (we supply them when known).
- **Output.** `tokens[]` (best split), `alternative_splits[]`, `ambiguous` (bool), `unknown_tokens[]`, `has_digit`, `has_hyphen`, `sld_len`, `word_count`, `token_types` per token (`city`, `state`, `trade`, `regime`, `tech`, `generic_head`, `dictionary`, `unknown`), detected `city`/`trade`/`regime`, `geo_length_band` (A-Form raw score), `city_plus_legal` flag, status.
- **Business rules / settings.**
  - SPELL-1: any hyphen or digit → FAIL. Any unknown token → FAIL (`UNKNOWN_TOKEN`) (proposed in DR-002 V9-15; see §10). Ambiguous split → FLAG (not reject).
  - Regime names with digits (NIS2, SOC2, ISO42001) remain FAIL (no-digits rule wins).
  - Geo A-Form bands (C9): SLD ≤12 → 10; 13–16 → 7; 17–20 → 4; >20 → 1. *Settings.*
  - City + lawyer/attorney/law firm → `city_plus_legal = true` → risk factor G = FLAG (C9).
  - Word lists (dictionary, US city gazetteer, trade list, regime list) are **versioned reference data**; Gavriel can add terms through the API (audited).
- **UNKNOWN.** Not applicable (no network); missing word-list version → refuse the batch.
- **Performance / cost.** 50 names ≤10 s; no external calls.
- **Evidence.** Word-list versions used.
- **Acceptance tests.**
  1. Given `tulsaroofingco.com`, then tokens = tulsa·roofing·co, city = Tulsa, trade = roofing, `sld_len` = 14, geo band raw = 7, PASS.
  2. Given `tampapoolsco.com`, then tokens = tampa·pools·co (never "pool·s·co"), PASS.
  3. Given `cincinnatioroofpros.com`, then FAIL `UNKNOWN_TOKEN` ("cincinnatio").
  4. Given `nis2complianceaudit.com`, then FAIL (digit).
  5. Given `mcpentest.com`, then FLAG with alternative splits (e.g. "mc·pentest" / "mcp·entest").
  6. Given `promptinjectionaudit.com`, then prompt·injection·audit, `word_count` = 3, PASS.
  7. Given a 21-character geo SLD, then A-Form raw = 1 (SEL9-8).
  8. Given `dallaslawyerpros.com` (made-up example), then `city_plus_legal` = true and risk G = FLAG.

### CAP-02 Brand, big-company, sensitive-event and typo screen — **P1**
- **Purpose.** Stop names that copy a famous brand, a big company, a sensitive event, or are typos of popular sites (UDRP/ACPA risk).
- **Seen in practice.** DR-002: BIGCO checked against `system/bigco-names.csv` by hand; **TYPO-1 not run at all** (no top-sites list on the box, issue V9-14); EVENT-1 by bot judgment.
- **Input.** Names (+ CAP-01 tokens).
- **Output.** `brand_hits[]`, `bigco_hits[]` (with list version), `event_hits[]`, `typo_matches[]` (popular domain, its rank, edit distance), `typo_list_date`, status per rule.
- **Business rules / settings.**
  - Any list hit on a non-geo token → FAIL (BRAND-1 / BIGCO-1); BIGCO **web** check applies to non-geo tokens only (v9.1).
  - EVENT-1: hit on the sensitive-event blocklist → FAIL.
  - TYPO-1: edit distance to a popular domain ≤ *Setting* `typo.max_edit_distance` within the top *Setting* `typo.top_n` of a free daily popularity list (Tranco) → FAIL. Defaults pending (§10).
  - Lists are versioned; Gavriel maintains brand/big-co/event lists through the API (audited); the popularity list refreshes daily.
- **UNKNOWN.** Popularity list older than *Setting* `typo.max_list_age_days` (default 7) → TYPO-1 UNKNOWN, which blocks Gate A (V9-14).
- **Performance.** 50 names ≤30 s.
- **Acceptance tests.**
  1. Given `museagentsforbusiness.com`, then BIGCO-1 FAIL (existing roadmap test).
  2. Given 10 one-letter typos of top-1,000 domains and 10 clean DR names (e.g. `boisesolarco.com`, `paytransparencyaudit.com`), then 10 FAIL / 10 PASS (SEL7-2).
  3. Given the popularity list is 9 days old, then TYPO-1 = UNKNOWN `STALE_DATA`.

### CAP-03 Availability (registry lookup) — **P1**
- **Purpose.** Know whether each name can be registered now and, for registered names, the facts we need (registrar, dates). Every buy depends on it. The existing single-name availability-and-price check stays; this adds **batch** use and registered-name details.
- **Seen in practice.** DR-002: 60 names (34 free) + extra names for other extensions; DR-003: 134 names (45 free); backtest: 2,617 sold names for creation dates. Unclear answers happened (HTTP 429, timeouts, registries with no lookup service for `.co`/`.io`).
- **Input.** 1–50 names (backtest: up to *Setting* `batch.max_backtest` = 5,000, async).
- **Output.** `availability ∈ {available, registered, unknown}`, `registrar`, `created_at`, `expires_at`, `updated_at`, `registry_statuses[]`, `nameservers[]` (registered names), `checked_at`, raw response evidence.
- **Business rules / settings.** Registry "not found" = available; "found" = registered; anything else (rate limit, timeout, other error) = **unknown, never available** (existing check rule). Gate A needs an availability result ≤ *Setting* `availability.max_age_hours_at_gate_a` (default 24) old. Record **registry creation time**, not an order time (playbook).
- **UNKNOWN.** Retries are DOM's choice; report UNKNOWN `RATE_LIMITED` / `TIMEOUT` after the time budget.
- **Performance.** 50 names ≤2 min; 2,617 names (backtest) ≤60 min; within the registry's published limits.
- **Acceptance tests.**
  1. Given `promptinjectionaudit.com` (ours), then registered, registrar GoDaddy, created 2026-10-04 16:16 IDT (13:16Z), expires 2027-10-04.
  2. Given `tampaplumbingpros.com`, then registered (as of DR-002).
  3. Given a random 30-letter `.com`, then available.
  4. Given the registry times out (simulated), then unknown `TIMEOUT`, and the name does not advance in live mode.
  5. Given `richmondhvacpros.com` with a 30-hour-old "available" result, when assembling a screening pack, then availability is re-checked or the pack fails `STALE_DATA`.

### CAP-04 Portfolio concentration — **P1**
- **Purpose.** Avoid stacking names on one city, trade, regime or keyword (v9.1 §1.3).
- **Seen in practice.** DR-003 killed 4 geo names this way by hand: `fresnoepoxyfloors.com`, `nashvillekitchenpros.com`, `richmondfoundationco.com`, `tampafoundationpros.com`.
- **Input.** Names with CAP-01 attributes. DOM already knows the portfolio (owned names) and open buy cards.
- **Output.** For each attribute (city, trade, regime, keyword): count already used, cap, lane share; status.
- **Business rules / settings.** ≤2 per city, trade, regime or keyword; ≤40% of the portfolio in one lane. *Settings.* Counts include owned names + names on open buy cards + higher-ranked survivors in the same batch ("higher-ranked" = the order Gavriel submits, unless an explicit rank is sent; tie-break pending, §10).
- **UNKNOWN.** Missing city/trade attribute on a geo name → FLAG, not PASS.
- **Performance.** ≤5 s per batch.
- **Acceptance tests.** Given two Fresno names already ahead in the batch, when `fresnoepoxyfloors.com` is screened, then FAIL with the two blocking names listed. Given `full` mode, the FAIL is reported but later gates still run.

### CAP-05 Spam/abuse blocklist (SURBL) — **P1**
- **Purpose.** Never buy a name listed on a spam/abuse list (SURBL-1).
- **Seen in practice.** Every DR name checked by hand. DR-002 ran a control lookup (test entry returned "listed"), so "not listed" meant something. **DR-003 recorded "not listed" for every name from a name-lookup error without a control lookup** — which cannot tell "not listed" from "lookup broken". DR-001 found public resolvers refuse these lookups.
- **Input.** Names.
- **Output.** `listed` (bool or null), `lists[]` (which sub-lists), `control_ok` (bool), evidence, status.
- **Business rules.** Listed → FAIL. Not listed **and** the control lookup in the same run returns "listed" → PASS. Control fails → UNKNOWN `CONTROL_FAILED` **for the whole batch**.
- **Performance / cost.** 50 names ≤1 min; within SURBL's free-use terms (§9 Q6).
- **Acceptance tests.**
  1. Given the SURBL test entry, then listed.
  2. Given `pittsburghroofpros.com`, `ragsecurityaudit.com`, `boisesolarco.com`, then not listed, PASS, `control_ok` = true.
  3. Given the lookup service is unreachable (simulated), then every name = UNKNOWN `CONTROL_FAILED`, never PASS.

### CAP-06 Web Risk / Safe Browsing — **P1**
- **Purpose.** Never buy a name Google flags as unsafe (WEB-RISK-1).
- **Seen in practice.** Google Transparency Report status read by hand for every name; never-used names return status 6 ("no data"); many calls hit HTTP 429 after ~10 requests. DR-003 carried `tampapoolsco.com` forward as "unverified" after a 429.
- **Input.** Names (+ the CAP-07 HIST-1 result).
- **Output.** `source ∈ {web_risk_api, transparency_report_interim}`, `raw_status` (as returned), `threat_types[]`, `hist1_clean` (bool), status.
- **Business rules (v9.1 C16).**
  - **With an API key:** Lookup no-match → PASS; any match → FAIL.
  - **Interim (no key):** PASS iff raw status ∈ {1 "no unsafe content", 6 "no data"} **and** HIST-1 is clean. Any unsafe status → FAIL. Record the raw status.
  - This is the one place where "no data" can pass, and **only** together with clean history. An error or rate limit is UNKNOWN, never "no data".
- **Performance / cost.** Interim source: throttle to *Setting* `webrisk.interim_min_seconds_between_calls` (default 5) → a batch of 50 takes ~4–5 min. API: Google lists the Lookup API as free up to 100,000 calls/month (checked 2026-10-06), but it needs a Google Cloud project/key — Dvir's decision (§9 Q5).
- **Acceptance tests.**
  1. Given `boisesolarco.com` (status 6, no captures), then PASS (interim).
  2. Given `tampapoolsco.com` with HTTP 429, then UNKNOWN `RATE_LIMITED`; it does not count as passing at Gate A.
  3. Given `tulsaroofingco.com` (status 1) while HIST-1 is not final, then UNKNOWN until HIST-1 is decided.
  4. Given an unsafe status (fixture), then FAIL.
  5. With a key, given a no-match response, then PASS (SEL9-14).

### CAP-07 Domain history (HIST-1) — **P1**
- **Purpose.** Never buy a name that used to host or redirect to a business (reputation/UDRP risk). It was the single most useful kill in both runs (DR-002, DR-003: "do not relax HIST-1").
- **Seen in practice.** Archive captures listed by hand, then the content of suspicious captures opened by hand. In DR-002, 13 of 18 archive calls timed out at 12 s; one-at-a-time calls with longer waits worked. `greensborohvacpros.com` timed out on the first try; the retry found a 2018 redirect. D-001 has a capture taken **after our own purchase** (GoDaddy default page), which a naive check reads as prior use. DR-003 passed `tulsaroofingco.com` as "parked, ambiguous" without opening its 2017–2018 HTML captures — not allowed (HIST-1: incomplete cannot pass).
- **Input.** Names; for names we own, our registration date (DOM knows it).
- **Output.** `captures_n`, first/last capture dates, `classification ∈ {no_captures, parked_only, business_content, redirect_to_other_site, own_post_purchase_only, mixed}`, per decisive capture: date, original status, target of any redirect, page title, short text excerpt, archive URL; `cert_history` (certificate-transparency first-seen date, supporting only); `complete` (bool); status.
- **Business rules.**
  - HIST-1: business content **or** redirect to another site → FAIL. Parked-only (registrar/parking pages, "for sale", "not yet connected") → PASS_WITH_NOTE, score −10. No captures → PASS.
  - Every capture that returned a page or a redirect must have its **content classified** before a verdict. If any decisive capture cannot be fetched or classified → **UNKNOWN (incomplete), which cannot pass Gate A**.
  - Captures dated after our own registration date, for names we own, are **ignored** (V9-08).
  - Parking-page signatures are versioned reference data (shared with CAP-10).
- **UNKNOWN.** A slow or unanswered archive request is **not** evidence of "no history": keep trying within the time budget, then UNKNOWN `TIMEOUT`.
- **Performance / cost.** Batch of 50 within *Setting* `hist.batch_time_budget_min` (target 30 min; DR-003 needed ~17 min for 45 names by hand). Free archive API, polite use (§9 Q7).
- **Evidence.** Archive URLs of every decisive capture + stored snapshots of their content.
- **Acceptance tests.**
  1. Given `pittsburghroofpros.com`, then FAIL `redirect_to_other_site`: 2018-08-07 capture 302 → `thetrocheckgroup.com/residential-roofing` (a roofing company); the 2022 NameSilo parking page is listed but does not rescue it.
  2. Given `sacramentoepoxypros.com`, then PASS_WITH_NOTE parked_only (2025 IONOS "not yet connected"), score −10.
  3. Given `memphisplumbingpros.com`, then PASS no_captures.
  4. Given `orlandokitchenpros.com`, then FAIL (2025-07-13 302 redirect, later HTML pages).
  5. Given `greensborohvacpros.com` with the first archive call timing out, then the service retries before deciding and the result is FAIL (2018 301 redirect) — never "no captures".
  6. Given `greensbororoofpros.com` (2013 HTML capture), then the capture content is classified and the result is PASS_WITH_NOTE / FAIL / UNKNOWN — never left as "needs content check".
  7. Given `tulsaroofingco.com` (HTML captures 2017-11 to 2018-03+), then each decisive capture is classified; "parked, ambiguous" is not a possible output.
  8. Given `promptinjectionaudit.com` (ours, registered 2026-10-04 13:16Z), then the 2026-10-04 18:21Z capture is ignored and the result is PASS no prior use.

### CAP-08 US trademark search (TM-1, USPTO) — **P1**
- **Purpose.** Do not buy names that hit live US trademarks.
- **Seen in practice.** USPTO wordmark search on exact phrase and sub-phrases, plus the control query "VSME" that must return >0. Reliable and cheap (DR-002 "things that worked"); it killed `epoxyfloorcrm.com` and both `aireceptionist*` names in DR-003. Phrases were built from bad token splits (CAP-01).
- **Input.** Names (tokens from CAP-01); optional extra phrases from Gavriel.
- **Output.** `phrases_queried[]` (exact phrase; city+trade or distinctive core; generic head pairs), per phrase: total records, live records (mark, serial, status, owner, classes); `control_ok`; status and reason.
- **Business rules / settings.**
  - Live mark on the exact phrase, or on the distinctive core phrase of the name (e.g. "AI RECEPTIONIST", "EPOXY FLOOR") → FAIL.
  - Live marks only on a generic sub-phrase (e.g. "ROOF PROS") → FLAG for bot judgment with the hits listed.
  - Dead marks are listed, not counted.
  - Control query returns 0 → UNKNOWN `CONTROL_FAILED` ("search broken"), never clear.
  - Not legal advice; Shomer still decides FLAGs.
- **Performance.** 50 names ≤5 min, within USPTO's rate limits and terms (§9 Q3).
- **Acceptance tests.**
  1. Given `epoxyfloorcrm.com`, then FAIL: EPOXY FLOOR, serial 99733154, Fusion Epoxy, Inc., "published for opposition".
  2. Given `aireceptionistplumbing.com` and `aireceptionistroofing.com`, then FAIL: AI RECEPTIONIST, serial 99685244, Nextiva, Inc.
  3. Given `tulsaroofingco.com`, then the phrases include "TULSA ROOFING CO" and "TULSA ROOFING" (not "ROOF ING"), result PASS with control OK.
  4. Given `promptinjectionaudit.com`, then 0 records, PASS, control OK (matches D-001 evidence).
  5. Given the control query returns 0 (simulated), then UNKNOWN `CONTROL_FAILED`.
  6. Given `pittsburghroofpros.com`, then exact phrase 0 hits; generic "ROOF PROS" has live marks → FLAG with the list.

### CAP-09 EU / international trademark search (TM-1 EU) — **P1 (record manual result) / P2 (automated)**
- **Purpose.** EU marks matter for S6 regulation names and EU leads.
- **Seen in practice.** EUIPO/WIPO/UK IPO/TMview web UIs block bots, so these checks were **not run** in either DR; D-001's manual searches have been outstanding since 2026-10-03 (V9-22).
- **P1 (manual record).** The screening pack (CAP-19) has a required field `eu_tm_manual`: who searched, when, register URLs, result (`clear` / `hits` + list). Required for S6 and for any name with EU leads (*Setting* `eu_tm.required_lanes` = [S6]). Missing → MANUAL_REQUIRED and the pack is incomplete.
- **P2 (automated).** EUIPO offers an official trademark-search API, which EUIPO says is free but needs an account and app registration (checked 2026-10-06; that is a credential → Dvir decides, §9 Q4). Same output and rules as CAP-08, including a control query.
- **Acceptance tests.** Given S6 `aiactconformity.com` with no manual EU record, then pack status incomplete and buy refused. Given a recorded "clear" with URLs and timestamp, then PASS. (P2) Given a known live EU mark (control), then ≥1 record.

### CAP-10 Sibling census / similar names in use (DEMAND-1 part 1) — **P1**
- **Purpose.** Prove that businesses actually use names built the same way (demand proof for non-geo names).
- **Seen in practice.** DR-002: the bot **wrote its own sibling lists** (SEL8-1 violation); the answer depended on word order; "in use" had no definition. DR-003 froze 7 pattern lists before scoring; every non-geo pattern failed (in_use 0.00–0.15).
- **Input.** `pattern_id@version` (from the frozen list store) or a name + its pattern id. Lists are uploaded once by Gavriel, approved, then **frozen**; a changed list = a new version. **Ad-hoc lists from bots are refused** (SEL8-1, SEL9-11). 20 siblings per pattern, both word orders where natural.
- **Output.** Per sibling: `registered`, `state ∈ {unregistered, registered_no_site, parked_or_for_sale, redirect_off_domain, in_use, unknown}`, final URL, visible-text length, evidence. Per pattern: `registered_share`, `in_use_share`, `forsale_share`, `unknown_n`, `pattern_id@version`, DEMAND-1 part-1 status.
- **Business rules / settings.**
  - `in_use` = page loads successfully **and** final host is the sibling itself (no off-domain redirect) **and** not matching the parking/for-sale signature list **and** ≥ *Setting* `census.in_use_min_visible_chars` (200) characters of visible text (C19, SEL9-12).
  - DEMAND-1 needs `in_use_share` ≥ *Setting* `demand.in_use_share_min` (0.25).
  - `registered_share` and `forsale_share` are logged as features; `registered_share ≥ 0.6` is shadow-tested as an alternative bar (V9-04) — **not** a gate.
  - Unknown siblings count in the denominator but not as in_use; if unknown siblings > *Setting* `census.max_unknown_share` (0.2) → UNKNOWN.
  - A census result is reusable for *Setting* `census.cache_days` (30).
- **Performance.** One pattern (20 siblings) ≤3 min; cached per pattern.
- **Acceptance tests.**
  1. Given `s6_regime_audit@v1` (DR-003), then registered 0.20 / in_use 0.00 → FAIL.
  2. Given `s4_voiceagent_trade@v1`, then 0.15 / 0.15 → FAIL.
  3. Given DR-002's AI-security `*audit` list (after Gavriel freezes it), then registered ≈0.65, for-sale ≈0.35, in_use ≈0.10 → FAIL.
  4. Given DR-002's regime+compliance list, then in_use ≈0.30 → PASS.
  5. Given a bot sends its own list of 20 stems, then refused.
  6. Given a sibling showing a parking page, then not in_use; given a sibling that redirects to another domain, then not in_use (SEL9-12).
  7. Live drift of ±1 sibling vs the DR numbers is acceptable if explained by evidence.

### CAP-11 NameBio keyword sales counts (cache) — **P1**
- **Purpose.** Free public sales counts for a keyword at the start/end of sold names. Used for DEMAND-1 part 2 (non-geo: end or start count ≥1), geo D-Liquidity (trade-term count bands) and the LANDER-1 exception (retail end count ≥20).
- **Seen in practice.** NameBio's CSV download returned 429 "Maximum 1 download per hour" and no copy was kept, so every agent re-downloads; bots fell back to the spot API at 15 s spacing (DR-002 V9-07, DR-003 DR3-06).
- **Input.** `keywords[]` (1–50); optional `position ∈ {start, end, exact}`.
- **Output.** Per keyword: `start_count`, `end_count`, `exact_count` (+ avg/max price where the source gives them), `cache_date` (`data_as_of`), `source ∈ {nightly_csv, spot_api}`, attribution text "Data from NameBio".
- **Business rules / settings.**
  - Served from a **nightly copy** of the free CSVs (retail stats + TLD stats), kept forever by date (C20). `cache_date` ≤ *Setting* `namebio.max_cache_age_hours` (48) else UNKNOWN `STALE_DATA` (SEL9-4).
  - Spot API only for misses, ≤4 calls/min, server-side. **No bot or agent ever calls the NameBio download URL or website** (SEL9-13). Attribution shown on every card that uses the numbers.
  - Geo D raw: start+end ≥30 → 9; 10–29 → 6; <10 → 2 (*Settings*, C9). Non-geo D: max 10% of score from retail stats alone (v9.1 §2.2).
- **Performance.** 50 keywords ≤5 s from cache.
- **Acceptance tests.**
  1. Given "roofing", then end 73 / start 22 (DR-003 spot values; nightly copy may differ slightly, with `cache_date` shown) → geo D raw 9.
  2. Given "epoxy", then end 1 / start 1 → D raw 2.
  3. Given "hvac", then 3 + 8 = 11 → D raw 6.
  4. Given "audit", then end 20 → LANDER-1 exception's retail half met.
  5. Given the cache is 3 days old, then UNKNOWN `STALE_DATA`.
  6. Over a 7-day run, outbound logs show 0 bot/agent calls to NameBio download pages and ≤4 spot calls in any minute.

### CAP-12 Extensions taken & same name on other extensions — **P1 (registration + same-name operator) / P2 (business-use classification)**
- **Purpose.** (a) *F ExtTaken* score feature and the logged `tlds_taken_n`; (b) the **same-name-on-other-extension** check that feeds D1 prospects (`exact_sld_other_tld`, `prefix_suffix_variant`) **and** TN-1/never_pitch (a business trading under our exact name is a legal risk and a possible buyer).
- **Seen in practice.** DR-002 checked .net/.org/.io/.co/.ai/.info/.biz/.us/.app and get-/-app/-hq `.com` variants for 10 names by hand; all free or non-resolving, so D1 added 0 leads. `.co`/`.io` registries answered "no lookup service available", so the bot fell back to a DNS lookup that cannot prove a name is free.
- **Input.** Names; *Setting* `ext.list` (default: net, org, co, io, ai, info, biz, us, app); *Setting* `ext.variants` (default: get{sld}.com, {sld}app.com, {sld}hq.com).
- **Output.** Per extension/variant: `registered ∈ {yes, no, unknown}`, `site_state` (same states as CAP-10), `business_use` (P2: business name or service description on its own site, with URL); `tlds_taken_n`; `exact_sld_other_tld_active` (bool or null); `same_name_operators[]` (URL + how the name is used: `business_name` / `service_description` / `product_name`).
- **Business rules.** `tlds_taken_n` is logged, **not a gate** (v9.1 §2.2 F). Operators found here go to CAP-15 as prospects only under the D1 limits (CAP-15 rule 7); operators trading under our exact name also go to the TN-1 bot-judgment FLAG. An extension whose registry offers no lookup service → `unknown`, never "free".
- **Performance.** 50 names ≤5 min.
- **Acceptance tests.**
  1. Given the 10 DR-002 names (e.g. `ragsecurityaudit.com`, `doraictcompliance.com`), then .net and get/app/hq variants not registered, `exact_sld_other_tld_active` = false, and `.co`/`.io` = unknown (not "free") if the registry gives no answer.
  2. Given `promptinjectionaudit.com`, then related registered names promptinjection.com, promptinjectiontest.com, promptinjectiontesting.com, promptinjectionprevention.com are listed as competing stock (feature `competing_forsale_n`).

### CAP-13 Geo market size — **P2**
- **Purpose.** Before names are invented, show which city × trade markets have enough small firms with weaker domains; feeds the strong/weak geo grade (pending D2/V9-16) and the score.
- **Seen in practice.** DR-003 scanned 35 markets by hand (e.g. Tulsa roofing 4,631 directory results); DR-002 counted firms ≤30 miles by hand.
- **Input.** `city`, `state`, `trade` (1–50 pairs).
- **Output.** `firms_within_radius_n`, `weaker_domain_share`, `trade_retail_count` (from CAP-11), `source`, `data_as_of`.
- **Rules / settings.** Radius *Setting* `geo.radius_miles` (30). Sources must be compliant (§9 Q1).
- **Acceptance.** Given Tulsa OK roofing, then firms_within_radius_n ≥ 40 and trade_retail_count = 95 (±cache drift).

---

## 6. Capabilities — leads (G10)

### CAP-14 Lead discovery — **P1**
- **Purpose.** Find businesses that could buy the name: firms selling the exact service with a weaker domain (LEAD-1, v9.1 §1.2).
- **Seen in practice.** Geo: BBB search queried for city × trade (up to 5 pages / 50 firms for a "deep" crawl), firms ≤30 miles kept, BBB profiles opened for website and owner names, firm site searched for emails. Non-geo: 1–3 web searches per name by the bot, then the script checked seller pages. Lead discovery was the biggest token cost (~35k for non-geo in DR-002). Problems: the BBB search is not a published API and BBB's robots.txt disallows search URLs (§9 Q1); results included out-of-area firms (DaBella, Hillsboro OR, in a Tulsa list) and general contractors/painters under "roofing"/"epoxy" (V9-17).
- **Input.** Geo: domain, `city`, `state`, `trade`, `depth ∈ {shallow, deep}`. Non-geo: domain, `service_phrases[]` (e.g. "prompt injection"), optional `candidate_seller_urls[]` supplied by bots (P1 fallback until §9 Q2 is solved).
- **Output (draft lead rows; one per firm).** Firm name, firm website/host, directory profile URL (if any), distance miles (geo), `service_evidence_url` + matched phrase (rule 1), category, `weaker_domain_reason ∈ {hyphen, long_sld, non_com, free_subdomain, no_site}` or `none` (strong domain → not a lead), `their_sld_len`, `prospect_type ∈ {similar_name_weaker_domain, generic_same_service, exact_sld_other_tld, prefix_suffix_variant}`, `lead_priority` (1–5 per v9.1 §1.2), `discovered_at`, sources.
- **Business rules / settings.**
  - Rule 1: the firm's **own site text** shows the exact service (trade or service phrase); firms with no site rely on directory category only and are flagged `rule1_directory_only`.
  - Radius *Setting* `geo.radius_miles` (30). Shallow = *Setting* `leads.shallow_firms` (25); deep = *Setting* `leads.deep_firms` (50).
  - Directory hosts (e.g. bbb.org, m.bbb.org) count as `no_site`. Social-only firms (Facebook/Instagram/Yelp page only) are **not qualified** (rule 2; SEL8-3) — whether social-only should equal `no_site` is pending (§10).
  - `long_sld` definition is a *Setting*; default today: SLD ≥16 characters (as in DR scripts); DR-002 proposal "their SLD ≥ ours + 3, or contains digits/phone digits" pending (§10).
  - Out-of-business firms excluded; a firm whose address is outside the radius is excluded even if the directory lists it.
- **UNKNOWN.** Source unavailable → lead build UNKNOWN; LEAD-1 cannot pass. Never return "0 leads" for a failed search.
- **Performance / cost.** Geo shallow ≤5 min per name; deep ≤12 min per name; non-geo verification of ≤20 supplied URLs ≤5 min. Free, compliant sources only; polite pacing per source terms.
- **Acceptance tests.**
  1. Given `tulsaroofingco.com`, deep, then ≥20 firm rows, each with a service evidence URL; DaBella (Hillsboro, OR) is excluded as out of area; no general-contractor-only firm counts without roofing on its own site.
  2. Given a firm whose only web presence is a Facebook page, then not qualified (SEL8-3).
  3. Given a firm listing `m.bbb.org` as website, then `no_site`.
  4. Given `promptinjectionaudit.com` with DR-002's 14 seller URLs, then Velora Consulting is not a lead (page lacks "prompt injection" — rule 1), CodeIT and Adversary Insights have no published email (not qualified), and the 8 batch-1 firms with strong brandable `.com`s are `none` (not leads).
  5. Given the directory source returns an error, then LEAD-1 = UNKNOWN, not "0 qualified".

### CAP-15 Lead verification and tiering — **P1**
- **Purpose.** Turn draft rows into qualified, tiered leads with evidence, so only A/B leads count toward the gate (v9.1 §1.2, C14, C15).
- **Seen in practice.** Regex tiering produced errors: junk addresses (`jane@test.com`, truncated duplicates `nfo@…`/`ebbie@…`, a state regulator's inbox `ccb.info@state.or.us` from a BBB page); business gmail addresses counted as owner inboxes (V9-24). "B?" (named inbox, unknown role) was common but could not be counted (Tulsa: 11). Size proof for the ≤10-person rule was rare in free HTML (DR3-03). All non-geo inboxes in DR-002 were role inboxes → 0 A/B before C15.
- **Input.** Draft lead rows (CAP-14) or a lead list uploaded by Gavriel; never_pitch list (stored by DOM, maintained by Gavriel/Shomer).
- **Output (per lead).** `email`, `email_source_url`, `email_belongs_to_firm` (bool), `inbox_type ∈ {personal_named, role_small_firm, role_large_firm, role_size_unknown}`, `named_person`, `named_role`, `role_evidence_url`, `firm_size` (number or band), `size_evidence_url`, `size_le_10 ∈ {true, false, unknown}`, `lead_tier ∈ {A, B, C, B_unverified}`, `tier_reason`, `never_pitch` (bool + reason), `enterprise_flag` (funded/enterprise/franchise of a national brand → bot judgment), `d1_eligible` (bool + reasons), `verified_at`, status.
- **Business rules / settings.**
  1. **Email validity:** kept only if it appears on the firm's own site or its own directory profile, belongs to the firm's domain (or is a free-mail address on a page that names the firm), and is not a placeholder (test/example/yourname) or a third-party/regulator address. Truncated duplicates removed.
  2. **Tier A:** named owner/founder/GM shown on the firm's own site or an official record **and** an inbox personal to them. (Proposed DR-002 refinement — or a role inbox at a firm with ≤5 people — pending, §10.)
  3. **Tier B:** named marketing/ops person, **or** a role inbox (`info@`, `contact@`, `hello@`, similar) at a firm with **≤10 people**, with size shown on the firm's team/about page or an official record and the URL recorded (C15). *Setting* `tier.role_inbox_small_firm_max` (10). *Setting* `tier.rule_review_after_sends` (60): after 60 outreach emails the API raises a "re-check C15" flag.
  4. **Tier C:** role inbox at a larger firm or of unknown size.
  5. `B_unverified` is **not counted**; DOM resolves it to A/B/C where evidence exists and lists the rest for bot review. A bot upgrade must cite a URL and is stored as `bot_verified`.
  6. **Only A/B count toward gate minima** (SEL4-3).
  7. **D1 (C14):** `exact_sld_other_tld` / `prefix_suffix_variant` count only if all hold: SLD plainly descriptive (tokens are geo+trade or a generic 2-word term; FLAG for bot confirmation); ≥ *Setting* `d1.min_unrelated_users` (3) unrelated businesses use the term as their **business name or service description** on their own site, URLs recorded — product-name use does not count (`exact_phrase_product_name`); TM-1 clean; price shown = standard BIN.
  8. **never_pitch** match (address, firm domain, or a firm whose name/mark matches our SLD tokens) → excluded.
  9. Size evidence must not come from automated LinkedIn access; a LinkedIn URL may be recorded by a human only.
- **UNKNOWN.** Firm site cannot be fetched → that lead is `unverified` (not C, not A/B).
- **Performance.** 50 leads ≤5 min.
- **Acceptance tests.**
  1. Given the Tulsa deep list, then `jane@test.com`, `nfo@tailoredremodeling.com`, `ebbie@americancentralcorp.com` and `ccb.info@state.or.us` are removed.
  2. Given Rembrandt Roofing `hello@therembrandtgroup.com` with a team page showing ~6 people, then tier B `role_small_firm` with the size URL recorded.
  3. Given Shelter OK Roofing `info@shelterokroofing.com` with no size evidence, then tier C `role_size_unknown`.
  4. Given Mighty Dog Roofing (a franchise of a national brand), then `enterprise_flag` = true and it goes to bot judgment before it can count.
  5. Given `info@` at a firm documented ≤10 people → B; same inbox at >10 → C; after 60 outreach sends the rule-review flag is raised (SEL10-1).
  6. Given CodeWheel (`matt@codewheel.ai`) on never_pitch, then excluded.
  7. Given three product-name-only URLs for "Prompt Injection Audit" (CodeWheel, AuditBuffet, Quantum Bases), then D1 count = 0 (SEL9-15).
  8. Given a Facebook-only firm, then not qualified (SEL8-3).

### CAP-16 Lead gate and capacity (LEAD-1, CAPACITY-1) — **P1**
- **Purpose.** Decide LEAD-1 and CAPACITY-1 from verified leads and hand `leads_AB` to scoring.
- **Output.** Counts: qualified, A, B, C, B_unverified; `weaker_enum_share`; `never_pitch_share`; `oldest_verified_at`; `prospect_type_counts`; `weeks_to_cover`; LEAD-1 / CAPACITY-1 status with the binding reason.
- **Rules / settings.** LEAD-1 geo: ≥20 qualified and ≥8 A/B; non-geo: ≥10 qualified and ≥5 A/B; weaker-domain enum on ≥80% of leads; `verified_at` ≤14 days; never_pitch share <30%. CAPACITY-1: `weeks_to_cover` ≤ min(12, weeks to 2027-04-03); total pledged leads ≤ 20 × weeks left. E1 cap ≤20/week, ≤10 per deal (v9.1 §1.3). All *Settings*. Cross-deal reuse of the same firm (V9-21) is pending (§10); until then the API reports `lead_reused_in[]` without blocking.
- **Acceptance tests.**
  1. Given `tulsaroofingco.com` deep (21 rows: A 1, B 5, B? 11, C 4), then FAIL "6 A/B < 8; qualified < 20", and EV is computed with n = 6.
  2. Given `memphisplumbingpros.com` (6 qualified, 1 A), then FAIL.
  3. Given D-001 under C15 with 9 small-firm role inboxes proven ≤10 people, then 9 B and LEAD-1 still FAILs (9 < 10 qualified).
  4. Given leads verified 15 days ago, then FAIL `STALE_DATA`.

---

## 7. Capabilities — money, pack, orchestration (G11–G13)

### CAP-17 Price and renewal quote — **P1 (new names) / P2 (owned names: renewal at current registrar + transfer option)**
- **Purpose.** Feed live costs into EV and Ratio. ARA = live renewal price, not a fixed $11.08 (C17).
- **Seen in practice.** Porkbun pricing API returned HTTP 403 from the box, so $11.08 was taken from the public page (Porkbun KB expects ~$11.81 from 2026-11-01). D-001's GoDaddy renewal (~$22.99 + $0.20, UNVERIFIED for Dvir's account) changes its Ratio from 0.46 to 0.22.
- **Input.** Names; for owned names, domain only (DOM knows registrar and dates).
- **Output.** New name: cheapest eligible registrar, `first_year`, `renewal`, `two_year` (existing check), `registrar_ft_capable` (Afternic Fast Transfer), `quoted_at`. Owned name (P2): `renewal_at_current_registrar` + source + `quoted_at`, `transfer_option` (cheapest Fast-Transfer-capable registrar, price incl. 1 year), `transfer_window` (creation + 60 days to expiry − 31 days), `ft_eligible_date`.
- **Rules.** Quotes older than *Setting* `quote.max_age_hours` (24) cannot feed a buy card. Missing renewal price → UNKNOWN, never 0 (existing rule CK-7). If the current registrar cannot be quoted by machine (e.g. GoDaddy accounts with <50 domains are management-only), a Dvir-entered value with timestamp is accepted for ≤ *Setting* `quote.manual_max_age_days` (30) (§9 Q9).
- **Acceptance tests.** Given a random unregistered `.com`, then Porkbun first year and renewal match the public price on the day ($11.08 on 2026-10-06) and `registrar_ft_capable` = true (manual opt-in noted). (P2) Given `promptinjectionaudit.com`, then GoDaddy renewal is returned with source and time, or UNKNOWN; the transfer option is not allowed before 2026-12-03.

### CAP-18 Scoring, expected profit, Ratio and price checks — **P1**
- **Purpose.** All money arithmetic and the 0–100 tiebreak score, exactly as v9.1 §2, so bots never compute it by hand.
- **Seen in practice.** EV/Ratio computed by hand in DR-002 (`ev-ratio-calc.txt`); reproduced SEL9-1 to ±0.01.
- **Input.** Domain + lane + `leads_AB` (CAP-16) + BIN candidate + quote (CAP-17) + all features (features_v1). DOM collects these from earlier gates; the caller only names the domain and the proposed BIN.
- **Output.** `p_passive`, `p_lead`, `n`, `P_sale`, `net_price`, `lifetime_cost`, `EV`, `STRe_eff_y1`, `ratio_at_bin`, `ratio_at_floor`, `floor`, `bin_in_allowed_set`, forbidden-band check, LANDER-1 exception check, `score_0_100` with per-factor raw values and weights, `data_coverage`, pass booleans for EV-1, RATIO-1, LANDER-1, coverage, `model_version`.
- **Business rules / settings (all *Settings*, v9.1 defaults).**
  - `P_sale = 1 − (1 − p_passive)^2 × (1 − p_lead)^n`; `EV = P_sale × BIN × 0.85 − (first_year + renewal)` > 0 at **low** priors, BIN not floor.
  - `STRe_eff_y1 = 1 − (1 − p_passive)(1 − p_lead)^n`; `renew_ratio(price) = price × 0.85 × STRe_eff_y1 / ARA` ≥ 1 at BIN **and** at floor.
  - Priors: S2 0.005 / 0.005; S3/S4 0.004 / 0.002; S6 0.005 / 0.003; S7 = matched pattern. Net factor 0.85 (Afternic with Afternic nameservers; 0.75 otherwise).
  - Allowed BIN set {299, 399, 499, 788, 1088, 1488, 1988, 2488}; forbidden $800–$999, $1,950–$1,999, ×95/×99 endings for non-geo. Floor 65% of BIN, ≥$750 non-geo; geo floor $299. LANDER-1: BIN ≤1,488 or exception (≥30 A/B and retail end ≥20).
  - Score: lane weights per v9.1 §2.2; UNKNOWN feature = 0 points; `data_coverage` ≥0.70 or fail; parked-only −10; the score only sorts the digest and never decides a buy.
  - Forbidden features: any $-appraisal (GoValue, Estibot, HumbleWorth, etc.) → request refused (SEL5-2). Single P_sale only; no additive EV fields (SEL8-4).
- **Acceptance tests (SEL9-1 fixtures, ±0.02, ARA $11.08 / lifetime $22.16).**
  1. Geo, 8 A/B, $499 / floor $299 → Ratio 1.69 / 1.01 pass, EV −1.4 FAIL.
  2. Geo, 10 A/B, $499 → EV +2.6, Ratio 2.05 / 1.23, all pass.
  3. Geo, 0 leads → Ratio FAIL.
  4. S3/S4, 5 A/B, $1,488 / $967 → 1.59 / 1.03, EV +0.4 pass; 4 A/B → EV FAIL.
  5. D-001 at $1,995 → LANDER-1 FAIL (forbidden band); at $1,488 → floor $967, EV −12.06, Ratio 0.46 / 0.30 (0 A/B).
  6. D-001 with ARA $23.19 (GoDaddy) → Ratio 0.22 at $1,488 (SEL9-10).
  7. `memphisplumbingpros.com`, 1 A, $399 → EV −17.10, Ratio 0.31 / 0.23.
  8. Each lane's weights sum to 100 (SEL3-1); a $-appraisal feature is rejected (SEL5-2).

### CAP-19 Screening pack (SCREEN-1) — **P1**
- **Purpose.** One frozen, complete evidence record per finalist — our legal artifact for "what we checked before buying". The existing buy action must refuse without it (SEL7-1).
- **Seen in practice.** Assembled by hand; D-001's pack is still incomplete (EUIPO/WIPO, Web Risk, Tranco open).
- **Input.** Domain (+ the bot judgment record: van test, TN-1/BIGCO verdicts, 3-lead spot check, one-line reason not to buy, FLAG resolutions; + manual EU trademark record).
- **Output.** Pack id, status `complete`/`incomplete` (+ missing items), one block per gate (US trademark: queried_at, control_ok, hits; EU manual record; typo screen; brand/big-co; history/SURBL/Web Risk; same-name-other-extension and directory notes (common-law notes); census `pattern_id@version`; NameBio counts + `cache_date` + attribution; leads summary; quote; EV/Ratio; `registrar_ft_capable`; `bin_in_allowed_set`), settings version, `screened_at`, screener identity, every evidence link.
- **Rules.** Complete only if every gate is PASS / PASS_WITH_NOTE or FLAG-with-bot-verdict; no UNKNOWN, no MANUAL_REQUIRED; availability and quote ≤24 h old at pack time. Frozen once issued; a change makes a new pack version.
- **Acceptance tests.** Given `pittsburghroofpros.com`, then the pack cannot be completed (HIST-1 FAIL). Given a name with Web Risk UNKNOWN, then incomplete. Given a buy request without a complete pack, then refused (SEL7-1).

### CAP-20 Full screening run (orchestration + funnel report) — **P1**
- **Purpose.** One call screens a batch in the §4 order and returns per-name results plus a funnel summary like DR-003's `funnel.md`, so Gavriel reads only survivors and FLAGs.
- **Input.** `names[]` (1–50) with lane and geo attributes; mode (`live` / `full`); optional gate subset; optional rank order.
- **Output.** Per name: every gate result (§3.2), first failing gate, final status `survivor` / `rejected` / `unknown`. Batch: stage counts per lane, first-fail counts per gate, survivors list, FLAG list for bot judgment, cost (upstream calls, duration per gate), job status/progress.
- **Rules.** `live`: stop a name at its first FAIL or UNKNOWN (an UNKNOWN can be re-queued once automatically after *Setting* `run.unknown_retry_minutes` (30)). `full`: run everything even after a fail. Survivors = all gates PASS / PASS_WITH_NOTE or FLAG awaiting judgment.
- **Performance targets (DOM to confirm, §9 Q10).** A 50-name `live` batch reaches "all names past G9 or stopped" in ≤30 min; lead gates run only for survivors (≤5 deep crawls per batch) with the batch finished in ≤60 min total. $0 data cost. Bot tokens for a batch fall back within v9.1's 35k scout budget.
- **Acceptance tests.**
  1. Given DR-003's 45 available names replayed with recorded source data in `live` mode, then first-fail counts match DR-003 (HIST-1 3, TM-1 3, CONCENTRATION-1 4, LEAD-1 20, DEMAND-1 15), with any difference explained name by name — expected: `tulsaroofingco.com` becomes UNKNOWN/FAIL at HIST-1 until its captures are classified, and the "no lead crawl this round (budget)" names now get a real LEAD-1 result.
  2. Given DR-002's 9 advanced names in `full` mode, then every gate is reported for every name, matching DR-002's cards table (e.g. `pittsburghroofpros.com` HIST-1 FAIL but leads still built).
  3. Given RDAP-before-history order on a 30-name fixture, then 100% ordered (SEL-1).

---

## 8. Capabilities — backtest and after the buy (P2)

### CAP-21 Backtest / as-of-date mode — **P2**
- **Purpose.** Recalibrate thresholds on sold names vs controls (BT-001: sold names score better than controls; ≤30% of controls pass proxy Gate A) without leaking future data.
- **Seen in practice.** `research/backtest-sold/` (in progress): sales parsed from DomainNameWire and DNJournal (2022+, `.com`, $300–$10k, 2–3 words) → 2,617 candidates; word split and type classification; RDAP creation dates (2,615 registered, 2 free).
- **Input.** A name list (CSV upload by Gavriel: domain, sale date, price, venue, source URL, label `sold`/`control`), `as_of` date per name, a draft settings version, mode `full`.
- **Output.** Same results as CAP-20, each check tagged `as_of_supported ∈ {exact, approximate, not_possible}`; aggregate report (pass rates per gate, sold vs control, per settings version).
- **Rules.** Checks that cannot be evaluated as of a past date (e.g. census of today's sites, today's NameBio counts) are marked `not_possible`/`approximate` and never silently use today's data. Results are labelled backtest and never feed buy cards.
- **Performance.** 2,617 names through cheap gates (G0–G7, no leads) ≤24 h.
- **Acceptance tests.** Given a sold name with sale date 2023-05-31, then history only uses captures before that date. Given the census, then it is marked `approximate`/`not_possible`. Given draft settings v1b, live settings are untouched.

### CAP-22 Distribution confirmation tracking (FT-1) — **P2**
- **Purpose.** Track that each bought name is opted in to Afternic Fast Transfer and listed at the same BIN within 7 days of becoming Fast-Transfer-eligible.
- **Seen in practice.** D-001 is at GoDaddy and becomes eligible only after the 60-day lock (~2026-12-03) (V9-09, DR3-09).
- **Input.** Domain, `ft_optin_at`, `afternic_listed_at`, BIN, evidence (pasted by Gavriel/Dvir).
- **Output.** `ft_eligible_date`, `deadline` = eligible date + 7 days, status `on_time` / `late` / `distribution_incomplete`.
- **Acceptance tests.** Given a name bought without confirmation 7 days after eligibility, then flagged and counted in pattern health (SEL9-6). Given D-001, then deadline ~2026-12-10, not buy + 7.

### CAP-23 Renewal decision and legacy review (Gate F) — **P2**
- **Purpose.** RENEW/DROP at most once per name using v9.1 §1.4 formula, live renewal price and the transfer comparison; plus an information-only "legacy review" for names bought before these rules (D-001, V9-13).
- **Output.** RENEW/DROP, Ratio (STRe_renew), option chosen (renew in place vs transfer), reason, decision date (≤ expiry − 31 days).
- **Acceptance tests.** Given D-001 with 0 uncontacted A/B leads and GoDaddy renewal $23.19, then DROP (Ratio 0.22). Given 5 uncontacted A/B at $11.08, then 1.59 → RENEW if the floor rule is satisfied per the pending Gate F wording (§10).

---

## 9. Open questions for DOM

1. **Compliant geo business source.** Both runs used BBB's search JSON. It is not a published API, BBB's robots.txt disallows parameterised search URLs, and BBB's terms forbid compiling its data into a similar service (checked 2026-10-06). Which free source(s) will you use instead or in addition (e.g. official state contractor-licence lookups, other open data)? Please confirm in writing that each source permits automated access, and the expected coverage for a Tulsa-roofing-sized market.
2. **Non-geo seller discovery.** What free, terms-compliant source can find B2B sellers of a service phrase? If none, is accepting bot-supplied seller URLs (verified by you) acceptable as the long-term contract?
3. **USPTO.** Is your proposed search route officially supported (rate limits, terms)? Does it need an API key (a credential → Dvir decides)?
4. **EUIPO API.** EUIPO lists a free trademark-search API that needs an account and app registration. Will you integrate it for P2, and in whose name should the account be (Dvir)? Any official route for WIPO Global Brand Database or UK IPO, or do those stay manual?
5. **Web Risk.** Do you recommend the Lookup API (free tier up to 100k calls/month per Google's pricing page; needs a Cloud project, possibly a billing account)? Is the interim Transparency Report status source acceptable under Google's terms at our volume, and if not, should the interim result be MANUAL_REQUIRED?
6. **SURBL / other DNS blocklists.** Does our volume fit SURBL's free-use policy? Do you need your own resolver (public resolvers refused in DR-001)? Should Spamhaus DBL be added under the same terms?
7. **Web archive throughput.** Given the slow responses seen (13/18 calls timed out at 12 s in DR-002; ~17 min for 45 names in DR-003), can you meet "50 names ≤30 min" for HIST-1 without breaking the archive's usage policy? If not, what can you commit to?
8. **NameBio.** Please confirm the nightly CSV copy fits NameBio's terms (1 download per hour; attribution), and whether as-of-date counts can exist for backtests (or CAP-21 must mark them `not_possible`).
9. **Renewal price for registrars without machine quotes** (e.g. GoDaddy accounts with <50 domains). Do you accept a Dvir-entered price with timestamp and expiry as the contract, or is there a better free route?
10. **Performance targets.** Please confirm or counter-propose the numbers in each capability and CAP-20, and state any hosting cost increase on the current Render plan. Any paid component must be flagged before building.
11. **As-of support per check.** For CAP-21, which checks can you evaluate as of a past date (archive and registry creation: likely yes; trademark status on a past date: partly; census and directory: likely no)?
12. **Evidence storage.** What will storing raw snapshots (archive pages, sibling homepages, lead pages) cost at our volume, and for how long can we keep them? Our draft is life of name + 3 years for carded names, ≥400 days for rejected names (§3.4).
13. **Firm-size evidence (C15).** Which ≤10-person signals can you detect reliably from firms' own sites and official records without LinkedIn automation? What share of DR-003's Tulsa B? leads would that resolve?
14. **Personal data.** Lead rows contain named people's emails (some EU). Where is it stored, can you delete per firm/address on request, and can you mark rows from EU firms?
15. **Word lists.** Which free dictionary and US city gazetteer will CAP-01 use, and how do we add terms (regimes, trades) through the API?
16. **Delivery.** Your sequence for the P1 set. Can a subset (CAP-00, 01, 03, 05, 06, 07, 08, 10, 11, 18, 20) be ready first, so DR-004 runs on the API with bots doing leads by hand for one more round?

## 10. Pending on our side (settings with open defaults — DOM builds them as settings; we fill the values)

| Item | Current default | Owner |
|---|---|---|
| TYPO-1 max edit distance and top-N list size | none yet | Gavriel → Dvir |
| `long_sld` definition (≥16 chars vs ours + 3 / digits) | ≥16 chars | Gavriel → Dvir |
| Tier A refinement (role inbox at ≤5 people = A?) (V9-24 / V9-01) | not adopted | Dvir |
| Social-only = `no_site`, or drop `no_site` (V9-18) | social-only not qualified | Dvir |
| Cross-deal lead reuse cap (V9-21) | report only | Dvir |
| Concentration tie-break inside a batch | Gavriel's submitted order | Gavriel |
| Geo strong/weak grade and BIN (D2 / V9-16) | $499 strong / $399 weaker, grade undefined | Dvir |
| Gate F: which price, and how contacted leads count (V9-12) | BIN + floor, uncontacted A/B only | Dvir |
| Screening-pack retention | life of name + 3 years (draft) | Dvir |
| Web Risk API key | interim rule C16 | Dvir |
| Unknown-token rule in SPELL-1 (V9-15) | proposed FAIL | Dvir |
| v9.1 SEL9-8 says "hvac trade count <10 → D raw 2", but the NameBio count for hvac is 11 (band 10–29 → 6) | follow the bands | Gavriel to correct v9.1 test text |

---

## 11. DOM response (2026-10-06)

**Verdict: accepted with changes.** DOM builds CR-001 in two P1 releases (P1a, P1b, see Q16). Items marked **DVIR** need Dvir's decision; nothing that depends on them is blocked except the capability named.

### 11.1 Pushback

| # | Topic | DOM position |
|---|---|---|
| P-1 | **Scope** | CR-001 roughly doubles the system, and Dvir asked on 6 Oct to keep it small. DOM keeps P1 to what DR-004 needs: deterministic checks over sources DOM can use compliantly. **Lead discovery (CAP-14) is not built.** Bots supply candidate firm and seller URLs; DOM verifies, tiers and gates them (CAP-15, CAP-16). See Q1 and Q2. |
| P-2 | **Undocumented endpoints** | Three sources used in the dry runs are the **internal backends of websites**, not published APIs: BBB search (the CR already found it disallowed), the USPTO search site's backend (`tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch`, used in DR-002) and Google Transparency Report status. Under ground rule 4, **DOM does not automate undocumented website endpoints.** Each becomes an official API (with a credential where one is required, owned by Dvir) or a `MANUAL_REQUIRED` field with a recorded human result. See Q1, Q3 and Q5. |
| P-3 | **Free hosting** | Hosting stays $0. Screening runs as a persisted job in the API service, so every check's state is in the DB. Render free sleeps after about 15 min with no inbound request. Gavriel's progress polling keeps it awake, and a run that was interrupted resumes on the next wake (the hourly tick also resumes stalled runs). |
| P-4 | **Evidence storage** | Neon free is 1 GB, so DOM does **not** store full raw HTML. Each item stores the source URL, retrieval time, sha256 of the full response, and the extracted visible text (gzip, capped per item). Archive evidence is the Wayback capture URL, a permanent public snapshot, plus the classified excerpt. See Q12. |
| P-5 | **Personal data vs append-only** | Lead rows hold named people's emails, some in the EU. Results stay append-only, but personal fields live in a separate erasable table that results reference. Erasure replaces them with a tombstone and keeps the rest of the record. See Q14. |
| P-6 | **Dependencies** | CAP-18 and CAP-19 depend on parts of selection v9.1 that Dvir approved on 6 Oct but that are **not built yet**: `pricing_settings` v3 (price list, step-down drops, geo ladder to $299) and `/buy` refusing without a complete screening pack (SEL7-1). DOM builds both inside CR-001, and the gap is listed in `docs/internal/gaps.md`. Until the CR-001 release, `/buy` keeps today's rules. |
| P-7 | **Live-data acceptance tests** | Tests that cite live facts (trademark serials, capture dates, census shares) are checked by DOM against **recorded responses**. Gavriel re-runs them live, and drift is accepted when the evidence explains it (as the CR already says for the census). |
| P-8 | **Settings writes** | CAP-00 needs an API path to settings. DOM allows **selection settings**: Gavriel proposes a draft (WRITE), and activation requires Dvir's `approval_ref`. `pricing_settings` stays admin-command only (founder rule 4). |
| P-9 | **Gate order** | Accepted as written. |

### 11.2 Answers to §9

1. **Geo business source.** DOM will not use BBB. DOM knows of no free, compliant source with BBB-like coverage of small trade firms.
   - OpenStreetMap (Overpass API, ODbL) is compliant but likely sparse for small roofers. DOM will measure Tulsa roofing coverage before relying on it.
   - State contractor-licence registries differ by state. DOM checks each state's terms when a market is chosen.
   - **Proposed long-term contract:** Gavriel supplies candidate firm URLs found by bot web search, and DOM verifies them mechanically (CAP-15).
   - DOM confirms in writing, per source, that automated access is permitted (quote + URL) in the release note before that source goes live. DOM does not promise coverage numbers until it has measured them.
2. **Non-geo sellers.** Yes, bot-supplied seller URLs verified by DOM is acceptable as the long-term contract. A search API (for example Brave Search or Google Programmable Search) would need a key (**DVIR**). It isn't needed for P1.
3. **USPTO.** The DR-002 route is the search website's internal backend, so DOM will not use it. DOM uses only an officially documented USPTO API; that USPTO terms permit wordmark search is being verified as the first step of CAP-08.
   - If the official API needs a free API key → **DVIR** (account owner).
   - If there is no official wordmark search, CAP-08 becomes `MANUAL_REQUIRED`, with a recorded manual result (same shape as CAP-09 P1) and the control query still required.
4. **EUIPO.** Yes, for P2, with the account in Dvir's name (**DVIR**). WIPO and UK IPO stay manual unless an official API is confirmed at P2.
5. **Web Risk.** DOM recommends the Lookup API with a key. Dvir creates the Google Cloud project (**DVIR**).
   - If Google requires a billing account, Dvir decides whether to accept that risk; DOM would set the quota so usage stays inside the free tier.
   - The Transparency Report status endpoint is internal, so DOM will not automate it. **Until a key exists, WEB-RISK-1 = `MANUAL_REQUIRED`:** Gavriel records the status seen by hand. This changes v9.1 C16's interim automation (**DVIR**).
6. **SURBL / Spamhaus.** Public resolvers refuse these lookups. DOM queries SURBL's authoritative DNS servers directly with its own DNS client, plus a control lookup in every run. DOM verifies that our volume (a few hundred lookups a week) fits SURBL's free-use policy before enabling it. Spamhaus DBL needs a free DQS key for this kind of use → P2, **DVIR**.
7. **Web archive.** Sequential, polite calls: one CDX query per name, then only the decisive captures, with backoff and a retry before any verdict.
   - Commitment: a 50-name batch finishes HIST-1 within the 30-min budget, **or** returns partial results with the rest `UNKNOWN TIMEOUT`, re-queued once automatically.
   - DOM measures on the DR-003 names in the first build and reports the real figure.
8. **NameBio.** One nightly download is within "1 per hour", and attribution is shown. DOM confirms the storage and caching rights in NameBio's terms before enabling it.
   - As-of counts: the CSV is a current snapshot. Counts as of dates **after DOM's first download** come from DOM's own nightly copies (`approximate`); earlier dates are `not_possible`.
9. **Manual renewal price.** Accepted as the contract: a Dvir-entered price with timestamp and source, valid for ≤ `quote.manual_max_age_days` (30).
10. **Performance and cost.** Hosting cost: **$0** (Render free + Neon free). P1 has no paid component. The only possible paid exposure is the Web Risk billing account (Q5). DOM treats the per-capability targets as goals and confirms or counters each one in the P1a release note, from measured runs.
11. **As-of support.**

    | Check | As-of support |
    |---|---|
    | History | `exact`: only captures before the date |
    | Registry creation date | `exact` |
    | Availability on a past date | `approximate`: inferred from creation and expiry dates |
    | Trademarks | `approximate`: filing and status dates allow a partial view |
    | NameBio | `approximate`: from DOM's own copies only |
    | Census, SURBL, Web Risk, leads | `not_possible` |

12. **Evidence storage.** Estimate: about 5 MB per 50-name batch (compressed text plus hashes and URLs).
    - At one batch a week, that is about 260 MB a year. With rejected-name evidence purged after 400 days, this fits Neon's 1 GB for about 2–3 years at $0.
    - If more is needed, older evidence moves to the private data repo. Retention stays Dvir's decision (§10).
13. **Firm size (C15).**
    - **Signals:** the number of named people on team or about pages, owner-operated or family-owned statements, and staff counts stated on the firm's own site. No LinkedIn automation.
    - **Reliability:** medium at best. DOM reports the share of DR-003's Tulsa B? leads it resolves, from the replay, in the P1b note.
14. **Personal data.**
    - **Storage:** Neon EU (Frankfurt region).
    - **Erasure:** a separate erasable table, with delete by firm domain or by address (WRITE, audited; the audit stores a hash, not the address).
    - **EU marking:** an `eu_firm` flag from the country of the firm's ccTLD or address.
15. **Word lists.** English dictionary: SCOWL (permissive licence; checked before use). US cities: US Census Gazetteer (public domain). Trades, regimes, brands and big companies are versioned lists that Gavriel adds to through the API (audited); each result stamps the list versions it used.
16. **Delivery.** Contract v1.0.0 (today's API) ships first.

    | Release | Contract | Contents |
    |---|---|---|
    | **P1a** (for DR-004) | v1.1.0 | CAP-00, 01, 02, 03, 04, 05, 07, 10, 11, 17, 18 (with `pricing_settings` v3) and 20. CAP-06 and CAP-08 ship as `MANUAL_REQUIRED` record fields until Q3/Q5 are settled. Leads stay with the bots for DR-004 |
    | **P1b** | v1.2.0 | CAP-15 and 16 (verify supplied leads), 19 with `/buy` enforcement (SEL7-1), the CAP-09 manual record, CAP-12 |
    | **P2** | later | The rest |

### 11.3 Decisions needed from Dvir (DVIR)
1. **USPTO:** an API key, if the official route needs one (Q3).
2. **Web Risk:** a Google Cloud project (and billing account?) for the key. Until then, accept `MANUAL_REQUIRED` for WEB-RISK-1 (Q5).
3. **P2 credentials:** a Spamhaus DQS key and an EUIPO account.
4. **The §10 items:** they remain open on your side.

---

## Appendix A — Reference scripts (NON-BINDING)

These scripts were written by Gavriel's workers during the practice runs to stand in for missing API functions. They are attached **for reference only**: they contain known shortcuts and errors (bot-written census lists, regex tiering, no control on DR-003 SURBL, tokenization faults, use of a non-published BBB endpoint). **They are not a specification**; DOM is not required to follow their approach, data sources, thresholds or structure. The CR text above governs.

| Path | One-line description |
|---|---|
| `dry-runs/DR-002/scripts/census.py` | Sibling census for 4 patterns: registry lookup per sibling, homepage fetch, parking-text regex + 200-char rule → registered / in_use / for-sale shares (sibling lists were bot-written — a SEL8-1 violation) |
| `dry-runs/DR-002/scripts/geo_leads.py` | Geo lead builder (3 cities): BBB search JSON for city × trade, 30-mile filter, BBB profile → website and owner names, firm-site emails, weaker-domain reason, heuristic tier |
| `dry-runs/DR-002/scripts/nongeo_leads.py` | Non-geo lead verifier: fetches bot-found seller pages, checks the service phrase on the page, extracts own-domain emails, weaker-domain reason, role-inbox = C / named = B? |
| `dry-runs/DR-002/scripts/nongeo_cfg.json` | Input for `nongeo_leads.py`: candidate seller names, URLs and service phrases per domain (from bot web searches) |
| `dry-runs/DR-003/scripts/geo_leads.py` | v9.1 version of the geo lead builder: 13 cities × 7 trades, emails from BBB profiles and firm sites, team-size estimate from page text, role inbox at ≤10 people → B (C15), B? kept separate |
| `research/backtest-sold/scripts/parse_dnw.py` | Parses DomainNameWire weekly sales posts (downloaded post JSON) into a sales CSV (domain, price, currency, date, venue, source URL) |
| `research/backtest-sold/scripts/parse_dnj.py` | Parses saved DNJournal weekly sales-chart pages into the same sales CSV format |
| `research/backtest-sold/scripts/filter.py` | Filters sales to `.com`, no digits/hyphens, $300–$10k (FX-converted), 2022+, 2–3 dictionary words; adds tokens, length and name type → `candidates.csv` |
| `research/backtest-sold/scripts/seg.py` | Word segmentation (word-frequency dictionary + lexicons) and a simple name-type classifier (geo_service, tech_compliance, service_keyword, …) |
| `research/backtest-sold/scripts/lex.py` | Hand-written lexicons frozen 2026-10-06 for the backtest: cities, states, countries, trades, tech terms, generic heads |
| `research/backtest-sold/scripts/rdap.py` | Resumable batch registry lookup: registered/free, creation/expiry/updated dates, registrar; retries on rate limits |
| `dry-runs/DR-002/evidence/d001-uspto.log` (inline code at top) | USPTO wordmark query snippet: exact-phrase queries, live marks in top 25, used with the VSME control |
| `system/tools/pricing_calc.py` (related, outside the DR folders) | Pricing-schedule calculator for pricing settings v2; its −20% drops are **superseded** by v9.1 C18 step-down prices |

`__pycache__` folders are build leftovers and not part of the reference.

## Appendix B — Where the practice-run evidence is

- DR-002: `summary.md`, `cards.md`, `d001-review.md`, `issues.md` (V9-01…V9-25), `cost.md`, raw logs in `evidence/` (e.g. `rdap-round1.json`, `cdx-serial.log`, `wayback-content-check.log`, `uspto-candidates.log`, `census.log`, `ev-ratio-calc.txt`, `leads-*.json`).
- DR-003: `funnel.md`, `cards.md`, `issues.md` (DR3-01…DR3-11), `cost.md`, frozen census lists `census/*@v1.csv` + `README.md`, raw data in `evidence/` (e.g. `hist-surbl-wr.json`, `tm-verdict.json`, `census-run.json`, `leads-deep-tulsaroofingco.com.json`, `namebio-spot.json`, `bbb-market-scan.json`).
- Example results quoted in acceptance tests were true at the time of those runs (2026-10-06 00:05–01:45 IDT). Live sources can drift; DOM may run acceptance tests against recorded copies of those responses plus a small live smoke test.

*End of CR-001.*
