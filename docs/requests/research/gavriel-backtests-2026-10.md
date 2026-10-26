# Gavriel backtests, October 2026: the 22 reverted registry items

Written 2026-10-26 by Gavriel, for the knowledge base (`type: own_analysis`, reliability A). Every number below is copied from Gavriel's own records on his box; nothing was re-run or re-estimated for this file:
- `research/two-line-iterations-final.md` (final report of the 2026-10-14 two-line iterations, ~15:05 IDT)
- `research/iterations.md` (iteration log, incl. 2026-10-15 PW-H9 / L1-11)
- `research/insight-registry.csv` (columns `harness_iteration`, `result`, `status`)
- iteration logs `lanes/S8-aftermarket/iter/iterlog.jsonl` (Line 2) and `harness/l1iter/iterlog.jsonl` (Line 1); buyer-now tests in `lanes/S8-aftermarket/buyernow/README.md`

## Method (same for every item)

**Line 2 (S8, existing names), dataset D2, frozen** (`D2.csv` sha256 5ba6c92f...):
- Positives: 3,631 aged .com names (5+ years) sold at retail for $500 or more, Jan 2025 to Oct 2026.
- Negatives: 14,524 GoDaddy closeout leftovers ($50 or less, 0 bids), the pool we actually buy from.
- 70/30 dev/sealed split with its own salt. From it14, names of 5 letters or fewer are dropped from both classes.
- Free features only: name shape, keyword comps from the 3 years before the as-of date, age (as a 10-year floor), .net registered before the as-of date (18,155 Verisign RDAP lookups).

**Line 1 (hand-registration):** harness split 1b448a32..., v9 Tier A baseline, debiased scorecard (L1-2), creation-year slices counted as segments from L1-8 on.

**Scoring:** expected profit (EP) per 100 buys, net of 20% venue commission, buy price, registration and renewals; sold price capped at $25k; a sale counts only if our list price is at or below what the buyer paid.

**Keep rule:** overall EP must rise, a paired bootstrap must win in 80% or more of resamples, and no slice with 20+ buys may lose more than 5% (slices are lanes, plus creation year for Line 1). Otherwise the change is reverted.

**Limits:** sale prices are self-reported marketplace data; Line 2 has only 2 sale years; the scorecard ignores time-to-sale and Buy Now drag. A revert means "not supported for our names on this data", not "proven false everywhere".

## Results per item

