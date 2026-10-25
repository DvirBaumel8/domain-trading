# Research: knowledge sources and a trustworthy evidence base (25 Oct 2026)

**Why:** Dvir wants a **knowledge base module**. It gathers a lot of online information about domain investing (what sells, prices, auction tactics, safety), grades every source, and lets a decision rest on the weight of all the evidence, never on one random post. Today research is done by Claude Code sessions with web search and fetch, written into markdown files (`score-research-2026-10.md`, `round2-score-and-data-2026-10.md`, `funnel-names-safety-2026-10.md`). This file answers two questions:
1. Which sources can we reach **free and legally, at volume**?
2. How do professionals grade and combine evidence, and what should we copy?

**Method and limits:**
- About 45 web searches and fetches, plus direct `curl` reads of robots.txt files and RSS feeds (25 Oct 2026, 15:00–16:00 UTC). Every access claim was checked on the provider's own page where it would load.
- Pages that refused us (HTTP 403 or a bot check) were **not** retried through any proxy or mirror: namepros.com HTML pages and its terms page, stackoverflow.com (its terms text loads only by script), namebio.com, support.reddithelp.com, techrepublic.com. Our web fetcher is also blocked from reddit.com and stackoverflow.com by those sites' own rules. Claims about them come from other official pages or secondary reports, and are marked that way.
- No account was created and no API key was used. Nothing was scraped. No marketplace, NameBio page or Wayback was automated.
- Grades as in our other files: **A** official or large-sample data; **B** experienced practitioner or established method body with a track record; **C** guide, small or unclear study, single-source article; **D** vendor marketing, single anecdote or content farm. Quotes are under 15 words.

---

## 0. Short answer

