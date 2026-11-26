## Bulk Domain Availability Checker (DNS + RDAP)

Check **hundreds or thousands of domain names for availability** in one run. Paste a list of domains, or give keywords and TLDs and let the Actor build every combination (for example `rentguitar` × `.com .io .ai .co`). Each domain gets a clear **available / registered** answer, confirmed against the **official registry (RDAP)**, plus registrar, creation date, expiry date, domain age and a listed-for-sale or parked flag.

You pay **per domain returned**. Current prices per 1,000 results, including any plan discounts, are on the **Pricing** tab. Turn on **Return only available domains** if you only want free names — registered rows are then omitted and not charged. The Apify Free plan includes monthly Store credit you can use for a first test — open the Pricing tab to see how far it goes at today's rates.

![Sample output from Bulk Domain Availability Checker](https://api.apify.com/v2/key-value-stores/dNe1hFUAqsMnqLOYE/records/availability-output.png)

## Use cases

- Domain investors and brand-name hunters checking a long list of names before bidding or registering.
- Founders and agencies testing a product name across many TLDs.
- SEO teams generating names × TLDs and keeping only the available ones.
- Watch lists: schedule a daily run and get notified when a name becomes available.

## What does it do?

- ✅ **Bulk availability check**: thousands of domains per run (300 domains in about 35 seconds in our tests).
- ✅ **Two-step accuracy**: a fast DNS pre-check, then confirmation from the registry's official RDAP server (the modern replacement for WHOIS) for every name that looks free.
- ✅ **Names × TLDs generator**: keywords + TLDs + optional prefixes (get, try, my) and suffixes (hq, app).
- ✅ **Registration details**: registrar, creation date, expiry date, domain age in years and EPP status codes for taken domains (switch on *Registration details for taken domains*).
- ✅ **For-sale / parked flag**: spots names parked at Afternic, Sedo, Dan.com, Atom, HugeDomains, BrandBucket, Bodis and others, based on their nameservers.
- ✅ **Works with 1,200+ TLDs**: every TLD in the IANA RDAP registry, plus .io, .co, .me and .de.
- ✅ **Clean input handling**: URLs, emails, `www.`, uppercase and international (IDN) names are normalised automatically. Invalid entries are flagged, not silently dropped.

## How to use it

1. Paste domains into **Domains**, or fill **Keywords** and **TLDs**. At least one of the two is required.
2. Optional: tick **Return only available domains** to get just the free names. You only pay for rows you get.
3. Click **Start**. Download results as JSON, CSV, Excel or HTML, or pull them through the Apify API.

### Input example

```json
{
  "keywords": ["rentguitar", "solarpet"],
  "tlds": ["com", "io", "ai"],
  "prefixes": ["get"],
  "onlyAvailable": true
}
```

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
| `available` | `true` = not registered at the registry, `false` = registered, `null` = could not be determined |
| `status` | `available`, `registered`, `unknown` or `invalid` |
| `method` | `dns` (decided by nameservers) or `rdap` (confirmed by the registry) |
| `parkedOrForSale` | Marketplace or parking service detected from nameservers |
| `registrar`, `createdDate`, `expiryDate`, `domainAgeYears`, `rdapStatus` | From the registry's RDAP record |

## How much does it cost?

You pay **per domain returned** (the `result` event on the Pricing tab), plus a small start fee. With **Return only available domains** switched on, registered names are not returned and not charged. There are no subscriptions or API keys to manage.

Because prices can change, this page does not hard-code a per-1,000 figure. Open the **Pricing** tab for the live rate and any Bronze, Silver or Gold discounts. Apify's Free plan monthly credit is enough for a first test of a typical list at usual rates.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/bulk-domain-availability-checker`), or from a language client. Schedule runs in Apify Console, and export results as JSON, CSV, Excel or HTML. You can also connect a webhook, Slack, Make, Zapier, n8n or Google Sheets.

## How accurate is it?

- A domain with live nameservers is registered. That answer comes from DNS.
- A domain with no nameservers is checked at the registry's own RDAP server. A "not found" answer there means the name is not registered.
- **Limits:** registry-reserved or premium-priced names can show as available but cost more, or be blocked, at a registrar. Names in redemption or pending delete show as registered. Always confirm the final price at your registrar before buying.

## Fair use

The Actor uses public DNS-over-HTTPS resolvers and the registries' public [RDAP](https://www.icann.org/rdap) services, which are listed in the [IANA RDAP DNS registry](https://www.iana.org/assignments/rdap-dns/rdap-dns.xhtml). Registry lookups are throttled to a few requests per second per registry, and DNS answers short-circuit most of them. Use the results for lawful purposes such as finding names to register. **Do not use them for spam or for unsolicited contact with domain owners.**

## FAQ

**Can I check .com only?** Yes. `.com` is the default TLD for keywords.

**How many domains can I check?** Up to 50,000 per run (`maxDomains`). For very large lists, split them across runs or schedule them.

**Does it show prices?** No. Prices depend on the registrar. This Actor answers *is it free?* and *who owns it, and since when?*

**Can I schedule it?** Yes. Use Apify Schedules to re-check a watch list daily and get notified by email, Slack or webhook when a name becomes available.

**What if I leave both Domains and Keywords empty?** The run fails with a clear message. Add at least one domain or one keyword.

## Other tools from this developer

- [Bulk DNS & Email Auth Checker](https://apify.com/looped_kite/bulk-dns-email-auth-checker) — SPF, DKIM, DMARC, MX, and a 0–100 email-auth score.
- [Sitemap URL Extractor](https://apify.com/looped_kite/sitemap-url-extractor) — every page URL from a website's sitemaps.
- [Domain Checkup Report](https://apify.com/looped_kite/domain-checkup-report) — registration, DNS, safety, for-sale signals, and a 0–100 score.
