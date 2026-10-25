# Research: historical sold and unsold .com data for the scoring engine (25 Oct 2026)

**Question (Dvir):** the learned scoring engine needs about 10,000 SOLD .com names (name, price, date, venue) and about 10,000 UNSOLD .com names (held or listed, then dropped or never sold, with a date). It has 0 of each, and the daily job only collects from today forward. Can we fetch history in bulk instead of waiting months?

**Short answer:**
- **Sold, history:** no free, legal, bulk source of individual historical sales exists.
  - The only large one is NameBio's paid API. It needs NameBio's written permission, the price isn't published, and its DailySales call reaches back only one year.
  - The free public copies of NameBio data (a 348,000-row Kaggle file, scraper repos) are scraped copies. We should not use them.
- **Unsold, history:** possible within our rules, but only through a paid zone-history vendor: dns.coffee Standard, $90 a month, one month is enough. It gives about one year of names that left the .com zone, and when each was first seen (since 2011).
- **Forward data is faster than "months" on both sides:**
  - Unsold: the official GoDaddy files and the free NameBio Verisign drop list give tens of thousands of dropped .com names a day.
  - Sold: GoDaddy auction endings give an estimated ~100+ .com sales of $100 or more a day.
  - **But** every row dated after the holdout date (2026-10-14) is rejected with `HOLDOUT_SEALED` until Dvir moves that date (`POST /engine/holdout-date`, his approval).

**Method and limits of this research:**
- Every claim about a source was checked on the source's own page where it could be fetched (WebFetch, honest client, no proxy).
- Pages that refused us (403 or a bot check) were **not** retried through any proxy. They are marked *unverified*: namebio.com, namepros.com, estibot.com, dnib.com, ssrn.com, wiley.com.
- The web-search budget of the session ran out at the start, so I found sources by fetching known official URLs, Crossref, the Kaggle and Hugging Face public APIs, and `gh search`. Smaller sources that only a search would surface may be missing.
- Grades: **A** official or large-sample, **B** practitioner with a track record, **C** guide, **D** vendor marketing, anecdote or content farm.

---

## 1. Options table

Fit: **OK** = allowed by our rules at $0; **Founder** = needs Dvir (money, a sign-up, or permission from the source); **No** = forbidden by a founder rule or the source's terms.

