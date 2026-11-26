## Bulk DNS & Email Auth Checker (SPF, DMARC)

Check the **email deliverability DNS of hundreds or thousands of domains in one run**. For each domain you get **MX records and the email provider**, **SPF** (the `all` policy and lookup count), **DMARC** policy, **DKIM** keys on common selectors, **MTA-STS**, **BIMI**, nameservers, a **parked or for-sale** flag, a **0–100 email-auth score**, and **plain-English issues** to fix.

You pay **per domain checked**. Current prices per 1,000 results, including any plan discounts, are on the **Pricing** tab. The Apify Free plan includes monthly Store credit you can use for a first test — open the Pricing tab to see how far that credit goes at today's rates.

Paste domains, URLs or emails and click Start. No API keys are required.

![Sample output from Bulk DNS & Email Auth Checker](https://api.apify.com/v2/key-value-stores/dNe1hFUAqsMnqLOYE/records/dns-output.png)

## Use cases

- Cold-email and outbound teams cleaning or scoring a lead list before sending.
- Agencies auditing client domains after a migration or a new email provider.
- MSPs and IT admins checking SPF, DKIM and DMARC across many customer domains.
- Security or vendor-review teams confirming that a partner domain publishes a strict DMARC policy.
- Enriching a company list with "which email provider do they use?".

## Features

- 📬 **MX and provider detection**: Google Workspace, Microsoft 365, Zoho, Proton, Proofpoint, Mimecast, Barracuda, GoDaddy, Fastmail, Amazon SES, plus null MX ("accepts no email") detection.
- 🛡️ **SPF analysis**: the record, its `all` policy (`-all`, `~all`, `?all`, `+all`), an approximate count of DNS lookups against the 10-lookup limit, duplicate records, and the deprecated `ptr` mechanism.
- 🔐 **DMARC analysis**: policy (`none`, `quarantine`, `reject`), `rua` report address, `pct`, and duplicate records.
- ✍️ **DKIM discovery**: tests 17 common selectors by default (google, selector1/2, k1, s1, mandrill, sendgrid, zoho…), follows CNAMEs, treats empty `p=` keys as revoked, and spots wildcard DKIM records. Add your own selectors.
- ➕ **Extras**: MTA-STS, BIMI, A/AAAA, CAA and nameservers, plus parking and marketplace detection (Afternic, Sedo, Dan.com…).
- 🧮 **Score and issues**: one number to sort by, with readable fixes such as "DMARC policy is p=none, so spoofed mail is still delivered".
- 🧾 **Flexible input**: domains, URLs or email addresses, one per line.
- 🌐 **Reliable**: uses DNS-over-HTTPS resolvers (Cloudflare, with Google as fallback), so it needs no UDP and no API keys. Checks follow the official [SPF (RFC 7208)](https://datatracker.ietf.org/doc/html/rfc7208) and [DMARC (RFC 7489)](https://datatracker.ietf.org/doc/html/rfc7489) specifications.

## How to use it

1. Paste domains, websites or email addresses into **Domains, URLs or emails**.
2. Optional: add your email provider's DKIM selectors if a known domain shows no key.
3. Click **Start**, then export the dataset or call the Actor from the API.

### Output example (real result, abridged)

```json
{
  "domain": "stripe.com",
  "emailProvider": "Google Workspace",
  "mx": [{"priority": 10, "host": "aspmx.l.google.com"}],
  "spfAll": "~all",
  "spfLookups": 3,
  "dmarcPolicy": "reject",
  "dmarcRua": "mailto:dmarc-reports@stripe.com",
  "dkimSelectorsFound": ["google", "s1", "s2", "mandrill"],
  "mtaSts": false,
  "bimi": false,
  "emailScore": 80,
  "issues": []
}
```

## How the score works

| Signal | Points |
|---|---|
| SPF `-all` / `~all` / `?all` or missing `all` / `+all` or broken | 25 / 20 / 8 / 0 |
| DMARC `reject` / `quarantine` / `none` / missing | 35 / 28 / 12 / 0 |
| DKIM key found on a tested selector | 25 |
| MTA-STS present | 8 |
| BIMI present | 7 |

DKIM is reported only for the selectors tested. A domain can sign with a selector that isn't on the list. Add it to **DKIM selectors to test**.

## How much does it cost?

You pay **per domain checked** (the `result` event on the Pricing tab), plus a small start fee. There are no monthly fees and no third-party API keys to buy.

Because prices can change, this page does not hard-code a per-1,000 figure. Open the **Pricing** tab for the live rate and any Bronze, Silver or Gold discounts. As a rule of thumb, Apify's Free plan monthly credit is enough to run a first test of several hundred to a few thousand domains at typical rates.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/bulk-dns-email-auth-checker`), or from a language client. Schedule runs in Apify Console, and export results as JSON, CSV, Excel or HTML. You can also connect a webhook, Slack, Make, Zapier, n8n or Google Sheets.

## FAQ

**Does it send emails or touch mail servers?** No. It only reads public DNS records.

**Can I monitor my domains?** Yes. Schedule a daily run and add a webhook or Slack alert when the score drops or new issues appear.

**Why does a big brand show "No DKIM key found"?** It probably uses a custom selector, such as Google's dated selectors. Add that selector to the list and run again.

**What happens if I leave the Domains field empty?** The run does not start. Add at least one domain, URL or email address.

## Other tools from this developer

- [Sitemap URL Extractor](https://apify.com/looped_kite/sitemap-url-extractor) — every page URL from a website's sitemaps.
- [Bulk Domain Availability Checker](https://apify.com/looped_kite/bulk-domain-availability-checker) — DNS plus official RDAP registry checks.
- [Domain Checkup Report](https://apify.com/looped_kite/domain-checkup-report) — registration, DNS, safety, for-sale signals, and a 0–100 score.
