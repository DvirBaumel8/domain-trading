# Research: what predicts that a .com sells, and a redesigned selection score (25 Oct 2026)

**Why:** our 0–100 selection score (the tiebreaker between candidate names) is weak. Its weights were set by hand, two of its seven parts are the bot's own opinion, and one part (F) is not built. This note asks what published data and experienced investors say actually predicts an end-user sale, and proposes a new score that uses measured parts only.

**Builds on:** `docs/research/funnel-names-safety-2026-10.md` (base rates, funnel, safety; not redone here) and `docs/research/auctions-playbook.md`. It also uses our own backtest, `docs/requests/CR-002-reference/results.md` (226 sold vs 224 dropped .com names), because it is the only data we have that measures features on our kind of names.

**Code read:** `src/modules/selection/settings.ts` (`score` block: weights per lane, bands), `src/modules/selection/money.ts` (`evaluateMoney`: Score = Σ raw × weight / 10; a null part scores 0), `src/modules/selection/sibling-scan.ts` (sibling rows: `registered`, `live_business`, `site_state`, `company`), `src/modules/engine/features.ts` and `docs/internal/engine.md` (the learned engine already has `n_endings_pit`, `net_pit` …, `com_age_years`, `demand`), migrations for `keyword_demand` and `godaddy_auctions_live` (`price_cents`, `bid_count`, `domain_age`, `valuation_cents`, `pageviews`).

**Grades:** A = official or large-sample data; B = experienced practitioner with a track record; C = guide or small or unclear study; D = vendor marketing, single anecdote, AI content farm.

**Method limits (read first):**
- NamePros blocks automated reading (HTTP 403). Following the founder rule, I did **not** use any proxy. Bob Hawkes' NamePros analyses are used only through (a) the earlier research note, which read them, and (b) Mike Sullivan's write-up of his method. No conclusion below rests on Hawkes alone.
- The search tool's budget ran out early, so sources were reached through known URLs, site archives, arXiv, Crossref and Semantic-Scholar-style metadata. Some papers (Lindenthal 2014, Phillips 2003, Dawes 1979) are used through their abstracts or metadata only; this is flagged where it matters.
- Many B sources come from one publication (Domain Name Wire, Andrew Allemann). They count as **one voice** when I say "sources agree".
- No marketplace was scraped, no Wayback was used, and no NameBio page or API was touched.

---

## 1. Short answer

1. **The best measured predictor is how many other people already registered the same name on other endings**, and whether real businesses use them. Three independent sources agree: a 159,000-sale academic dataset (the "TLD count" is its strongest name feature), our own backtest (AUC 0.85 for the share of related names registered; the exact name on another ending registered before the .com caught 39% of sold names and 0% of dropped ones), and practitioners (Silver, Hawkes, Squadhelp data). **Confidence: high** that it predicts; medium on the exact points. Caveat: one owner registering many endings defensively inflates the count.
2. **Word count and length come next.** 1–2 words beat 3+, and shorter beats longer. Sources: our backtest (AUC 0.78 and 0.73), the dataset paper (length is the second-strongest feature), Hawkes' sales data, Atom, and the appraisal tools that fail on multi-word names. **Confidence: high.**
3. **The buyer pool (category) matters**: B2B, SaaS/tools, local and professional services, real estate, health, law. Sources: Afternic's monthly top keywords (A), Allemann (B), Atom's 1,000-startup study (startups buy brandables, not descriptive names). **Confidence: medium.**
4. **Weak or unproven:** syllables and pronounceability (no domain-sale study found), word commonness (backtest AUC 0.56; dataset paper: small), CPC and search volume (appraisal tools use them; no study ties them to end-user sales of names like ours), domain age on its own (Hawkes: "Most aged domain names won't find use").
5. **Bad signals in today's score:**
   - **D (keyword appears in sales)**: the NameBio retailstats count gave AUC 0.25 in our backtest; dropped names used *more* popular keywords.
   - **B (bot-found buyers)**: the lead count showed no signal (AUC about 0.5).
   - **C and E (bot opinion)**: the v8 score that leaned on such parts scored AUC 0.44 on a sealed holdout, worse than chance.
6. **Auction bids are a mixed signal.** Many expired-name bids come from SEO and online-casino buyers who pay for backlinks and old traffic, not for end-user resale value (DNW, 2026). Bid count shows *someone* wants the name, not that a business will pay $1,488. No study links bid count to later end-user resale. **Confidence: low to medium.**
7. **Hand weights vs a learned model:** with 40 names we can't learn weights from our own sales. The best-supported approach at our scale is a few strong, measured parts with **roughly equal, rounded weights** (Dawes 1979, "improper linear models"). Check those weights against the public sold/dropped data the engine already holds.

