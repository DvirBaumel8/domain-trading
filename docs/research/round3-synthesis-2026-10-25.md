# Research round 3: synthesis (25 Oct 2026)

Three parallel researchers (Dvir: "search online more... YouTube... books... Reddit... compare it to our system, insert it to the knowledge base, decide on action items"):
- **A, investors' own data:** `investors-deep-2026-10.md`, knowledge file 0004 (47 sources).
- **B, YouTube, podcasts, books:** `video-podcast-books-2026-10.md`, file 0005 (36 sources, 10 transcripts read in the viewer panel).
- **C, Reddit, forums, communities:** `communities-2026-10.md`, file 0006 (44 sources). Reddit, Quora, Indie Hackers and Medium refused automated reading (not bypassed); Hacker News' free API and NamePros threads worked.

The knowledge base now holds 6 files and about 330 graded sources. All six validate together (one duplicate source between 0004 and 0005 was removed from 0005). The verdicts below are the server's own `verdict.ts`, run in memory on all six files.

## How the verdicts moved
| Question | Before (0001-0003) | After (0001-0006) |
|---|---|---|
| `s8-max-bid-share` | very low, 0.25 of resale (1 cluster) | very low, **median 0.095 of resale** (10 clusters, range 0.03-0.6, 53% agreement) |
| `sell-through-yearly` | very low, 0.5%/yr (2 clusters) | very low, **median 1.7%/yr** (15 clusters, range 0.01-3.6%) |
| `end-user-price-band` | moderate, median $595 (2 clusters) | low, **median about $2,270** (23 clusters, very wide; biased toward reported wins) |
| `s8-auctions-vs-closeouts` | very low, auctions lead (59%) | very low, **closeouts lead** on one cluster (Allemann). Auctions lost their weak support; nothing proves closeouts |
| `signal-auction-bid-count` | low, weak signal (5 clusters) | low, weak signal (**10 clusters**): bids mean investors competing; shill and bot bidding is common |
| `signal-other-endings`, `signal-live-businesses` | moderate | moderate, more clusters (12 and 9), including founders who upgraded from .co/.io to the .com |
| `line1-hand-regs-worth-buying` | very low, none | very low, **a small side line** (screened registrations can pay; sell 0.23% in year 1) |
| `hold-two-years-enough` (new) | - | very low, tie. Allemann: only about 1 in 10 of his sales come from names bought in the previous 2 years; his sold names were held about 5 years |

## The central tension (for Dvir)
The professional ratio (pay about 10% of the eventual sale price) works for investors who hold names 5+ years and own thousands of them. Our founder rules hold a name at most about 2 years (rule 3) in a 40-name portfolio.
- At about 1.7% sold a year, a name has about a 3-4% chance of selling within our hold, so its expected value is about $45-$80.
- So **under the 2-year hold, a $160 maximum bid loses money on average**, unless our picks sell 2-3 times better than the published rates.
- Either the maximum bid comes down (to the expected value), or the hold gets longer for names that show interest. That second option is a founder-rule decision.

## Decisions for Dvir
1. **Maximum bid rule** (shown in the shortlist; buying is paused anyway):
   - (a) keep 20% of a $1,000 net resale scaled by score (up to $160);
   - (b) **expected value**: chance of a sale within the hold × net resale − renewal, about $80 at full score today, raised only by our own results;
   - (c) 10% of a realistic sale price (about $130-$230).
   - DOM recommends (b) while the 2-year hold stands.
2. **The 2-year hold (founder rule 3):** reconsider whether names with real interest (views, leads, offers) may get a second renewal. This is not a change now: a question to decide once our names reach month 12-18.
3. **The price test (F7):** run it in both directions. One higher group (e.g. $2,488), and for S8 names priced $3,488-$4,888, compare against $2,488. One large portfolio sold 0.43% a year at about $4,700 against 1.5% at about $1,450. This is weak (C), but it says the top S8 prices may sell less.

## Change now (DOM, no rule change)
- Bid weight in the auction score 10 → 5 (in v5.47.0).
- Add revenue per held name per year to `/report` (the real yardstick for a 40-name portfolio).
- Track zero-bid ($1) auctions as their own group in the funnel; Allemann's retail sales came mostly from names nobody else bid on.
- Never compare stored GoDaddy valuations across GoDaddy's 2026 rebuild of the tool.
- Note in `knowledge-sources-2026-10.md` that NamePros threads load today (its blog doesn't); Reddit and Indie Hackers refuse automated reading.

## Reconsider when we have our own data
- Auctions vs closeouts: our pick-proof test and our own bid outcomes.
- The max-bid share: after 10 or more resolved bid plans.
- The Line 1 Tier A rule, which needs a live business on .net AND .org. The founders who upgraded to the .com were mostly on .co and .io: consider counting .co and .io.
- The 65% floor, once real offers on our names are logged.
- A "request price" page instead of Buy Now for S8 names at $3,488 and up.

## No change (supported)
Afternic network listing (60-77% of sales come through GoDaddy search and partners); lease-to-own on (B: 25-36% of sales; ours is on, 16 months); the other-endings and live-business signals; word quality in the auction score; never scoring GoDaddy's valuation; the transfer check before import; Line 1 as a side line.
