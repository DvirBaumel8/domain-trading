# Research: the investors who publish data (session A, 25 Oct 2026)

Founder's ask: "find the most quality information you can... compare it to our system, insert it to the knowledge base". This was a DOM research session and read nothing but public pages. The knowledge-base rows are in `data/knowledge/0004-investors-deep.jsonl`: 6 authors, 1 new question, 12 new claims, 47 new sources, 78 evidence rows and 15 links. The adapted validator reads files 0001-0004 together and reports **0 errors**. Grading follows `docs/internal/knowledge.md`:
- B needs a verifiable record. Most B sources here are a named investor's whole-portfolio numbers.
- A post that reports only wins is marked `survivorship`.
- Portfolios of thousands of names, wholesale flipping and outlier sales are marked `indirect` against our case (40 S8 names, Buy Now $1,488-$4,888, 2-year hold).
- Repeats of the same data are linked (`echo_of`, or `same_author` with a note naming the data), so they count once.

**Access.** WebSearch and WebFetch only, with no browser and no proxy.
- NamePros blog and threads, the NameBio blog, Efty's blog and Namecheap's blog all return 403. NamePros content is used from search snippets only and is marked so.
- The DNW and DomainSherpa podcasts have their numbers only in the audio. Only the show-note pages, their comments and the DomainSherpa transcripts were used.
- One older dotweekly.com page answered 410.

