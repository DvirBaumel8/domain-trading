# Domain Due Diligence Report: Check a Domain Before You Buy

Due diligence before you buy a domain: paste domains, URLs or emails and get one report row per domain with its age, registrar, expiry, DNS, for-sale signals, email auth and safety check.

**Returns** one row per domain: `domain`, `status`, `createdDate`, `domainAgeYears`, `expiryDate`, `daysUntilExpiry`, `registrar`, `rdapStatus`, DNS facts (`hasA`, `hasMx`, `hasNs`, `nameservers`, `nameserverProvider`, `emailProvider`), for-sale signals (`isParkedOrForSale`, `parkedOrForSaleReason`, `forSaleUrl`, `askingPrice`), landing page (`httpStatus`, `httpsValid`, `finalUrl`, `pageTitle`), email auth (`hasSpf`, `spfPolicy`, `hasDmarc`, `dmarcPolicy`), `safetyStatus`, a `trademarkRisk` hint, a 0-100 `score` with `scoreReasons`, and a one-line `summary`.

**Cost:** pay per result, one result (a report) per domain. Lines that are not a domain are never charged. See the Pricing tab for current prices.

```json
{ "domains": ["example.com", "google.com"], "lookupRdap": true, "fetchLandingPage": true }
```

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
  - Flags exact tokens or substrings matching a small built-in list of well-known brand names, with an explicit disclaimer that this is **not** a trademark search and **not** legal advice.
- **0–100 Checkup Score & Plain-English Summary**:
  - Transparent additive scoring across registration/age, DNS/HTTPS, email auth, safety, parking, and brand-token risk, with every point explained in `scoreReasons` and a one-line `summary`.

## How to use it

1. Paste domains, URLs or emails into **Domains**.
2. Leave **Look up registration details** and **Inspect landing page** on for a full report.
3. Click **Start**, then export the dataset or call the Actor from the API.

Lines that are not a domain (for example a string without a TLD) are skipped, saved to `INVALID_INPUTS` in the key-value store and **not charged**.

### Example output (illustrative, abridged)

A made-up domain parked at a marketplace. A real run returns the live facts of your domain.

```json
{
  "domain": "parked-name.example",
  "tld": "example",
  "registered": true,
  "status": "registered",
  "createdDate": "2020-08-19",
  "domainAgeYears": 6.27,
  "expiryDate": "2027-08-19",
  "registrar": "Example Registrar, Inc.",
  "nameserverProvider": "Afternic (listed for sale)",
  "isParkedOrForSale": true,
  "parkedOrForSaleReason": "Nameservers indicate Afternic (listed for sale)",
  "httpsValid": true,
  "hasSpf": false,
  "hasDmarc": false,
  "safetyStatus": "not_flagged",
  "trademarkRisk": "none_detected",
  "score": 45
}
```

## Example tasks

These ready-made inputs are saved as tasks on this Actor's page; open one and press Start.

- **Due diligence on two domains**: One-row report per domain with age, registrar, DNS and score.
- **Check a domain before you buy**: The report for a single domain you are thinking of buying.
- **Fast run: skip the landing page**: Registration and DNS only, without opening the site.
- **Skip RDAP, check DNS and site**: Use when you only need DNS and landing-page signals.
- **Compare 5 candidate domains**: Score several candidates side by side.
- **Check a domain's email setup**: Includes SPF and DMARC in the report.
- **Look for for-sale signals**: The landing-page check looks for for-sale pages and asking prices.
- **Trademark-risk hint on a brand-like name**: The report includes a hint, not legal advice.
- **Gentle run: low concurrency**: Fewer parallel lookups.
- **Report for a list of 10 domains**: A typical small batch.

## FAQ

**Is the trademark flag a real trademark search?** No. It is a small built-in list of well-known brand tokens only, and it is not legal advice. Always run a proper trademark search before you buy or use a name.

**Is a "not_flagged" safety status a guarantee the site is safe?** No. It only means Cloudflare Security DNS did not flag the domain at check time. A domain can also be `"not_checked"` if it does not resolve.

**Does it tell me a fair price?** No. It shows the asking price only when the domain's own page displays one.

**Do I need API keys?** No. The Actor uses public DNS-over-HTTPS, official RDAP registries, and the domain's own landing page.

**Can I schedule portfolio checks?** Yes, with Apify Schedules.

**What happens if I leave Domains empty?** The run stops with a message. Add at least one domain, URL or email address.

## Data sources and fair use

DNS answers come from public DNS-over-HTTPS resolvers ([Cloudflare 1.1.1.1](https://developers.cloudflare.com/1.1.1.1/), [1.1.1.2 Security DNS](https://developers.cloudflare.com/1.1.1.1/setup/#1112) and Google Public DNS), registration data from [IANA-listed RDAP](https://www.iana.org/assignments/rdap-dns/rdap-dns.xhtml) registries (throttled to about 3 requests per second per registry), and the landing page from a direct HTTP request to the domain itself. Trademark flags are a simple built-in famous-brand check only.

## Other Actors by the same author

- [Cold-Email List Pre-Check: DMARC, SPF & MX in Bulk](https://apify.com/looped_kite/bulk-dns-email-auth-checker)
- [Sitemap URL Extractor: Every URL of a Site for Audits](https://apify.com/looped_kite/sitemap-url-extractor)
- [Check 1,000 Startup Name Ideas at Once (DNS + RDAP)](https://apify.com/looped_kite/bulk-domain-availability-checker)
- [Site Migration QA: Check Old URLs Redirect to Live Pages](https://apify.com/looped_kite/broken-link-auditor)
- [Core Web Vitals for Every Page in Your Sitemap, as CSV](https://apify.com/looped_kite/bulk-pagespeed-checker)

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. It also saves an `INVALID_INPUTS` record in its own default key-value store.
