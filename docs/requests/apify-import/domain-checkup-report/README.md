## Domain Checkup Report: DNS, Safety & Score

Get a **complete, single-row due-diligence report** for any domain name (any TLD). Paste domains, URLs or email addresses and get **registration age, registrar, expiry, DNS and provider, parked or for-sale detection with a visible asking price, SPF/DMARC email auth, a Cloudflare Security DNS safety check, a lightweight trademark-risk hint, and a transparent 0–100 score** with plain-English reasons.

You pay **per domain report**. Current prices per 1,000 reports, including any plan discounts, are on the **Pricing** tab. Invalid input lines are skipped and never charged. The Apify Free plan includes monthly Store credit you can use for a first test — open the Pricing tab to see how far it goes at today's rates.

![Sample output from Domain Checkup Report](https://api.apify.com/v2/key-value-stores/dNe1hFUAqsMnqLOYE/records/checkup-output.png)

## Use cases

- Domain buyers checking age, registrar, expiry and whether a name is listed for sale, before they bid.
- Brand and legal-adjacent reviews that need a quick safety and trademark-hint pass (not a substitute for a real trademark search).
- Agencies or analysts scoring a list of names on DNS, email auth and landing-page signals.
- Portfolio reviews: schedule a run and watch expiry dates, parking and safety flags.

## What each report includes

- **Registration & RDAP (official registries via IANA bootstrap + ccTLD endpoints)**:
  - Registered vs. available status, creation date, domain age in years, expiry date, days until expiry, registrar name, and EPP status codes.
  - Throttled politely (~3 requests/sec per registry host) and DNS-first where possible.
- **DNS & Hosting Signals**:
  - `hasA`, `hasMx`, `hasNs`, IPv4 A records, MX priority/host, authoritative nameservers, detected **DNS provider** (Cloudflare, Route 53, GoDaddy, Namecheap, Google Cloud DNS, etc.), and **email provider** (Google Workspace, Microsoft 365, Zoho, etc.).
- **Parked / For-Sale & Price Detection**:
  - Checks known marketplace/parking nameservers (Afternic, Sedo, Dan.com, Bodis, ParkingCrew, HugeDomains, Atom, BrandBucket, Sav) **and** inspects the HTTP/HTTPS landing page (including common `/lander` JS/meta redirects) for marketplace redirects and visible asking/Buy-It-Now prices.
- **Email Authentication Basics**:
  - SPF (`v=spf1`) presence and `all` policy (`-all`, `~all`, `?all`, `+all`, `redirect`), plus DMARC (`v=dmarc1`) presence and `p=` policy (`reject`, `quarantine`, `none`).
- **Safety Screening (Free, Terms-Clean Source)**:
  - Queries **Cloudflare Security DNS (`1.1.1.2` / `security.cloudflare-dns.com`)** for malware/phishing filtering, plus HTTPS TLS certificate validity check.
  - Honest reporting: reports `"not_flagged"`, `"flagged_malware_or_phishing"`, or `"not_checked"` (for example when a domain does not resolve), never overclaiming universal safety.
- **Trademark-Risk Hint (Honest Heuristic)**:
  - Flags exact tokens or substrings matching a small built-in list of ~130 famous global brands, with an explicit disclaimer that this is **not** a trademark search and **not** legal advice.
- **0–100 Checkup Score & Plain-English Summary**:
  - Transparent additive scoring across registration/age, DNS/HTTPS, email auth, safety, parking, and brand-token risk, with every point explained in `scoreReasons` and a one-line `summary`.

## How to use it

1. Paste domains, URLs or emails into **Domains**.
2. Leave **Look up registration details** and **Inspect landing page** on for a full report.
3. Click **Start**, then export the dataset or call the Actor from the API.

## Input example

```json
{
  "domains": [
    "google.com",
    "mineunited.com",
    "example.com",
    "quietbluefalcon9912.com"
  ],
  "lookupRdap": true,
  "fetchLandingPage": true
}
```

Invalid input lines (for example malformed strings without a TLD) are skipped, saved to `INVALID_INPUTS` in the key-value store, and **not charged**.

## Output example

```json
{
  "domain": "mineunited.com",
  "tld": "com",
  "registered": true,
  "status": "registered",
  "createdDate": "2020-08-19",
  "domainAgeYears": 6.27,
  "expiryDate": "2027-08-19",
  "daysUntilExpiry": 267,
  "registrar": "GoDaddy.com, LLC",
  "nameserverProvider": "Afternic (listed for sale)",
  "isParkedOrForSale": true,
  "parkedOrForSaleReason": "Nameservers indicate Afternic (listed for sale); Landing page redirects to GoDaddy / Afternic (forsale.godaddy.com)",
  "forSaleUrl": "https://forsale.godaddy.com/forsale/mineunited.com",
  "askingPrice": "$1,488",
  "httpsValid": true,
  "hasSpf": false,
  "hasDmarc": false,
  "safetyStatus": "not_flagged",
  "trademarkRisk": "none_detected",
  "score": 45,
  "summary": "mineunited.com is registered (6.27 yrs old, GoDaddy.com, LLC), parked/for sale ($1,488), no SPF/DMARC, not flagged by Cloudflare Security DNS (score 45/100)."
}
```

## How much does it cost?

You pay **per domain report** (the `report` event on the Pricing tab), plus a small start fee. Bad input lines are skipped and never charged, and runs respect your maximum spending limit.

Because prices can change, this page does not hard-code a per-1,000 figure. Open the **Pricing** tab for the live rate and any Bronze, Silver or Gold discounts. Apify's Free plan monthly credit is enough for a first test of a typical handful of domains at usual rates.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/domain-checkup-report`), or from a language client. Schedule runs in Apify Console, and export results as JSON, CSV, Excel or HTML. You can also connect a webhook, Slack, Make, Zapier, n8n or Google Sheets.

## FAQ

**Is the trademark flag a real trademark search?** No. It is a small built-in list of well-known brand tokens only, and it is not legal advice. Always run a proper USPTO/WIPO search before you buy or use a name.

**Is a "not_flagged" safety status a guarantee the site is safe?** No. It only means Cloudflare Security DNS did not flag the domain at check time. A domain can also be `"not_checked"` if it does not resolve.

**Do I need API keys?** No. The Actor uses public DNS-over-HTTPS, official RDAP registries, and the domain's own landing page.

**Can I schedule portfolio checks?** Yes. Use Apify Schedules and send the dataset or a webhook to email, Slack or a spreadsheet.

**What happens if I leave Domains empty?** The run does not start. Add at least one domain, URL or email address.

## Pricing & Fair Use

All data comes from public, terms-clean DNS-over-HTTPS resolvers ([Cloudflare 1.1.1.1](https://developers.cloudflare.com/1.1.1.1/) and [1.1.1.2 Security DNS](https://developers.cloudflare.com/1.1.1.1/setup/#1112), Google Public DNS), [IANA-listed RDAP](https://www.iana.org/assignments/rdap-dns/rdap-dns.xhtml) registries (throttled to ~3 req/s per registry), and direct HTTP checks of the domain's own landing page. Trademark flags are a simple built-in famous-brand check only and do not constitute legal advice.

## Other tools from this developer

- [Bulk DNS & Email Auth Checker](https://apify.com/looped_kite/bulk-dns-email-auth-checker) — SPF, DKIM, DMARC, MX, and a 0–100 email-auth score.
- [Sitemap URL Extractor](https://apify.com/looped_kite/sitemap-url-extractor) — every page URL from a website's sitemaps.
- [Bulk Domain Availability Checker](https://apify.com/looped_kite/bulk-domain-availability-checker) — DNS plus official RDAP registry checks.