| Item | Claim (short) | Test | Result | Stance vs claim |
|---|---|---|---|---|
| MC-C5 | Short, easy to spell, few syllables | L2 it18; L1-5 | Syllables 4 or fewer + spellable: +126% L2 / +142% L1 pooled, but the descriptive lane (L2) and 3 of 5 creation-year cohorts (L1-8) lost; reverted under the 5% slice rule. First to retest when data grows | contradicts (as a gate for our names) |
| MC-H-M2 | Syllables + spellable beat length as a gate | same as MC-C5 | see MC-C5 | contradicts |
| MC-C9 | Older names are worth more | L2 it3; it18 | Once negatives are age-matched, an age floor of 5, 10 or 15 years makes no measurable difference; kept at 10 years as a practical filter only | contradicts |
| MC-H-M4 | Age 10+ improves sold-rate among S8 candidates | L2 it3; it18 | see MC-C9 | contradicts |
| CB-G3 | Age / real-phrase filter (vexc: skip under 10 yrs) | L2 it3; it18 | see MC-C9 | contradicts |
| MC-H-M10 | Two-word natural-order dictionary names under 12 chars with 2+ comps | L2 it13; L1-9 | Dictionary-only / 1-2-word filters: -22k EP on L2; L1 light filters failed the year and lane slices | contradicts |
| PW-L12 | Meaningful beats made-up brandables | L2 it13 (PW-H3) | A dictionary / meaningful filter alone does not predict retail sale (-22k) | contradicts |
| PW-H3 | All-dictionary 2-word vs coined, sold vs dropped | L2 it13 | see PW-L12 | contradicts |
| PW-L4 | Geo/SMB price $250-500; $1,500 never | L1-1 (PW-H2) | A low price cap loses: $1,488 gives about 2x the EP of $788 on dev and sealed (sealed +7,640 per 100 buys at $1,488) | contradicts (for our names) |
| PW-L5 | SMB exact-match sweet spot $250-350 | L1-1 | see PW-L4 | contradicts (for our names) |
| PW-H2 | Price cap min(tier, $500) or $350 wins on total profit | L1-1 | see PW-L4. On S8, every price below $1,488 loses money (it19) | contradicts |
| PW-L17 | Pro sell-through 1-2%/yr; average names at $2k-5k; lower prices can't rescue a tiny buyer pool | L1-1 | Our test supports its pricing point (low caps lose) and does not test the 1-2%/yr figure, so it only narrows the claim | qualifies |
| PW-L23 | Calvin 16-17% sell-through with a strict keyword list | L2 it13 | A keyword / meaningful filter alone does not predict retail sale for our pool; his portfolio figure itself is not tested | qualifies |
| PW-L15 | Allemann 2025: 41 sales, closeouts biggest source | L2 it17 (PW-H8) | His popular-keyword method: phrase popularity across 1.46M names +28% EP, but won only 73% of resamples (under 80%); his sales numbers themselves are not tested | qualifies |
| PW-H8 | A top-200 sold-keyword token lifts precision | L2 it17 | +28% but only 73% of resamples won; reverted | contradicts |
| PW-H9 | One-buyer names sell differently from 3+-firm names | L1-11 / L1-11c (2026-10-15) | Share tier ($2,488 if share under 0.5, else $1,488) beat flat $1,488 (epc 12,215 to 15,766) but lost to a mean-matched flat $1,988 (16,467; P(win) 0.03; year 2022, 2025 and descriptive slices hurt). The inverse tier also scored higher (16,447). Pure price-level effect; the one-buyer split adds nothing. Sealed not opened. Weak proxy (sibling census, not a named-firm count) | contradicts |
| BN-3 | .org registered before as-of alone signals a buyer | L2 bn-org | Promote: dev -507 / -8,261; require: dev +51k but the sealed descriptive lane lost; reverted | contradicts |
| BN-4 | A USPTO exact-phrase filing before as-of means a buyer exists | L2 bn-tm | tm_any promote dev +258 (p .98) but sealed 0 change; tm_recent +50 (p .6). As an auto-demote: dev -12,043, sealed -8,352 (good names carry marks). Kept only as a human conflict check | contradicts |
| BN-5 | An App Store app with the exact name | L2 bn-app | 0 change on dev and sealed: all hits were already in the top 0.5%. Coverage partial (334 of 876 top-2% names; iTunes rate-limited) | contradicts (weakly: coverage partial) |
| BN-6 | A YC company with the name launched before as-of | L2 bn-yc | 10 dev / 7 sealed hits, 0 change; too rare. Kept as shortlist evidence only | contradicts (weakly: too few hits) |
| BN-7 | Keyword ad-spend proxy (SEMrush CPC / volume per token) | L2 bn-ad | All 6 variants lose or fail a lane slice; best (ad_cpc_med b0.1) dev +2,602 (p .65), sealed -1,566 | contradicts |
| PW-L8 | Buy Now off during outbound | none | Not a backtest: an owner decision (Dvir, 2026-10-14, "your call") to keep Buy Now on at $1,488 during outbound. No evidence row from this file | none |

## How this file is used in the knowledge base

One evidence row per item above from this URL (`own_analysis`, A): `contradicts` for 18 items, `qualifies` for PW-L15, PW-L17 and PW-L23 (our test checks the method they imply, not the facts they report), and none for PW-L8. The original `supports` rows from the public sources are added back so both sides are in the base.
