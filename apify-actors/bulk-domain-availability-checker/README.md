# Check 1,000 Startup Name Ideas at Once (DNS + RDAP)

Check 1,000 startup-name ideas at once: combine your name ideas with any TLDs, run a fast DNS pre-check, and confirm with the registry's RDAP server. The input allows up to 50,000 names per run.

**Returns** one row per domain: `domain`, `status`, `available`, `method`, `registrar`, `createdDate`, `expiryDate`, `domainAgeYears`, `rdapStatus`, `nameservers`, `parkedOrForSale`, `keyword`, `tld`, `length`, `error`, `checkedAt`.

**Cost:** pay per result, one result per domain returned. Rows with status `invalid_tld` are not charged. See the Pricing tab for current prices.

```json
{ "keywords": ["rentguitar", "solarpet", "quietfalcon"], "tlds": ["com", "io", "ai"], "prefixes": ["get"], "onlyAvailable": true }
```

## Name ideas across TLDs

Put one idea per line in **Keywords**, the TLDs in **TLDs** and, optionally, words in **Prefixes** and **Suffixes**. The Actor builds every combination once. The example above is 3 keywords x 2 variants (plain and with `get`) x 3 TLDs = 18 names. 1,000 ideas on 3 TLDs is 3,000 names, inside the default cap of 5,000 per run (`maxDomains`, up to 50,000).

Already have finished names? Paste them into **Domains** (domains, URLs or emails, one per line). Both inputs can be used together.

## How to read `status`

| `status` | `available` | Meaning |
|---|---|---|
| `available` | `true` | DNS has no record and the registry's RDAP server says the name is not registered |
| `registered` | `false` | The name has nameservers in DNS, or the registry returned a record |
| `likely_available` | `null` | The TLD is real but has no public RDAP server in the IANA list, and DNS says the name does not exist. The registry could not confirm it, so check at a registrar. Left out when **Return only available domains** is on, unless **Include likely-available names** is on |
| `unknown` | `null` | The lookups did not give a clear answer (see `error`) |
| `invalid_tld` | `null` | The TLD is not in the IANA root zone list (for example `.zz`). It is never reported as available and is not charged |

`method` is `dns` when DNS alone decided and `rdap` when the registry answered. The IANA TLD list is fetched once per run; a copy bundled in the Actor is used if it cannot be fetched.

### Example output (illustrative, abridged)

```json
{
  "domain": "getrentguitar.io",
  "tld": "io",
  "keyword": "rentguitar",
  "status": "available",
  "available": true,
  "method": "rdap",
  "hasDns": false,
  "registrar": null,
  "checkedAt": "2026-11-26T10:00:00+00:00"
}
```

## What it does

- **Bulk check**: DNS first. A name with nameservers is registered. A name without them is looked up at the registry's RDAP server (the modern replacement for WHOIS) for the TLDs that publish one in the [IANA RDAP bootstrap file](https://www.iana.org/assignments/rdap-dns/rdap-dns.xhtml), plus `.io`, `.co`, `.me` and `.de`.
- **Registration details**: registrar, creation date, expiry date, age and status codes for registered names (switch on *Registration details for taken domains*).
- **For-sale flag**: spots names parked at marketplaces such as Afternic, Sedo, Dan.com, Atom and HugeDomains, from their nameservers.
- **Input clean-up**: URLs, emails, `www.`, upper case and international (IDN) names are normalised. Entries that are not a domain are skipped, listed in `INVALID_INPUTS` in the key-value store and not charged.

## Input

| Field | Meaning |
|---|---|
| `keywords`, `tlds`, `prefixes`, `suffixes` | Name generator (default TLD: `com`) |
| `domains` | Finished names to check |
| `onlyAvailable` | Only return names with status `available` (default off) |
| `includeLikelyAvailable` | With `onlyAvailable`, also return `likely_available` names (default off) |
| `lookupRegistered` | Registry details for registered names (default off) |
| `maxDomains` | Cap per run, 1-50000 (default 5000) |
| `concurrency` | Parallel DNS lookups, 1-50 (default 20) |

## Limits to know

- Registry-reserved or premium-priced names can show as available but cost more, or be blocked, at a registrar. Names in redemption or pending delete show as registered. Confirm the final price at your registrar before you buy.
- This Actor does not show prices and does not register domains.
- Registry lookups are throttled to a few requests per second per registry.

Use the results for lawful purposes such as finding names to register. Do not use them for spam or for unsolicited contact with domain owners.

## Example tasks

These ready-made inputs are saved as tasks on this Actor's page; open one and press Start.

- **3 name ideas across 6 TLDs**: Names times TLDs, with DNS pre-check and RDAP confirmation.
- **Only available .com names**: Return only names that look available on .com.
- **Add a prefix: get + name**: Try a prefix in front of each name.
- **Add a suffix: name + app**: Try a suffix after each name.
- **Check an exact list of domains**: Give full domain names instead of keywords.
- **Who owns the taken names**: Registration details (registrar, created, expiry) for registered domains.
- **Include likely-available names**: Also list names that probably are free, marked as likely.
- **Short .ai names**: A small .ai check for AI product names.
- **Brand names with prefix and suffix**: Combine prefixes and suffixes in one run.
- **Gentle run: low concurrency**: Same check with fewer parallel lookups.

## FAQ

**Can I check .com only?** Yes. `.com` is the default TLD for keywords.

**What if Domains and Keywords are both empty?** The run stops with a message. Add at least one domain or one keyword.

**Can I schedule it?** Yes, with Apify Schedules, for example to re-check a watch list.

## Other Actors by the same author

- [Cold-Email List Pre-Check: DMARC, SPF & MX in Bulk](https://apify.com/looped_kite/bulk-dns-email-auth-checker)
- [Sitemap URL Extractor: Every URL of a Site for Audits](https://apify.com/looped_kite/sitemap-url-extractor)
- [Domain Due Diligence Report: Check a Domain Before You Buy](https://apify.com/looped_kite/domain-checkup-report)
- [Site Migration QA: Check Old URLs Redirect to Live Pages](https://apify.com/looped_kite/broken-link-auditor)
- [Core Web Vitals for Every Page in Your Sitemap, as CSV](https://apify.com/looped_kite/bulk-pagespeed-checker)

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. It also saves an `INVALID_INPUTS` record in its own default key-value store.
