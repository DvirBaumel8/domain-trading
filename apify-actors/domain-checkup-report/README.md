# Domain Due Diligence Report Before You Buy

Due diligence before you buy a domain: paste the names you are considering and get one report row per domain with its age, registrar, expiry, DNS, for-sale signals, email-auth basics, a safety check, a trademark hint and a 0-100 score.

**Returns** one row per domain: `domain`, `status`, `createdDate`, `domainAgeYears`, `expiryDate`, `daysUntilExpiry`, `registrar`, `nameservers`, `nameserverProvider`, `emailProvider`, `isParkedOrForSale`, `parkedOrForSaleReason`, `forSaleUrl`, `askingPrice`, `httpsValid`, `hasSpf`, `hasDmarc`, `safetyStatus`, `trademarkRisk`, `score`, `scoreReasons`, `summary` and more (see the output schema).

**Cost:** pay per result, one result (report) per valid domain. Invalid input lines are skipped and not charged. See the Pricing tab for current prices.

**Example input:**

```json
{
  "domains": ["example.com", "example.net"],
  "lookupRdap": true,
  "fetchLandingPage": true
}
```

## Use cases

- Domain buyers checking age, registrar, expiry and whether a name is listed for sale, before they bid or make an offer.
- A quick safety and trademark-hint pass on a shortlist of names. It is not a trademark search and not legal advice.
- Agencies or analysts scoring a list of names on DNS, email auth and landing-page signals.
- Portfolio reviews: schedule a run and watch expiry dates, parking and safety flags.

## What each report includes

- **Registration (RDAP, the official registries):** registered or available, creation date, domain age in years, expiry date, days until expiry, registrar name and EPP status codes. Lookups are spaced to about 3 requests per second per registry.
- **DNS and hosting:** `hasA`, `hasMx`, `hasNs`, A records, MX records, nameservers, the DNS provider (Cloudflare, Route 53, GoDaddy, Namecheap, Google Cloud DNS and others) and the email provider (Google Workspace, Microsoft 365, Zoho and others).
- **Parked or for-sale signals:** known marketplace and parking nameservers (Afternic, Sedo, Dan.com, Bodis, ParkingCrew, HugeDomains, Atom, BrandBucket, Sav), plus the landing page (including common `/lander` JavaScript or meta redirects) for marketplace redirects and a visible asking price.
- **Email-auth basics:** whether SPF and DMARC exist, the SPF `all` policy and the DMARC `p=` policy.
- **Safety check:** whether Cloudflare Security DNS (`security.cloudflare-dns.com`, 1.1.1.2) blocks the domain as malware or phishing, and whether HTTPS connects with a valid certificate. The status is `not_flagged`, `flagged_malware_or_phishing` or `not_checked` (for example when the domain does not resolve). `not_flagged` is not a guarantee that a site is safe.
- **Trademark hint:** matches against a small built-in list of about 130 famous brand names, with a disclaimer that it is not a trademark search.
- **Score and summary:** a 0-100 `score` added up from registration, age, expiry, DNS, HTTPS, email auth, safety, parking and brand-token signals. Every point is explained in `scoreReasons`, with a one-line `summary`.

## How to use it

1. Paste domains, URLs or email addresses into **Domains**.
2. Leave **Look up registration details** and **Inspect landing page** on for a full report.
3. Click **Start**, then export the dataset or call the Actor from the API.

Lines that are not valid domains (for example strings without a TLD) are skipped, saved to `INVALID_INPUTS` in the key-value store, and not charged.

## Output example (abridged)

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
  "httpsValid": true,
  "hasSpf": false,
  "hasDmarc": false,
  "safetyStatus": "not_flagged",
  "trademarkRisk": "none_detected",
  "score": 45
}
```

## Cost

You pay per result: one result per domain report. Bad input lines are skipped and never charged, and runs respect your maximum spending limit. See the Pricing tab for current prices.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/domain-checkup-report`), or from a language client. Schedule runs in Apify Console and export results as JSON, CSV, Excel or HTML. You can also add an Apify webhook to a run.

## FAQ

**Is the trademark flag a real trademark search?** No. It is a small built-in list of well-known brand names only, and it is not legal advice. Run a proper USPTO or WIPO search before you buy or use a name.

**Is "not_flagged" a guarantee the site is safe?** No. It only means Cloudflare Security DNS did not flag the domain at check time. A domain can also be `not_checked` if it does not resolve.

**Do I need API keys?** No. The Actor uses public DNS-over-HTTPS, the official RDAP registries and the domain's own landing page.

**What happens if I leave Domains empty?** The run does not start. Add at least one domain, URL or email address.

## Data sources and fair use

DNS answers come from public DNS-over-HTTPS resolvers ([Cloudflare 1.1.1.1](https://developers.cloudflare.com/1.1.1.1/), [1.1.1.2 Security DNS](https://developers.cloudflare.com/1.1.1.1/setup/#1112) and Google Public DNS). Registration data comes from [IANA-listed RDAP](https://www.iana.org/assignments/rdap-dns/rdap-dns.xhtml) registries. The landing-page check is a direct request to the domain's own site.

## Other tools from this developer

- [Pre-Send Lead List Checker](https://apify.com/looped_kite/bulk-dns-email-auth-checker) - DMARC, SPF, DKIM and MX checks for lead lists.
- [Sitemap URL Extractor](https://apify.com/looped_kite/sitemap-url-extractor) - every page URL from a website's sitemaps.
- [Startup Name Availability Checker](https://apify.com/looped_kite/bulk-domain-availability-checker) - DNS plus official RDAP registry checks.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. It also saves skipped input lines to its own default key-value store.