**Grades of the 47 new sources:** 29 B (including GoDaddy's own pricing test, a vendor page), 17 C, 1 D. No A: none of these is an official dataset. Coverage per investor:

| Investor | What was found (source grade) |
|---|---|
| Andrew Allemann (DNW) | His own yearly results for 2020, 2021, 2022 and H1 2024 (B; linked as one data set), BuyDomains economics (B), end-user rewinds 2020 and 2025 (B), weekly Sedo end-user lists (B), NameJet/SnapNames expired lists (B), the Afternic LTO terms (B), 404media (B) |
| Doron Vermaat | 2016 DomainSherpa totals: 3.5 years of sales against acquisition cost (B); 2025 revenue per name from the X post that is already in the base |
| Brad Mugford | 2020 interview: plans on 1-2% sell-through and needs "large margins" (B); a snippet of the AMA that is already in the base |
| Elliot Silver | Sell-through 2021 and 2024, auction price inflation, the annualised sell-through method, a reader poll (B/C) |
| Michael Cyger | Revenue per domain post (B); the $500 challenge is already in the base |
| Michael Sumner / NameBio | The "don't shoot for the moon" analysis via DNW (B), a 2020 interview (C); the NameBio blog is blocked |
| Bob Hawkes | NamePros snippets: NameBio covers about 25% of retail sales, H1 2026 dollar volume, Nikul's sales channels (B); the acquisition-source split from his reported-sales post (already in the base, new evidence row) |
| Shane Cultra / DSAD | DomainSherpa interview (C), YourLogoHere.com bought for $2,005 and sold for $45,888 (C, via Raymond Hackney), a DSAD auction recap (C) |
| Mike Mann | OnlineDomain (Konstantinos Zournas) analyses of his self-reported sales, 2019, 2025 and 2026 (C) |
| Rick Schwartz | His list of 33 sales over 20 years (C, survivorship) |
| Ron Jackson (DNJournal) | 2025 Top 100 chart (B, outlier end, claim graded C); InterNetX review of the Sedo report (C, echo) |
| Joe Uddeme, Logan Flatt, Morgan Linton | DomainSherpa and Crunch.id interviews (B/C/C) |
| Jamie Zoch, Raymond Hackney | Zoch: no data post reachable (his lists are tools, not outcomes). Hackney: reports others' wins (C) |

## 1. What we learned per weak question

Verdicts below are an offline run of the server's own `computeVerdict` code with `kb_settings` v1, before (files 0001-0003) and after (0001-0004).

**sell-through-yearly** (very low before and after; 8 clusters became 14, 6 A/B became 11). The weighted median **moved from 2.4% to 2.0% a year** (range 0.5-3.6%). New whole-portfolio numbers:

| Investor | Sell-through | Grade |
|---|---|---|
| Allemann (about 2,000-2,500 names) | 1.7% (2021), 1.6% (2022), 1.96% (2023), 1.36% annualised (H1 2024) | B |
| Silver (about 2,000 names) | 3.6% by mid-2021; about 3% benchmark in 2024 | B |
| Mugford | plans on 1-2% | B |
| BuyDomains (large holders) | 1-3% | B |
| Cyger | 1-3%, sometimes 4-5% | B |
| A NamePros member (2,000 names) | 0.5-1% | C |
| Mike Mann, the $10k+ band only | 0.014-0.046% | C, qualifies |

Two cautions:
- Hawkes: NameBio holds only about 25% of retail sales, so sell-through estimates built on NameBio counts are too low.
- Silver (Munjal's method): a portfolio that is still buying must annualise by days held. This applies to our first-year numbers.

Still indirect (99% of the weight): every number comes from portfolios of thousands of names.

**s8-max-bid-share** (very low before and after; clusters 3 → 7, A/B 1 → 4). This is the biggest move of the round. **The pooled number fell from 0.25 to about 0.10 of the resale price** (range 0.03-0.30). The old 0.25 rested on two guide-site opinions, graded C/D. The new rows are investors who published both their cost and their sales:

| Investor | Cost against sale price | Grade |
|---|---|---|
| Vermaat | $14,738 of cost against $154,827 of sales over 3.5 years: **9.5%** (measured, about 1,000 names) | B |
| Allemann | buys under $60, median sale $2,300: about **3%** ("10x-200x") | B |
| Mugford | "mid $XX-low $XXX" buy against "low-mid $X,XXX" end-user price, because 1-2% sell-through needs "large margins" | B |
| Cultra (2012) | pays $500-1,500 for names he sells at $2,500-4,000: **about 30%**, only for very liquid LLL/LLLL/numeric names resold to investors, with 70-80% sold at NameJet | C, indirect |
| YourLogoHere.com | 4.4% | C, single win |

Certainty stays very low: the agreement is 46% because the opinions still point to 25%, and the evidence is indirect.

**s8-auctions-vs-closeouts** (very low before and after). **Still nobody publishes auction-bought against closeout-bought outcomes.** What moved:
- Three B/C sources now contradict "contested auctions still leave a margin": Mugford (prices up from mid $XX to mid $XXX+), Silver (names under $100 now go for $500+, single-bid auctions are rare) and Sumner (beginners should avoid expired auctions).
- One B source supports closeouts. Allemann (2020) bought mostly under $60 (closeouts and uncontested expired names) and still sold at a $2,300 median.
- Net: the computed lead flipped from "auctions" (very low, 59% agreement) to "closeouts" (very low, one cluster). Read this as **"auctions lost their weak support", not "closeouts proven"**.

Hawkes' acquisition split of NamePros-reported sales (hand-reg 62.5%, closeouts 11.8%, after-expiry registrations 8.3%, auctions 8.3%) is stored as its own claim, not tied to the question. It counts shares of sales without the number bought in each channel, so it gives no rate.

**end-user-price-band** (moderate before → low after; clusters 4 → 12, A/B 4 → 9). **The median moved from $595 to $1,300.** The $595 was the market-wide Sedo/registrar figure. New investor-sale numbers sit higher:

| Source | Sale prices | Grade |
|---|---|---|
| Allemann | median $2,300 (2020); most in $1k-5k (2021) | B |
| Vermaat | average $2-3k (2016); median $4,995 (2025, X) | B |
| Mugford | "Quality (2) Word .COM sell consistently in the $1K-$10K price range" | B |
| DNW Sedo end-user lists (sales of $2,000 and up only) | $2,000-$12,500, about 60% under $5,000 | B |

The market figures stay lower: Sedo 2024 median $549, 69% of sales by Buy Now (B); NameBio H1 2026 mean about $1,140 (B snippet). Certainty fell one step because the new sources added self-reported and indirect weight. GoDaddy NameFind's controlled test (B, marketplace): **499/999 endings on $2,500-$10,000 names gave revenue +22%, units +8%**. It is stored untied (a revenue change, another unit).

**signal-auction-bid-count** (low, leaning weak_or_no_signal; clusters 6 → 8). Three sources say a high bid count shows investors competing, which is not end-user demand:
- Cultra: "60, 70, 80 bidders" tell him a name will resell to investors.
- DSAD: 80+ bids come with investor competition.
- 404media.com: a clear end-user name drew only two bidders and closed at $1,207.

The lean stays the same, with more support.

**line1-hand-regs-worth-buying.** One new opinion only: Sumner (C) tells beginners to hand-register and buy outbound rather than bid at expired auctions. The verdict does not change (very low, leaning "none").

**New question `hold-two-years-enough`** (options `two_years_enough`, `longer_hold_needed`). It is a near tie, very low:
- For a 2-year hold: Hawkes' median hold before a reported sale is 11 months (survivorship) (weight 0.11).
- Against: 5 clusters, weight 0.10. Mike Mann's sold names were held over 5 years on average. Schwartz's wins came after 5-14 years. YourLogoHere.com sold after 6 years. Allemann sold a $5,700 name for $10,500 after 3 years. BuyDomains would need 35 years to sell half at 2%.

The arithmetic matters more than the tie. At 2% a year, about 96% of names do not sell within any 2-year window. A 2-year hold also cuts off the long tail of late wins, which is where much of these investors' profit comes from.

**Untied but stored:**
- Revenue per domain: typical portfolios $20-60 a year (Cyger, B); Vermaat about $44 (2016) and $224 (2025).
- Sales channels: Allemann had 58% (2021) and 78% (2022) of his sales through Afternic; Nikul 46% through the Afternic network and 48% from landers; Sedo 45% through its partner network (SedoMLS).
- Afternic lease-to-own terms (B): no outcome data anywhere.
- Afternic says a Buy Now price raises the sale chance "by up to 65%" (C, vendor).
- A broker needs 7-10 contacts per outbound sale (Uddeme, B). Not usable: founder rule 10 means we never contact buyers.

## 2. Comparison with our system

| Our rule | Evidence after this round | Enough weight to reconsider? |
|---|---|---|
| **Auctions as the S8 main line** (CLAUDE.md, Dvir 25 Oct) | **Challenged (weak).** No source compares auction-bought with closeout-bought outcomes. The support for "auctions" came from guide-site opinions plus Silver's bidder-count remark. Three experienced voices now say contested auction prices have risen past the resale margin, and one B investor made money on sub-$60 closeouts. Bid counts measure investor liquidity more than end-user demand. | **Not enough to change the line.** Very low either way, and all of it is indirect. It is enough to say the choice is unproven. Only our own bid outcomes and the pick-proof can settle it. |
| **Maximum bid rule** (20% of a $1,000 realistic net resale, scaled by score, $160 at full score, cap $250; `auctions.md` rule 18) | **Challenged (moderate weight, low certainty).** Investors who publish both cost and sales pay about 3-10% of their eventual sale price, and they explain it by 1-3% sell-through. The rule's 20% rests on the old 0.25 opinion. Our own knowledge base gives this arithmetic: P(sale within 2 years) ≈ 2 × 2% = 4%; net per sale about $1,040-1,190 (median end-user $1,300-1,488 less Afternic's 20%); **expected revenue per name ≈ $45**. A $160 bid breaks even only at about **7.5% sell-through a year**, 2-3x the best whole-portfolio rate anyone published (Silver 3.6%, Cultra 3.5%). | **Yes, enough to reconsider now.** 5 independent valued clusters (4 A/B) now point to about 0.10, against 1 opinion cluster at 0.25. The numbers are a Dvir decision (proposal below). |
| **Shortlist score parts** (shape, other endings, headroom, bids 10, age 10; v2 word quality) | **Bids: challenged** (as above): supports F8 (bids 10 → 5). **Other endings: no change.** The new Sedo lists show only 4 of 39 end-user buyers already on the same name elsewhere; this supports the existing "the sibling owner is rarely the buyer" claim, while the census signal (backtest AUC 0.77) is untouched. **Age / past use: no new evidence** (Linton and the DNW expired lists qualify only for investor demand). | Bids: yes (DOM, already planned as F8). Others: no. |
| **Buy Now levels** ($1,488 Line 1 default; S8 ladder $2,488-$4,888) | **Supported, with a lean upward.** End-user investor sales cluster at $2,000-5,000 (Allemann $2,300 median, Vermaat $4,995 median, Sedo end-user lists 60% under $5,000). Mike Mann sells many names at his $4,888 floor. NameBio/Atom found little price sensitivity below about $2,000-2,500. So the S8 ladder fits. $1,488 is at the low end and may leave revenue unused (F7). NameFind's +22% from 499/999 endings is in $2,500-$10,000; our endings are 88s. | F7 price test: yes, already a proposal for Dvir; add a 99-ending arm. No rule change without our own test. |
| **Afternic + lease-to-own** | **Afternic supported:** most of Allemann's sales (58-78%) and about half of Nikul's come through Afternic's network; NameBio says 60-65% across the networks. **Lease-to-own: no new evidence** on outcomes (terms only; the "more sales" claims come from marketplace marketing). | No change. |
| **2-year hold** (founder rule 3; S8 about 3 years) | **No clear verdict** (near tie, very low). Reported-sale medians (11 months) say most sales that happen come early. Long-hold investors earn their big wins after 3-6+ years, which our hold gives up. | No change to the rule. It strengthens the max-bid case: a short hold lowers the value of each name. |

## 3. Proposed action items

### Change now
1. **Re-base the maximum bid on expected value** (proposal; **Dvir decides**, `s8-max-bid-share` is his question).
   - **What:** max bid = P(sale in hold) × net sale − remaining renewal. Start with P = 2 × (2% a year × a selection multiplier of 2) = 8% and net = $1,040. That is about **$80 at full score instead of $160**. Raise the multiplier only when our own outcomes show it.
   - **Measure:** expected profit per bought name; later realised revenue per name against its cost.
   - **Who:** Dvir sets the numbers. DOM changes `shortlist-score.ts` and the settings in a release.
2. **Lower the bid-count weight in the auction score** (F8: bids 10 → 5). **What:** three sources say bids track investor competition, not end users; never read bids alone as demand. **Measure:** shortlist precision against auction outcomes. **Who:** DOM (with F5).
3. **Add revenue per held name per year to `/report`** (Cyger's RPD). **What:** an RPD line next to the sales count, because with 40 names the sell-through rate is mostly noise. **Measure:** RPD against the published $20-60 band. **Who:** DOM (small reporting change, next release).

### Reconsider when more data
4. **Auctions vs closeouts as the main line.** **What:** keep auctions as Dvir decided. Treat the pick-proof and the first 10-20 bid outcomes (won price, views, leads) as the deciding data. Re-run the verdict when they exist. **Measure:** leads and sales per name by channel. **Who:** Dvir (main-line decision); DOM reports.
5. **F7 price test, with a 99-ending arm.** **What:** part of the names at a higher Buy Now ($1,988 or $2,488), and some at $1,499 / $2,499 instead of 88 endings. **Measure:** revenue per listed name; leads per name. **Who:** Dvir (pricing settings by the admin command).
6. **Hold length.** **What:** when our first S8 names reach month 18-24, compare leads and offers by age, then decide whether S8 names deserve one more renewal. **Measure:** offers per name by months held. **Who:** Dvir (founder rule 3).

### No change
7. Afternic as the main venue and full network listing (supported again).
8. Lease-to-own settings (no outcome evidence).
9. Line 1 stays a gated side line (no new data).
10. The other-endings and live-business score parts (no new evidence against them).
11. The 2-year hold rule itself.

**Lessons:** the best data (NamePros blog, the NameBio blog, podcasts) is behind 403 or only in audio. The next round should be a hand session in Dvir's browser for the NamePros posts by Hawkes, plus a once-a-year January pass for the investors' yearly results posts (Allemann, Vermaat, Silver).
