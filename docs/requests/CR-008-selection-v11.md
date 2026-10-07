# CR-008: Picking rule v11 as a selection settings change

**From:** Gavriel (requester, on Dvir's behalf)
**Status:** APPROVED by Dvir 2026-10-07 13:59 IDT (see §15). DOM: accepted with changes (2026-10-07). Released v2.4.0 (`docs/releases/v2.4.0.md`). Next: Gavriel's §17.4 steps 2 to 4, and Dvir on AC-6.
**Date:** 2026-10-07 14:10 IDT
**Contract base:** v2.2.0 (docs at commit `04f54c2`, which holds DOM's reply to CR-007)
**Priority:** P1 for the parts DOM builds in v2.4.0 anyway (the sibling method, §7). The settings draft itself needs no new code except one key (§6, C-1).
**Reference material:** `docs/requests/CR-008-reference/` (Appendix A)

## 0. Words used in this CR
- **Picking rule (selection rule):** the settings that decide whether a name is worth buying (in DOM: the tier clauses and DEMAND-2, `selection.md` §Tier). "v11" is the name of the new rule from Gavriel's research round 15. It is also the settings label proposed here.
- **Screen:** a first filter that says "worth a closer look" or "skip". A screen is not a buy decision.
- **Sibling list (census list):** 20 names built the same way as a candidate by swapping one word (for `achievehire.com`: other first words with `hire`, then `achieve` with other last words). **Registered share** is the share of those 20 that someone already owns. It is the main demand signal.
- **Sibling method `bt1@v1`:** the fixed recipe that built every sibling list in the research: four frozen word pools plus a fixed way to pick and order words (Appendix B). "v1" is its version.
- **Other-extension signal (`alt`):** the same label (the part before `.com`) is registered on `.net`, `.org`, `.biz` or `.ca`, and was registered before the decision date. In DOM this is the feature `alt_tld_before_n`.
- **RDAP:** the official registry lookup for a domain (registered or not, creation date). For `.com` it is Verisign's public service.
- **Sealed test set:** names with known outcomes (sold or dropped) that are frozen before a rule is scored on them, and scored once. Round 15's set is called TEST15.
- **Sold / dropped:** "sold" = a hand-registered `.com` that later sold publicly for $100 or more. "Dropped" = a `.com` whose owner let it expire and that nobody took when it became free again (exactly the names we could register for about $11).
- **95% range (Wilson interval):** the range the true rate very likely sits in, given how many names were tested.
- **As-of date:** the day a decision would have been made. A fair test uses only data dated strictly before it. Using later data is called **leakage**.
- **Buy hold (BUY-HOLD):** the setting `buy_hold: true` that blocks every real purchase. It is on today.

## 1. Business need
Buying is paused until a picking rule passes a fair test. Round 15 (2026-10-07) found a rule that passes the bar on a fresh sealed test, but only just. Today that rule lives only in Gavriel's scripts, so every screen of a real name is a hand job (sibling list written by script, Dvir approves each list, lookups by script, the decision by hand).

Dvir's standing rule (CR-007 §1) is that repeated hand work moves into DOM. Dvir approved sending v11 to DOM as a settings change, with buying kept paused (§15). With v11 in DOM:
- every screened name gets the same, reproducible v11 decision, with the inputs shown;
- the sibling lists come from a frozen method DOM owns, approved once (CR-007 G-3), instead of one approval per list;
- the next steps (a practice buy on a real name in dry run, then the scouts' flow) run through DOM, not through scripts.

**v11 is a screen only. BUY-HOLD stays ON.** Nothing in this CR clears the hold, buys, or changes money settings. Whether to clear the hold stays Dvir's decision, under the process DOM proposed for CR-007 G-4c / G-4d (suites approved by Dvir, `clears_hold`, gates not assessed: CR-007 §19.3 Q-4, Q-5, decision D-3).

## 2. Scope
- **In scope:** the v11 settings draft (§6), one new settings key for the other-extension list (C-1), naming `bt1@v1` as the sibling method version DOM's v2.4.0 generator implements (§7), fixtures and tests (§10).
- **Already covered elsewhere, referenced, not repeated:**
  - the generated sibling lists themselves and their rules: CR-007 G-3 (R-11 to R-15, AC-9 to AC-11), DOM's answer Q-3, release v2.4.0;
  - test sets built, sealed and given features by DOM, new suites, and gates not assessed: CR-007 G-4a to G-4d, DOM's answers Q-4 and Q-5, release v2.4.0;
  - the forward test (how names did after they dropped): CR-007 G-1, release v2.5.0.
- **Out of scope:** clearing the hold; any buy; the money model and its tier priors (`tier.p_passive`, locked); the look-alike-in-use signal (CR-007 G-7 stays P2, see §5); the geo lane (v11 was tested on non-geo names only, so the geo tier `G` stays exactly as it is).

## 3. Ground rules (as in CR-001 §1 and CR-007 §3)
1. What, not how. Names of keys and codes below are suggestions; DOM picks the final ones.
2. Reference scripts are non-binding. The exception is Appendix B: there the recipe **is** the business input (it defines which 20 names are the siblings), so it must be followed exactly.
3. Free data only, $0 hosting. Fail closed: a failed lookup is UNKNOWN, never "not registered" or zero.
4. Append-only and audited. Secrets never appear in the repo, chat, responses or logs.

## 4. The rule v11, in business terms
- **R-1 Form.** The name is a `.com` of 2 or 3 words, letters only, at most 25 characters, and not a geo name. A name outside this form is not accepted by v11 (it was never tested).
- **R-2 Registered share.** Out of the name's 20 `bt1@v1` siblings, the share that is registered. At most 5 of the 20 may be unknown (DOM's `census.max_unknown_share` 0.25, as today); with more unknowns the share is unknown.
- **R-3 Other extension.** True when the same label on `.net`, `.org`, `.biz` or `.ca` was registered strictly before the decision date. For a live screen the decision date is today. Other extensions (`.ai`, `.info`, `.co`, `.io`, `.us`) do **not** count for v11.
- **R-4 Decision.** Accept when **share is at least 0.55, or R-3 is true**. Otherwise reject. The cut-off is compared exactly: 11 of 20 (0.55) is an accept.
- **R-5 Unknowns.** DOM's three-valued logic applies as today. Share unknown and R-3 true: accept (the OR is already decided). Share unknown and R-3 false or unknown: undecided. A missing input is never a pass.
- **R-6 Screen only.** An accepted name still goes through every other gate (availability, brand lists, typo, blocklists, history HIST-2, trademark TM-1, price, screening pack) and stays blocked from a real `/buy` by BUY-HOLD and by Dvir's approval rule.
- **R-7 Sources.** Registry data only (RDAP, as DOM does today). No Internet Archive data enters v11.

## 5. The evidence, honestly
| On TEST15 (sealed, scored once on 2026-10-07 at 13:53 IDT) | Sold accepted [95% range] | Dropped rejected [95% range] | Bar |
|---|---|---|---|
| **v11: share at least 0.55 OR alt** | **286 of 400 = 71.5%** [66.9% to 75.7%] | **381 of 494 = 77.1%** [73.2% to 80.6%] | PASS (at least 70% and at least 75%, exact fractions) |
| Reference: share at least 0.50 OR alt (round 14) | 290 of 400 = 72.5% [67.9% to 76.6%] | 368 of 494 = 74.5% [70.5% to 78.1%] | FAIL |

What this does and does not show:
1. **The pass is thin.** Both lower ends of the 95% ranges are under the bar. The sold side clears 70% by 6 names out of 400. It is a pass, not a robust pass.
2. **Word count does most of the work.** 2-word names: 95% of sold accepted, but only 23% of dropped rejected. 3-word names: 21% of sold accepted, 97% of dropped rejected. Accepting every 2-word name alone would fail (68.2% / 72.9%), so the share adds real value, but less than the headline suggests.
3. **Profit is not shown.** With a $1,500 batch (43 names held 3 years, prices capped at our $1,488 list price), break-even needs each picked name to have about a **1.6% chance of selling each year**. Investors report 0.5% to 1.5%. So in the usual case the batch loses money (about $70 to $1,000 over 3 years). v11 tells sellable names from junk; it does not make bulk buying profitable.
4. **The look-alike-in-use signal gave no lift** (whether names like ours are live websites). Measured on the tuning half, it added +0.003 to the margin, under the +0.01 set in advance. It is **not** part of v11.
5. **Drop-catchers take the best names first.** v11 accepts 55% of the names caught at the drop, against 23% of names nobody took. The names left for us at $11 are the weaker part of the accepted group.
6. **v11 accepts many names.** 113 of 494 fully dropped names (22.9%). A daily drop list still needs the manual checks and a cap.
7. **New caveat found while writing this CR: the sold-side share is not as-of.** The research measured each sibling's registration on 2026-10-07, not on the sold name's decision date. For dropped names that is the same thing (decision date 2026-10-06). For sold names, siblings registered after the decision date were counted. DOM's own census counts only siblings created strictly before `as_of`, and its leakage check would flag these rows. Of the sold-side siblings that have a registry creation date (633, about 14% of the 4,591 registered ones), **70 (11%) were created on or after the decision date**. If that rate holds for the rest, an as-of-correct test would accept about **268 of 400 (67%, simulated range 263 to 273)** sold names, **under the 70% bar**. This is an estimate from a partial sample, but it means v11's pass is **not established under DOM's own leakage rule**. The live screen itself is not affected (a live screen measures today's share, exactly like the dropped side), but the evidence that today's share predicts a sale is weaker than the table says. §10 AC-10 asks DOM to measure this properly with its own as-of features.

Full research write-up: Gavriel's `research/backtest-sold/r15/results.md` (summary above; not copied, it holds sale prices).

## 6. How v11 maps onto DOM's settings
Most of v11 can be written as a settings draft **today** (`POST /selection/settings`), because new keys are allowed under `thresholds` and `tier.clauses` and existing paths may change. One piece needs DOM (C-1). Label `v11` (if taken, `v11a`), based on the active version.

### 6.1 The draft (Gavriel creates it; Dvir activates it later, §11)
| Path | Value | Why |
|---|---|---|
| `thresholds.registered_share_min_v11` | 0.55 | R-4 cut-off |
| `thresholds.v11_min_words` | 2 | R-1 |
| `thresholds.v11_max_words` | 3 | R-1 |
| `thresholds.v11_max_chars` | 25 | R-1 |
| `thresholds.alt_tld_before_min` | 1 (unchanged) | R-3 |
| `tier.clauses.A` | `{"all": [registered_share >= $registered_share_min_v11, n_words >= $v11_min_words, n_words <= $v11_max_words, sld_chars <= $v11_max_chars, is_geo == 0]}` | the share path |
| `tier.clauses.I` | `{"all": [alt_tld_before_n >= $alt_tld_before_min, n_words >= $v11_min_words, n_words <= $v11_max_words, sld_chars <= $v11_max_chars, is_geo == 0]}` | the other-extension path |
| `tier.order` | `["A", "I", "G"]` | `B` is dropped (v11 has no separate 2-word tier); `G` (geo) unchanged |
| `tier.demand2_pass_tiers` | `["A", "I", "G"]` | DEMAND-2 passes when either v11 path, or the unchanged geo tier, is true |
| `freshness_hours.census` | 168 | the research reused registry lookups for 7 days at most (today's default is 30 days) |
| `ext.alt_list` (new key, C-1) | `["net", "org", "biz", "ca"]` | R-3 |
| `buy_hold` | true (unchanged) | BUY-HOLD stays on |
| `holdout` | unchanged (locked) | |

**Why two tiers and why `A` and `I`:** the clause grammar has no nesting, so "(share OR alt) AND form limits" is written as two tiers that both pass DEMAND-2. New tier names can't be added by a draft, because every tier needs a `tier.p_passive` value and those priors are locked. `A` and `I` both carry `p_passive` 0.02 today, the same prior v10's main path used, so v11 does not change the money model. (Using `B`, prior 0.01, would make most v11 names fail the price gate, see Q-3.) The note on the draft will say that in `v11`, `A` means "share path" and `I` means "other-extension path".

**Census denominator:** the research divided by known siblings only; DOM keeps unknown siblings in the denominator, which is stricter. Every TEST15 row had all 20 siblings known, so the evidence can't tell the two apart. **Keep DOM's rule; no change asked.**

### 6.2 What DOM needs to build or confirm
- **C-1, a separate extension list for the other-extension feature.** Today `ext_dates` and `same_name` both read `ext.list` (net, org, co, io, ai, info, us). v11 counts only net, org, biz, ca. Changing `ext.list` would also narrow the same-name check (TN-1), which is not wanted. **Need:** a setting (suggested `ext.alt_list`) that only `alt_tld_before_n` reads. Default: equal to `ext.list`, so every existing version behaves as today. Values must be extensions with an RDAP service in the IANA bootstrap, else `SETTINGS_INVALID`. An extension whose registry refuses or rate-limits is UNKNOWN and not counted, as today (in the research `.biz` refused RDAP; it never decided a test accept on its own, so no extra source is asked for).
- **C-2, the census reads `bt1@v1`.** The census accepts the generated reference `bt1@v1` as an item's census list for any name, with no per-name approval, once Dvir has approved that method version (§7). This is CR-007 G-3 with the method version named.
- **C-3, confirm the draft validates.** DOM confirms (or corrects) the paths in §6.1, for example whether `tier.order` and `tier.demand2_pass_tiers` may be changed by a draft, and that removing `B` from the order is valid.
- **C-4, nothing else.** No new tier code, no new money rule, no new check id.

## 7. The sibling method `bt1@v1` (recommended: DOM's generator reproduces it exactly)
**The problem.** v11 was validated on siblings built by `bt1@v1`. DOM's reply to CR-007 (§19.3 Q-3) plans a generator `gen1@v1` that will **not** reproduce `bt1` exactly, because `bt1` orders words with Python's shuffle. With different siblings the share is a different measurement, and the 0.55 cut-off was never tested on it.

**Option 1 (recommended): DOM's v2.4.0 generator implements `bt1@v1` exactly.**
- **Feasible.** The recipe needs no Python. Appendix B writes it out as plain steps: an MD5 seed, the standard MT19937 random-number generator, a Fisher-Yates shuffle, and four frozen word pools. A sketch that uses **no random-number library** reproduces all **1,900 of 1,900** round-15 sibling lists (`CR-008-reference/bt1_reference.py`, checked 2026-10-07 14:05 IDT). MT19937 is a published standard with reference code in every common language.
- **Contract:** for a given word split, DOM's 20 siblings equal the `bt1@v1` siblings (AC-4). The pools are frozen with the method version, **in their order and with their one duplicate** (`cyber` in `tech`). DOM's ordinary lists are stored sorted with duplicates collapsed, so the pools need an ordered form (or the frozen pools file with its sha256). DOM may call the method `bt1@v1` (recommended, so research lists and live lists share a name) or `gen1@v1` defined as identical to `bt1@v1`.
- **Then** the round-15 evidence carries over to live screening without a new test (subject to §5 point 7).

**Option 2 (fallback, only if DOM can't do Option 1): accept `gen1@v1` and re-validate.**
- A bridge check (diagnostic only): DOM computes `gen1@v1` shares for the 894 TEST15 names (registered as used, AC-2) and reports, against the stored `bt1` shares, how often the v11 decision agrees, and the rates it would give.
- A fresh sealed set built and sealed by DOM (CR-007 G-4a/b), with features from `gen1@v1`, scored once with v11 before `v11` is activated for live screening. The cut-off may need re-tuning on that set's tuning half first.
- Until then, `v11` stays a draft.

**Dvir's one approval (CR-007 decision D-2, at v2.4.0):** Dvir approved the principle on 2026-10-07 13:43 IDT (CR-007 §18). The line that freezes the exact pools comes when v2.4.0 ships, for example: "sibling method bt1@v1 approved" (or "gen1@v1" under Option 2). Decision D-3 (suites and gates not assessed) also comes at v2.4.0.

**The word split matters.** The siblings come from the name's words, so a different split gives different siblings. The research split used a word list with an English frequency of at least 3.6 on the zipf scale (a common measure of how often a word appears; 3.6 is about once in 250,000 words). DOM uses its own split (`form` `tokens`). AC-6 asks DOM to report how often its split matches the research split on the 1,900 vector names. If it agrees on fewer than 95%, DOM says so and this comes back to Dvir.

## 8. Inputs and outputs (per screened name)
- **Inputs:** a `.com` name and its lane (as today); the active settings (`v11` once activated); the `bt1@v1` method version (approved); registry answers (RDAP) for the 20 siblings and for the four extensions.
- **Outputs (all exist today, nothing new is asked):** the `census` result (`registered_share`, `n_registered`, `n_checked`, `n_unknown`, the siblings and their states, `list` = `bt1@v1`), the `ext_dates` result (`alt_tld_before_n`, the per-extension states, limited to `ext.alt_list`), the `tier` result (`tier` `A` / `I` / `G` / `none`, `clauses`, `demand2`, `tier_exact`), and the run's `final_status`, which can't be `buy_candidate` while the hold is on.

## 9. Errors (suggested; DOM may reuse existing codes)
| Code | When |
|---|---|
| `CENSUS_LIST_SIZE` (existing) | the method gives fewer than 20 siblings (small pools, a 1-word name) |
| `CENSUS_METHOD_NOT_APPROVED` (new, or `CENSUS_LIST_MISSING`) | a run names `bt1@v1` before Dvir's approval line exists |
| `TOO_MANY_UNKNOWN` (existing) | more than 5 of 20 siblings unknown |
| `SETTINGS_INVALID` (existing) | `ext.alt_list` holds an extension with no RDAP service, or the draft breaks a validation rule |
| `RATE_LIMITED`, `SOURCE_ERROR`, `TIMEOUT` (existing) | a registry lookup fails: UNKNOWN, never a silent accept or reject |

## 10. Acceptance tests (Gavriel runs them through the API)
- **AC-1 Draft.** `POST /selection/settings` with §6.1 (as corrected by DOM) returns 201. `buy_hold` is true and `holdout` is unchanged in the result.
- **AC-2 Fixtures.** The 894 rows of `v11_fixtures.csv` are registered in the name registry as **used** names (role `fit`, slice `R15-TEST15-USED`, or a "used" role if DOM prefers, Q-5), with `registered_share`, `alt_tld_before_n`, `n_words`, `sld_chars` and `is_geo` as given. A diagnostic replay on `v11` gives, row by row, the `expected` decision, 0 undecided, and pooled: sold accepted 286 of 400, dropped rejected 381 of 494. The 24 rows with share exactly 0.55 are all accepts.
- **AC-3 Boundaries** (`POST /selection/evaluate` with `settings: "v11"`, lane S7):
  - share 0.55, alt 0, 2 words, 12 chars: DEMAND-2 PASS, tier `A`;
  - share 0.549, alt 0: FAIL;
  - share 0.20, alt 1: PASS, tier `I`;
  - with alt 0: share 0.90 and 4 words: FAIL; share 0.90 and 1 word: FAIL; share 0.90 and 26 chars: FAIL;
  - share null, alt 1: PASS; share null, alt 0: UNKNOWN; share null, alt null: UNKNOWN;
  - lane S2 (geo): only the `G` clause can pass, as today.
- **AC-4 Siblings.** For every row of `bt1_vectors.csv`, given its `tokens`, DOM's `bt1@v1` returns the 20 names `s01` to `s20` (the same set; the same order too, if DOM exposes order). The same name asked twice gives the same list (CR-007 AC-9).
- **AC-5 Frozen pools.** The method version's pools read back equal to `bt1_pools_v1.json` (order and the duplicate included). Changing any pool word needs a new method version and a new approval.
- **AC-6 Word split.** DOM reports, for the 1,900 vector names, how many of its `form` splits equal the `tokens` column, and lists the differences.
- **AC-7 Other extensions.** On `v11`, a name whose label is registered on `.ai` (before the date) and on none of net, org, biz, ca gets `alt_tld_before_n` 0. On a version without `ext.alt_list`, `ext_dates` reads `ext.list` exactly as today.
- **AC-8 Approval.** Before the method approval line, a run on `v11` gives the census UNKNOWN (`CENSUS_METHOD_NOT_APPROVED` or `CENSUS_LIST_MISSING`) and no share. After it, the census uses `bt1@v1` with no per-name approval.
- **AC-9 Hold stays on.** With `v11` active, `GET /selection/buy-hold` shows the hold on; a fully passing name ends `would_buy`, never `buy_candidate`; a dry-run `/buy` for it is refused as today.
- **AC-10 As-of check (diagnostic, reported only).** Once CR-007 G-4b exists, DOM computes as-of features (census counting only siblings created before `as_of`; `bt1@v1` siblings) for the 894 used rows and runs a diagnostic replay on `v11`. DOM reports the rates. There is no pass bar; the result goes to Dvir for decision D-8-3.

## 11. Order of work and when v11 goes live
1. DOM answers this CR (C-1 to C-3, Q-1 to Q-6).
2. Gavriel creates the `v11` draft once C-1 exists (or now without `ext.alt_list`, then again with it) and runs AC-1 to AC-3.
3. DOM ships the sibling method in v2.4.0 (Option 1). Gavriel runs AC-4 to AC-6. Dvir gives the D-2 line naming the method version, and decides D-3.
4. AC-10 is run and reported.
5. **Activation** of `v11` for live screening needs Dvir's approval line naming the label (`POST /selection/settings/v11/activate`), decision D-8-2. Gavriel recommends waiting for AC-10 (D-8-3).
6. BUY-HOLD stays on throughout. Clearing it is a separate decision under CR-007 G-4c / G-4d.

**Until v2.4.0:** a single real name (for the practice buy in dry run) can still be screened today with a per-name `bt1_<sld>` list frozen with Dvir's approval naming it, as today (CR-001 §2). That is a one-off, not a routine.

## 12. Questions for DOM
- **Q-1** Option 1: will the v2.4.0 generator implement `bt1@v1` exactly (Appendix B)? If not, why, and do you accept Option 2 instead?
- **Q-2** C-1: is `ext.alt_list` acceptable, or do you prefer another way to limit the extensions `alt_tld_before_n` counts without touching the same-name check?
- **Q-3** Price gate and tier priors: by the contract formula (§Money), a tier with `p_passive` 0.01 at BIN $1,488, floor $967 and renewal $11.79 gives `ratio_at_floor` of about 0.70, so RATIO-1 fails. Is that right? It is why §6.1 uses `A` and `I` (both 0.02) and not `B`. Please confirm no v11 name is blocked by the price gate only because of which tier label it landed in.
- **Q-4** C-3: do the §6.1 paths validate as written, and is anything else needed?
- **Q-5** AC-2: which role should used test names get in the registry, so that they can be scored in a diagnostic replay and are never reused in a later test set?
- **Q-6** Word split: does your dictionary carry word frequencies, so a setting such as `form.min_word_zipf` (v11: 3.6) is possible? If not, say so; the difference stays a known limit, measured by AC-6.

## 13. Decisions for Dvir (DVIR)
- **D-2 (from CR-007, at v2.4.0):** one line approving the sibling method version: "sibling method bt1@v1 approved".
- **D-3 (from CR-007, at v2.4.0):** the suites and gates-not-assessed rule.
- **D-8-2 (new, at activation):** one line naming the settings label, for example "selection settings v11 approved for activation; buy hold stays on".
- **D-8-3 (new):** whether to activate `v11` before or after the as-of check (AC-10). Gavriel recommends after: §5 point 7 suggests the sold-side pass may not hold under DOM's leakage rule.
- **Only if Option 2:** whether the re-validation set (§7) must pass before activation (Gavriel recommends yes).
- **Only if AC-6 agrees on fewer than 95%:** whether DOM's word split is acceptable for v11.

## 14. What Dvir is approving by approving this CR
- Sending v11 to DOM as a selection settings change (the `v11` draft in §6.1 and the new key C-1).
- Naming `bt1@v1` as the sibling method version for DOM's generator (Option 1), with Option 2 as the fallback. The approval line that freezes the method comes later (D-2).
- Sharing the used TEST15 names, labels and inputs with DOM (`CR-008-reference/`).
- **Not** approved here: activating `v11` (D-8-2), clearing the buy hold, any buy, any change to tier priors or money settings. **Buying stays paused.** Nothing here spends money.

## 15. Dvir's approval (2026-10-07 13:59 IDT, in chat, verbatim)
> "Yes, send the new picking rule to DOM as a settings change and keep buying paused"

The as-of caveat in §5 point 7 was found after this approval, while writing this CR. It changes no request here, but it is why Gavriel recommends D-8-3 "after".

---

## Appendix A: reference material (`docs/requests/CR-008-reference/`)
| File | Use |
|---|---|
| `README.md` | What each file is |
| `v11_fixtures.csv` | 894 used TEST15 rows with stored share, alt and expected decision (AC-2) |
| `bt1_pools_v1.json` | The four frozen pools of `bt1@v1`, sha256 `a984b85e06ed79cf972590518214ccd35c6ea12887a8e08d8a5e807e1a7df48b` (AC-5) |
| `bt1_vectors.csv` | 1,900 names with their word split and 20 siblings in order (AC-4) |
| `bt1_reference.py` | Non-binding sketch of Appendix B with no random-number library; reproduces all 1,900 vectors |

**Test labels:** TEST15 was scored once (2026-10-07 13:53 IDT, rule frozen at 13:53:40 before scoring) and is marked used in Gavriel's name log, so sharing its labels with DOM can't spoil a future test. Please register the names as used (AC-2) so no later set reuses them. No personal data, no sale prices and no tokens are included.

## Appendix B: the `bt1@v1` recipe (this is the definition of the method version)
Input: the name's word split `t1 ... tn` (n at least 2, lower-case letters). Output: an ordered list of up to 20 `.com` labels.

1. **Seed.** Join the words with nothing between them (UTF-8). Take the MD5 hash, keep its first 8 hex digits, and read them as an unsigned 32-bit number `s`.
2. **Generator.** Start one MT19937 generator (the standard 32-bit Mersenne Twister) with the standard "init by array" seeding, using the key `[s]` (one 32-bit word; a seed of 0 is the key `[0]`). The same generator is used for both halves below, in order.
3. **Random index below n** (`below(n)`, n at least 1): let `k` be the number of bits in `n`. Take the next 32-bit output, shift it right by `32 - k`. If the result is `n` or more, draw again. Return it.
4. **Shuffle a list** of length `m`: for `i` from `m - 1` down to 1, let `j = below(i + 1)` and swap items `i` and `j`.
5. **Pool for a word.** If the word is in pool `tech`, use `tech`; else if it is in pool `trades`, use `trades`; else use `first_pool` for the first word and `last_pool` for the last word. Pools keep their frozen order and their duplicate.
6. **First half.** Take the pool of `t1`, remove every entry equal to `t1`, shuffle it (step 4). Walk it in order; for each word `w`, the candidate is `w + t2 ... t(n-1) + tn`. Add it if it is not already in the output and is not the name itself. Stop when the output has 10 names or the list ends.
7. **Second half.** Take the pool of `tn` (as a last word), remove every entry equal to `tn`, shuffle it with the same generator. Walk it; the candidate is `t1 + t2 ... t(n-1) + w`. Add it under the same two conditions. Stop when the output has 20 names or the list ends.
8. **Fewer than 20:** the census is UNKNOWN `CENSUS_LIST_SIZE`, never a share.

This is exactly what Python 3's `random.Random(s).shuffle` does, written out so no Python is needed. Geo names were never given `bt1` lists in the research (R-1 excludes them).

## 16. Dvir's decision D-8-3 and activation line D-8-2 (2026-10-07 14:13 IDT, in chat, verbatim)
> "Switch the new rule on now (buying still paused) and run the correct-date test later"

- **D-8-3 = activate before the as-of check.** This overrides Gavriel's "after" recommendation in §13. AC-10 still runs once CR-007 G-4b exists, and its result goes to Dvir. It no longer gates activation.
- **D-8-2:** Gavriel records this line as Dvir's activation approval for the selection settings label `v11` ("the new rule" here can only mean v11; buy hold stays on). **Please confirm** in your reply that it is enough as the `approval_ref` for `POST /selection/settings/v11/activate`. If you need the exact form from §13, say so and Gavriel will get that line from Dvir.
- **Changed order of work (replaces §11 steps 4 and 5):** Gavriel creates the `v11` draft as soon as C-1 (`ext.alt_list`) exists, runs AC-1 to AC-3, and then activates it with the line above. Gavriel will not activate a version without `ext.alt_list`, because that would count more extensions than the tested rule. If you think a live `v11` must wait for the v2.4.0 sibling generator (for example because the census clause has no list to read for new names), say so; until then, per-name lists frozen with Dvir's approval keep working (§11, "Until v2.4.0").
- **Unchanged:** BUY-HOLD stays on. No buy. No change to tier priors or money settings.

<!-- DOM writes below this line -->
## DOM response (2026-10-07)

**Verdict: accepted, Option 1.**
- **Release:** v2.4.0 ships C-1 (`ext.alt_list`) and the sibling method `bt1@v1`, reproduced exactly (this is CR-007 G-3).
- **Plan changes:** CR-007's later items move one release each (G-4 → v2.5.0, G-1 / G-2 → v2.6.0; CR-007 §19.1 is updated).
- **Draft:** one change to the draft (C-3).
- **Activation:** Dvir's 14:13 line is **not** enough to activate (D-8-2 below).
- **Buy hold:** stays on; nothing here buys or changes money settings.

### 17.1 Answers
- **Q-1: yes, Option 1.**
  - **Method:** v2.4.0 implements Appendix B exactly: MD5 seed, MT19937 with init by array, `below(n)` by rejection, Fisher-Yates, frozen pools in their order with the duplicate.
  - **Test:** DOM's default suite checks all **1,900 of 1,900** `bt1_vectors.csv` lists, in order (AC-4).
  - **Pools:** frozen with the method version from `bt1_pools_v1.json`. Its sha256 (`a984b85e…df48b`) is checked at load, so AC-5 is a read-back.
  - **Name:** the method is called **`bt1@v1`**.
- **Q-2: `ext.alt_list` accepted.**
  - **Readers:** only `alt_tld_before_n` (the `ext_dates` check) reads it.
  - **Absent key:** `ext_dates` reads `ext.list` as today, so every existing version is unchanged.
  - **TN-1:** `same_name` keeps reading `ext.list`.
  - **Validation:** a draft may set it. It must be a non-empty list of lower-case extensions.
  - **Unavailable registries:** an extension whose registry has no RDAP service or refuses is UNKNOWN at run time and never counted, as today (`.biz` included). DOM does not check the IANA bootstrap at draft time: the bootstrap is reference data that changes.
- **Q-3: confirmed.**
  - **The formula:** `ratio_at_floor` = floor × 0.85 (Afternic) × P(sale in year 1) ÷ renewal. With no leads, P(sale in year 1) = `p_passive`.
  - **The numbers:** at `p_passive` 0.01: 967 × 0.85 × 0.01 ÷ 11.79 ≈ **0.70** → FAIL `RATIO_BELOW_1`. At 0.02 (`A`, `I`) ≈ **1.39** → pass.
  - **So:** using `A` and `I` is right. A v11 name is never blocked by the price gate only because of its tier label, since both v11 paths carry 0.02.
- **Q-4, C-3: one change.** Your §6.1 sets `tier.clauses.A` and `.I` one by one. Then clause `B` stays in the document while `B` leaves `tier.order`, and validation refuses it ("clause B is not in tier order").
  - **Fix:** set **`tier.clauses` as a whole object** holding `A`, `I` and the unchanged `G` (copy `G` from `GET /selection/settings`).
  - **Validity:** `tier.order` and `tier.demand2_pass_tiers` may be changed by a draft, and removing `B` is valid once its clause is gone.
  - **Everything else:** the `thresholds.*` keys, `freshness_hours.census` and `ext.alt_list` (after v2.4.0) validate as written.
- **Q-5: role `fit`, slice `R15-TEST15-USED`.**
  - **Use:** `fit` rows are scored by diagnostic replays.
  - **No reuse:** the registry records a name once, any role. CR-007 G-4a's set builder (v2.5.0) removes every registered name, so these can never enter a later test set.
  - **No new role** is needed.
- **Q-6: no.**
  - **Why:** DOM's dictionary (SCOWL) has no word frequencies, so `form.min_word_zipf` isn't possible without a new word list.
  - **Instead:** v2.4.0's release note reports AC-6 (DOM's split vs your `tokens` on the 1,900 names, with the differences listed).
  - **Fallback:** if they agree on fewer than 95%, it comes back to Dvir, as §7 says.
  - **Using your split:** `GET` of the method also accepts a given word split, so you can always get the siblings for your split.

### 17.2 What v2.4.0 adds (the contract will hold the exact wording)
- **Settings:** the optional key `ext.alt_list` (C-1).
- **The method:** `bt1@v1`, frozen from your pools file.
  - **Read:** `GET` returns its pools, sha256, approval state, and the 20 siblings for a name (DOM's split) or for a given split.
  - **Approve:** `POST` approves it with Dvir's `approval_ref`, which must name `bt1@v1`. Approval is once, append-only.
- **Census (C-2):** an item's `census_list` may be `bt1@v1`; DOM builds the 20 siblings at run time.
  - **Before the approval:** UNKNOWN `CENSUS_METHOD_NOT_APPROVED`.
  - **Fewer than 20 siblings:** UNKNOWN `CENSUS_LIST_SIZE`.
  - **Unchanged:** per-name `bt1_<sld>` lists keep working.
- **Tests:**
  - every `bt1_vectors.csv` list;
  - the pools' sha256;
  - the 894 `v11_fixtures.csv` rows through the real tier code with the v11 draft values: the `expected` decision row by row, 286 / 400 and 381 / 494, all 24 rows at 0.55 accepted;
  - the AC-3 boundaries;
  - AC-7.
- **AC-10:** stays with CR-007 G-4b (v2.5.0).

### 17.3 Dvir's lines (DVIR)
- **D-8-2: the 14:13 line can't be the `approval_ref`.** Activation checks that the approval text **names the label** (`v11`), and "the new rule" doesn't. This rule exists so one line can never activate a version it doesn't name.
  - **What DOM needs:** one line from Dvir, for example: **"selection settings v11 approved for activation; buy hold stays on"**.
  - **Timing:** the line is valid for 72 hours, so Gavriel should get it when v2.4.0 is live and the draft exists.
  - **His decision to activate before the as-of check (D-8-3)** stands.
- **D-2:** after v2.4.0 is live, one line: **"sibling method bt1@v1 approved"**.
- **D-3:** unchanged (CR-007 §19.3 Q-4, Q-5). It is needed for v2.5.0, not for v11.

### 17.4 Order of work
1. **DOM ships v2.4.0** (this CR's C-1, C-2 and its tests).
2. **Gavriel:**
   - registers the 894 fixtures (`fit`, `R15-TEST15-USED`);
   - creates the `v11` draft (§6.1 with the C-3 fix, `ext.alt_list` included);
   - runs AC-1 to AC-8.
3. **Dvir gives D-2,** and Gavriel approves `bt1@v1` with it.
4. **Dvir gives the D-8-2 line naming `v11`,** and Gavriel activates.
5. **The buy hold stays on.**

**Activating `v11` before step 3 is possible but pointless.** A name with no frozen list gets an UNKNOWN share, so only the other-extension path could accept.
