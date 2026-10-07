# Round 15 preregistration (written 2026-10-07 12:40 IDT, BEFORE any DEV15 or TEST15 result was computed)

Author: Grok Bot (executor). Research only: nothing bought, registered, sent, posted or committed. No writes to the live API. No Wayback/Internet Archive. No paid sources. DOM's src/ and tests/ not read.

## 1. Data (built and split before any feature was computed)
- **Sold (primary definition, same as r14):** a real public retail sale of a .com reported by UnreportedSales (weekly reports Jun 2024 to Oct 5 2026), price ≥ $100, whose current RDAP creation date is on or before the sale date and at most 36 months before it (a hand-registered name that was later sold).
- **Dropped (changed toward buyable inventory):** a name from the SnapNames deleting list with join-by date 10/06/2026 that, when checked by Verisign RDAP on 2026-10-07 ~12:40 IDT, returns "not found" (404): the owner let it expire, it fully dropped, and no drop-catcher took it. These are exactly the names we could register at the normal $11 price. Names caught on 10/06 (113) are kept aside as a report-only slice. Creation date is unknown for deleted names, so r14's "created 2021–25" filter cannot be applied.
- **Same name-form filter for both classes** (new in r15; r14 applied it only to dropped): 2–3 dictionary words (each word zipf ≥ 3.6, as `scripts/sn_filter.py`), letters only, ≤ 25 characters, not geo. Never used in any earlier round (`excluded15.txt`, 17,525 names).
- **Split:** eligible names (800 sold / 987 dropped) split 50/50 per class with random seed 15: **DEV15 400 / 493**, **TEST15 400 / 494**. TEST15 frozen in `test15.frozen.csv` (read-only), sha256 `86aef89874208a381d3344e00cb77e7fa8569ea7705cbc4f1dcf4e45f484e00f` (`test15.sha256`), logged in `iterations/name-log.md` as reserved for r15.
- **Census filter (both roles, label-blind):** a row is scored only if ≥ 15 of its 20 frozen siblings have a known RDAP state. Rows failing it are reported as excluded counts.

## 2. Features (identical code for DEV and TEST)
- `share`: registered share of the 20 frozen siblings (census method bt1, `census/bt1_<sld>@v1.csv`), RDAP measured 2026-10-07 for both classes.
- `alt` (r14 feature): the exact name on .net/.org/.biz/.ca has an RDAP creation date **before the as-of date**. As-of: sold = the .com's RDAP creation date (when we would have had to decide to buy); dropped = 2026-10-06. Registered but date unknown → conservative (sold 0, dropped 1). Change from r14: .us removed (it has no RDAP service in the IANA list).
- **New signal, "look-alike names in use":**
  - `alt_use`: the exact name on .net/.org/.ai/.biz/.ca was created before the as-of date (RDAP) **and** its homepage is in use today.
  - `var_use`: the hyphenated .com (words joined by "-") or the plural/singular .com (add/remove a final "s") was created before the as-of date (Verisign RDAP) **and** is in use today.
  - `look_use` = `alt_use` OR `var_use` (main new signal).
  - `sib_use`: share of the 20 frozen siblings whose homepage is in use today (no DNS or no website counts as not in use).
  - "In use" = one GET of the public homepage returns HTTP 200, stays on the same domain (no redirect elsewhere), has ≥ 200 characters of visible text, and shows no parking / for-sale text (same test as v9.1 C19, `scripts/census_run_lib.py`). Check errors count as not in use. Date unknown for an alt/variant → conservative (sold 0, dropped 1).
- Exploratory only (DEV, never selectable): exact name on .io/.co/.us resolving to an in-use site, with no date control (these registries have no RDAP).
- `n_words` (breakdowns only).

## 3. Candidate rules (finite; nothing added after DEV15 is seen)
- **R0 reference** (= r14 C0, v10 without history): `share ≥ 0.50 OR alt`.
- **R0k** (reference family for measuring lift): `share ≥ k OR alt`, k ∈ {0.30, 0.35, …, 0.70}.
- **R1(k)**: `share ≥ k OR alt OR look_use`, same k grid.
- **R2(k,u)**: `share ≥ k OR alt OR look_use OR sib_use ≥ u`, k grid, u ∈ {0.10, 0.15, …, 0.40}.
- **R3(k,u)**: `(share ≥ k AND sib_use ≥ u) OR alt OR look_use`, k ∈ {0.20, 0.25, …, 0.60}, u ∈ {0.05, 0.10, 0.15, 0.20, 0.25}.

## 4. Choosing on DEV15 (mechanical)
- Margin M = min(sold accepted − 0.70, dropped rejected − 0.75) on DEV15.
- Best setting per family by M (ties: higher k, then higher u).
- Final: the simplest of R0 < R0k* < R1* < R2* < R3* unless a more complex one beats the current choice by ≥ 0.01 in M.
- **Lift of the new signal on DEV (report):** (a) prevalence of `look_use` and mean `sib_use` per class; (b) M of best R0k vs best R1/R2/R3; (c) sold accepted at the loosest setting that still rejects ≥ 75% of dropped, with vs without the new signal.
- Optimism check (report only): 2-fold split of DEV15 (seed 15), choose on one half, score on the other.

## 5. TEST15 (scored once, frozen rule only)
- **PASS** iff n sold ≥ 50 and n dropped ≥ 50, sold accepted ≥ 0.700 **and** dropped rejected ≥ 0.750, as exact fractions. **No rounding: 69.7% is a FAIL.**
- Wilson 95% intervals reported next to every rate. Label **ROBUST PASS** (report only) if both lower bounds also clear the bar.
- Reported without effect on the verdict: R0 on TEST15; exact McNemar chosen vs R0 per class; by word count; by price band; accept rate on the caught-by-drop-catcher slice; BIGCO/brand proxy gate (r13 token list).
- **Secondary analysis (declared now; D-14-1, report only, cannot pass or fail the round):** "sold" = sales of **$1,000 or more** only, same frozen rule, same dropped set, same bar and Wilson intervals.
- No rule change after TEST15 is scored. A fail is reported as FAIL.

## 6. Profit (after test; r14 `profit14.py` structure)
$1,500 batch; 43 names × 3 years (and 50 × 2 years); Porkbun .com $11.08 first year (before 2026-11-01), renewals $11.79; 20% commission; sold names stop renewing. Yearly sale chance per picked name q = 0.5%, 1%, 1.5%, 2%; plus backtest q = p·TPR/(p·TPR + (1−p)·FPR) with TEST15 rates and pool base p = 0.5% / 1%. Prices from TEST15 sold names the rule accepts: as computed, without the top 3, and capped at the $1,488 list price (the realistic case). Break-even q stated.

## 7. If it passes
Draft `selection-v11.md` (contract style: inputs, outputs, rules, errors, tests). Not sent, not committed. If it fails: state exactly why and the next most promising lever.
