# Pre-Send Lead List Checker: DMARC, SPF & MX

Pre-send check for cold-email lead lists: paste your prospect domains (or URLs, or emails) and find which ones have no DMARC or MX before you send. The same run works as a bulk email-auth audit for agencies.

**Returns** one row per domain: `domain`, `resolves`, `mx`, `emailProvider`, `spf`, `spfAll`, `dmarc`, `dmarcPolicy`, `dkimSelectorsFound`, `mtaSts`, `bimi`, `emailScore` (0-100) and `issues` (plain English), plus `ns`, `a`, `aaaa`, `caa`, `parkedOrForSale`, `error` and `checkedAt`.

**Cost:** pay per result, one result per domain checked. See the Pricing tab for current prices.

**Example input:**

```json
{
  "domains": ["example.com", "https://www.example.net/contact", "jane@example.org"]
}
```

## Who it's for

- **Lead-gen agencies** cleaning a prospect list before it goes into a sequencer.
- **Cold-email senders** who want to know which prospect domains cannot receive mail (no MX) or publish no DMARC.
- **Deliverability consultants** auditing the SPF, DKIM and DMARC records of many client domains in one run.

The Actor reports DNS records and issues. It does not send email, it does not check any mailbox, and it does not promise or improve deliverability or inbox placement.

## Example: check a lead list before you send

Take one column from your lead spreadsheet or CSV (domains, website URLs or email addresses) and paste it into **Domains, URLs or emails**. In Console use **Bulk edit** to paste the whole column at once. Paste one column only, not whole CSV rows.

```
example.com
https://www.example.net/contact
jane@example.org
```

Each line is reduced to its domain (`www.` and paths are dropped, the part after `@` is used), duplicates are removed, and lines that are not valid domains are skipped. The same list as Actor input:

```json
{
  "domains": ["example.com", "https://www.example.net/contact", "jane@example.org"],
  "includeRecords": false
}
```

Export the dataset as CSV or Excel and filter on `mx` (empty means no MX), `dmarcPolicy` (empty means no DMARC) or `emailScore`.

### Example output (illustrative, not a real lookup)

The domains below are reserved example names. The values show the shape of the result and how the score adds up.

| domain | mx | emailProvider | spfAll | dmarcPolicy | dkimSelectorsFound | emailScore |
|---|---|---|---|---|---|---|
| example.com | 1 host | Google Workspace | ~all | reject | none | 55 |
| example.net | 1 host | Microsoft 365 | -all | no DMARC record | selector1 | 50 |
| example.org | none | no MX | no SPF | no DMARC record | none | 0 |

```json
{
  "domain": "example.org",
  "resolves": true,
  "mx": [],
  "emailProvider": null,
  "spf": null,
  "dmarc": null,
  "dkimSelectorsFound": [],
  "mtaSts": false,
  "bimi": false,
  "emailScore": 0,
  "issues": [
    "No MX records - the domain cannot receive email.",
    "Domain does not receive mail: publish 'v=spf1 -all' and DMARC p=reject to stop spoofing.",
    "No SPF record - receivers cannot verify who may send mail for this domain.",
    "No DMARC record - spoofed mail from this domain is not blocked and you get no reports."
  ]
}
```

## How to read the score

`emailScore` is a number from 0 to 100. It adds up these points, taken from the records the Actor found:

| Signal | Points |
|---|---|
| SPF ends in `-all` | 25 |
| SPF ends in `~all` | 20 |
| SPF ends in `?all`, or has no `all` mechanism | 8 |
| SPF ends in `+all`, there is no SPF record, or there are several SPF records | 0 |
| DMARC `p=reject` | 35 |
| DMARC `p=quarantine` | 28 |
| DMARC `p=none` | 12 |
| No DMARC record, no valid `p=`, or several DMARC records | 0 |
| A DKIM key found on a tested selector | 25 |
| MTA-STS record present | 8 |
| BIMI record present | 7 |

Things to know:

- The score is a summary of published records. It does not say whether mail reaches an inbox.
- The score is computed whether or not the domain has MX records. For a lead list, read `mx` and `issues` as well as the score.
- DKIM is reported only for the selectors tested. A domain can sign with a selector that is not on the list; add it to **DKIM selectors to test** and run again.

## What it checks

- **MX and provider:** Google Workspace, Microsoft 365, Zoho, Proton, Proofpoint, Mimecast, Barracuda, GoDaddy, Fastmail, Amazon SES and others, and null MX ("accepts no email").
- **SPF:** the record, its `all` policy, an approximate count of DNS lookups against the limit of 10, duplicate records and the deprecated `ptr` mechanism.
- **DMARC:** policy (`none`, `quarantine`, `reject`), `rua` report address, `pct` and duplicate records.
- **DKIM:** 17 common selectors by default, follows CNAMEs, treats an empty `p=` as revoked, and flags wildcard DKIM records. You can add your own selectors.
- **Extras:** MTA-STS, BIMI, A/AAAA, CAA, nameservers, and a parked or for-sale hint from the nameservers (Afternic, Sedo, Dan.com and others).
- **Issues:** readable problems such as "DMARC policy is p=none (monitoring only) - spoofed mail is still delivered."

Lookups use public DNS-over-HTTPS resolvers (Cloudflare, with Google as fallback), so no API keys are needed. The SPF and DMARC checks follow [RFC 7208](https://datatracker.ietf.org/doc/html/rfc7208) and [RFC 7489](https://datatracker.ietf.org/doc/html/rfc7489).

## How to use it

1. Paste domains, websites or email addresses into **Domains, URLs or emails**.
2. Optional: add your email provider's DKIM selectors if a known domain shows no key.
3. Click **Start**, then export the dataset (CSV, Excel, JSON) or call the Actor from the API.

## Cost

You pay per result: one result per domain checked. There are no third-party API keys to buy. See the Pricing tab for current prices.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/bulk-dns-email-auth-checker`), or from a language client. Schedule runs in Apify Console and export results as JSON, CSV, Excel or HTML. You can also add an Apify webhook to a run.

## FAQ

**Does it send emails or touch mail servers?** No. It only reads public DNS records.

**Does a high score mean my emails will reach the inbox?** No. The score summarises DNS records. Inbox placement depends on much more than DNS.

**Why does a big brand show "No DKIM key found"?** It probably uses a selector that is not on the tested list, such as a dated selector. Add that selector to the list and run again.

**What happens if I leave the Domains field empty?** The run does not start. Add at least one domain, URL or email address.

## Other tools from this developer

- [Sitemap URL Extractor](https://apify.com/looped_kite/sitemap-url-extractor) - every page URL from a website's sitemaps.
- [Startup Name Availability Checker](https://apify.com/looped_kite/bulk-domain-availability-checker) - DNS plus official RDAP registry checks.
- [Domain Due Diligence Report](https://apify.com/looped_kite/domain-checkup-report) - registration, DNS, safety, for-sale signals, and a 0-100 score.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset.
