# Research round 2: selection score evidence, lift scoring, and free historical data (25 Oct 2026)

**Why:** round 1 (`score-research-2026-10.md`, `historical-data-2026-10.md`) ran out of web searches and could not read NamePros. This round re-checks round 1's claims with new sources, answers the founder's question about **lift-based scoring** (score a name by how much more common its patterns are among sold names than among unsold names), and redoes the data plan under the founder rule of 25 Oct: **free services only**.

**Method and limits:**
- About 60 web searches plus direct reads of official pages, papers (arXiv HTML, PDFs read in the scratchpad) and GitHub repos through the `gh` API.
- NamePros (blog and threads), namebio.com, domainsmoke.com and the ACM full-text page still return **HTTP 403**. Following the rule, I used **no proxy or mirror**. Bob Hawkes' NamePros articles and the NameBio terms are used only through **search-result snippets**, and they are marked that way. No conclusion rests on a snippet alone.
- Nothing was scraped. No marketplace, NameBio page, Wayback or catch service was automated. No account was created. The DASH data file (non-commercial licence) was **not** downloaded; only its licence and file list were read.
- Grades: **A** official or large-sample data; **B** practitioner with a track record; **C** guide or small or unclear study; **D** vendor marketing, single anecdote or content farm. DNW (Allemann) still counts as one voice.
- Our backtest numbers here are the coordinator's newer CR-002 counts (767 sold, 988 dropped), not round 1's 226/224.

---

## 0. Short answer (what changed since round 1)

1. **Ending count holds up, and for price it is even stronger than round 1 said.** Round 1 quoted the DASH paper's cross-asset *average* column. For **domains only**, removing "TLD count" raised the error by **+0.330**, and removing length by only **+0.026** (Table 4, XGBoost, dev set). Professional drop-catchers also pick names with more endings taken (0.8 vs 0.3 for one-off buyers; 28M-name study).
2. **Short and 1–2 words: confirmed for the chance of a sale, weaker for price.** New two-sided data: on NotRenewing ($99 fixed price, 20,824 listings), 1–5 letters sold 3.00% and 17+ letters 1.03%. In the 28M-name drop study, caught names averaged 10 letters and 2.0 words, uncaught 12 letters and 2.5 words. Once ending count and extension are known, length adds little to price.
3. **Auction bids mainly measure investor and SEO demand, not end-user demand.** New sources: in one investor's 150 lost GoDaddy auctions, 64% went to two big resellers and only 1 name was in end use (DNW 2023). Caught expired names had 3.4x more Wayback history and 5.5x more top-1M traffic ranks. Linton: "it only takes one persistent new bidder" to inflate a price. Counter-point: at $4,000+, Hawkes counted about 35% end users or developers among GoDaddy buyers.
4. **Lift scoring is sound, and it has a standard name.** "Share among sold ÷ share among unsold" is a likelihood ratio. Its log is the "weight of evidence" (WoE) behind credit scorecards and naive Bayes. It ranks well with small samples (Ng & Jordan 2001; Domingos & Pazzani 1997; Hand & Yu 2001), but it double-counts correlated patterns and overstates rare ones. §3 gives a safe method: smoothing, caps, joint bins, and counting a missing pattern too.
5. **Data, free only:**
   - **Historical unsold:** the free path is **ICANN CZDS** (free; Dvir signs up). Its agreement is the proof **OpenINTEL** requires before it shares its closed daily .com measurements, which go back to **Feb 2015**. From those, names that left the zone can be derived.
   - **Historical sold:** no free source exists that we may use without written permission.
     - The **DASH dataset is public on GitHub** (159,047 domain sales, 2006–2022, Sedo and Flippa), but its licence is **non-commercial only** unless the author gives written permission.
     - **NameBio's terms forbid using its data to train ML models** without written permission (search snippet of namebio.com/tos). This affects round 1's plan B1, and possibly the engine's NameBio-derived features.
   - **Forward:** the GoDaddy files we already collect give same-population sold and unsold labels (auctions ending with bids vs closeouts ending unsold). This is the best free source for lift tables.

---

## 1. Claim-by-claim verdicts (goal A)

