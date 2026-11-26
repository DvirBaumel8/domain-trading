# Cold-Email List Pre-Check: DMARC, SPF & MX in Bulk

Pre-send check for cold-email lead lists: paste a list of prospect domains and find which ones have no DMARC or no MX before you send. It is also a bulk email-auth audit (SPF, DKIM, DMARC, MX) for agencies.

**Returns** one row per domain: `domain`, `resolves`, `mx`, `emailProvider`, `spf`, `spfAll`, `dmarc`, `dmarcPolicy`, `dmarcRua`, `dkimSelectorsFound`, `mtaSts`, `bimi`, `emailScore` (0-100), `issues` (plain English), plus `ns`, `a`, `aaaa`, `caa`, `parkedOrForSale`, `error`, `checkedAt`.

**Cost:** pay per result, one result per domain checked. See the Pricing tab for current prices.

```json
{ "domains": ["example.com", "https://www.example.org/pricing", "jane@example.net"] }
```

## Use it on a lead list (CSV in)

You do not need to clean the list first. Copy the column of domains, website URLs or email addresses from your CSV or spreadsheet and paste it into **Domains, URLs or emails**, one entry per line. URLs and emails are reduced to the domain and duplicates are checked once.

```text
example.com
https://www.example.org/pricing
jane@example.net
```

From the API, send the same column as a JSON array. This is the whole input:

```json
{
  "domains": ["example.com", "https://www.example.org/pricing", "jane@example.net"],
  "includeRecords": false
}
```

Then export the dataset as CSV or Excel and filter: `mx` empty means no MX record, `dmarc` empty means no DMARC record, `resolves` false means the domain does not exist in DNS.

### Example output (illustrative, abridged, made-up reserved domains)

Two rows as the Actor builds them from a test zone. Real results depend on each domain's live DNS.

```json
[
  {
    "domain": "lead-one.example",
    "resolves": true,
    "mx": [{ "priority": 10, "host": "mail.lead-one.example" }],
    "emailProvider": "Other / self-hosted",
    "spfAll": "~all",
    "dmarc": null,
    "dmarcPolicy": null,
    "dkimSelectorsFound": [],
    "emailScore": 20,
    "issues": [
      "No DMARC record - spoofed mail from this domain is not blocked and you get no reports.",
      "No DKIM key found on common selectors (add your provider's selector to check)."
    ]
  },
  {
    "domain": "lead-two.example",
    "resolves": true,
    "mx": [],
    "emailProvider": null,
    "spfAll": "-all",
    "dmarcPolicy": "reject",
    "emailScore": 60,
    "issues": ["No MX records - the domain cannot receive email."]
  }
]
```

## How to read the score

`emailScore` adds up what the Actor finds in DNS, capped at 100:

| Signal | Points |
|---|---|
| SPF ends in `-all` / `~all` / `?all` or has no `all` / `+all` | 25 / 20 / 8 / 0 |
| No SPF record, or more than one SPF record | 0 |
| DMARC policy `reject` / `quarantine` / `none` | 35 / 28 / 12 |
| No DMARC record, no valid `p=`, or more than one DMARC record | 0 |
| A DKIM key found on a tested selector | 25 |
| MTA-STS record present | 8 |
| BIMI record present | 7 |

The score does not depend on MX: a domain with no MX is flagged in `issues`, not in the score. A DKIM key is looked up only on the selectors you test; a domain can sign with another one. A domain that does not exist in DNS gets 0. The score describes DNS records; it is not a prediction of inbox placement.

## Who it's for

- Lead-gen agencies checking a prospect list before a campaign goes out.
- Cold-email senders who want to drop or flag domains that cannot receive mail.
- Deliverability consultants auditing the SPF, DKIM and DMARC setup of many client domains.
- IT admins and MSPs reviewing customer domains in one pass.

This Actor reports DNS records and issues. It does not improve deliverability and does not guarantee inbox placement.

## What it checks

- **MX and provider**: MX records, a null MX (the domain says it accepts no email) and the provider guessed from the MX host (for example Google Workspace, Microsoft 365, Zoho, Proofpoint).
- **SPF**: the record, its `all` policy, an approximate count of DNS-lookup mechanisms against the limit of 10, multiple records and the deprecated `ptr` mechanism.
- **DMARC**: policy (`none`, `quarantine`, `reject`), `rua` report address, `pct` and multiple records.
- **DKIM**: looks for a key on 17 common selectors by default (you can change the list), follows CNAMEs, treats an empty `p=` as revoked and flags wildcard DKIM records.
- **Extras**: MTA-STS, BIMI, A, AAAA and CAA records, nameservers and a parked or for-sale hint from the nameservers.

It reads public DNS only (DNS over HTTPS, Cloudflare with Google as fallback). It does not send email and does not contact any mail server.

## Input

| Field | Meaning |
|---|---|
| `domains` (required) | Domains, website URLs or email addresses, one per line |
| `dkimSelectors` | DKIM selectors to test (default: 17 common ones) |
| `includeRecords` | Also return A, AAAA and CAA records (default on) |
| `concurrency` | Parallel lookups, 1-30 (default 10) |
| `maxDomains` | Safety cap, 1-100000 (default 10000) |

Lines that are not a domain are skipped. If nothing valid is left, the run stops with a message and charges nothing.

## FAQ

**Does it send emails or touch mail servers?** No. It only reads public DNS records.

**Why does a big brand show "No DKIM key found"?** It probably uses a selector that is not on the list. Add that selector to **DKIM selectors to test** and run again.

**Can I run it on a schedule?** Yes, with Apify Schedules. Webhooks and the API are available as for any Actor.

## Other Actors by the same author

- Sitemap URL Extractor: every page URL from a website's sitemaps.
- Bulk Domain Availability Checker: DNS plus official RDAP registry checks.
- Domain Checkup Report: registration, DNS, safety and for-sale signals for a domain.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset.
