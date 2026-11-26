# Startup Name Availability Checker (DNS + RDAP)

Check 1,000 startup-name ideas at once (DNS pre-check + RDAP confirm). Paste your name ideas and the TLDs you want, and the Actor builds every combination and returns each domain as available or registered. A fast DNS pre-check comes first; names that look free are confirmed against the registry's official RDAP server.

**Returns** one row per domain: `domain`, `available`, `status`, `method`, `hasDns`, `nameservers`, `parkedOrForSale`, `registrar`, `createdDate`, `expiryDate`, `domainAgeYears`, `rdapStatus`, `keyword`, `tld`, `length`, `error` and `checkedAt`.

**Cost:** pay per result, one result per domain returned. With **Return only available domains** on, other rows are not returned and not charged. See the Pricing tab for current prices.

**Example input (name ideas across TLDs):**

```json
{
  "keywords": ["rentguitar", "solarpet", "brightloop"],
  "tlds": ["com", "io", "ai"],
  "onlyAvailable": true
}
```

## 1,000 name ideas at once

Put your ideas in **Keywords**, one per line, and choose the TLDs. Every keyword is combined with every TLD: 1,000 ideas and 3 TLDs make 3,000 domains. A run checks up to **Max domains per run** (default 5,000, maximum 50,000), so 1,000 ideas fit in one run as long as ideas times TLDs stays under that cap; raise **Max domains per run** for more.

Add **Prefixes** (for example `get`, `try`) or **Suffixes** (for example `hq`, `app`) to also check variants such as `getrentguitar.com` or `rentguitarhq.com`. The plain keyword is always checked too.

Already have finished domains? Paste them into **Domains** instead (or as well).

## Use cases

- Founders and agencies testing a product name across many TLDs.
- Domain investors and brand-name hunters checking a long list before bidding or registering.
- SEO teams generating names and TLDs and keeping only the available ones.
- Watch lists: schedule a run and look for names that turn available.

## What it does

- **Bulk availability check:** a list of domains, or keywords times TLDs, in one run.
- **Two steps:** a DNS check of the nameservers first. A domain with nameservers is reported as registered. A domain without nameservers is looked up at the registry's RDAP server (the modern replacement for WHOIS); a "not found" answer there means available.
- **Names and TLDs generator:** keywords, TLDs, optional prefixes and suffixes.
- **Registration details:** with **Registration details for taken domains** on, registered domains also get registrar, creation date, expiry date, domain age in years and EPP status codes from RDAP.
- **For-sale or parked flag:** `parkedOrForSale` shows when the nameservers belong to a marketplace or parking service such as Afternic, Sedo, Dan.com, Atom, HugeDomains, BrandBucket or Bodis.
- **TLD coverage:** TLDs listed in the IANA RDAP registry, plus .io, .co, .me and .de. For a TLD with no RDAP server the result is DNS-only and `error` says so.
- **Input cleaning:** URLs, emails, `www.`, uppercase and international (IDN) names are normalised. Invalid lines are skipped, saved to `INVALID_INPUTS` in the key-value store and not charged.

## How to use it

1. Put name ideas in **Keywords** and choose **TLDs**, or paste finished domains into **Domains**. At least one of the two is required.
2. Optional: turn on **Return only available domains** to get just the free names.
3. Click **Start**. Download the results as JSON, CSV, Excel or HTML, or pull them through the Apify API.

### Output example

```json
{
  "domain": "rentguitar.com",
  "available": false,
  "status": "registered",
  "method": "rdap",
  "parkedOrForSale": "Afternic (listed for sale)",
  "registrar": "GoDaddy.com, LLC",
  "createdDate": "2009-09-25",
  "expiryDate": "2027-09-25",
  "domainAgeYears": 17.17,
  "nameservers": ["ns5.afternic.com", "ns6.afternic.com"],
  "checkedAt": "2026-11-25T09:30:00+00:00"
}
```

| Field | Meaning |
|---|---|
| `available` | `true` = not registered, `false` = registered, `null` = could not be determined |
| `status` | `available`, `registered` or `unknown` |
| `method` | `dns` (decided by nameservers) or `rdap` (confirmed by the registry) |
| `parkedOrForSale` | Marketplace or parking service detected from nameservers |
| `registrar`, `createdDate`, `expiryDate`, `domainAgeYears`, `rdapStatus` | From the registry's RDAP record, for registered domains when **Registration details for taken domains** is on |

## Cost

You pay per result: one result per domain returned. With **Return only available domains** on, registered and unknown names are not returned and not charged. There are no API keys to manage. See the Pricing tab for current prices.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/bulk-domain-availability-checker`), or from a language client. Schedule runs in Apify Console and export results as JSON, CSV, Excel or HTML. You can also add an Apify webhook to a run.

## Limits of the check

- A domain with nameservers in DNS is reported as registered. That answer comes from DNS.
- A domain with no nameservers is checked at the registry's RDAP server. A "not found" answer there means the name is not registered.
- Registry-reserved or premium-priced names can show as available but cost more, or be blocked, at a registrar. Names in redemption or pending delete can show as registered. Always confirm the final price at your registrar before buying.

## Fair use

The Actor uses public DNS-over-HTTPS resolvers and the registries' public [RDAP](https://www.icann.org/rdap) services, which are listed in the [IANA RDAP DNS registry](https://www.iana.org/assignments/rdap-dns/rdap-dns.xhtml). Registry lookups are throttled to a few requests per second per registry. Use the results for lawful purposes such as finding names to register. Do not use them for spam or for unsolicited contact with domain owners.

## FAQ

**Can I check .com only?** Yes. `com` is the default TLD for keywords.

**How many domains can I check?** Up to 50,000 per run (`maxDomains`). The default is 5,000.

**Does it show prices?** No. Prices depend on the registrar. This Actor answers whether a name is free, and who holds it and since when.

**What if I leave both Domains and Keywords empty?** The run fails with a clear message. Add at least one domain or one keyword.

## Other tools from this developer

- [Pre-Send Lead List Checker](https://apify.com/looped_kite/bulk-dns-email-auth-checker) - DMARC, SPF, DKIM and MX checks for lead lists.
- [Sitemap URL Extractor](https://apify.com/looped_kite/sitemap-url-extractor) - every page URL from a website's sitemaps.
- [Domain Due Diligence Report](https://apify.com/looped_kite/domain-checkup-report) - registration, DNS, safety, for-sale signals, and a 0-100 score.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. It also saves skipped input lines to its own default key-value store.
