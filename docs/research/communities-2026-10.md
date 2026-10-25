# Research: what communities say (founders, forums), compared with our system (25 Oct 2026)

**Why:** Dvir asked for the best information from communities (Reddit, Facebook, Indie Hackers and the rest), checked against our system and added to the knowledge base. New information changes the system only if it shifts the weight of the evidence.

**Output:** `data/knowledge/0006-communities.jsonl`. It holds 44 new sources, 11 new claims and 64 evidence rows. 28 of those rows land on 14 claims that already existed in files 0002 and 0003. There are 2 links: one `same_author` and one `cites`. The adapted validator ran over files 0001-0003 plus 0006: 0 errors.

**Method and limits**
- Hacker News: read through the free Algolia API, with no key and no HTML scraping. I made about 40 API calls and pulled about 6,000 comments by keyword. I then read the purchase statements myself, by hand.
- NamePros: I read thread pages only when they loaded without a challenge. Blog and article pages answered 403, and I did not retry them.
- Stack Exchange: read through its API, with no key.
- Indie Hackers: its pages returned 403, so I know them only from search snippets. Those are graded D with credibility 5.
- Product Hunt and the founder blogs: read directly.
- No login, no bot check passed, no Reddit API, no Chrome.
- Grades, the same as in our other files:
  - **A**: official or large-sample data.
  - **B**: named practitioner or investor with a track record.
  - **C**: forum threads with several reports, or a named single case.
  - **D**: one anonymous post, a snippet only, or a vendor. D is kept for the record and weighs 0.
- Self-reported sales are flagged with `survivorship`. Quotes are 15 words or fewer, and taken word for word only from pages I read (mostly the Hacker News API text).

---

## 1. Which communities were reachable and useful

| Community | Reachable? | Useful? | What we got |
|---|---|---|---|
| **Reddit** (r/Domains, r/DomainNames, r/Entrepreneur, r/SaaS, r/juststart) | **No.** Our search tool refuses reddit.com outright ("not accessible to our user agent"). `old.reddit.com` gives 403. `site:reddit.com` searches return no Reddit pages. | Not usable. | Nothing. Reddit's Data API also needs a commercial agreement (`knowledge-sources-2026-10.md` §1.2). Reddit counts only when someone else quotes it, and the only quote we found was a 2014 DomainGang piece with no data. |
| **Hacker News** | **Yes**, through the free Algolia API. | **The best end-user source.** Founders say what they paid, what they refused and how they reached the owner. | 10 threads and 3 single comments (C and D). About 31 stated .com purchase prices and about 12 walk-aways with the ask stated. |
| **NamePros** | **Partly.** Thread pages loaded without a challenge on 25 Oct. Blog and article pages answered 403. | **Useful for investor data**: auctions, Afternic channels, sell-through. | 18 threads, of which 4 are measured samples: the HugeDomains auction tracking (n=150), the daily auction tracking (about 500 a day), a 9,390-name Afternic month and a 7,000-name sell-through table. |
| **Indie Hackers** | **No** (403). Search snippets only. | Weak: it confirms the "about $1-2k" mood. | 3 posts, all D. |
| **Product Hunt** | Yes, a public discussion. | Some use. | 1 poll: 64% of makers buy the domain first; two makers refused $10k and $27k asks. Launch counts came via a NamePros thread. |
| **Stack Exchange** (Webmasters) | Yes, through its API. | Thin, as expected. | 1 Q&A (2010). |
| **Founder blogs** (Medium, Substack, company blogs) | Mixed. Medium and some Substack pages answered 403 or 404. Company blogs loaded. | Useful as named single cases. | SuperTokens, Resend, Cofounders.com, Pilot, Experiment.com, Fred Wilson (AVC), Paul Graham. |
| **Facebook** groups | Not tried. They are closed behind a login, and we never pass one. | No. | The only evidence is a 2014 NamePros thread: Facebook groups sell between investors at $xx-xxx and give almost no end-user sales (D). |
| **Quora** | No (403). | No. | Nothing. |
| **DNForum, Acorn Domains** | Yes. | Not useful. | DNForum mostly reposts DomainNameWire's end-user lists, which are already in our base, so I added nothing. I found no Acorn data threads about .com. |

**Lesson for later rounds:** for founders' (end-user) views, Hacker News through Algolia is the only community source that is free, legal and readable at volume. NamePros threads are readable today, but that may change. A session should read them only when they load and never pass a challenge.

## 2. End-user evidence: what founders pay and how they buy

### 2.1 Prices founders report paying for an already-owned .com (claim C1)
I hand-coded 31 stated .com purchases. The sources were the two "most you've paid" threads on Hacker News (2015, 2017), single Hacker News comments, and named founder posts.