| # | Source | Gives | History depth | Rows (estimate) | Cost | Terms (short quote, URL) | Effort | Fit |
|---|---|---|---|---|---|---|---|---|
| S1 | **NameBio paid API**: DailySales, TopSales, Comps | Sold: name, price, date, venue type (Private/Auction) | DailySales: *"Must be within the past year"*. TopSales: all time, but highest prices first | DailySales: likely 100k+ .com rows of $100+ for one year (inferred from S3's venue counts; not verified) | Credits: DailySales 250 (sales of $100+) or 500 (all) per day; TopSales 1 per sale. **The USD price of a credit is not published** | *"You MAY NOT use our Paid API for a product or service ... without obtaining written permission"*; *"Sharing or re-selling API access, or the data obtained from it, is strictly forbidden."* (api.namebio.com/docs, updated 18 Jul 2026) | Low once access exists: 365 calls | **Founder** (written permission and price; Dvir writes to NameBio himself) |
| S2 | **NameBio free endpoints**: RetailStats (+ CSV download), TLDStats, Verisign drop order | RetailStats: **per keyword, not per name**: sale_count, price_sum, avg, max, stddev for sales of $100+, all time. Verisign: .com/.net names due to drop in the next ~6 days | All-time aggregates; the drop list looks forward only | One row per keyword; drops: tens of thousands a day | $0 | *"You may incorporate this data into other products and services, but attribution is required."* (api.namebio.com/docs) | Already built (CR-062; `sources.namebio` off). The drop-order call was removed in 5.15.0 | **OK.** Gives features, not labels. The drop list is a forward unsold source (see plan) |
| S3 | **Kaggle `domainnamesales/domainnamesales`** (TSV: date, domain, price, venue) | Sold: 348,235 .com sales, $100 to $9.99M, median $246. Venues: GoDaddy 204,580, NameJet 62,170, DropCatch 42,609, BuyDomains 9,588, Sedo 7,560, Dynadot 5,368 | Almost all rows are 2017–2020; newest 2021-01-01 | 348k (93k of $500+) | $0 | Licence field says PDDL, but nothing shows who produced the data. The $100 floor and the venue names match NameBio's database, so it is almost certainly a NameBio scrape. https://www.kaggle.com/datasets/domainnamesales/domainnamesales | Low | **No.** A scraped copy of a source whose terms forbid sharing its data; it goes around our NameBio rule. 4 to 7 years old, too. Inspected once in the scratchpad to learn what it is, then deleted; nothing kept or loaded |
| S4 | **GitHub NameBio scrapers** (e.g. `kamich22/NameBio-Scraper`, `windbridges/namebio`) | Code that scrapes NameBio | — | — | $0 | Scraping NameBio | — | **No** (founder rule) |
| S5 | **DNJournal** weekly (now every two weeks) Top 20 charts, YTD Top 100 charts, archive back to about 2004 | Sold: name, price, venue, date. High-value sales only | About 20 years | About 20 per chart, all TLDs. Very roughly 5k–10k .com rows in the whole archive (not counted) | $0 | *"No photos, text or content of any kind may be copied from this site without expressed written consent."* (dnjournal.com, every page) | High (manual) | **Founder:** only with Ron Jackson's written consent, which Dvir would have to ask for. Without it: **No**, also for manual copying |
| S6 | **Domain Name Wire** end-user sales posts (Sedo) | Sold: about 15–20 end-user sales a week | Since 2005 | Thousands, mostly non-.com and high price | $0 | *"use automated programs to access Domain Name Wire without express written permission"* is prohibited (domainnamewire.com terms) | High | **No** for bulk. A permission request would go to the publisher (Dvir) |
| S7 | **GoDaddy auctions inventory files** (official, `inventory.auctions.godaddy.com`) | Current listings only: expiring auctions, closeouts, bids, prices. 39 files, all dated today | **None.** `metadata.json` lists only today's files; no archive | Forward: auction endings with bids give an estimated ~140 GoDaddy sales of $100+ a day (S3's 204,580 GoDaddy rows over ~4 years). Expiring names with no bid: tens of thousands a day | $0 | Official public host, already used (datasave rule 1) | Built (CR-071). Only auctions of **$500+** are stored today (rule 18) | **OK** (forward only) |
| S8 | **Dynadot API** `get_closed_auctions`, `get_closed_backorder_auctions` | Closed auctions: sold (with bids) or unsold | Not stated in the docs I could read | Unknown | $0 (needs an account balance) | Rate limit only: 60 a minute on Regular. **Our account is barred:** *"Your account is restricted from using the apis related to auction"* (21 Oct 2026, CR-071 R-9) | Built as an upload kind | **Blocked.** Dvir would have to ask Dynadot for access. Backorder auctions are catch-service data (flag) |
| S9 | **dns.coffee** (formerly CAIDA DZDB): zone archive of the root zone and 1,200+ TLDs incl. .com since 2011 | Unsold (derived): `feeds/domains/old/{date}` = names that *"lost their last nameserver in a zone"* that day. `domains/{domain}` = first_seen / last_seen | Per-name dates since 2011; the daily feeds keep *"about one year of history"* | Hundreds of thousands of .com removals a day; a year gives far more than 10k after filters | Academic: free *"by application for research, teaching, non-profit"*. **Standard: $90/month** (500 bulk requests, 5M lookup rows). Pro: $400 | *"Scrape or otherwise access the dns.coffee website by automated means"* is forbidden (the API is the allowed route); no bulk *"redistribute, or republish"* without agreement (dns.coffee/terms) | Medium: 365 bulk calls, filter .com, then RDAP confirmation | **Founder** ($90 for one month; Dvir signs up). We are commercial, so the free academic plan doesn't honestly fit |
| S10 | **OpenINTEL** (University of Twente): daily DNS measurement of every .com name since 20 Feb 2015 | Unsold (derived from the daily name set) + "was live" (A/MX records) | Since 2015 | Full .com every day | Commercial licence on request; price unknown | .com is *"Closed"*: *"Closed data may be available upon request"*; commercial: *"feel free to contact us"* (openintel.nl/data/forward-dns/zone-based) | High (a big data handoff) | **Founder** (a request or a licence, by Dvir) |
| S11 | **ICANN CZDS .com zone file** (Verisign) | Today's zone only; daily diffs give removals going forward | **None** (current file only) | ~160M names a day; daily removals in the tens of thousands | $0 (ICANN account; Verisign approves) | The file leaves out *"serverHold, clientHold, pendingDelete, and redemptionPeriod"* names (verisign.com zone-file page). The CZDS terms couldn't be read (JS page): **unverified** | High: several GB a day, needs disk (CR-007 §19.2 said no at $0 on Render; the Mac host has disk but is temporary) | **Founder** (sign-up by Dvir; forward only) |
| S12 | **Common Crawl** (152 crawls, 2008 to Oct 2026) | Feature: was there a live website on the name at time T | 2008–2026 | Any name | $0 | A *"limited ... non-exclusive, limited license to access and use"*; *"Please do not overload the URL index server"* (commoncrawl.org/terms-of-use, index.commoncrawl.org) | Medium (use the columnar index) | **OK** for features (no labels). Not the Wayback Machine |
| S13 | **Certificate Transparency** (crt.sh) | Feature: TLS certificates issued for the name over time | Since about 2013 | Any name | $0 | crt.sh answered 502 on both tries: **unverified** | Medium | Probably OK for features; check its terms first |
| S14 | **Tranco** daily top-site lists (archived) | Feature: traffic rank at time T (top 1M only) | Years of daily lists | 1M a day | $0 | Mixed upstream licences, one of them *"CC BY-NC 4.0"* (tranco-list.eu). Already "not used" in sources.md | Low | **No** (licence; we use Majestic) |
| S15 | **Rapid7 Project Sonar** | DNS snapshots | Years | Large | Commercial | Policy *"changed on Feb 10, 2022"*, now restricted (sonardata.rapid7.com) | — | **No** (not open) |
| S16 | **WhoisXML API**: Newly Registered + dropped domains feed, Domain Info DB (*"active, expired, and deleted domains"*), WHOIS History DB (*"28.7 billion+ WHOIS records"*) | Unsold (derived): dropped lists; registration dates | Feeds: free *"5-day rolling sample"*; archive depth and prices **not published** (quote only) | Large | Quote only (WXA One *"starting from $129/month"* is a different product) | Vendor terms; not reviewed | Medium | **Founder** (quote). Vendor marketing, grade D |
| S17 | **Verisign DNIB** quarterly reports | Counts only (registrations, total names) | Since 2007 | No per-name rows | $0 | dnib.com 403: **unverified** | — | Context only |
| S18 | **Academic datasets**: Lindenthal, *Valuable words* (JASIST 2014), *"a large data set of domain sales spanning the years 2006 to 2013"*; Miramirkhani et al., *Panning for gold.com* (WWW 2018, drop-catching); Pavicevic et al. (IEEE Access 2026, aftermarket inventories) | Method; their data are not published | 2006–2013 | Not available | $0 | No data-availability statement found (Wiley and SSRN 403) | Asking the authors means emails by Dvir | **Founder** (only if Dvir wants to write to authors). Most useful for method (labels for drop-catching) |
| S19 | **ExpiredDomains.net** | Deleted and pending-delete lists, marketplace listings | Not stated | Large | Free account | No terms on automation found on its pages | — | **No:** it is a website listing marketplace data, and automating it would be scraping |
| S20 | **Estibot** | Appraisals; claims sales data | — | — | Unknown | Cloudflare bot check: **unverified** | — | Not a source of labels; skip |
| S21 | **Our own data** (datasave since 14 Oct; `drop_list_rows` from Gavriel's uploads; GoDaddy closeout episodes) | Unsold: dropped, deleting and closeout names. Sold: GoDaddy auction endings of $500+ | Since early Oct 2026 | Thousands; mostly after the holdout date | $0 | Ours | Low | **OK**, but rows after 2026-10-14 are blocked by the holdout guard |
| S22 | **Bob Hawkes' NamePros analyses** (via our research of 25 Oct) | Aggregate rates (sell-through 0.5–1.1% a year, median $1,300) | 2024–26 | No row data found | $0 | namepros.com 403: **unverified**; earlier research used a proxy for it, which is no longer allowed | — | Context only (base rates for checks) |
| S23 | Hugging Face `tlders/domain-prices-sample` | Registrar price lists, not sales | — | <1k | $0 | CC BY-NC 4.0 | — | Not relevant |

---

## 2. Recommended plan

### Facts that shape the plan
- **The holdout date:** `settings.engine_sales_max_date` is 2026-10-14. Any sale or unsold row dated after it is refused with `HOLDOUT_SEALED`. So:
  - every **forward** source (S2 drops, S7, S11, S21) gives no training rows until Dvir moves the date;
  - **historical** sources fit the engine as it is.
- **The regime filter cuts the rows:** training uses only names of letters only, 6–20 characters, 2–3 known words. A rough guess: 20–35% of raw rows pass. **To have ~10k usable rows per class, collect about 30k–50k raw rows per class.**
- **The time windows must overlap:**
  - The test file is the newest full quarter that has sales (today Q3 2026, Jul–Sep).
  - The unsold rows must span 90 days or more, or the `dated` split and `tok_rate_pit` stay off.
  - Sold and unsold rows should cover the same months, or the model learns the date instead of the name.
- **RDAP fill time:** each new name gets 6 RDAP ending checks. 32k names took about 13 nights, so 60k–100k names would take roughly 25–40 nights. Plan for it, or sample.
- **`POST /data/sales` refuses any source containing "namebio"**, so NameBio rows could go only to `POST /engine/sales`, never to `market_sales`.

### Step A: unsold, historical (fastest route to 10k, legal)
1. **Dvir buys one month of dns.coffee Standard ($90)**. He signs up himself; we never create accounts for him.
2. Gavriel (or a DOM-written local script run by a bot) pulls `feeds/domains/old/{date}` for each day from about Oct 2025 to 14 Oct 2026. That is 365 bulk requests (the plan allows 500). Keep `.com` only.
3. **Keep a name only if:**
   - its `first_seen` is at least 365 days before its removal (it was "held" for at least one renewal cycle), and
   - it passes the regime filter (cheap to check before any RDAP call).
4. **Confirm the drop and the catch with RDAP (Verisign, already allowed):**
   - 404 → dropped and not re-registered: `caught_by_catcher: false`;
   - 200 with a registry creation date 0–7 days after the expected delete (removal + ~35 days, after redemption and pending delete) → `caught_by_catcher: true`;
   - a later re-registration → `false`;
   - unanswered → `null`.
5. **Load:** `POST /engine/unsold` `{domain, type: "dropped_after_held", observation_date: <removal date + 35 days, capped at 2026-10-14>, caught_by_catcher}`, in chunks of 5,000–10,000.

**Why this works:** within a year, .com loses hundreds of thousands of names a day, so 10k usable rows is easy after the filters.

**Alternative at $0:** OpenINTEL's closed .com data (S10), if they agree. The request is slower and the outcome uncertain.

### Step B: sold, historical (no free legal path; pick one of these)
- **B1 (recommended if Dvir agrees): ask NameBio for written permission and a price** for DailySales on the past year (S1).
  - 365 calls × 250 credits (sales of $100+). Expect well over 10k .com rows; ~30k+ after the $100 floor, before the regime filter (estimate from S3).
  - Load: `POST /engine/sales` `{domain, price_usd, sale_date, venue: <NameBio venue>, source: "namebio_paid_dailysales", source_url: "https://namebio.com"}`.
  - Keep NameBio's attribution and never re-share the rows (their terms).
  - Not `/data/sales`: it refuses NameBio by design.
- **B2 (cheap, small, high-price only):** ask DNJournal for written consent (S5) to copy its archived charts by hand.
  - Gives a few thousand .com sales of $2k+.
  - Too few and too skewed for 10k on its own; useful as a tier-B check set: `POST /data/sales` with `venue` = the "Where sold" column, `source: "dnjournal_weekly"`, `tier: "B"`, `listing_type: "bin"` unless the chart says auction.
- **B3 (free, forward only):** lower the GoDaddy auction-ending floor for the engine from $500 to $100.
  - That is a code change for DOM (datasave rule 18 / market rule 1 store only $500+). Ended auctions with bids (`SOLD_BIDS`) then become `POST /engine/sales` rows with `venue: "godaddy_auction"`, `source: "godaddy_inventory"` (tier A in `market_sales`).
  - About 100+ rows a day, so 10k in roughly 2–3 months.
  - **Usable only after Dvir moves the holdout date**, or once the engine's split uses a later quarter.

### Step C: forward sources, now (both sides, $0)
- **Unsold:**
  - the Verisign drop order from NameBio's free endpoint (S2; the call would need to be added back, since 5.15.0 removed it);
  - the GoDaddy expiring-auction names that end without a bid (S7);
  - with an RDAP check after the drop day for `caught_by_catcher`.
- **Sold:** GoDaddy endings (B3).
- **The holdout question:** they all need Dvir's decision to move it. The holdout exists so later data can test the model honestly. Moving it monthly (for example to the end of the last full month) keeps a test window. That is a DOM design proposal, not a recommendation to drop the guard.

### Labelling biases (must be stated next to any model trained on this)
- **Reported sales are skewed upward:**
  - DNJournal and DNW report only big sales;
  - TopSales is top by price;
  - private sales below about $1k are rarely reported.
- **Venue mix:** NameBio-style data is ~60% GoDaddy expiry auctions and ~30% drop-catch venues (S3's counts). These are **wholesale, investor-to-investor** prices for expired names, not end-user BIN sales like ours. Keep `venue` and consider training with venue, or on retail venues only.
- **"Unsold" from drops is mostly not an investor's failed listing:**
  - most dropped names were hand-regs by businesses or hobbyists that were never listed;
  - so "dropped" ≈ "nobody valued it enough to renew", a weaker and different label than "listed N days, didn't sell";
  - the held ≥1 year filter and the catcher check help, but can't fix this.
- **The truly comparable unsold label** is "listed for sale for N days without a sale". Today only our own episodes (`UNSOLD_60D`, Dynadot / GoDaddy closeouts) give it, and only forward.
- **Zone removal is not deletion:**
  - removal happens at redemption or hold;
  - some names are restored, and a name removed then restored shows as removed;
  - RDAP confirmation is required;
  - names registered and dropped between two zone snapshots are invisible (dns.coffee FAQ).
- **Survivorship and time:**
  - sold rows from S1 cover only the past year;
  - unsold from S9 also only the past year;
  - keep both windows the same, or weight by time.

---

## 3. What needs Dvir's decision (DVIR)
1. **NameBio paid API (S1):** write to NameBio (the docs ask for the company, the use, the endpoints and the credits a month) and approve the price, which is unknown until they answer. Without it, there is no historical sold source big enough for 10k.
2. **dns.coffee Standard (S9): $90 for one month**, signed up by Dvir. This is the fastest legal route to ~10k historical unsold. The free academic plan doesn't fit a commercial company.
3. **Optional free requests by Dvir:** DNJournal written consent (S5); OpenINTEL closed .com data (S10); Dynadot auction API access (S8); paper authors' datasets (S18).
4. **The holdout date (2026-10-14):** whether and how often to move it, so the forward sources (S2, S7, S21) can feed the engine.
5. **CZDS (S11):** only if Dvir wants to own daily zone diffs himself (sign-up by him, disk on a host). DOM doesn't recommend it while Step A is possible.
6. **The Kaggle/NameBio copy (S3):** DOM recommends **not** using it (a scraped copy; it breaks the NameBio rule and NameBio's terms). Listed so the decision is visible.

---

## 4. Sources, graded
| # | Source | Grade | URL | Verified here |
|---|---|---|---|---|
| 1 | NameBio API docs (updated 18 Jul 2026) | A | https://api.namebio.com/docs/ | yes |
| 2 | NameBio site and terms | A | https://namebio.com/terms | **no** (403) |
| 3 | Kaggle domain-name-sales dataset (metadata via the Kaggle API; file inspected) | D (unknown provenance) | https://www.kaggle.com/datasets/domainnamesales/domainnamesales | yes |
| 4 | GitHub NameBio scrapers | D | https://github.com/kamich22/NameBio-Scraper | yes (listing only) |
| 5 | DNJournal home, sales report, YTD charts | B | https://www.dnjournal.com/domainsales.htm, https://www.dnjournal.com/ytd-sales-charts.htm | yes (archive depth not shown) |
| 6 | Domain Name Wire and its terms | B | https://domainnamewire.com/privacy-policy-and-terms-of-use/ | yes |
| 7 | GoDaddy auctions inventory `metadata.json` | A | https://inventory.auctions.godaddy.com/metadata.json | yes |
| 8 | Dynadot API commands | A | https://www.dynadot.com/domain/api-commands | partly (closed-auction parameters not readable) |
| 9 | Our CR-071 R-9 (Dynadot auction API blocked) | A (own record) | docs/requests/CR-071-daily-data-saves-scheduled-job.md | yes |
| 10 | dns.coffee home, terms, pricing, FAQ, OpenAPI | A (data) / D (pricing page is a vendor's) | https://dns.coffee/, https://dns.coffee/terms, https://dns.coffee/pricing, https://api.dns.coffee/openapi.json | yes |
| 11 | OpenINTEL zone-based data | A | https://openintel.nl/data/forward-dns/zone-based/ | yes |
| 12 | ICANN CZDS | A | https://www.icann.org/resources/pages/czds-2014-03-03-en, https://czds.icann.org/help | partly (terms unreadable) |
| 13 | Verisign zone file access | A | https://www.verisign.com/en_US/channel-resources/domain-registry-products/zone-file/index.xhtml | yes |
| 14 | Verisign DNIB | A | https://www.dnib.com/ | **no** (403) |
| 15 | Common Crawl terms, index, collections | A | https://commoncrawl.org/terms-of-use, https://data.commoncrawl.org/cc-index/collections/index.html | yes |
| 16 | crt.sh | A | https://crt.sh/ | **no** (502) |
| 17 | Tranco | A | https://tranco-list.eu/ | yes |
| 18 | Rapid7 Project Sonar | A | https://sonardata.rapid7.com/ | yes |
| 19 | WhoisXML API (NRD, Domain Info DB, WHOIS History DB) | D | https://newly-registered-domains.whoisxmlapi.com/, https://domain-info.whoisxmlapi.com/database, https://whois-history.whoisxmlapi.com/database | yes (no prices published) |
| 20 | Lindenthal, *Valuable words*, JASIST 2014 (abstract via Crossref); SSRN 2011 version | A | https://doi.org/10.1002/asi.23012, https://doi.org/10.2139/ssrn.1885465 | abstract only |
| 21 | Miramirkhani, Barron, Ferdman, Nikiforakis, *Panning for gold.com*, WWW 2018 | A | https://doi.org/10.1145/3178876.3186092 | metadata only |
| 22 | Pavicevic et al., IEEE Access 2026 (aftermarket inventories) | A | https://doi.org/10.1109/access.2026.3740779 | metadata only |
| 23 | ExpiredDomains.net | C | https://www.expireddomains.net/ | yes (no automation terms found) |
| 24 | Estibot | D | https://www.estibot.com/ | **no** (bot check) |
| 25 | Hawkes' NamePros analyses (through `funnel-names-safety-2026-10.md`) | B | https://www.namepros.com/ | **no** (403) |
| 26 | Hugging Face `tlders/domain-prices-sample` | D | https://huggingface.co/datasets/tlders/domain-prices-sample | yes |

**Could not verify:**
- the USD price of NameBio credits, and whether NameBio sells bulk historical files;
- DNJournal's exact archive start year;
- the CZDS and Verisign zone file terms of use;
- Dynadot's closed-auction history depth;
- crt.sh terms;
- WhoisXML and OpenINTEL prices;
- whether the authors of any paper share their data.

**The daily-volume figures are estimates:** about 140 GoDaddy sales a day comes from S3's 2017–2020 venue counts, and "tens of thousands of .com drops a day" from general zone churn. Neither was measured by us.
