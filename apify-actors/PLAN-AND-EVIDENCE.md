# Apify test: 3 Actors. Evidence, pricing, build status (25 Nov 2026)

Approved by Dvir on 25 Nov at 10:52 IST (Israel time).
- What: 3 paid Actors, public data only.
- Budget: $0, with a $20 cap.
- Pass mark by 15 Jan 2027: 30 or more outside users in 30 days, or $20 or more earned.
- Stop condition: fewer than 10 users by then.

Status: **built and tested locally only.** Nothing is published. No token, no sign-in, no spending.

## 1. Picks and demand evidence

All counts come from Apify's public Store API (`https://api.apify.com/v2/store?search=...`), pulled on 25 Nov 2026. Raw files are in `research/`.
Note that "users" counts include free-plan users, and those users bring $0 revenue (see §3).

| # | Actor | Competitors (users in 30 days / reviews / price per result) | Weakness we target | Data source and terms status |
|---|---|---|---|---|
| 1 | **bulk-domain-availability-checker** | automation-lab 71 / 0 reviews / $0.0023 · bridgeworks 43 / **1★ (1 review)** / free · santamaria 39 / 0 / $0.003 · onescales 30 / 5★(3) / **$0.10** · datascoutapi 27 / 5★(4) / $0.00049 (sum of top 5 ≈ 210) | Leader has no reviews; #2 rated 1★; #4 charges 40× more. We add DNS-first plus registry confirmation, a names×TLDs generator and a for-sale/parked flag. | DNS over HTTPS (Cloudflare, Google), plus RDAP servers listed by IANA (https://data.iana.org/rdap/dns.json). **Risk:** Verisign's RDAP terms forbid "high volume, automated" queries except "as reasonably necessary to register domain names" (https://www.verisign.com/legal-center/rdap-terms/). Mitigation: DNS answers first, so RDAP is only called for names with no nameservers; RDAP is throttled to about 3 requests per second per registry; the stated purpose is finding names to register. |
| 2 | **sitemap-url-extractor** | apify/sitemap-extractor 57 / **3.2★ (8 reviews)** / $0.0005 · boxbox10 33 / 0 / free · onescales 14 / 5★(3) / **$0.03** (sum ≈ 104) | The incumbent run by Apify itself is the worst-rated in the niche. | Sitemaps are files that sites publish for machines. Discovery is via robots.txt. Requests are plain HTTP with an identifying User-Agent. No login and no crawling of pages. |
| 3 | **bulk-dns-email-auth-checker** | gazidev 24 / 0 / $0.001 · pvalyou 18 / 0 / $0.001 · superlativetech 16 / 0 / free · automation-lab email-enrichment 18 / 0 / $0.003 (sum ≈ 80) | Nobody has reviews. Nobody scores the domain or gives plain-English fixes. | Public DNS only (DNS over HTTPS). Lowest-risk source. |

Considered and **excluded**:
- **Wayback / domain history** (demand ≈ 385 users in 30 days). Excluded because the Internet Archive's terms allow its collections only "for scholarship or research purposes" (Mark Graham, quoted by WGCU/Nieman Lab, 22 May 2026: https://news.wgcu.org/text/section/science/2026-05-22/over-340-local-news-outlets-are-limiting-the-internet-archives-access-to-their-journalism).
- **GoDaddy auction-list parsing.** Excluded per the rule: the terms page did not load, so the terms are unclear.
- **App Store reviews.** Higher demand (top tool has 675 users in 30 days), but prices are a race to the bottom at $0.0001 per review, and Apple's terms for its feeds are unclear.
- **LinkedIn, Instagram, Amazon-type targets.** Excluded as legal risk.
- **SEC, FDA, grants, Companies House.** Clean sources, but demand of 2–49 users, and some need API keys.