| Band | Count | Share |
|---|---|---|
| under $1,000 | 6 | 19% |
| $1,000-$4,999 | 9 | 29% |
| $5,000-$9,999 | 8 | 26% |
| $10,000 and up | 8 | 26% |

- **Median $5,000.** Range $50 to $400,000.
- **Bias:** these are "the most I ever paid" reports and blog-worthy deals, so the true median of founder purchases is lower. The six-figure cases are all one-word names (pilot, experiment, cofounders), far from what we sell.
- **Cases close to our names:**
  - supertokens.com: a two-word name that moved from .io, about $8,000 plus a broker.
  - myh2o.com: $3,500.
  - ipvm.com: $5,000.
  - A business-name .com: $1,600.
  - The .com of a business that started on .co: $9,000.

### 2.2 What bootstrapped founders accept (claim C2)
In threads where founders ask "how much should I pay?" (Hacker News 2013 x2, Stack Exchange 2010, Indie Hackers):
- The common anchor is about **$1,000**. Range $200-$2,000, from 7 independent statements.
- "$1,500 is very reasonable" was the majority view for a $1,500 Buy Now .com.
- The standard advice is to wait until the business makes money.

**Venture-funded startups are a different buyer** (claim C24). Fred Wilson's advice went from $10k to $50k, and the reported deals run from $25k to $400k.

### 2.3 When they walk away (claim C3)
Twelve stated walk-aways with the ask named: $1,800, $2,600 (HugeDomains), $4,395 (HugeDomains), $5,000 twice, $10,000 three times, $27,000, $30,000, $50,000 (.ai) and $53,000. In those cases founders took the .org, a hyphen, a .co or .io, or another name.

Below about $2,000 the threads say "buy it". From about $5,000 they mostly say "pick another name" unless the business already makes money.

### 2.4 How they reach the owner (claim C22)
- Founders' own reports: mostly **direct email through WHOIS** (Resend, Experiment.com, several Hacker News comments) or **a broker** (Sedo, GoDaddy's broker service, DomainAgents, an unnamed broker for SuperTokens).
- Almost no founder names Afternic Buy Now as the route.
- Investor data says the opposite for names listed with Buy Now. In a 9,390-name Afternic portfolio, 11 of 22 sales came through GoDaddy search and 6 through partner registrars, so **77% came through the network**. Only 5 came through the lander.

Reading both together: buyers who already want a name hunt the owner, while buyers who are searching for a name find our Buy Now at the registrar. **We depend on the second kind.**

### 2.5 Negotiation (claim C4)
Founders who negotiated paid between 10% and 100% of the first ask:
- "about 30-40% of ask" (one founder buying several names)
- 63% (Resend)
- 10% (tgood.com and a personal name)
- about 100% (SuperTokens)

This is thin evidence: mostly C and D sources.

### 2.6 The upgrade mechanism (supports the live-business signal)
- Paul Graham counted that only **66% of a YC batch owned their .com**, against 100% of YC's top 20 companies. On Product Hunt, about 67% of launches use .com (243 of 365 counted).
- About a third of new companies therefore start without the .com. The cases above show that those who grow buy it later, usually after starting on .co, .io or .net.
- This is the mechanism behind our signals "other endings registered" and "live business on another ending".

## 3. What we learned per weak question

