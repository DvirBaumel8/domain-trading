# Independent rethink: DOM Architect, 2026-11-05 (Asia/Jerusalem)
Written without asking Gavriel first. Read-only analysis; no money, no settings changed. Numbers come from the repo, the KB and the live DOM API (/auctions/funnel as_of 2026-11-05 00:23 IDT, /visits). Where I don't know something, I say "unknown".

## 1) Verdict
- **Zero sales from 5 names in 4 weeks is the expected result, not proof the method fails.** At the usual 1–2% a year sell-through rate, 5 names should make about 0.05–0.1 sales a year. We can't learn anything from 5 names in 30 days.
- **The real problem is that we built a large system and are hardly using it.** About 1,015 commits, 107 CRs and 28 BUGs since Oct 3 have produced $74 of domains, 0 bids in the last 7 days, and 1 outreach round (16 delivered, 0 replies) that was then paused.
- **Discovery "finding nothing" comes mostly from timing and the filters, not from a lack of names.** DOM's own 7-day funnel shows that 2,290 of the 2,500 shortlisted names were *ended* by the time anyone looked at them.
- **My honest call:** simplify hard. Pick one cheap channel that gives real buyer signal (outbound to end users on names we own or hand-register) and run it for 30 days with a clear kill rule. Freeze system building while that runs.

## 2) Outside evidence (fact vs opinion marked)
- **Sell-through is about 1–2% a year for typical portfolios.** These are investor reports, not audited data.
  - DN.org: "annual sell-through rates … often fall between 1% and 2%"; speculative names do worse. https://dn.org/creating-a-sell-through-forecast-you-can-trust/
  - One NamePros seller with 6,700–7,500 names (self-reported, a fact about one portfolio): 1.5% at a $1,450 average price, 1.0% at $2,000, 0.43% at $4,681. https://www.namepros.com/threads/sell-through-rates.1193687/
  - A NamePros opinion thread: the "natural" rate is about 0.5%, and active outbound, many venues and a small portfolio can raise it to 2–5%. Brad (NamePros): "most … around 1%-2%". https://www.namepros.com/threads/what-does-a-1-portfolio-turn-mean.943824/
  - Namefi glossary: 2–3% is "healthy" for a curated .com book. https://namefi.io/r/en/glossary/sell-through-rate
- **What this means for us:** with 5 names, inbound-only selling (Afternic landers) needs years to show anything. These are base rates, not a guarantee.
- **First sales for small new investors usually come from outbound or cheap pricing.** These are anecdotes, not statistics.
  - A hand-registered $7 three-word geo .com sold for $800 by outbound in 7 days. https://www.namepros.com/threads/my-first-sale-undeveloped.1082113/
  - A hand-registered name listed at a £1,500 BIN took a £350 offer within a week. https://www.namepros.com/threads/a-tale-of-2-sales-my-first-two-ever.1080536/
  - "How long before your first sale?" thread: reports range from 1 week to 8 months or more. https://www.namepros.com/threads/how-long-before-your-first-sale.757170/