Honest base rate: across about 61,900 paid Store listings, about 70% had 0–1 users in 30 days (https://www.doesitpay.org/selling-ai-agents-and-gpts/research/). Our niches are small: 80–210 users across the whole niche each month.

## 2. Proposed prices (pay per event, using the automatic dataset-item event; no custom charging code)

| Actor | Primary event | FREE / BRONZE / SILVER / GOLD | Reasoning |
|---|---|---|---|
| Domain availability | domain returned | $0.0015 / $0.0013 / $0.0011 / $0.0010 | Below the leader ($0.0023) and far below onescales ($0.10); above datascoutapi ($0.00049) because we confirm at the registry and add the generator. |
| Sitemap extractor | URL returned | $0.0003 / $0.00025 / $0.0002 / $0.0002 | 40% under Apify's own tool ($0.0005); 100× under onescales. |
| DNS & email auth | domain checked | $0.0015 / $0.0013 / $0.0011 / $0.0010 | Richer output (score, issues, 17 DKIM selectors) than gazidev ($0.001). One free competitor exists. |

Keep Apify's default actor-start event.

Platform cost from local timings, at 256 MB of memory:
- 300 domains took 34 s, about 0.0024 compute units ≈ $0.0005. That run would bring in $0.45 revenue (×0.8 = $0.36).
- 310 email-auth domains took 58 s ≈ $0.0008.
- 600 sitemap URLs took about 10 s.

Margins are fine.

Price-change rule: raising a price is allowed once a month and takes effect after 14 days, **but takes effect immediately while an Actor has no paying users** (https://docs.apify.com/actors/monetize/set-up-monetization.md).

## 3. Monetization and payout rules (official)

- **Models now offered:** pay-per-event, or pay-per-usage (free to the developer) (https://docs.apify.com/platform/actors/publishing/monetize). Rental and pay-per-result are no longer listed.
- **Split:** developer profit = 0.8 × revenue − platform costs (https://docs.apify.com/platform/actors/publishing/monetize/pricing-and-costs).
- **Free-plan users bring $0 revenue.** Apify covers their usage instead (same page). The $20 pass mark therefore needs paying users: about 16,700 domains checked at $0.0015 just to clear $20 net.
- **Before publishing:**
  - Accept the Store Publishing Terms.
  - Build and run each Actor once on the platform.
  - Have a README plus input and output schemas.
  - ID verification is needed only for full permissions or more than 10 Actors. Ours use the default limited permissions, and there are 3 (https://docs.apify.com/actors/publishing/publish.md).
- **Before monetizing:** "complete your billing and payment details" in Console (https://docs.apify.com/actors/monetize/set-up-monetization.md).
  - Needs Dvir's legal name, address and payout method.
  - No approval queue or review time is documented. Publishing appears to be self-serve.
- **Payout:**
  - An invoice is generated on the 11th of each month, with 3 days to dispute; payment goes out on the 21st–25th.
  - Minimum is **$20 by PayPal or Wise**, or $100 by SWIFT wire with $10–50 in fees.
  - Below-minimum balances roll over. Balances unpaid for 12 months are forfeited.
  - Source: https://docs.apify.com/platform/actors/publishing/monetize/monthly-payouts.
- **KYC for payout:**
  - Government ID, and possibly proof of address, tax documentation and beneficial-owner details. Unpaid balances are forfeited after 12 months without KYC (Publishing Terms §10.1.2–10.1.6: https://docs.apify.com/legal/store-publishing-terms-and-conditions.md).
  - No Israel-specific exclusion was found. PayPal can receive money in Israel (https://getpaidatlas.com/country/israel).
- **Other Publishing Terms that bind us:**
  - No promoting off-platform products in the README.
  - No fake or self reviews; Apify can ban the account and take back payouts.
  - Answer Apify's requests within 3 business days.
  - A faulty Actor gets marked "under maintenance", and is deprecated after 30 days.

## 4. What is built (`/workspace/apify-actors/<name>/`)

Each Actor has:
- `.actor/actor.json`, plus input, dataset and output schemas. All pass `apify validate-schema`.
- A `Dockerfile` (apify/actor-python:3.13; the image tag exists on Docker Hub; a local Docker build was not possible because the box has no Docker).
- A `README.md` written for Store search, `src/` code (Python, Apify SDK 4.3.0, httpx), `tests/`, and a sample input.

To re-run everything: `/workspace/apify-actors/run_all_tests.sh`. It runs the unit tests, validates the schemas, and does a local `apify run` with no token.

| Actor | Unit tests | Local runs |
|---|---|---|
| Domain availability | 4/4 pass | 300 domains (150 keywords × .com/.io) in 34 s: 89 available, 211 registered, **0 unknown**. Spot checks: google.io/.de/.co/.ai/.me registered; rentguitar.io/.ai/.de available (matches DoH NXDOMAIN); rentguitar.com shows GoDaddy, 2009-09-25, "Afternic (listed for sale)". Invalid input lines are skipped and saved to the key-value store, not charged. |
| Sitemap | 5/5 pass (includes an XML-bomb rejection test) | apify.com plus docs: 600 URLs. wordpress.org/news with regex, modified-since and status check: 60 URLs, all HTTP 200, 85 sitemap files walked. Sites with no sitemap are logged and not charged. |
| DNS & email auth | 5/5 pass | 310 domains in 58 s, 0 errors. Null MX, empty DKIM key and wildcard DKIM are handled (example.com is a real wildcard case). stripe.com: Google Workspace, ~all, DMARC reject, 4 DKIM selectors, score 80. |

Local git commit: f45bc4e. It is not pushed anywhere.

## 5. Needed to publish (in order)

1. API token from the looped_kite account. The parent handles this; then run `apify login -t <token>` on the box. **Do not print the token.**
2. Run `apify push` in each Actor folder. This creates private Actors and builds them on Apify.
3. Run each once on the platform with its sample input. Free-plan credit covers this; expect pennies.
4. In Console, accept the Store Publishing Terms. This is an agreement in Dvir's name.
5. In Console, fill billing and payout details: Dvir's legal name, address, and PayPal email (or Wise). Collect them through the vault or an in-chat form; never put them in chat.
6. For each Actor, in the Publishing tab:
   - Add a logo, short description and categories (Developer tools / SEO / Lead generation).
   - Monetization: pay-per-event, primary event = dataset item, prices from §2.
   - Click Publish.
7. Later, only if money accrues: KYC with an ID photo, then the first payout around the 21st–25th of the month after earning.
8. Track users in 30 days per Actor weekly against the pass mark. Data comes from the same public Store API.