| Question | New evidence (grade) | Effect on the verdict |
|---|---|---|
| `end-user-price-band` | C1 (median $5k, skews high), C2 (bootstrappers about $1k), C3 (walk away from about $5k), C24 (funded startups $10k-$400k), C4 (paid 10-100% of ask). Mostly C and D, direct population. | Adds the **first direct end-user clusters** (founders are the buyers). The band in which end users say yes is roughly **$1,000-$5,000**, which fits a $1,488 Buy Now and the lower S8 rungs. |
| `s8-max-bid-share` | HugeDomains paid $42-$540 for names it relisted at $2,095-$2,995 (median buy/ask about 6%, ceiling about 20%, n=150, C). Investors' "fair wholesale" poll: mode 10% (n=11, C). Brad Mugford: generic two-word .coms fetch a lower share than liquid formats (C, qualifies). | **Supports** a maximum of about 5-20% of the retail ask. Our $160 is 16% of the $1,000 expected net resale, 11% of $1,488 and 3-6% of the S8 ladder. |
| `s8-auctions-vs-closeouts` | Low-price GoDaddy auctions are won mostly by investors who relist at retail: 56% by HugeDomains in one sample, 25-35% of tracked names sold (C, 2016-2018, old). A thread says contested names cost "hundreds or thousands" (D). One closeout bought for about $30 resold for $1,788 (C, survivorship). | No new weight either way. The data is old and says nothing on end-user resale by source. |
| `signal-auction-bid-count` | The two-bidder run-up with a non-paying winner was confirmed by 236 replies (C, linked `same_author` to Brad Mugford's X post). A known operator once bid up every single-bid auction to about $100 (C). | **Supports "weak signal"**, which strengthens F8 (bids weight 10 -> 5). |
| `s8-auction-win-finality` | Regular bidders say reversals within the post-expiry window are routine; a lawsuit is open (C). | Supports the current rule: import only after the transfer check (rule 15 of `auctions.md`). |
| `signal-live-businesses` | Founders on .co, .io or a business name bought the .com for $1,600-$9,000 (C and D). Paul Graham's YC count (B, indirect). NameBuyer's strategy of buying names used by small growing companies (C). | **Supports useful_signal** with the buying mechanism, not only correlation. |
| `signal-buyer-pool` | Two-word .coms sell when the words form "one natural commercial idea"; random stacks don't (C, Brad Mugford). | Supports. This matches auction score v2's word-quality step. |
| `signal-shape-words-length` | 481 NameBio sales: average price $2,735 for one word, $1,221 for two, $882 for three or more (C, disputed method, qualifies). | Small support (price, not sale chance). |
| `sell-through-yearly` | NameBuyer about 1.0-1.5% a year at $1,450-$2,000 average prices (n about 7,000, C). One Afternic month annualised to about 2.8% (C). 9.3% for 300 premium new-gTLD names (C, indirect). | Supports the F15 range (0.5-3.5%). |
| `line1-hand-regs-worth-buying` | Founders register a name per project and let most lapse; holders say renewals eat the profit (C and D). | Supports "small side line" or none. No change. |
| `signal-trend-terms` | One newcomer's biggest sales were NFT and crypto names (D, contradicts). | Weight 0. No change. |
| Pricing elasticity (claim from 0003, price band below $2,500) | **NameBuyer's segments: 1.5% sold a year at a $1,450 average, 1.0% at $2,000, 0.43% at $4,681** (C, contradicts "no elasticity below $2k", but these are segments, not a test). | Opens a real question for F7 (section 4). |

## 4. Comparison with our system

| Current rule | Community evidence | Verdict | Enough weight to reconsider? |
|---|---|---|---|
| **Max bid = 20% of expected net resale ($1,000) less commission, scaled by score -> $160** (`auctions.md` rule 18) | HugeDomains, the biggest retail buyer at these auctions, pays a median of about 6% of its ask and rarely more than about $500 on a $2-3k ask. Investors' fair-wholesale mode is 10%. | **Supported** | No |
| **Expected resale $1,000** (not the list price) | Bootstrapped founders anchor at about $1,000; founders' stated purchases have a median of about $5k with a high skew; asks of $1.8k-$4.4k drew walk-aways. | **Supported** (realistic, slightly conservative) | No |
| **Line 1 / default Buy Now $1,488** | Inside the band where the threads say "buy it" ($1,000-$2,000). NameBuyer's $1,450-average segment sold best (1.5% a year). | **Supported** | No |
| **S8 ladder Buy Now $2,488 / $3,488 / $4,888 by length** | $4,888 is above every bootstrapper anchor and above HugeDomains' $2-3k asks. NameBuyer's segment with about $4,700 averages sold 0.43% a year, about a third of the $1,450 segment. NameBio (0003) found no change in sales count below $2,000-2,500, which says nothing about $4,888. | **Challenged (weakly)** | **Not yet.** All C, indirect, and segment comparisons, not tests. But it changes the F7 price test design (section 5). |
| **Floor 65% of Buy Now; private walk-away about 48%; min offer $100** | Founders report paying 10-100% of ask, typically a third to two thirds; negotiation is the norm. | **No conflict**: the walk-away near 48% sits inside the reported range | No (thin evidence) |
| **Auctions get the main effort; closeouts paused until the pick-proof shows an edge** | Old data shows auctions are priced by investors (wholesale), not end users. One closeout success story (survivorship). Nothing compares end-user resale by source. | **No new evidence** | No |
| **Bids weigh little in the auction score (F8: 10 -> 5)** | Shill run-ups and bot bids are confirmed again (236-reply thread; bots bidding up single-bid auctions). | **Supported** | No (already planned) |
| **Import only after the transfer is confirmed** | Reversals after payment are routine. | **Supported** | No |
| **Other endings registered and live businesses (shortlist endings; Tier A gate for Line 1; "above $50, show why")** | Founders who started on .co, .io or a business name bought the .com later ($1.6k-$9k). A third of new startups launch without the .com. The upgraders come from .co, .io and .ai, not only .net and .org. | **Supported**. Note: the Tier A gate names .net and .org only, while the upgraders in these reports were mostly on .co and .io | Reconsider the gate wording when Tier A is enforced in `/buy` (planned) |
| **Word quality in auction score v2** | "One natural commercial idea" is what sells for two-word .coms. | **Supported** | No |
| **Keep every name in Afternic's network (F9)** | 77% of one large portfolio's Afternic sales came through GoDaddy search and partner registrars. Founders who use brokers or WHOIS find the owner regardless. | **Supported** | No (F9 open: mineunited.com still unlisted) |
| **Sell-through planning at 0.5-3.5% a year (F15)** | 1.0-1.5% at our price level; 2.8% in one good month. | **Supported** | No |
| **Line 1 hand regs = side line only** | Founders' unused names lapse; holders lose money on renewals. | **Supported** | No |
| **No marketplace scraping; free legal sources only** | Reddit, Quora, Indie Hackers and Medium blocked us; Hacker News and NamePros threads worked. | Consistent | No |

**Bottom line:** the community evidence moves no rule. It **supports** the maximum-bid rule, the $1,000 expected resale, the $1,488 Buy Now, the bid-count downgrade, the transfer check and the live-business and other-endings signals. The **one tension** is the top S8 rungs ($3,488-$4,888): end-user budgets and one large portfolio's numbers point to fewer sales above about $2,500. Most of the weight is C and indirect, so this needs our own test, not a rule change.

## 5. Proposed action items

### Change now (DOM, no rule change)
1. **F7 price test design:** test **both directions**. Besides "S8 names at a higher Buy Now", add a lower arm for the 8-letters-or-fewer rung, $2,488 against $4,888. NameBuyer's segments say sales may fall above about $2,500, and NameBio's test only covered prices below $2,500. Measures: leads, offers and sales per listed name. Dvir decides the price rule.
2. **Knowledge sources note** (`knowledge-sources-2026-10.md` §1, NamePros row): NamePros thread pages loaded without a challenge on 25 Oct 2026, while blog and article pages did not. Readable threads may be read by a session at a polite rate. Hacker News through Algolia is the community source for end-user views. Reddit, Quora, Indie Hackers and Medium refused us.
3. **F8 stays as planned** (bids weight 10 -> 5). The new evidence agrees.

### Reconsider when more data
4. **S8 ladder top rungs ($3,488 / $4,888):** reconsider after the F7 test shows leads and offers per name at $2,488 against $4,888, or when an A or B source with a price test above $2,500 appears.
5. **Tier A gate endings:** when the server enforces Tier A in `/buy`, consider counting a live business on .co, .io or .ai, not only .net and .org. The upgraders in the founder reports came mostly from .co and .io. This needs our own sold-name data, from the engine endings, to confirm.
6. **Floor and offers:** once Afternic offers on our names are logged, compare them with the founders' "pay a third to two thirds of the ask" before touching the 65% floor.
7. **Auctions against closeouts:** the community has no data on end-user resale by acquisition source. Only our own pick-proof and won-auction results can answer it (F6).

### No change
8. The maximum-bid rule ($160 at 20% of $1,000 net), the $1,000 expected resale and the $1,488 default Buy Now.
9. Auctions as the main effort, with closeouts paused.
10. Import only after the transfer check.
11. Word quality, other endings and live business as score inputs.
12. Line 1 as a side line.
13. Afternic network distribution.
14. No Facebook or Reddit work: Facebook groups are investor-to-investor, and Reddit is closed to us.

---

## Sources (44; full rows in `0006-communities.jsonl`)
- **B (2):** Paul Graham "Change your name" (2015); Fred Wilson, AVC (2011).
- **C (31):**
  - Hacker News threads 9003510, 13554854, 6831632, 5642503, 35889335, 28106113, 30331396, 36565905, 20977199, 44733800.
  - Founder posts: SuperTokens (advaitruia.com), Resend, Pilot (waseem.substack), Priceonomics on Experiment.com, OnlineDomain on Cofounders.com.
  - Product Hunt poll; Stack Exchange 4502.
  - NamePros threads 1392048, 1071611, 1380354, 1325539, 1372328, 1395969, 1193687, 1367493, 1395318, 1306045, 1386618, 1338755, 1114160, 988898.
- **D (11, weight 0):**
  - Hacker News comments 6606048, 43575800, 13368978.
  - Indie Hackers x3 (snippets).
  - NamePros 1287515, 1265607, 1385657 (vendor), 814385 (Facebook).
  - jovancicmil.com.
- **Echo handling:** the NamePros two-bidder thread is linked `same_author` to Brad Mugford's X post in 0003, so the two count as one cluster. The Hacker News discussion of the SuperTokens post `cites` it and is used only for other commenters' walk-aways, not for the SuperTokens price. One founder who appears in two Hacker News threads (surname .com, $3,500) is counted once.