---

## 2. Evidence table per signal

Effect = direction and rough size on the chance of an end-user sale (or on price, where noted). "Measurable" = can we get it automatically and legally for free.

| # | Signal | Effect (what the evidence says) | Sources (grade) | Agree / conflict | Confidence | Measurable for us |
|---|---|---|---|---|---|---|
| 1 | **Other endings registered** (count of .net/.org/.co/.io/.ai/.us … holding the exact name) | Strong positive. Dataset paper: removing "TLD count" hurt price prediction most of all the name features (+0.199 MSLE, more than length's +0.142). Squadhelp: 5+ endings sold about 3x as often as 1. Hawkes: $25k+ .com prices rise with ending count. Our backtest: `tlds_taken_n` today AUC 0.86, but that is **leaked** for sold names (buyers register endings after the sale) | DASH, arXiv 2210.10637 (A); our CR-002 backtest (A−, internal); Squadhelp 2021 via earlier note (A−, vendor data); Hawkes via earlier note (A); Silver 2020 (B) | All agree on the direction. Silver 2018 (B) warns one defensive owner can hold many endings. The DASH count comes from a 2013 DNS census, so it is time-shifted | **High** (direction), medium (size) | **Yes**: RDAP per ending (already in `engine_endings` and `sibling_scans.registered`). The defensive case can be spotted when the endings share a registrar and creation date |
| 2 | **Exact name on another ending registered *before* the .com** | Strong and very clean in our data: 39% of sold, 0% of dropped (AUC 0.70, zero false positives) | Our backtest (A−); Silver 2020 (B, "other entities have valued this keyword") | One internal sample only; Silver supports the logic | **Medium** | **Yes**: RDAP creation dates (`engine_endings.created_at_registry`). Applies to hand-regs and to aged names alike |
| 3 | **Live businesses on those endings** (operating sites, unrelated owners) | Positive and strong per hit, but rare: share in use ≥0.25 was true for 10% of sold vs 0.4% of dropped (big lift, low recall); share ≥0.10 for 58% vs 20%. Practitioners: development on other endings "make[s] the .com more valuable" (Silver) | Our backtest (A−); Silver 2020 (B); Hawkes method via Sullivan 2026 (B: "how often similar names adopted in businesses") | Conflict to note: in DNW's October 2026 end-user sale lists, only 2 of 18 and 2 of 14 buyers were described as owners of the same name elsewhere. So a live sibling is mainly evidence that the **term** has many business users, and less often the actual buyer | **Medium-high** | **Yes**: `sibling_scans` rows with `live_business = true`, distinct `company` |
| 4 | **Word count** | Strong negative per extra word. Backtest: 83% of sold names were 2 words vs 27% of dropped (AUC 0.78). Hawkes: 3-word names sell only as common exact phrases. One-day sales data: 1 word averaged $1,242, 2 words $717, 3+ words $475 | Our backtest (A−); Hawkes 2023 via earlier note (A); DNW Estibot review 2026 (B: tools "struggle with multi-word domains"); DASH (A: token count matters little for *price* once length is in, +0.015) | Agree on sale chance; for price, length carries most of the effect | **High** | **Yes**: the frozen `bt1@v3` split |
| 5 | **Length (letters before .com)** | Negative: sold median 10 vs dropped 13 (AUC 0.73, partly a price-floor bias). Dataset paper: second-strongest name feature for price | DASH (A); our backtest (A−); Atom 2026 (B: median brand length 9.0 for .com startups); DNJ top-100 chart (A, short generics only at the top) | Agree | **High** | **Yes** |
| 6 | **Syllables / pronounceability** | Plausible but **no domain-sale study found**. Estibot lists "pronunciation" among its inputs; Dynadot names memorability. Our syllable counter only counts vowel groups (crude) | Estibot methodology (D); Dynadot hub (D); fluency research (Alter & Oppenheimer, PNAS 2006) not reachable, so not used | No data either way for domains | **Low** | Yes, but the measure is noisy and mostly duplicates length |
| 7 | **Word commonness (frequency)** | Weak: backtest zipf AUC 0.56; DASH "vocabulary" feature +0.020 MSLE (small). Lindenthal (JASIST 2014) builds a price index from word-level sales, but the abstract gives no effect sizes | Our backtest (A−); DASH (A); Lindenthal 2014 (A, abstract only) | Agree it is weak once length and words are known | **Low** | Yes (`zipf_*` in the engine) |
| 8 | **Category / buyer pool** | Positive for B2B, SaaS/tools, local and professional services, home and real estate, health, law, finance. Afternic's monthly top-20 keyword lists: AI, MY, HOME, BET, GROUP, PRO in all 12 months, then HEALTH, IT, REAL, SOLUTIONS, TECH. Funded startups buy brandables (72%); 1 in 715 owns a category keyword | DNW Afternic 12-month analysis (A, official lists); Allemann 2026 (B); Atom 2026 (B, vendor data) | Agree. Allemann avoids info, recipe, review and travel names ("AI providing answers") | **Medium** | **Yes, as a fixed list**: category words in selection settings, refreshed by hand from Afternic's published monthly list |
| 9 | **Trend terms** | Negative for a 2-year hold: 3 of 23 AI hand-regs from 2017 sold after 5+ years; meta and crypto mostly dropped. Hindsight trend lists also leak (engine prototype AUC fell from 0.850 to 0.809 when made point-in-time) | Allemann 2023 (B); Hawkes via earlier note (B); CR-056 engine note (A−, internal) | Agree | **Medium** | Yes: the existing trend list and `trend_pit_*`. Better used as a cap on slots than as score points |
| 10 | **CPC (ad price)** | Used by appraisal tools and named by Hawkes as one demand sign. **No study found** that ties CPC to end-user sales of 2–3 word .coms. Appraisal tools that lean on such data are poor on multi-word names | Estibot FAQ (D); Hawkes via Sullivan (B); DNW appraisal test (B) | Weak support, no test | **Low** | Only by a **human export** from Keyword Planner ("top of page bid" low/high = about the 20th/80th percentile paid, Google help). `keyword_demand` has no CPC column today |
| 11 | **Search volume** | Same as CPC: an appraisal input, untested for our names. After listing, Afternic's exact-match search history is a useful *renewal* signal (Allemann) | Google Keyword Planner help (A, definitions); Allemann 2026 (B); Estibot (D) | — | **Low** (before buying), medium (after listing) | Human-exported Keyword Planner file (`keyword_demand.avg_monthly_searches`, built) |
| 12 | **Keyword sales-to-listings ratio** | Hawkes' preferred liquidity measure (example: 122 "agentic" sales vs about 16,500 listings). The plain sales count we use instead had **no signal** (backtest AUC 0.25; 98% of sold and 100% of dropped names pass ≥1) | Hawkes via Sullivan (B); our backtest (A−) | One source for the ratio; strong internal evidence against the plain count | **Low** for the ratio; **high that the plain count is useless** | The ratio needs listing counts, which only marketplace scraping gives (**not allowed**). The plain count is allowed but useless |
| 13 | **Comparable sales** | Appraisals are credible only with relevant comps (DNW test's main conclusion); comps support a price, they don't predict *whether* a name sells. Our backtest found no $300–$999 comps for our class at all | DNW appraisal test (B); Estibot (D); our backtest (A−) | Agree | **Medium** (for price), low (for sale chance) | Only by hand (NameBio by a human); never automated |
| 14 | **Age of the .com** | Weak alone: "Age on its own is not a complete metric" (Hawkes). Prior history (from Wayback) separated well in our backtest (AUC 0.76), but Wayback is now off-limits for automation | Hawkes via Sullivan (B); our backtest (A−); SVM paper arXiv 1707.00906 (C, unclear labels) | Partial conflict: history helped in our data; age alone, practitioners say no | **Low-medium** | RDAP creation date of the .com; `godaddy_auctions_live.domain_age` |
| 15 | **Past use / backlinks / traffic** | Drives **SEO and casino** buyers' bids, not end-user resale. About 30% of high-authority expired sales in one month became gambling sites; prior branded use also lifts end-user price sometimes (donate.net) | DNW Oct 2026 and Sep 2026 (B); DNW Apr and Jun 2026 (B); Dynadot hub (D) | Agree: it moves auction price; little evidence it moves end-user sale chance | **Medium** (as a price driver), low (as a sale predictor) | Backlinks: no free legal source. `pageviews` in GoDaddy's file is a rough traffic hint. Harmful history stays a manual safety check |
| 16 | **Hyphen / digit / plural** | Negative. DASH includes character-type flags; practitioners avoid hyphens and digits. Plural: no data | DASH (A, flags present, size not reported separately); earlier note (B) | Agree on hyphen/digit | **Medium** (hyphen/digit), low (plural) | Yes; already a form gate |
| 17 | **Appraisal values (GoValue, Estibot, …)** | Poor absolute values; GoDaddy ranks a pool "correctly relative to each other" but uses "a very old model". Estibot is weak on multi-word names, our type. An academic test found tools mostly measure website traits, not the name | DNW appraisal series (B); arXiv 1811.03415 (B); arXiv 1707.00906 (C) | Agree they are unreliable for our names | **High that they are unreliable** | GoDaddy's file has `valuation_cents`. Keep it **out** of the score (it is already in `forbidden_feature_keys`); log it only |
| 18 | **Auction bid count / bidders** | Shows other people want the name at a wholesale price. Silver likes expiry auctions because he can see "how many bidders are participating". But bids are often SEO-driven (row 15). **No study links bid count to later end-user resale** | Silver 2020 (B); DNW 2026 (B); auctions playbook (C/D sources); GoDaddy help (A: number of bids is shown) | Partial conflict (demand proof vs SEO noise) | **Low-medium** | `godaddy_auctions_live.bid_count` (bids, not bidders); `godaddy_auctions` keeps the final price |
| 19 | **Bot-found buyers (today's B)** | Our geo lead count (BBB method): median 1 for sold and for dropped, no signal. The non-geo proxy failed 99% of winners | Our backtest (A−) | Only internal, small n (15/23) | **Medium** that it adds nothing as built | — |
| 20 | **Bot opinion (today's C intent, E timing)** | The v8 score, which leaned on such parts, got AUC 0.44 on the sealed holdout. Different AI models give nearly the same output (arXiv 2501.19361, earlier note) | NOTE-2026-10-14 (A−, internal); arXiv 2501.19361 (A) | — | **Medium** that it adds nothing | — |

**Where the strongest evidence comes from:** rows 1–5 each have an academic or official large sample **and** our own backtest **and** practitioners pointing the same way. Everything else has one kind of evidence at most.

---

## 3. Proposed new score (selection score v2)

### 3.1 Principles
- **Measured parts only.** The bot's opinion is dropped from the score (C, E). The bot can still write its buyer story as text evidence; it gets no points.
- **Few parts, rounded weights.** With 40 names, our own sales will never be enough to learn weights. Dawes (1979) showed that simple equal or near-equal weights on the right predictors do about as well as fitted weights out of sample, and better than expert judgment. So the weights below are rounded and close to each other, tilted only where the evidence is clearly stronger.
- **Gates stay gates.** Safety, trademark, form (no hyphen/digit, length cap) and the Tier A/Tier B demand gates stay pass/fail. The score only orders names that already passed. So risk leaves the weighted sum: it becomes a **penalty**, because a "clean" name scoring 10/10 on G today just adds the same points to everyone.
- **Missing data is visible, not zero.** Today a null part scores 0, so an unmeasured name looks bad. In v2 the score is computed over the parts that were measured, rescaled to 100, and `data_coverage` is shown. Below a coverage of 0.7 the name is "not ranked". (The `coverage_min` 0.7 setting already exists; `coverage_gate` would turn on.)

### 3.2 The parts

| Part | Replaces | What it measures | How (source; automatic or human) | Points rule (raw 0–10) |
|---|---|---|---|---|
| **S — Shape** | A Form | words and length | automatic: `bt1@v3` split, length before `.com` | words: 1 → 10, 2 → 9, 3 → 3, 4+ → 0. Length: ≤8 → 10, 9–12 → 8, 13–15 → 5, 16–18 → 2, ≥19 → 0. **S = 0.6 × words + 0.4 × length.** Syllables are dropped (no evidence, and they duplicate length). Geo names keep the geo bands |
| **R — Registered elsewhere** | (new; part of F) | how many of the 7 sibling endings hold the exact name, counting one owner once | automatic: RDAP. Endings `net, org, co, io, ai, us, co.uk` (the `siblings.endings` list). Two endings with the **same registrar and the same creation day** count as one (the defensive-owner case). Data: `sibling_scans.siblings[].registered` plus `engine_endings` dates | distinct owners: 0 → 0, 1 → 3, 2 → 5, 3 → 7, 4 → 8, 5+ → 10. **+2 (cap 10)** when any of them was created before the .com (for a hand-reg: any at all, since the .com doesn't exist yet) |
| **F — Live businesses elsewhere** | F External (not built) and B Buyers | operating businesses using the exact name on another ending | automatic: `sibling_scans` rows with `live_business = true` and `site_state = 'in_use'`, counted by distinct `company` (unrelated companies). Prefix siblings (`get`, `try`) count half | 0 → 0, 1 → 6, 2 → 8, 3+ → 10 |
| **P — Buyer pool** | C Intent and E Timing | whether the name's words sit in a category with many paying small businesses | automatic, from a **fixed list in selection settings** (not opinion): (a) a word on Afternic's published top-20 keyword lists of the last 12 months; (b) a word on our category list (services, law, health, home, real estate, B2B, SaaS/tools, finance). The list is reviewed by hand monthly | (a) or (b) → 10; a generic consumer or information topic → 4; a trend-only term (on the trend list, without a second category word) → 2 |
| **K — Keyword demand** | D Liquidity | searches and ad price for the exact phrase | **human-entered**: the monthly Keyword Planner export already loaded into `keyword_demand`; add the "top of page bid (high)" column (needs a small migration) | searches/month: 0 → 0, 10–99 → 4, 100–999 → 7, 1,000+ → 10. Top bid (high) ≥ $5 → +2, ≥ $15 → +3 (cap 10). Null when not uploaded (then left out of the sum, lowering coverage) |
| **Risk penalty** | G Risk | warnings that did not kill the name | automatic (existing checks) | −10 points per warning (dead coined mark, URIBL grey, live mark in another class …), floor 0 |

**Dropped and kept only as logged features (no points):** the NameBio retailstats count (no signal, AUC 0.25), syllables, zipf commonness, GoDaddy valuation, the bot's intent and timing opinions, the bot-found lead count. Logging them keeps them testable (§5).

### 3.3 Weights per lane (sum 100)

| Part | Line 1 (new registration) | S8 auction | S8 closeout / fixed price | Evidence behind the weight |
|---|---|---|---|---|
| S Shape | 30 | 25 | 30 | Rows 4–5: high confidence, every source. Heavier for Line 1 and closeouts, where shape is the main thing we know |
| R Registered elsewhere | 25 | 20 | 25 | Row 1 (strongest single signal; DASH, backtest, Squadhelp). A little lower for auctions, where bids already carry some outside-demand evidence (auction score, §4) |
| F Live businesses | 25 | 25 | 25 | Row 3: big lift per hit, independent of R (a live site, not just a registration) |
| P Buyer pool | 10 | 15 | 10 | Row 8: medium confidence. Higher for auctions, because aged names in a strong category are what end users buy and SEO bidders don't care about category |
| K Keyword demand | 10 | 15 | 10 | Rows 10–11: low confidence, so a small weight; it is the only part that needs a human upload |
| **Total** | 100 | 100 | 100 | |

**Honest note on the lane differences:** the evidence supports the ordering of the parts (S, R, F strong; P medium; K weak), not fine differences between lanes. The lane changes are small on purpose. If Dvir prefers one weight set for all three lanes, use **S 30, R 25, F 25, P 10, K 10**. Nothing in the evidence argues against that.

**Mapping to today's code:** the lanes in `settings.ts` are S2–S7 (Line 1 lanes; S2 = geo). The S8 lanes don't have score weights yet. Line 1's weights would apply to S3/S4/S6/S7 (non-geo); S2 geo keeps its geo shape bands with the same weights. Part F is today's `extBusinessRaw: null` in `money.ts`; it would be filled from the newest `sibling_scans` row. Building it means changing the `score` schema (`weights` keys, band lists), which is a selection-settings draft activated with Dvir's approval (CR-001 P-8). This note changes no code.

### 3.4 What part F should be (direct answer)
**F = the number of distinct, unrelated, operating businesses using the exact name on another ending**, read from the newest `sibling_scans` row:
1. take siblings with `registered = true` and `live_business = true` and `site_state = 'in_use'`;
2. group by `company` (case-folded, without "Inc", "Ltd", "LLC"); a missing company name counts as its own owner;
3. prefix siblings (`getX.com`, `tryX.com`) count as half a business;
4. score 0 → 0, 1 → 6, 2 → 8, 3+ → 10.

The **registration-only** signal (registered but parked, or no site) goes into part **R**, not F. That keeps "someone paid for it" apart from "someone runs a business on it". Both are needed: R catches many more sold names (81% vs 23% at a 0.5 registered share in the backtest), and F is rarer but much more selective.

---

## 4. Separate auction-name score (for S8 bids)

Purpose: rank live GoDaddy/Dynadot auctions in our price range and set the maximum bid. It is used **after** the name passes the gates and has a selection score v2 of at least 50.

| Part | Weight | Measured from | Points (0–10) | Evidence and confidence |
|---|---|---|---|---|
| Name score | 50 | selection score v2 / 10 | — | §2 rows 1–5 (high) |
| Price headroom | 20 | `godaddy_auctions_live.price_cents` at about 24 h before the end, vs our maximum bid | price ≤ 30% of max → 10; ≤ 60% → 6; ≤ 90% → 3; above → 0 | Auctions playbook (late bids extend the auction, so the price at T−24h is a fair early read). Low-medium confidence; this is about winning within the cap, not about resale |
| Bids | 20 | `bid_count` at T−24h (bids, not bidders: GoDaddy's file has no bidder count) | 1 → 4, 2–4 → 7, 5–9 → 9, 10+ → 10; **halved when the SEO flag is on** | Silver (B), playbook. SEO noise: DNW (B). Low-medium |
| .com age | 10 | `domain_age` or RDAP creation | ≥ 10 years → 10, 5–9 → 7, < 5 → 4 | Weak alone (Hawkes B); history helped in our backtest (A−). Low |

- **SEO flag** (a warning, not a gate): `pageviews` high for a parked name, or the name was obviously a content or news site. Bids on such names likely come from SEO or casino buyers, so they say little about end users and the price will likely pass our cap. A human also checks the history (safety check 9) before bidding.
- **Maximum bid** (unchanged rule, written before bidding): min($250, 20% of the expected net resale). At a $1,488 Buy Now (about $1,190 net after 20% commission) that is about $238. For S8 Buy Now prices of $2,488–4,888 the $250 cap binds.
- **Closeouts** (no bids, falling price) use the selection score v2 alone. "No bids" is weak negative evidence (Allemann: why did nobody else pay?), so closeouts should need a higher selection score than auctions (for example, 60 vs 50), until the pick-proof shows otherwise.

---

## 5. How to validate the score later

**Our 40 names can't validate it by sales alone** (0–3 expected sales over 2 years). So use three data sets, cheapest first:

1. **Public sold vs dropped (now, free):** the engine already holds `engine_sales` (sold .com names) and `engine_unsold` (dropped after held), with point-in-time endings. Compute each part's AUC and the v2 score's AUC on the newest held-out quarter, as `/engine/health` does. **Pass bar:** v2 AUC ≥ 0.75 and better than v1 by ≥ 0.05; every part with weight ≥ 20 has an AUC ≥ 0.60 alone. If a part fails, cut its weight. This is the main check of the weights.
2. **Wholesale demand (now, free):** for every ended auction in `godaddy_auctions`, compare the name score with the final price and with whether the name fell into closeout (Spearman rank correlation). This measures investor demand, not end-user demand, so it is a sanity check only.
3. **Our own names (slow):** for every name we score, log the data below. At each renewal check (60 days before expiry), compare score bands against Afternic exact-match searches, leads, offers and sales.

**What to log for every scored candidate** (append-only, with the settings label):
- every raw part value (S words, S length, R distinct owners, R before-.com flag, F businesses, P list hit, K searches and top bid), coverage, final score, lane, and the score version;
- the logged-only features: retailstats count, syllables, zipf, GoDaddy valuation, bot intent/timing text, lead count;
- the decision (bought, skipped, not ranked, outbid), the price paid or the max bid, and the date;
- for auctions: price and bid count at first sight, at T−24h and at the end; final price; whether we bid and won; the SEO flag;
- outcomes per owned name, monthly: Afternic exact-match searches, lander visits, leads, offers (amount), sale (price, date), drop.

**Pre-commit the test:** write the pass bars into `docs/internal/` before looking at the results, as CR-056 did for the engine.

---

## 6. How practitioners turn signals into a rank (summary)
- **Hawkes:** expected value = retail price × yearly sale chance, compared with the renewal cost. The sale chance comes from how often businesses adopt similar names (OpenCorporates, Crunchbase, LinkedIn), advertiser interest, exact-phrase web results and comparable sales. He ranks his portfolio by these, not by a fixed formula (Sullivan's write-up: "no explicit naming weights").
- **Appraisal tools (Estibot, GoDaddy):** statistical models over 100+ attributes (length, extension, word count, pronunciation, search popularity, CPC, age, comparable sales). Their absolute values are poor and they are weakest on multi-word names; GoDaddy's still ranks a pool sensibly. They are useful only as a crude first sort.
- **Silver, Allemann:** checklists. Endings registered (and who owns them), live use on other endings, category fit, past use, a fixed maximum bid.
- **Academic:** the DASH paper's gradient-boosted model on 159,000 sales: the extension, ending count and length carry most of the signal; a language model adds about 4%.
- **For us:** a short measured checklist turned into a rounded-weight score (this proposal), checked against the engine's public sold/dropped data. The learned engine stays an information-only second opinion until it meets its own bars (CR-056).

---

## 7. Sources

Grades: A official / large sample; B experienced practitioner; C guide or small/unclear study; D vendor marketing, anecdote or content farm. "Earlier note" = read for `funnel-names-safety-2026-10.md`, not re-read today.

**Academic and large-sample**
1. "Digital Asset Valuation: A Study on Domain Names, Email Addresses, and NFTs" (DASH dataset, 159,047 domain sales 2006–2022, ablations), arXiv 2210.10637 (2022). **A.** https://arxiv.org/abs/2210.10637 (HTML: https://arxiv.org/html/2210.10637)
2. Lindenthal, "Valuable words: The price dynamics of internet domain names", JASIST 65(5):869–881 (2014), DOI 10.1002/asi.23012; SSRN 1885465. **A** (abstract only). https://doi.org/10.1002/asi.23012
3. Phillips, "A Hedonic Regression Model for Internet Domain Name Valuation", Business Valuation Review 22(2) (2003), 155 sales. **B** (old, small; abstract only). https://doi.org/10.5791/0882-2875-22.2.90
4. Lauinger et al., "Game of Registrars: An Empirical Analysis of Post-Expiration Domain Name Takeovers", USENIX Security 2017. **A** (market mechanics). https://www.usenix.org/conference/usenixsecurity17/technical-sessions/presentation/lauinger
5. "Credibility of Automatic Appraisal of Domain Names", arXiv 1811.03415 (2018). **B.** https://arxiv.org/abs/1811.03415
6. "Prediction of Domain Values … Support Vector Machines", arXiv 1707.00906 (2017). **C** (labels unclear). https://arxiv.org/abs/1707.00906
7. Dawes, "The robust beauty of improper linear models in decision making", American Psychologist 34(7):571–582 (1979). **A** (classic; metadata checked, content from the well-known paper). https://doi.org/10.1037/0003-066X.34.7.571
8. "Creative Homogeneity Across LLMs", arXiv 2501.19361 (2025). **A** (earlier note). https://arxiv.org/abs/2501.19361
9. DNJournal 2026 year-to-date top sales chart. **A** (reported sales). https://www.dnjournal.com/ytd-sales-charts.htm

**Official / platform**
10. DNW, "12-month analysis: which keywords are most popular in Afternic domain sales" (Afternic's official monthly lists), Jul 2025. **A** (data) / B (analysis). https://domainnamewire.com/2025/07/08/12-month-analysis-which-keywords-are-most-popular-in-afternic-domain-sales/
11. Google Ads Help, Keyword Planner metrics (searches, top of page bid ranges). **A.** https://support.google.com/google-ads/answer/3022575 and https://support.google.com/google-ads/answer/7337243
12. GoDaddy Help, listing types for GoDaddy Auctions. **A.** https://www.godaddy.com/help/listing-types-for-godaddy-auctions-1525
13. GoDaddy Help, bidding on GoDaddy Auctions (proxy bids, steps, number of bids shown). **A.** https://www.godaddy.com/help/bidding-on-godaddy-auctions-domains-893
14. Dynadot Help, bidding in expired auctions. **A** (own policy). https://www.dynadot.com/help/question/bid-in-expired-auction
15. Our backtest, CR-002 reference results (226 sold vs 224 dropped .com; feature AUCs). **A−** (internal, small). `docs/requests/CR-002-reference/results.md`
16. Our sealed-holdout note on the v8 score (AUC 0.44). **A−** (internal). `docs/requests/NOTE-2026-10-14-buyer-method-v9-tier-a-gate.md`; engine prototype numbers in `docs/requests/CR-056-scoring-engine.md`

**Practitioners**
17. SullysBlog, "Bob Hawkes: the odds, the data, the method" (2026). **B.** https://sullysblog.com/bob-hawkes-the-odds-the-data-the-method
18. Hawkes, NamePros analyses (reported sales 2024; 3-word names 2023; 2021 high-value .com; portfolio ranking 2026). **A/B** (earlier note; NamePros blocks automated reading, not re-read). https://www.namepros.com/blog/
19. Sullivan, "97% of my hand registered domains never sell" (2024). **B.** https://sullysblog.com/97-of-my-hand-registered-domains-never-sell
20. Silver, "Number of TLDs Registered is a Key Metric*" (2020). **B.** https://domaininvesting.com/number-of-tlds-registered-is-a-key-metric/
21. Silver, "# of Registered Extensions Can be Deceiving" (2018). **B.** https://domaininvesting.com/of-registered-extensions-can-be-deceiving/
22. Silver, "Why I Prefer Expiry Auctions Over Private Deals" (2020). **B.** https://domaininvesting.com/why-i-prefer-expiry-auctions-over-private-deals/
23. Silver, "Poll: Expiry vs Private Auctions Bidding" (2019; reader comments). **C.** https://domaininvesting.com/poll-expiry-vs-private-auctions-bidding/
24. Allemann, "How I'm adapting my domain investing" (Jul 2026). **B.** https://domainnamewire.com/2026/07/01/how-im-adapting-my-domain-investing/
25. Allemann, "What types of domains I'm buying in an AI world" (Mar 2026). **B.** https://domainnamewire.com/2026/03/11/what-types-of-domains-im-buying-in-an-ai-world/
26. Allemann, "Hand-registered trend domains can take a while to pay off" (2023). **B.** https://domainnamewire.com/2023/03/06/hand-registered-trend-domains-can-take-a-while-to-pay-off/
27. Allemann, "The ease of building web apps seems to be driving aftermarket sales in 2026" (Oct 2026; 22 of 27 sold names already developed). **B.** https://domainnamewire.com/2026/10/13/the-ease-of-building-web-apps-seems-to-be-driving-aftermarket-sales-in-2026/
28. DNW, "We put 15 domain appraisal tools to the test" (May 2026). **B.** https://domainnamewire.com/2026/05/20/appraisal-review/
29. DNW, GoDaddy appraisal review (May 2026). **B.** https://domainnamewire.com/2026/05/22/godaddys-domain-appraisal/
30. DNW, Estibot review (May 2026). **B.** https://domainnamewire.com/2026/05/21/estibot-domain-appraisals/
31. DNW, "More expired domains, more casino sites" (Oct 2026). **B.** https://domainnamewire.com/2026/10/07/sean/
32. DNW, "NameJet expired domain sales: a bonanza for iGaming" (Sep 2026). **B.** https://domainnamewire.com/2026/09/23/namejet-expired-igaming/
33. DNW, "A banner month for expired domain names" (Apr 2026). **B.** https://domainnamewire.com/2026/04/15/a-banner-month-for-expired-domain-names/
34. DNW, "Nearly $700k of recent expired domain name sales up to $83k" (Jun 2026). **B.** https://domainnamewire.com/2026/06/26/nearly-700k-of-recent-expired-domain-name-sales-up-to-83k/
35. DNW, end-user sale lists, 15 and 21 Oct 2026 (buyer notes). **B** (small, not systematic). https://domainnamewire.com/2026/10/15/end-user-sales-here-comes-si/ and https://domainnamewire.com/2026/10/21/eighteen-end-user-domain-sales-including-si/
36. Atom, "What 1,000 Recent Funding Rounds Tell Us About Domain Demand" (Aug 2026). **B** (vendor, but real data). https://www.atom.com/blog/what-1000-recent-funding-rounds-tell-us-about-domain-demand/
37. Squadhelp ending-count data (2021), via the earlier note. **A−/D** (vendor data, not re-read). See `funnel-names-safety-2026-10.md`
38. Mugford AMA, NamePros (2022), via the earlier note. **B** (not re-read).

**Vendor**
39. Estibot FAQ and methodology. **D.** https://www.estibot.com/faq and https://www.estibot.com/methodology
40. Dynadot Hub, "How to buy expired domains: tips for discovery". **D.** https://www.dynadot.com/hub/aftermarket/how-to-buy-expired-domains-tips-for-discovery

**Independent voices behind the main conclusions:** DASH team, Lindenthal, our backtest, Afternic/GoDaddy official data, Google, Hawkes, Sullivan, Silver, Allemann/DNW (counted once), Atom, Squadhelp, Estibot, the two arXiv appraisal papers, Dawes. Content farms used in the morning's auction research (domainnamelovers, domaindetails, seo.domains) are **not** relied on here.