| # | Round-1 claim | Verdict | New evidence (grade) | Agree / conflict, caveats |
|---|---|---|---|---|
| 1 | **Ending count is the strongest predictor** | **Confirmed** (stronger for price) | DASH paper Table 4, domain set: TLD count +0.330 MSLE vs length +0.026, tokens +0.009, vocabulary +0.007 (A). Miramirkhani et al. 2018, 28M dropped names: professional catchers' names had 0.8 other endings vs 0.3 for one-off buyers (A). Squadhelp 2021: "the more extensions … the higher the sell-through" (DNW summary; vendor data, A−/D). Silver: .com as the only ending registered is a sign the words are "not widely used" (B). Hawkes uses dotDB ending counts in his brand-term studies (B, snippet) | Agree on direction. **Caveat 1:** for *being caught* at all, other endings differed little (0.30 caught vs 0.23 uncaught), so ending count is a retail and expert signal more than a mass-demand signal. **Caveat 2:** DASH counts endings from a 2013 DNS census, so for sales before 2013 the count is partly *after* the sale (leakage). **Correction to round 1:** its +0.199 / +0.142 figures were cross-asset averages, not domain figures |
| 2 | **1–2 words and short names sell better** | **Confirmed for sale chance; weakened for price** | NotRenewing (Sully, Aug 2026; 20,824 listings, 496–523 sales, $99 fixed): sell-through 1–5 chars 3.00%, 6–8 2.92%, 9–12 2.70%, 13–16 1.51%, 17+ 1.03% (B, two-sided). Drop study: caught 10±4 chars, 2.0±0.9 words; uncaught 12±5, 2.5±1.2 (A). Hawkes: 3–4 word names were about 3.9% of .com sales of $7,500+ (B, snippet). Squadhelp 2022: names of ≤12 chars were 91% of sales (B, vendor) | Agree on sale chance. Size: about a **3x** gap between the shortest and longest band, and almost flat up to 12 chars. **Conflict on price:** DASH length adds only +0.026 for domains; Bishopi (480,667 .com sales 2024–26) finds median prices flat at $181–$194 for every length above 3 chars (D, dominated by cheap drop-catch sales). NotRenewing buyers at $99 are mostly investors, not end users |
| 3 | **Live businesses on other endings** | **Still thin** (direction supported) | Hawkes counts active companies using the term (OpenCorporates) as a sale-probability input, e.g. "care" in 556,602 active listings (B, snippet, Nov 2025). MediaOptions, 383 upgrades: 32.9% moved from a one-word alt-extension to the .com, 62.9% from a weaker .com (B; premium one-word names only) | Agree that real business use of the *term* matters. No study measures live sibling sites against later sales of 2–3 word .coms. Round 1's conflict stands: few DNW end-user buyers owned the same name elsewhere |
| 4 | **Buyer pool (category) matters** | **Confirmed (medium)** | Sedo/InterNetX Global Domain Report 2026: .com 66% of sales, .com median $595, 76% Buy Now (A). Squadhelp: top industries Agency & Consulting, Tech, Health (B, vendor). NotRenewing: AI the largest category, but "AI isn't automatic success" (B) | Agree. **Caveat:** "how often a keyword appears in sales" counts popular keywords that are also listed far more often (no denominator). Category is safe only as a fixed list, not as a sales count (see #6) |
| 5 | **CPC / search volume weak or untested** | **Still thin for end users; partly contradicted for investor demand** | Drop study: average keyword search volume 833 for caught vs 130 for uncaught names; search results 215K vs 98K (A) | So search volume **does** predict that *investors and catchers* want a name. No new study links it to end-user sales of names like ours. It is a wholesale-demand signal, so it fits the auction score better than the end-user score |
| 6 | **Keyword sales count (retailstats) is anti-predictive** | **Still thin externally** (mechanism explained) | No outside test found. Hawkes prefers the sales ÷ listings ratio (B, via Sully 2026). Sully: adding listings "just makes the denominator bigger" (B) | The internal AUC 0.25 stays the only test. The likely reason is the lift problem: a raw count rewards keywords with huge supply. **New reason to drop it:** NameBio's terms bar ML use of its data without permission (§4) |
| 7 | **Appraisal tools are unreliable** | **Confirmed** | DNW, best-tool verdict (Jun 2026): "no domain appraisal system will be accurate to the nearest dollar" … nor thousand; Atom ranked best; GoDaddy good for *relative* ranking (B). SVM paper (arXiv 1707.00906), full text read: 903 names, "valuable" = auction price ≥ $100, features mostly backlinks and PageRank; 93–97% accuracy on a hand-picked set (C) | Agree. The SVM paper measures SEO value, not name value, so it supports the "backlinks drive auction price" point rather than appraisal quality |
| 8 | **Auction bid count is mixed (SEO and backlink bidders)** | **Confirmed, sharper** | DNW 2023 (Digiventures, 150 lost GoDaddy auctions): HugeDomains 47.3%, PerfectDomain 16.6%, 1 end user (B, n=150). Drop study: Wayback history 10.8% caught vs 3.2% uncaught; Alexa top-1M 3.3% vs 0.6%; fewer than 11% of caught names hosted content (A). Linton: bidders are hard to resell to; one bidder can fake demand (B, snippet). Silver 2013: good values come from names with "few bidders" (B). Hawkes, GoDaddy sales of $4,000+: ~40% investors, ~35%+ end users or developers (B, snippet) | Mostly agree: bids reflect investor, SEO and history demand. **Conflict at high prices:** end users take a real share of $4k+ auctions, which is above our $250 cap. At our price level, the winner is usually a reseller |
| 9 | **Near-equal weights beat fitted weights at small scale** | **Confirmed** | Czerlinski, Gigerenzer & Goldstein 1999 (20 data sets): tallying beat regression on cross-validation on average; it works best when cues are correlated and n is small (A, via Gigerenzer & Brighton 2009). Graefe 2015: equal weights had 5% lower error than regression in 6 of 9 election models (A). Green & Armstrong 2015: simple beats complex across forecasting studies (A). Ng & Jordan 2001: naive Bayes beats logistic regression at small n (A) | Agree. With ~1,700 labelled names, a fitted GBM could beat equal weights; with our 40, never. Use the public sold/dropped data to *check* the weights, not to free-fit them |
| + | **Age of the .com** (round 1: weak alone) | **Mixed** | Drop study: caught names 49 vs 32 months old; professional catchers favour age (A). NotRenewing sold names: median ~9 years, 46% 10+ years (B, sold side only). Practitioners: end users "will not care about age" for a quality name (C, forum) | Age predicts **investor** demand. For end users it is still unproven. Keep it only in the auction score |

**Agreement across source types:** the A sources (DASH, drop study, Sedo report) and the B sources (Hawkes, Silver, Sully, Linton, DNW) point the same way on #1, #2, #7, #8 and #9. The main split is **who** a signal predicts: traffic, history, age, search volume and bids predict *investor and SEO* demand, while ending count, business use of the term and shape predict *retail* demand.

**Selection bias:** every "sold" source is skewed. Reported sales skew high (DNJournal, Hawkes' $4k+ set). NotRenewing and Dynadot (89% of 54,000 sales under $50, Q2 2026) skew low. Our class ($1,488–$4,888 Buy Now on 2–3 word .coms) sits between them, and no source measures it directly.

---

## 2. Changes to round 1's score v2 and auction score

**Selection score v2.** The evidence calls for small changes, not a redesign.

| Part | Round 1 weight (Line 1 / auction / closeout) | Round 2 weight | Why |
|---|---|---|---|
| S Shape | 30 / 25 / 30 | **25 / 25 / 25** | Confirmed, but the gap is about 3x and nearly flat up to 12 chars. **Merge words and length into one joint cell** (§3.3) instead of 0.6 × words + 0.4 × length, because the two overlap |
| R Registered elsewhere | 25 / 20 / 25 | **30 / 25 / 30** | Strongest measured signal (DASH domain ablation; expert catchers; backtest lift ~22). Cap the "before the .com" bonus (§3.2) because ~10 dropped names carry that lift |
| F Live businesses | 25 / 25 / 25 | **20 / 20 / 20** | Still thin; mostly logic plus our backtest. **Nest F inside R** (one ordinal factor, §3.3) so a live sibling is not counted twice |
| P Buyer pool | 10 / 15 / 10 | **15 / 15 / 15** | Confirmed (medium) by Sedo, Afternic and Squadhelp. Keep it a fixed list, never a sales count |
| K Keyword demand | 10 / 15 / 10 | **10 / 15 / 10** (unchanged) | Search volume predicts investor demand (drop study), so it stays higher in the auction lane only |

- **Points inside each part:** derive them from smoothed lift on the engine's sold/dropped data (§3), not by hand. Keep round 1's hand bands only as the fallback until that table exists.
- **Simplest acceptable option:** if Dvir wants one weight set, use **S 25, R 30, F 20, P 15, K 10**.

**Auction score.** Bids get less weight; the name score gets more.

| Part | Round 1 | Round 2 | Why |
|---|---|---|---|
| Name score (v2 / 10) | 50 | **60** | Resale to end users depends on the name. Bids mostly show reseller demand at our price level |
| Price headroom | 20 | 20 | Unchanged (about winning within the cap) |
| Bids | 20 | **10** | Two new independent sources show bids are reseller and SEO driven at < $4k. Keep the halving under the SEO flag |
| .com age | 10 | 10 | Predicts investor demand (drop study); unproven for end users |

**SEO flag:** besides `pageviews`, flag names that look like former content sites. The drop study's strongest catch signals were past traffic and Wayback history, which drive SEO bidders and our cost but not our resale. We still may not automate Wayback, so this stays a manual history check (safety check 9).

**Closeouts:** keep round 1's higher bar (60 vs 50). "No bids" is weak negative evidence, and closeouts are the one place we get a true same-population "listed and unsold" label (§4).

---

## 3. Lift-based scoring (founder's question)

### 3.1 Published two-sided comparisons (sold vs unsold or vs all registered)
- **NotRenewing, sell-through by length** (Sully, Aug 2026, 20,824 listings; B). Lift vs the 2.38% average: 1–5 chars ≈ 1.26, 6–8 ≈ 1.23, 9–12 ≈ 1.13, 13–16 ≈ 0.63, 17+ ≈ 0.43. By extension: .com 2.08% (below average at $99), .xyz under 1%, .site 0%.
- **Caught vs uncaught dropped names** (Miramirkhani et al., WWW 2018, 28M names, Jan–Oct 2017; A). Lifts as share caught ÷ share uncaught:

  | Pattern | Caught | Uncaught | Lift |
  |---|---|---|---|
  | Wayback record | 10.8% | 3.2% | 3.4 |
  | Alexa top-1M | 3.3% | 0.6% | 5.5 |
  | Hyphen | 5.5% | 10.3% | 0.53 |
  | Digits | 13.0% | 16.9% | 0.77 |

  The label is investor or catcher demand, not end-user sale.
- **Squadhelp ending count vs sell-through** (2021; vendor). Rising sell-through with more endings; the numbers are in a chart that was not readable as text.
- **Zone vs sales length:**
  - the .com zone median is 12 chars, mean 13.5 (Verisign data, 2012; DataGenetics, C);
  - "43.4% of all .coms are 14+ chars, 7.8% under 7" (MediaOptions, B).
  
  Against sale shares this gives a rough "sold vs registered" lift by length, but the denominators are old.
- **Our CR-002 backtest** (767 sold / 988 dropped, internal A−). With approximate 95% ranges from the counts:

  | Pattern | Sold | Dropped | Lift | Approx. 95% range |
  |---|---|---|---|---|
  | Another ending before the .com | 22% | 1% | ~22 (27 with unrounded shares) | 10–45 |
  | 1–2 words | 75% | 30% | 2.5 | 2.2–2.9 |
  | ≤10 letters | 41% | 14% | 2.9 | 2.3–3.7 |

  The first row rests on only ~10 dropped names, hence the wide range.

**Nothing published gives two-sided rates for our exact class** (2–3 word .com at $1.5k–$5k Buy Now). Every outside table measures a nearby population (cheap fixed-price, catchers, brandables).

### 3.2 Does anyone use lift / likelihood-ratio / naive-Bayes scores, and do they work?
- **In domains:**
  - Hawkes' method is the closest. He sets an estimated sell-through per name by judging it "stronger or weaker" than his own average name. That is a hand-made lift on a base rate (B, snippet, Apr 2026).
  - Squadhelp's "Domain Insights" shows ending counts as a popularity marker (B).
  - No published domain study tests a naive-Bayes or WoE score against a GBM. DASH used XGBoost and BERT on price, not sale chance.
- **In general** (all A):
  - Credit scorecards turn each binned variable into WoE = ln(share among goods ÷ share among bads) and add them up. This is the standard method where models must be explainable. Siddiqi's rules: each bin ≥ 5% of rows, no empty bins, monotonic WoE.
  - Naive Bayes (the same sum of log-lifts) **ranks** well even when patterns are correlated (Domingos & Pazzani 1997; Hand & Yu 2001). It beats logistic regression at small n (Ng & Jordan 2001).
  - **Known failures:** its probabilities are over-confident, because correlated patterns add the same evidence twice. A rare pattern with few counts gets a huge, unstable lift.
  - Tallying and equal weights do well when cues are correlated and n is small (Czerlinski et al. 1999).
- **Correlation problem, in our numbers:** "≤10 letters" and "1–2 words" overlap. Adding ln 2.9 + ln 2.5 = 2.0 counts the shortness evidence about twice.
- **Rare-pattern problem:** ln 22 = 3.1 for "ending before .com" alone outweighs both shape patterns. It rests on ~10 dropped names, and it may be partly leaked or biased by how the two sets were built.
- **Missing-pattern side:** a name *without* "ending before .com" gets ln(0.78/0.99) = −0.24, not 0. Dropping the absent side makes every score drift upward.

### 3.3 Recommended method
1. **Bins, pre-registered:** define each pattern as an ordinal bin before looking at the data.
   - **Shape:** one *joint* cell of words × length (1–2 words / 3 words) × (≤8, 9–12, 13–15, 16+), so the overlap is handled inside one factor.
   - **Outside evidence:** one ordinal factor:
     0. nothing registered
     1. registered elsewhere only
     2. registered elsewhere before the .com
     3. one live business
     4. two or more live businesses
     
     This nests F in R, so a name can't collect both.
   - **Buyer pool:** list hit / generic / trend-only.
   - **Keyword demand:** search-volume bands, or "not uploaded".
2. **Smoothed log-lift per bin:** points = ln[(k_sold + a)/(n_sold + 2a)] − ln[(k_unsold + a)/(n_unsold + 2a)], with a = 1. Then **shrink toward 0** by n/(n + 50), where n is the bin's smaller count, and **cap at ±2.0** (lift ≈ 7.4). The cap is for the rare-pattern case until a same-population test (step 5) shows the lift is real. Require ≥ 30 names per side per bin, or merge bins.
3. **Score:** sum the bin points (absent bins included), add the base log-odds, and map to 0–100 with the logistic curve for display. Ordering is what matters; don't read the number as a probability.
4. **Correlation check:** fit one logistic regression on the WoE values (one coefficient per factor). If a coefficient falls well below 1 (say < 0.6), that factor overlaps others; scale it down. This is the scorecard practice, and it needs only a few parameters, so ~1,700 rows suffice.
5. **Validate:** on the newest held-out quarter, compare AUC for:
   1. WoE score
   2. round-2 hand weights (§2)
   3. the engine's GBM
   
   Pre-commit the bar: adopt WoE if it beats the hand weights by ≥ 0.02 AUC; on a tie keep the simpler hand weights. Prefer **same-population labels** (GoDaddy auctions with bids vs closeouts unsold; sold vs listed-unsold), because sold-vs-dropped mixes aftermarket names with never-listed hand-regs and inflates lifts.
6. **Refresh:** recompute the bins quarterly from the engine's tables, append-only and versioned like `pricing_settings`. Changing the table is a selection-settings draft activated with Dvir's approval (CR-001 P-8).

**Why this over a GBM now:** at a few thousand rows, WoE plus one logistic layer is about as accurate as a tuned GBM in scorecard practice, can be explained per name, and fails visibly. Once the engine holds ~10k rows per class, the GBM can be re-tested against it.

---

## 4. Historical data, free only (goal B)

**Paid options exist** but are not recommended (founder rule, 25 Oct):
- NameBio: Business membership about $100/month (2019 price) with 50k exports a month; paid API by quote;
- DNPric.es: full download about $1,999 (snippet);
- zone history: dns.coffee $90/month, AllZonefiles Pro $79/month;
- dropped-domain feeds: WhoisFreaks from $84/month, WhoisXML from $129/month;
- WHOIS tools: DomainTools from $99/month, ViewDNS from $29/month.

| # | Source | Gives | Depth | Price | Terms (short quote, URL) | Fits our rules? |
|---|---|---|---|---|---|---|
| F1 | **ICANN CZDS .com zone** (Verisign) | Today's .com zone; daily diffs give removals going forward | Current file only | **Free** (*"provided to users at no cost"*, CZDS policy) | Lawful use; no marketing to non-customers; no *"high volume, automated"* queries to registry systems (ICANN CZDS policy, https://www.icann.org/resources/pages/czds-2014-03-03-en) | **Yes, Dvir signs up.** Mainly needed as the key to F2. Daily file is several GB |
| F2 | **OpenINTEL closed .com measurements** (Univ. Twente) | Daily .com name set with DNS records since **2015-02-20**; dropped names can be derived from names that disappear | 2015 → now | Fee not stated | Access to gTLD data *"if and only if you demonstrate that you have zone file access"* (https://openintel.nl/data/access-to-closed-data/). Open data is CC BY-NC-SA | **Best free path to historical unsold**, if they agree after CZDS proof. Ask whether commercial internal use is allowed and whether a fee applies. Unverified: response time |
| F3 | **GoDaddy auction inventory files** (already collected) | Auctions with bids at the end (sold, wholesale); closeouts that end unsold (**listed and unsold, same population**) | Forward only (no archive) | Free | Official public host | **Yes.** Lower the stored floor from $500 to $100 for engine rows. Gives same-population labels for lift tables. Rows after 2026-10-14 need Dvir to move the holdout date |
| F4 | **DASH dataset** (Kai Sun, GitHub `kaisunresearch/dash`) | 159,047 domain sales (name, price, date; Sedo 79%, Flippa 21%), 2006–2022, all TLDs, with features | 16 years | Free | *"non-commercial research purposes only … unless prior written permission"* (LICENSE, https://github.com/kaisunresearch/dash) | **Only with the author's written permission.** Ask (free). Data likely gathered from public auction pages, so note provenance. Sold only; .com share not checked |
| F5 | **NameBio free endpoints** (RetailStats, TLDStats, drop order) | Per-keyword aggregates; .com drop list | All-time aggregates / forward | Free | API docs: *"may incorporate … attribution is required"*. **But** the ToS (snippet, namebio.com/tos, 403 to us) bars using data *"to train … machine learning models"* without written permission | **Conflict to resolve:** the docs allow reuse with attribution; the ToS bars ML. Until NameBio confirms in writing, keep NameBio data **out of the learned engine**. A scored feature arguably is ML use too |
| F6 | **DNJournal, DNW** sales reports | High-value sold names | DNJournal since late 2003 (archive confirmed) | Free to read | No copying without written consent (both sites) | Only with permission; skewed high; useful as a small check set |
| F7 | **Dynadot `get_closed_auctions`** | Closed auctions | — | Free | Per Dynadot's docs (snippet): returns *"closed auctions of specified account"*, so **our own auctions only**. Our account is also barred from auction APIs (CR-071 R-9) | **No** as a market source. Correction to round 1, which hoped it gave market history |
| F8 | **GoDaddy Auctions API** (opened to all members, Aug 2026) | Bid and buy | — | Free | Docs list no closed or sold history endpoint (https://developer.godaddy.com/en/docs/api-users/auctions) | No history source |
| F9 | **dns.coffee Academic** | Zone history, ~1 year of removed-domain feeds | 2011 → now (per name); feeds ~1 year | Free for academics only | *"not resold or embedded in a commercial product"* (https://dns.coffee/pricing) | **No.** We are commercial, so the free plan doesn't honestly fit |
| F10 | **WhoisFreaks free GitHub feed** | 10,000 expired/dropped names a day | Since Mar 2026 | Free | **No licence file** (all rights reserved by default) | **No** until they grant a licence |
| F11 | **Common Crawl** | "Was there a live site at time T" feature | 2008 → now | Free | Limited non-exclusive licence (round 1) | Yes, for features only |
| F12 | **Published aggregates** (Sedo report, Afternic monthly keywords and TLD sell-through, Escrow.com index, Dynadot quarterly, NotRenewing tables) | Base rates and two-sided rates by pattern | Yearly / monthly | Free | Read and cite; no bulk copying | **Yes**, to set priors and sanity-check the lift table |

**Recommended free plan (cheapest legal path to ~10k sold and ~10k unsold .com):**
1. **Now:** lower the GoDaddy engine floor to $100 (F3).
   - Auction endings with bids give an estimated ~100+ .com rows a day; closeouts ending unsold give at least as many.
   - That reaches about 10k per class in roughly 3 months, all in **one population**, which is best for lift.
   - Needs Dvir to move the holdout date monthly, or the engine to use a later test quarter.
2. **Dvir signs up for CZDS (free)**, then asks OpenINTEL for closed .com access (F2).
   - If granted, derive names that left the zone between 2024 and Oct 2026 and were held ≥ 1 year.
   - Confirm each with RDAP (as in round 1's Step A).
   - This gives historical unsold with no NameBio and no payment.
3. **Dvir writes three free permission requests:**
   - DASH author (F4: historical sold, 2006–2022);
   - NameBio (F5: is ML use of free-endpoint data allowed?);
   - DNJournal (F6: small high-price check set).
   
   Until DASH or NameBio says yes, **historical sold stays empty**, and the engine trains on forward GoDaddy rows only.
4. **DOM check (code, not research):** see whether any NameBio-derived value feeds the learned engine today (e.g. retailstats features). If so, hold it out until NameBio confirms (F5).

**Round-1 corrections in one place:**
- the DASH numbers (§1 #1);
- the DASH data is public, but non-commercial;
- OpenINTEL needs CZDS proof;
- NameBio's ToS bars ML training;
- Dynadot closed auctions cover the account's own auctions only;
- zonefiles.io shut down on 15 Aug 2025 (its successor AllZonefiles.io is paid).

---

## 5. Still uncertain after two rounds
1. **No two-sided rates exist for our class.** All outside lift tables are from neighbouring populations: $99 investor sales, drop-catch, brandables.
2. **Live-business effect (F):** still mostly our backtest and practitioner logic.
3. **How much of the "ending before the .com" lift is real** vs leakage or sampling. It rests on ~10 dropped names, so the cap stays until F3 data tests it.
4. **Search volume and CPC for end users:** shown only for investor demand.
5. **Bid count at < $250:** no study links it to end-user resale; the evidence says reseller demand.
6. **Terms not read first-hand:** the NameBio ToS (403), and whether CZDS terms restrict deriving training labels.
7. **Access not yet known:** OpenINTEL's fee and commercial position.
8. **Unchecked counts and volumes:** the DASH .com share, and the daily GoDaddy volumes (estimates, not measured).
9. **Whether WoE beats the hand weights** on our data. Pre-registered test in §3.3 step 5.

---

## 6. Sources (new in round 2 unless marked "re-read")

**Academic / large sample**
1. Sun, *Digital Asset Valuation* (DASH), arXiv 2210.10637, Table 4 re-read for domain-only ablations. **A** (re-read). https://arxiv.org/html/2210.10637
2. DASH repository and LICENSE (non-commercial). **A.** https://github.com/kaisunresearch/dash
3. Miramirkhani, Barron, Ferdman, Nikiforakis, *Panning for gold.com*, WWW 2018, full text (Tables 1 and 3). **A** (round 1 had metadata only). https://securitee.org/files/dropcatching_www2018.pdf
4. Bikadi, Ahangama, Hazai, SVM domain values, arXiv 1707.00906, full text (903 names, $100 threshold). **C** (re-read). https://arxiv.org/abs/1707.00906
5. Lindenthal, *Monocentric Cyberspace: The Primary Market for Internet Domain Names*, J. Real Estate Finance & Economics 57 (2018), abstract. **A** (abstract). https://ideas.repec.org/a/kap/jrefec/v57y2018i1d10.1007_s11146-016-9547-2.html
6. Ng & Jordan, *On discriminative vs. generative classifiers*, NIPS 2001. **A.** https://gwern.net/doc/ai/scaling/2001-ng.pdf
7. Domingos & Pazzani, *On the optimality of the simple Bayesian classifier under zero-one loss*, Machine Learning 29 (1997). **A.** https://link.springer.com/content/pdf/10.1023/A:1007413511361.pdf
8. Hand & Yu, *Idiot's Bayes, not so stupid after all?*, Int. Statistical Review 69 (2001). **A.** https://onlinelibrary.wiley.com/doi/10.1111/j.1751-5823.2001.tb00465.x
9. Gigerenzer & Brighton, *Homo Heuristicus* (2009), reporting Czerlinski, Gigerenzer & Goldstein 1999 on tallying vs regression. **A.** https://sites.socsci.uci.edu/~lpearl/courses/readings/GigerenzerBrighton2009_HomoHeuristicus.pdf
10. Graefe, *Improving forecasts using equally weighted predictors*, J. Business Research 68(8) (2015). **A.** https://www.researchgate.net/publication/258809219
11. Green & Armstrong, *Simple versus complex forecasting: the evidence*, J. Business Research 68(8) (2015). **A.** https://ideas.repec.org/a/eee/jbrese/v68y2015i8p1678-1685.html
12. SAS Global Forum 141-2012, WoE-binned scorecards (Siddiqi practice). **B.** https://support.sas.com/resources/papers/proceedings12/141-2012.pdf
13. DataGenetics, .com name length analysis (Verisign data, 2012). **C.** http://datagenetics.com/blog/march22012/

**Official / platform data**
14. Sedo and InterNetX Global Domain Report 2026, via DNW (Mar 2026). **A** (data) / B. https://domainnamewire.com/2026/03/23/new-report-contains-interesting-aftermarket-domain-name-data/
15. Dynadot Q2 2026 sales data (54,000 sales), via DNW (Sep 2026). **A** / B. https://domainnamewire.com/2026/09/29/dynadot-shares-data-from-54000-domain-sales/
16. Afternic, 2024 TLD rundown (sell-through ranking by TLD). **A.** https://blog.afternic.com/2024-tlds/
17. Squadhelp 2021 data release, via DNW (ending count vs sell-through). **A−/D** (vendor). https://domainnamewire.com/2021/12/22/squadhelp-releases-treasure-trove-of-data/
18. Escrow.com Domain Investment Index reports (context). **A.** https://www.escrow.com/domains/investment-index-reports
19. ICANN CZDS policy and help. **A.** https://www.icann.org/resources/pages/czds-2014-03-03-en
20. OpenINTEL, access to closed data. **A.** https://openintel.nl/data/access-to-closed-data/
21. dns.coffee pricing, terms and OpenAPI (feeds ~1 year), re-verified. **A/D** (re-read). https://dns.coffee/pricing, https://api.dns.coffee/openapi.json
22. GoDaddy Auctions API docs (no history endpoint). **A.** https://developer.godaddy.com/en/docs/api-users/auctions
23. Dynadot API commands (`get_closed_auctions`: own account; via search snippet). **A** (snippet). https://www.dynadot.com/domain/api-commands
24. NameBio API docs, re-verified (credits; "past year" limit; no USD price). **A** (re-read). https://api.namebio.com/docs/
25. NameBio Terms of Service, AI/ML training clause (search snippet only; 403). **A** (unverified first-hand). https://namebio.com/tos

**Practitioners**
26. Sully, *What Domain Names Actually Sell on NotRenewing?* (Aug 2026; length and extension tables). **B.** https://sullysblog.com/what-types-of-domain-names-actually-sell-on-notrenewing
27. Sully, *What the First 500 Sales Taught Me About Domain Liquidity*, NamePros (snippet). **B.** https://www.namepros.com/blog/what-the-first-500-sales-taught-me-about-domain-liquidity.1395363/
28. Hawkes, *Who Bids On High-Value Domain Auctions?*, NamePros (snippet). **B.** https://www.namepros.com/blog/who-bids-on-high-value-domain-auctions.1220609/
29. Hawkes, *How I Ranked Every Name In A 2000+ Domain Name Portfolio* (Apr 2026; snippet). **B.** https://www.namepros.com/blog/how-i-ranked-every-name-in-a-2000-domain-name-portfolio.1383894/
30. Hawkes, *How Many Businesses Have That Term In Their Name?* (Nov 2025; snippet). **B.** https://www.namepros.com/blog/how-many-businesses-have-that-term-in-their-name.1368356/
31. Hawkes, *Sales of Domain Names Containing Three or Four Words* and *Premium Two-Word .COM Sales in 2019* (snippets). **B.** https://www.namepros.com/blog/sales-of-domain-names-containing-three-or-four-words.1179809/
32. Hawkes, *Domain Name Sell-Through Rates* (snippet: ~1.1% average). **B.** https://www.namepros.com/blog/domain-name-sell-through-rates.1164616/
33. DNW, *Who wins the domains you lose?* (Jan 2023; 150 auctions). **B.** https://domainnamewire.com/2023/01/12/who-wins-the-domains-you-lose/
34. DNW, *And the best automated domain name appraisal tool is…* (Jun 2026). **B.** https://domainnamewire.com/2026/06/05/and-the-best-automated-domain-name-appraisal-tool-is/
35. DNW, *GoDaddy opens updated Auctions API to all users* (Aug 2026). **B.** https://domainnamewire.com/2026/08/13/godaddy-auctions-api/
36. Silver, *Before Buying Expiring Domain Names, Be a Sleuth* (2013). **B.** https://domaininvesting.com/before-buying-expiring-domain-names-be-a-sleuth/
37. Silver, *STR on Brandable Domain Names* (Oct 2023). **B.** https://domaininvesting.com/str-on-brandable-domain-names/
38. Morgan Linton on bidder counts in expired auctions (snippet; page 404 on fetch). **B** (snippet). https://www.morganlinton.com/the-truth-about-buying-and-selling-expired-domains-part-two/
39. MediaOptions, *The Statistics Behind Domain Upgrades* (383 upgrades). **B.** https://mediaoptions.com/blog/the-statistics-behind-domain-upgrades/
40. tldinvestors, domain length and sell-through (Squadhelp chart; no numbers). **C.** https://tldinvestors.com/2020/09/domain-length-and-sell-through.html
41. NamePros thread, NameBio representative on bulk data ("four-figure range"; snippet). **B** (snippet). https://www.namepros.com/threads/is-it-possible-to-pay-for-all-domain-sales-history-2007-2021.1265348/
42. DNW, NameBio paid accounts (2019; membership tiers). **B.** https://domainnamewire.com/2019/01/07/namebio-features/
43. OnlineDomain, Mike Mann monthly sales reports (context on reported-sales bias). **C.** https://onlinedomain.com/2026/10/06/domain-name-news/mike-mann-sells-8-domains-for-237216-in-july/

**Vendors (D; context only, nothing rests on them)**
44. Bishopi, *What 480,667 .com Sales Reveal* (median price by length). **D.** https://bishopi.io/blog/what-480667-com-sales-reveal-about-the-2026-domain-economy
45. AllZonefiles.io pricing (internal use only on Basic/Pro). **D.** https://allzonefiles.io/pricing
46. WhoisFreaks pricing and free GitHub feed (no licence). **D.** https://whoisfreaks.com/pricing/expiring-dropped-domains, https://github.com/WhoisFreaks/daily-expired-and-dropped-domains
47. WhoisXML API, DomainTools, ViewDNS pricing pages and reviews. **D.** https://whois-history.whoisxmlapi.com/api/pricing, https://viewdns.info/api/pricing/
48. DNPric.es full dataset download (~$1,999, snippet; https page refused connection). **D.** http://dnpric.es/

**Not usable (checked):**
- Essex undergraduate auction paper: about iPhone eBay auctions, not domains;
- Logan Stanley: no domain-research source found under that name;
- Josh Reason, Shane Cultra, Mike Mann, Michael Cyger: no data posts found beyond anecdotes (Cyger's "3% sell-through" is a snippet only).