- **Outbound playbook (one practitioner's opinion).** It's a volume game ("no response for your first 20 domains, then your 21st sells"). Geo and keyword three-word names "very low chances" via lander or marketplace but sell via outbound. The sweet spot is $200–$499, follow-ups matter, and leads come from Google, Maps, advertisers and LinkedIn. https://www.namepros.com/threads/outbound-process-for-beginners.1101291/
- **Pricing (math from the NamePros thread above):** selling $200 names needs about 4.25% sell-through just to cover renewals, so starters should price around $450. Our names are listed at a $1,488–$2,488 BIN, which is the slow, low-turnover end.
- **Not verified this session:** DNJournal, Afternic or GoDaddy official stats, Cyger/DNAcademy, Elliot Silver and Josh Schoen. I didn't fetch them, so I'm not quoting any numbers from them.

## 3) Our data: effort vs results
| Item | Value | Source |
|---|---|---|
| Repo commits since 2026-10-03 | 1,015 (420 since Oct 20 "freeze") | git log |
| CRs / BUGs filed | 107 / 28 (178 request files total) | docs/requests |
| Discovery v3 packs | 5 (Oct 28, 29, Nov 2, 3, 4) | discovery-runs/ |
| Bot lessons files | 12 roles (buyer, gizbar, shomer, sochen…) | lessons/ |
| Domains owned | 5; cost $74.15 (13.73+11.08×3+24.19) + $4.99 GoDaddy Auctions membership | ledger/ledger.csv |
| Renewals next year | about $76 (23+11.08×3+22) | ledger/portfolio.csv |
| Sales | 0, $0 | /auctions/funnel |
| Afternic views/leads, 30 days | 0 / 0 | /auctions/funnel traffic_of_bought |
| Redirect visits | 3 Porkbun names, Oct 20–27 only (e.g. aievals 254 "human" on Oct 20, mostly self-referrer hosts, so probably our own tests or crawlers, not buyers); 0 since the switch to Afternic NS | /visits |
| Outreach | Oct 14: 19 rows, about 16 delivered, 0 replies, then PAUSED. The 50-address test was prepped but never sent. | sales/outreach-log.csv, outreach-test-50/07-round1-status |
| Auctions | rentguitar.com lost; 0 bid plans created Oct 30–Nov 5 | funnel bid_plans |
| Token/usage cost | heavy (once 25% of the weekly limit in 1 day); $ value unknown | parent notes |

**Funnel (DOM, Oct 30–Nov 5):**
- 6,334 live auctions seen, 2,500 shortlisted and served, 684 excluded as prior kills.
- **2,290 marked ended.**
- 47 auto-prebid checks, 17 passed.
- 0 bid plans.

**Per-run packs:**
| Run | field_n | Served | Survivors |
|---|---|---|---|
| Oct 29 | 686 | 562 | 6 survivors, all parking landers |
| Nov 2 | 763 | 248 | 1 card |
| Nov 3 | 709 | 240 | 0 |
| Nov 4 | 667 | 110 | 0 |

On Nov 4, 61 of 110 served names were killed for "brand/coinage/fragment" and 21 as "not a named paid service".

**Paper-auction check:** among shortlist names, 64 of 96 would have been won at our max, with a median final price of $22. So cheap names *are* winnable. We just don't act on them.

**Filters vs sourcing:**
- Both play a part, but **timing comes first**. The shortlist is built at about 17:33 IDT and judged hours later, often the next morning, so most names have ended by then.
- After that, the meaning filter (only "named paid service" exact-match names) kills about 75–95% of what's left. It's strict by design, and for a $1,500 budget that's defensible. But together with the late timing it leaves nothing.

## 4) Root causes (ranked)
1. **No demand test.** We never put a priced offer in front of enough real end users. Inbound on 5 names is statistically silent, and outbound stopped after 16 emails.
2. **Building beat doing.** 135 CRs and BUGs, 12 bot roles, and daily datasave, panel and DB-size work. Most of the effort went into infrastructure, not buying or selling.
3. **Discovery timing.** Judging happens after most auctions end (2,290 of 2,500 ended).
4. **Narrow buy box plus high BIN.** Exact-match "service" .coms at a $1,488+ BIN is the slow, low-turnover end of the market.
5. **Measurement is broken.** Moving to Afternic NS ended our own visit counting, so we can't see traffic.

## 5) Ranked next actions
**A. SIMPLIFY: outbound-first sprint (recommended)**
- **What:** send the prepped 50-address test (already built, legal-checked and tokenized), plus follow-ups, on the 5 owned names. Offer a price of about $300–$500 as well as the BIN.
- **Cost:** $0 cash; Dvir's approval to send.
- **Time to signal:** 14 days after the last send.
- **Pass:** at least 1 offer or at least 3 positive replies. **Fail:** 0 replies, in which case drop outbound for these niches.

**B. Fix discovery timing, then run 2 weeks**
- **What:** judge within 1 hour of the 17:33 IDT shortlist, or judge only auctions that end at least 12 hours later. Create real bid plans at $11–$30 max.
- **Cost:** up to the existing cap; about $15–$30 a name.
- **Time to signal:** 14 days.
- **Pass:** at least 5 names bought at $30 or less, each with an end-user outbound list of at least 10 leads. **Fail:** fewer than 2 survivors a week, in which case the buy box is too narrow, so loosen it or stop auctions.

**C. Hand-reg plus outbound test (cheapest signal)**
- **What:** hand-register 10 geo or service three-word .coms at about $11, but only where at least 10 businesses use the term. Do outbound in the same week.
- **Cost:** about $110.
- **Time to signal:** 30 days.
- **Pass:** at least 1 sale or 2 offers. **Fail:** 0 offers on more than 100 emails.

**D. PAUSE the system**
- **What:** freeze all new CRs except BUGs that block A, B or C. Stop the daily DB-size, panel and L&L reviews, and run checks weekly. Cut bot runs to the minimum.
- **Cost:** saves token usage (the exact $ is unknown).
- **Signal:** the usage graph within 1 week.
- **Pass:** usage at least 50% lower with A, B and C still running.

**E. STOP option**
- **When:** if A and C both fail (0 offers on about 150 contacts plus the 5 listed names) by about Dec 15.
- **What:** stop buying, let the names sit on Afternic until renewal (about $76 at risk), and drop the non-performers in Oct 2027.
- **Total loss:** about $155 cash plus time.

## 6) What I would stop building
- New discovery-pack features, L&L idea rounds and the CR-104 pre-run gate. The gate is good hygiene, but it's not on the path to a first sale.
- DB-size work. It's at 60.9%, which is fine, and Dvir said no cleanup.
- Dynadot closeouts scoring (BUG-063) until a closeout is actually going to be bought.
- The visit counter and its redirect rework. Use Afternic views and lead emails instead.
- New bot roles or org redesigns. Run 2–3 bots (buyer, seller/outreach, coordinator) until we have a first sale.