1. **Reddit is effectively closed to us.** Its Data API terms need a separate agreement for any commercial use, Reddit takes **no new public API requests after 31 Oct 2026** (6 days from now), RSS ends 13 Nov 2026, and the remaining public API ends in March 2027. Don't rush a signup: even an approved free key would be non-commercial. Reddit content reaches us only when other sources quote it.
2. **X/Twitter has no free read access left.** It is pay per use at $0.005 per post read. It is out under the free-only rule.
3. **YouTube works through the official API**, free once Dvir creates a Google Cloud key: 100 searches a day plus 10,000 units for everything else (video details and comments cost 1 unit each). **Transcripts of other people's videos are not officially available**: `captions.download` needs edit rights on the video, and transcript scrapers break YouTube's terms. Raw API data may be kept at most 30 days, so we keep only our own claims and the video link.
4. **Forums and blogs are reachable through RSS**, which is the clean route.
   - Working feeds: NamePros (whole-site feed only), DNForum, Acorn Domains, DomainNameWire, DomainInvesting, SullysBlog, DNJournal, Domaining.com (an aggregator), DomainGang, OnlineDomain, TheDomains and DSAD (Shane Cultra's blog, now at dsad.com).
   - NamePros thread pages sit behind a Cloudflare challenge. We read only the feed and never pass the challenge; reading a thread in full needs a person or NamePros' permission.
   - Feeds give titles and short excerpts. They are **leads**; the full article is read by a research session.
5. **Free APIs that remain:**
   - Hacker News through Algolia: no key, about 10,000 requests an hour.
   - Stack Exchange: 10,000 a day with a key. Its terms text could not be read, and domain topics there are thin.
   - Papers: arXiv (metadata CC0), Crossref (no key), OpenAlex (free key, $1 a day of usage free, CC0 data). Semantic Scholar works too, but part of its data is non-commercial (CC BY-NC), so we use it to find papers only.
   - Google Scholar's robots.txt forbids automation.
6. **No free general web-search API is left for the server.**
   - Google's Custom Search JSON API is closed to new customers and ends 1 Jan 2027.
   - Bing's Search API was retired on 11 Aug 2025.
   - Brave gives $20 of free credit a month but needs a card, and keeping results needs a paid plan with storage rights.
   - **Claude Code's WebSearch in research sessions stays our search tool.** This fits founder rule 9 anyway: the server may not call AI, so all reading and summarising happens in sessions or bots, and the server only stores structured results.
7. **Evidence method (Part 2):**
   - Grade every **source** on two separate axes, like the intelligence Admiralty code: who said it (reliability A–D) and how well this one claim is backed (credibility 1–5).
   - Collapse **echoes** (posts repeating one original) into one independent "evidence cluster".
   - Weight each cluster by grade, sample size and age.
   - Give each decision question a **GRADE-style certainty** (high, moderate, low, very low), never a bare yes or no.
   - Rough size: **at least 3 independent clusters, 2 of them A or B**, before a verdict above "low". Around **12 sources per topic** is usually enough (saturation). Numeric effects need **10+ data points** before any check for publication bias means anything.

---

## Part 1: which sources we can reach

### 1.1 Summary table

| # | Source | Access route | Free limit | Automated reading allowed? | Commercial use? | Auth (Dvir signs up) | Content quality for us | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | **Reddit** (r/Domains, r/DomainNames, r/Entrepreneur) | Data API (OAuth); RSS until 13 Nov 2026 | 100 queries a minute per OAuth client (secondary sources; Reddit's help page returned 403) | Only through the approved API. Since Nov 2025 every new key needs approval (secondary) | **No** without a separate agreement (terms §3.1, below) | Reddit account plus approval. **New requests close 31 Oct 2026** | Many beginners, many anecdotes, some useful threads from known investors. Mostly C/D | **Not usable.** Count Reddit only when another source quotes it, and trace it to the original |
| 2 | **YouTube** (domain-investing channels, conference talks) | Data API v3 | 100 `search.list` calls a day plus 10,000 units a day; `videos.list` and `commentThreads.list` cost 1 unit each | Yes through the API. Scraping is forbidden. `robots.txt` also blocks `/feeds/videos.xml` | Yes: commercial API clients are allowed, but not ads on pages that show only YouTube data | Google Cloud project with an API key (Dvir) | Talks by known investors (B) mixed with get-rich-quick channels (D). Comments are mostly D | **Usable for metadata and comments.** No transcripts for others' videos |
| 3 | **X/Twitter** | API v2 | **No free tier**: $0.005 per post read, capped at 3M reads a month | Paid API only | Paid | Card and credit purchase | Domain-Twitter is active (prices, sales boasts) but anecdotal | **Not usable** (not free) |
| 4 | **NamePros** (largest domain forum; Bob Hawkes' data blog) | Whole-site RSS `/forums/-/index.rss` (50 items, refreshed within minutes) | No stated limit | `robots.txt` allows `/data/feeds/` and does not block `/threads/`, but thread pages, per-forum feeds and `/blog/` return a **Cloudflare challenge** | Terms page returned 403, so **unverified** | None for the feed | The best practitioner content in the field (B): Hawkes' sale analyses, sales threads. Also beginners' noise (C/D) | **Feed only, as leads.** Full text only when a page loads without a challenge; never pass the challenge. **DVIR:** ask NamePros for written permission to read threads by bot |
| 5 | **DNForum** | Whole-site RSS `/forums/-/index.rss` (40 items) | — | `robots.txt`: `Allow: /`, blocks `/posts/`, `/members/`, `/search/` | Terms not checked | None | Smaller and older forum. C | **Usable (feed plus allowed thread pages, polite rate)** |
| 6 | **Acorn Domains** (UK) | Whole-site RSS (49 items) | — | `robots.txt` blocks named SEO bots and `/search/`, otherwise `Allow: /` | Terms not checked | None | UK and ccTLD focus, so less relevant to .com. C | **Usable, low priority** |
| 7 | **Blogs and news** | RSS (all checked 25 Oct 2026): DomainNameWire (5 items, latest 23 Oct), DomainInvesting (5, 20 Oct), SullysBlog (50, 15 Oct), DNJournal (37, 23 Oct), Domaining.com aggregator (20, 25 Oct), DomainGang (15, 23 Oct), OnlineDomain (50, 16 Oct), TheDomains (5, 20 Oct), DSAD (10, 24 Oct) | — | Public feeds exist for feed readers. DomainInvesting's robots blocks only `/?blackhole` and some named bots | Reading for internal research is normal. **Republishing is not**, and we don't publish (founder rule 10). Store our summary, quotes under 15 words and the link | None | DNW (Allemann) and DNJournal (weekly reported sales charts): B. Sully, Elliot Silver, Shane: B (practitioners). Domaining.com: an **aggregator** of other feeds, so an echo source, used only to find originals. DomainGang: news and gossip, C | **Usable: the core daily feed** |
| 8 | **Escrow.com blog** | No RSS found (`/blog/rss.xml`, `/blog/feed` both 404) | — | Pages readable by research sessions | — | None | Vendor (D) for marketing; A only for its own published transaction stats | **Session reading only** |
| 9 | **Podcasts** | DomainSherpa archive (404 shows) | — | domainsherpa.com returned a Cloudflare block to `curl`, but pages show up in search | — | None | DomainSherpa interviews are B (named investors), but old. **Transcripts exist** inline and as PDFs. The homepage now also lists new short posts (Oct 2026, from a search result title) | **Session reading of transcripts.** GoDaddy and other podcasts: no transcripts verified, so they count only through written summaries |
| 10 | **Hacker News** | Algolia HN Search API (`hn.algolia.com/api/v1/search`); works with no key (tested) | About **10,000 requests an hour per IP** (search snippets of the API page) | Yes. The API exists for this. `news.ycombinator.com` robots.txt asks for `Crawl-delay: 30` on HTML | Not restricted on the API page (unverified) | None | Founders talking about naming and buying domains (C). Good for end-user buyer views | **Usable, low volume** |
| 11 | **Stack Exchange** (Webmasters, Startups) | API v2.3 | 10,000 requests a day per key; an IP throttle at 30 requests a second | Yes through the API | **Unverified**: the terms page loads only by script; Stack now sells data licences | Key (Dvir) | Thin on domain investing | **Skip** unless a topic needs it |
| 12 | **Papers**: arXiv, Crossref, OpenAlex, Semantic Scholar | APIs | arXiv: one request every 3 s. Crossref: no key, back off on 429. OpenAlex: free key, $1 a day of usage. S2: no key (shared pool) or a key at 1 request a second | Yes | arXiv metadata CC0. OpenAlex CC0. S2 data partly **CC BY-NC**, so used only to find papers | OpenAlex and S2 keys (Dvir, optional) | A, but few papers on domain resale (DASH and drop-catch studies were found this way) | **Usable** |
| 13 | **Google Scholar** | No API | — | **No**: `robots.txt` has `Disallow: /scholar` | — | — | — | **Not usable by automation**; sessions may use WebSearch |
| 14 | **Web search APIs** | Google CSE JSON, Bing, Brave | Google: 100 a day, but **closed to new customers**, ends 1 Jan 2027. Bing: **retired** 11 Aug 2025. Brave: $20 of credit a month | — | Brave: storing results needs a plan with storage rights | Brave needs a card | — | **Not usable for the server.** Research sessions use Claude Code's WebSearch (US results) |
| 15 | **NameBio** (sales data) | Free endpoints (RetailStats, TLDStats) | See `historical-data-2026-10.md` S2 | Free endpoints only (founder rule) | Allowed with attribution (S2) | Already built (CR-062) | A for reported sales | **Unchanged**: free endpoints only |

### 1.2 Key terms, quoted

**Reddit** (`redditinc.com/policies/data-api-terms`, read with `curl` on 25 Oct 2026):
- §3.1: for "commercial purposes" you "will need to enter into a separate agreement with Reddit."
- §2.4: no "training a machine learning or AI model, without the express permission of rightsholders".
- On ending access, data must be deleted: "delete any cached or stored User Content".
- Dates (WinBuzzer, 1 Oct 2026, reporting Reddit): 31 Oct 2026, "New requests for public API access will no longer be accepted"; RSS ends 13 Nov 2026; removals start 12 Jan 2027; public API ends March 2027. Approved apps move to Reddit's Developer Platform (Devvit), where Reddit hosts the code.
- **For us:** we are a company, so even a free key would need a separate commercial agreement. No route is free, commercial and allowed.

**YouTube** (`developers.google.com/youtube/...`):
- Quota: "100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day".
- Captions: `captions.download` "requires the user to have permission to edit the video" (200 units). So **no official transcripts** for videos we don't own.
- Terms of Service: no "automated means (such as robots, botnets or scrapers)". Developer policies: must not "scrape YouTube Applications … or obtain scraped YouTube data". This rules out third-party transcript tools.
- Storage: non-authorized data kept "not longer than 30 calendar days". **For us:** store the video ID, title, channel, date and our own extracted claims. Refresh or delete raw comments within 30 days.

**X** (`docs.x.com/x-api/getting-started/pricing`): "No subscriptions—pay only for what you use". "Posts: Read | $0.005 per resource". Capped at "3 million Post reads per monthly billing cycle". The $20 credit comes only after a card and a first purchase.

**NamePros:**
- `robots.txt` (read 25 Oct 2026) starts with `User-agent: *` / `Allow: /data/feeds/` and blocks only login, POST and transient paths.
- But HTML pages answer with Cloudflare's "Just a moment..." challenge. A challenge is bot protection, and passing it, or using proxies around it, is forbidden by our rule. The whole-site RSS answered 200 with no challenge.
- The terms page (`/help/terms/`) returned 403, so whether a company may read by bot is **unverified**.

**Search APIs:**
- Google: "The Custom Search JSON API is closed to new customers." Existing customers have "until January 1, 2027".
- Microsoft: "Bing Search APIs will be retired on August 11, 2025."
- Brave: storage of results only "with a plan that includes storage rights".

**Papers:**
- arXiv: "no more than one request every three seconds". Metadata "Creative Commons Universal (CC0 1.0)".
- Semantic Scholar: "Most … endpoints are available to the public without authentication". The licence lists data under "CC BY-NC or ODC-BY".
- OpenAlex: "$1 of API usage per day for free" (key required since Feb 2026, per OpenAlex's blog).

### 1.3 Who reads what (founder rule 9)

- **Server (no AI):** a daily job could pull the RSS feeds in §1.1 rows 4–7 and the HN API. It would store only item metadata (URL, title, author, date, feed, a 300-character excerpt) as **unread leads**, deduplicated by canonical URL. That is plain fetching, like a feed reader, polite (once a day, one request per feed), with no AI.
  - It must never fetch marketplaces, NameBio pages beyond the free endpoints, Wayback or any page behind a challenge.
  - YouTube API pulls also fit here if Dvir creates a key; they spend about 1 unit per call.
- **Research sessions and bots (with AI):** read the leads and the full articles, extract claims in the fixed format of §2.3, grade them, and post them to the server. They decide nothing; the server computes verdicts deterministically from the stored rows.
- **Expected volume:** the 12 feeds give about 150–250 new items a day, mostly news, sales lists and auction lists. From experience with these feeds, maybe 5–20 a day touch our topics. A session can triage that in minutes.

---

## Part 2: how to build a trustworthy evidence base

### 2.1 What professionals do

| Practice | Core idea | What we copy |
|---|---|---|
| **GRADE** (medicine) | Certainty of a body of evidence: high, moderate, low or very low. Randomized trials start high, observational studies start low. The grade goes **down** for risk of bias, inconsistency, indirectness, imprecision and publication bias, and **up** for large effects or a dose-response. "High" means "very confident that the true effect lies close". | One certainty label per decision question, with the reasons for each step down. Our "observational" is almost everything, so a verdict starts at **low** unless it rests on large official data (for example registrar or marketplace statistics, or our own backtests) |
| **Admiralty / NATO code** (intelligence) | Source reliability A (completely reliable) to F (cannot be judged) **times** information credibility 1 (confirmed by other sources) to 6 (cannot be judged). Each descriptor is "considered in isolation". UK police now use a simpler 3x5x2: source reliable, untested or not reliable, and "reliable" needs both competence **and** a past record of accurate information | Two axes: **who** (source grade, from track record) and **this claim** (credibility). A reliable author can still post a doubtful claim |
| **Cochrane systematic review** | A protocol written first (question, inclusion rules). Search more than one database. Two reviewers screen independently (at least 20% double-screened in rapid reviews). A piloted extraction form. Risk of bias. Synthesis. **Living reviews** search again on a set schedule, often monthly | A written **question card** before collecting. A fixed extraction form. A second independent extraction on a sample. A set re-check schedule |
| **Meta-analysis** | Weight by precision ("inverse of the variance": bigger samples weigh more). Check heterogeneity. Use random effects when studies differ. **Don't count votes.** Publication bias: "available evidence differs systematically from missing evidence". Funnel-plot tests only with **10+ studies** | Weight by sample size. Pool numbers as weighted medians or ranges, never as "7 posts agree". Flag **survivorship**: people post wins, not the 99% of names that never sell |
| **Wikipedia reliable sources** | Prefer sources with "a reputation for fact-checking and accuracy". Self-published sources are "largely not acceptable", except from "an established expert on the subject matter". Forums are "generally unacceptable". "Reliability … depends on context" | A forum post is C by default. It goes up to B only for an author with a verified record. Grade **per claim type**: a marketplace is A for its own sales count and D for "domains are a great investment" |
| **Fact-checking** (IFCN, SIFT, lateral reading) | IFCN: transparency of sources and method, and corrections. SIFT: Stop, Investigate the source, Find better coverage, **Trace claims to the original**. Fact-checkers read **laterally** (leave the page and check what others say about the source) and beat PhD historians in Wineburg & McGrew's study | Every claim records its **original** source. A session checks an unknown author or site laterally before grading |
| **Circular reporting** | Information that "appears to come from multiple independent sources" but has one origin (also called false confirmation; "citogenesis") | `echo_of` links. Echoes add no weight |
| **Near-duplicate detection** | Broder's shingling and MinHash: the share of shared word 5-grams estimates text similarity (Jaccard) cheaply | The server can compute MinHash on excerpts and flag likely echoes (similarity ≥ 0.5) for the session to confirm. Plain code, no AI |
| **AI content farms** | NewsGuard tracks 3,749 AI content-farm sites. Signs: chatbot error text, generic names, many posts a day, no disclosure. Google's spam policy: "many pages … without adding value". Hanley & Durumeric: synthetic articles on misinformation sites rose 474% (2022–23). AI-text detectors are unreliable: OpenAI withdrew its classifier for its "low rate of accuracy" | Grade by **site signals**, not by a detector: a named author with a history, an About page, original data, post rate, and no "As an AI" leftovers. Unknown listicle sites are D. Our known content-farm list (from `funnel-names-safety`) is kept as a blocklist |
| **Analysis of Competing Hypotheses** (Heuer, CIA) | Test each piece of evidence against **all** hypotheses. Evidence consistent with every hypothesis has no diagnostic value | A question card lists the options (for example "bid on auctions" vs "closeouts"). A claim counts only where it separates them |
| **Track record** (Tetlock, Good Judgment) | Forecasters scored by Brier score. The top 2% keep beating the crowd year after year. Track record beats credentials | **Author scores** come from checkable history: verified sales (in DNJournal charts or NameBio), years active, and later, how often their past claims in our base held up |

### 2.2 Recommended data model

Five tables, append-only like `listing_history` and `audit_log`. The weights live in a versioned settings row (like `pricing_settings`), never hard-coded.

**`kb_sources`**: one row per document (article, thread, video, paper, dataset, our own backtest).
- `id`, `url` (canonical), `url_hash`, `publisher` (site), `author_id` (nullable), `title`, `published_at`, `retrieved_at`.
- `type`: `official_data | paper | dataset | news | practitioner_blog | forum_post | video | comment | vendor | aggregator | own_analysis`.
- `access_method`: `rss | api | session_web | manual`, plus `access_note` (for example "feed excerpt only").
- `reliability`: `A | B | C | D | F`. F means not yet judged; a new unknown source starts at F, never at C by default.
- `reliability_reason`: required text, for example "named investor, 400 verified sales in DNJournal".
- `conflict_of_interest`: `none | sells_service | sells_names | marketplace | unknown`.
- `content_hash` and `minhash` (of the stored excerpt).
- `status`: `lead | read | graded | rejected`, with `rejected_reason` (for example `content_farm`, `behind_challenge`).

**`kb_authors`**: `id`, `name`, `handles` (per site), `first_seen`, `verified_sales_count`, `verified_sales_source`, `years_active`, `track_score` (later: the share of their past claims that held up), `grade` and `grade_reason`.

**`kb_claims`**: one row per **normalised statement**, shared by every source that makes it.
- `id`, `topic` (a fixed list: `sell_through`, `price_bands`, `auction_tactics`, `buyer_types`, `name_shape`, `extensions`, `renewal_economics`, `safety_trademark`, `safety_history`, `marketplaces`, `platform_rules`, ...), `question_ids` (see below).
- `statement` (one sentence, plain words).
- `variable` and `direction` (`increases | decreases | no_effect | value`); for example the variable is "sell-through of 2-word .com" and the direction is "value".
- `effect_value`, `effect_unit`, `effect_low`, `effect_high` (for example 0.5–1.1 %/year).
- `population`: what it applies to, for example "hand-regs, .com, portfolios of 1,000+"; this is the base for the **indirectness** check against our case (S8 auctions, 40 names).
- `date_range_start` and `date_range_end` (when the underlying data is from, not when it was posted).
- `half_life_days` (§2.4).

**`kb_evidence`**: the link Source → Claim.
- `source_id`, `claim_id`, `stance` (`supports | contradicts | qualifies`).
- `credibility`: 1–5 for this item: 1 confirmed by an independent source; 2 probably true (consistent with known data); 3 possibly true; 4 doubtful; 5 cannot be judged.
- `sample_size` (n names, sales or auctions; null for opinion), `evidence_kind` (`measured | reported_sale | experience | opinion`).
- `quote` (under 15 words), `locator` (section, timestamp or table), `extracted_by` (session or bot ID), `extracted_at`, `extraction_check` (`single | double_agreed | double_conflict`).

**`kb_source_links`**: `from_source_id`, `to_source_id`, `kind`: `echo_of` (repeats it with nothing new), `cites` (uses its data and adds analysis), `same_author`, `syndicated` (the same text elsewhere), `aggregator_of`.
- Each source then belongs to an **independence cluster**: the root original plus everything that echoes it, syndicates it, or comes from the same author on the same data.

**`kb_questions`** and **`kb_verdicts`**:
- Question: `id`, `text` (for example "Should S8 money go to auctions with bidding rather than closeouts?"), `options`, `decision_owner`, `created_by`.
- Verdict, appended at each recompute: `question_id`, `computed_at`, `settings_version`, `verdict` (the leading option or a value range), `certainty` (`high | moderate | low | very_low`), `downgrades` (the list of reasons), `clusters_used`, `weight_for`, `weight_against`, `inputs_snapshot`.

### 2.3 Scoring rules

**A. Source grade (axis 1: who).** Our A–D, applied **per claim type**:
- **A:** official data or a large measured sample (registrar or marketplace statistics about their own platform, peer-reviewed papers, NameBio and DNJournal reported-sale aggregates, our own backtests).
- **B:** a named practitioner with a verified record: 50+ verified sales or 5+ years of published data posts, and no undisclosed conflict on this claim (for example Hawkes, Allemann, Sullivan, Silver); also established method bodies.
- **C:** an unverified named author, forum threads, general guides, small studies.
- **D:** vendor marketing about its own product, single anecdotes, anonymous posts, AI content farms.
- **F:** not judged yet. It weighs nothing until graded.
- **Conflict rule:** a marketplace or service is A for counts of its own sales, but **D** for "now is a great time to buy domains".

**B. Claim credibility (axis 2: this item).** 1–5 as in `kb_evidence`, judged without looking at the source grade (the Admiralty "in isolation" rule). Credibility 1 needs a match in a **different** cluster.

**C. Weight of one evidence item:**
`w = G(grade) × C(cred) × N(n) × R(age) × K(kind)`
- `G`: A 1.0, B 0.6, C 0.25, D 0, F 0. D is kept for the record but carries no weight.
- `C`: 1 → 1.0, 2 → 0.8, 3 → 0.5, 4 → 0.2, 5 → 0.3.
- `N`: for measured items `min(1, log10(n+1)/3)`, so n = 10 gives 0.35, n = 100 gives 0.67, n ≥ 1,000 gives 1.0. Experience and opinion items get a fixed 0.3. A single reported sale gets 0.1.
- `R`: `0.5^(age_days / half_life_days)`, with age counted from `date_range_end`.
- `K`: measured 1.0, reported_sale 0.8, experience 0.6, opinion 0.4.
- **Independence:** inside a cluster, only the **highest** `w` counts (echoes add 0). Clusters, not posts, are counted.

**D. Verdict per question:**
- For each option, `W_for` is the sum of the cluster weights that support it, and `W_against` the sum of those that contradict it. `agreement = W_for / (W_for + W_against)`.
- For numbers, the verdict is a weighted median and range of `effect_value` across clusters. Never average a 1-name anecdote with a 10,000-name study.
- **Certainty**, GRADE-style:
  - **Starting level:** moderate if at least one A cluster with measured data supports the option; otherwise low.
  - **Step down one level** for each of:
    - inconsistency: agreement below 0.75;
    - indirectness: most of the weight comes from a different population, such as hand-regs when the question is about S8 auctions, wholesale prices when we sell retail, or big portfolios when we hold 40 names;
    - imprecision: fewer than 3 independent clusters, or a total `N` below 1.0;
    - bias: most of the weight is self-reported wins (survivorship) or comes from sources with a conflict;
    - staleness: weighted mean `R` below 0.5.
  - **Step up one level** if two or more **independent A clusters** agree (agreement ≥ 0.9), or if our own backtest agrees.
  - **High** needs at least 3 independent clusters, at least 2 of them A, agreement ≥ 0.9, and no step down left.
- A verdict states its certainty and its main downgrade in plain words, for example "low: only 2 independent clusters, both from hand-reg portfolios". Following ICD 203 practice, likelihood and confidence are said separately, never mixed in one sentence.

**E. Author track score (later):** after 6 months, each author's past claims are checked against our own outcomes and later data: `track = held / (held + failed)`, with smoothing (+1 / +2). An author with 10+ checked claims and track ≥ 0.7 may be moved up a grade, and one with < 0.4 moved down. Each such change is written to `grade_reason`.

### 2.4 Workflow

1. **Question first** (Cochrane protocol). Gavriel, Dvir (through Gavriel) or DOM opens a `kb_question` with its options, the population ("our case": S8 auctions, ≤ $250, 40 names, a 2-year hold) and what would change the decision. ACH rule: list every option.
2. **Collect.**
   - The daily server job adds RSS, HN and YouTube metadata as **leads** (no AI).
   - A research session runs the question's searches with WebSearch, reads the leads and the full pages that load without a challenge, and **traces each claim to its original** (SIFT). If the original won't load, the claim stays at credibility 5.
3. **Grade the source** before extracting: lateral reading of an unknown author or site, the content-farm signs, conflicts of interest. Grade F until done.
4. **Extract** with one fixed JSON form: statement, variable, direction, value and range, n, population, date range, quote under 15 words, locator. The session maps each statement to an existing `kb_claim` where it matches, and makes a new claim only when none fits, so the list doesn't split into near-copies.
   - **Double extraction:** a second session, without seeing the first, re-extracts 20% of sources and every A source. Disagreements are flagged `double_conflict` and resolved before they count.
5. **Link echoes:** the server flags likely duplicates (same canonical URL, MinHash ≥ 0.5, the same numbers and dates from a later date), and the session confirms the `echo_of` links. Aggregators (Domaining.com) are always `aggregator_of` and never a cluster root.
6. **Compute** the verdict on the server (plain code, settings-versioned weights) and append it to `kb_verdicts`. A read route returns the verdict, its certainty, the top clusters with links and the downgrade reasons, so Gavriel can show Dvir **why**, never just "the base says yes".
7. **Re-check stale claims** (living review):
   - **Half-lives:** platform rules and API terms 180 days; auction tactics and prices 2 years; sell-through and buyer types 3 years; safety and legal (trademark, UDRP) 2 years.
   - When a claim's `R` drops below 0.5, it goes on a re-check list. A session searches for newer evidence and adds new `kb_evidence` rows; old rows stay and simply weigh less.
   - Questions behind a live decision are re-checked monthly.
8. **Use:** a decision document (CR, buy case, strategy note) cites the question ID and the verdict version. A decision that goes against a moderate or high verdict says why.

### 2.5 How much is enough

- **To give any verdict above "very low":** at least **3 independent clusters**, with **at least 2 graded A or B**. This mirrors the "two tests" for a reliable source in UK policing and the corroboration rule behind Admiralty credibility 1.
- **To stop collecting (saturation):** stop when the last **5 new sources** add no new claim and do not move any verdict's certainty. Studies of qualitative saturation found it between **9 and 17 interviews**, with a median of about 12 (Hennink & Kaiser 2022, 23 studies). So plan for **about 12–15 graded sources per topic**, and fewer when two A datasets already agree.
- **Numbers** (sell-through, price bands): aim for **10+ independent data points** before trusting a pooled range or checking for publication bias. Cochrane says funnel-plot tests need at least 10 studies.
- **The whole base** at the start: about 10 topics × 12–15 sources gives **120–150 graded sources and 200–400 claims**. Our three October research files already hold about 130 graded sources that can be loaded first, keeping their grades.

### 2.6 Domain-investing biases to watch (the "step down" reasons)

- **Survivorship:** forum and blog posts report sales, not the ~99% of names that never sell. Trust a sell-through only from someone who reports the whole portfolio count.
- **Wholesale vs retail:** expired-auction prices (investor to investor) are not end-user BIN prices (see `historical-data-2026-10.md`).
- **Scale mismatch:** advice from portfolios of thousands of names (volume models) is indirect evidence for our 40.
- **Vendor interest:** marketplaces, appraisal tools and course sellers profit from optimism.
- **Echo chambers:** one Hawkes or DNW article is often repeated by many blogs and threads within days. It counts as one cluster.

---

## Sources (graded)

**Access terms (Part 1):**
1. Reddit, *Data API Terms* (§2.4, §3.1; read 25 Oct 2026). **A.** https://redditinc.com/policies/data-api-terms
2. WinBuzzer, *Reddit to End Feed-Reader Updates and Public API Access for Apps* (1 Oct 2026; reports Reddit's dates). **C.** https://winbuzzer.com/2026/10/01/reddit-to-end-feed-reader-updates-and-public-api-access-for-apps-a002-xcxwbn/
3. Reddit, *Responsible Builder Policy* (403 to us; content via search results only). **C** (secondary). https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
4. Google, *YouTube Data API Overview* (quota). **A.** https://developers.google.com/youtube/v3/getting-started
5. Google, *Captions: download*. **A.** https://developers.google.com/youtube/v3/docs/captions/download
6. Google, *YouTube API Services Developer Policies*. **A.** https://developers.google.com/youtube/terms/developer-policies
7. YouTube, *Terms of Service* (automated access). **A.** https://www.youtube.com/static?template=terms
8. Google, *CommentThreads: list* and *Videos: list* (1 unit each; via search result). **A.** https://developers.google.com/youtube/v3/docs/commentThreads/list
9. YouTube `robots.txt` (blocks `/feeds/videos.xml`). **A.** https://www.youtube.com/robots.txt
10. X, *X API pricing*. **A.** https://docs.x.com/x-api/getting-started/pricing
11. NamePros `robots.txt` and whole-site RSS (read directly). **A.** https://www.namepros.com/robots.txt , https://www.namepros.com/forums/-/index.rss
12. DNForum `robots.txt` and RSS. **A.** https://www.dnforum.com/robots.txt
13. Acorn Domains `robots.txt` and RSS. **A.** https://www.acorndomains.co.uk/robots.txt
14. Blog feeds checked live (DNW, DomainInvesting, SullysBlog, DNJournal, Domaining, DomainGang, OnlineDomain, TheDomains, DSAD). **A** (as to access). https://domainnamewire.com/feed/ , https://www.dnjournal.com/rss.xml , https://www.domaining.com/rss/ , https://dsad.com/feed/
15. DomainSherpa, *After Six Years and 404 Shows, DomainSherpa Bids Farewell*, and *Four Ways to Learn* (transcripts; via search). **B.** https://domainsherpa.com/farewell/
16. Hacker News `robots.txt` (crawl-delay 30) and HN Search API (tested; limit from search snippets). **B.** https://hn.algolia.com/api
17. Stack Exchange, *API throttles*. **A.** https://api.stackexchange.com/docs/throttle
18. arXiv, *API Terms of Use*. **A.** https://info.arxiv.org/help/api/tou.html
19. Crossref, *Tips for using the REST API*. **A.** https://www.crossref.org/documentation/retrieve-metadata/rest-api/tips-for-using-the-crossref-rest-api/
20. Semantic Scholar, *API* and *API License Agreement*. **A.** https://www.semanticscholar.org/product/api/license
21. OpenAlex, *Pricing* (and the Feb 2026 key change). **A.** https://help.openalex.org/access/pricing/
22. Google Scholar `robots.txt`. **A.** https://scholar.google.com/robots.txt
23. Google, *Custom Search JSON API overview* (closed to new customers). **A.** https://developers.google.com/custom-search/v1/overview
24. Microsoft, *Bing Search APIs Retiring on August 11, 2025*. **A.** https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
25. Brave, *Search API* (vendor page; free credits, storage rights). **A** for its own terms. https://brave.com/search/api/

**Evidence method (Part 2):**

26. GRADE Working Group, home page (the GRADE domains). **A.** https://www.gradeworkinggroup.org/
27. Schünemann et al., *GRADE Handbook* (certainty definitions; starting levels). **A.** https://gdt.gradepro.org/app/handbook/handbook.html
28. Wikipedia, *Admiralty code* (scales; the article itself relies on one source). **C.** https://en.wikipedia.org/wiki/Admiralty_code
29. College of Policing, *Intelligence report* (3x5x2; the "reliable" tests; via search). **A.** https://www.college.police.uk/app/intelligence-management/intelligence-report
30. Cochrane Handbook, Chapter 10 (meta-analysis, inverse variance, heterogeneity). **A.** https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-10
31. Cochrane Handbook, Chapter 13 (missing evidence, publication bias). **A.** https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-13
32. Cochrane Handbook 5.1, §10.4.3.1 (funnel tests need 10+ studies; via search). **A.** https://handbook-5-1.cochrane.org/chapter_10/10_4_3_1_recommendations_on_testing_for_funnel_plot_asymmetry.htm
33. Cochrane, *Rapid Reviews methods guidance* (dual screening of at least 20%; via search). **A.** https://methods.cochrane.org/sites/methods.cochrane.org.rapidreviews/files/uploads/cochrane_rr_-_guidance-23mar2020-final.pdf
34. Cochrane, *Cochrane's pioneering role in living evidence* (via search). **A.** https://www.cochrane.org/about-us/news/cochranes-pioneering-role-living-evidence
35. ODNI, *ICD 203 Analytic Standards* (the PDF would not render here; the likelihood terms are via #36). **A** (unread). https://www.odni.gov/files/documents/ICD/ICD-203.pdf
36. Wikipedia, *Words of estimative probability* (Kent; NIC terms). **C.** https://en.wikipedia.org/wiki/Words_of_estimative_probability
37. Wikipedia, *Analysis of competing hypotheses* (Heuer; diagnosticity; via search). **C.** https://en.wikipedia.org/wiki/Analysis_of_competing_hypotheses
38. Wikipedia, *Reliable sources* guideline. **B** (a long-tested editorial rule set). https://en.wikipedia.org/wiki/Wikipedia:Reliable_sources
39. Wikipedia, *Circular reporting*. **C.** https://en.wikipedia.org/wiki/Circular_reporting
40. Poynter IFCN, *Code of Principles: the commitments*. **A.** https://ifcncodeofprinciples.poynter.org/the-commitments
41. Caulfield, *SIFT* (via library guides). **B.** https://openoregon.pressbooks.pub/findinginfo/chapter/four-moves/
42. Wineburg & McGrew, *Lateral Reading and the Nature of Expertise* (Teachers College Record 2019; 45 participants). **A** (peer-reviewed, small n). https://stacks.stanford.edu/file/druid:yk133ht8603/Wineburg%20McGrew_Lateral%20Reading%20and%20the%20Nature%20of%20Expertise.pdf
43. NewsGuard, *AI Tracking Center* (3,749 sites; criteria). **B.** https://www.newsguardtech.com/special-reports/ai-tracking-center/
44. Google Search Central, *Spam policies* (scaled content abuse). **A.** https://developers.google.com/search/docs/essentials/spam-policies
45. Hanley & Durumeric, *Machine-Made Media* (ICWSM; 15.46M articles). **A.** https://arxiv.org/abs/2305.09820
46. OpenAI, *New AI classifier for indicating AI-written text* (withdrawn July 2023; 26% true positives). **A.** https://openai.com/index/new-ai-classifier-for-indicating-ai-written-text/
47. Broder, *Identifying and Filtering Near-Duplicate Documents* (shingling, MinHash). **A.** https://cs.brown.edu/courses/cs253/papers/nearduplicate.pdf
48. Hennink & Kaiser, *Sample sizes for saturation in qualitative research* (Soc Sci Med 2022; 23 studies). **A.** https://ideas.repec.org/a/eee/socmed/v292y2022ics0277953621008558.html
49. Good Judgment, *The Superforecasters' Track Record* (vendor of the method, but backed by the IARPA tournament). **B.** https://goodjudgment.com/resources/the-superforecasters-track-record/

**Our own earlier files** (grades kept): `historical-data-2026-10.md` (NameBio terms), `funnel-names-safety-2026-10.md` (content-farm list), `round2-score-and-data-2026-10.md`.

**Not relied on:** third-party "Reddit/X API pricing 2026" blogs (octolens, prowlo, socialcrawl, twexapi and others): **D**, vendor SEO pages. They were used only to find the official pages above.
