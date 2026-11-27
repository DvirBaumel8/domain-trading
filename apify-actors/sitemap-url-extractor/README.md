# Sitemap URL Extractor: Every URL of a Site for Audits

Get every URL of a site for an SEO or AI audit, or to feed a crawler. Give a website or a sitemap address and get the list of page URLs it publishes.

**Returns** one row per URL: `url`, `lastmod`, `changefreq`, `priority`, `imageCount`, `hreflang`, `sitemapUrl` (the sitemap file it came from), `site`, and `statusCode` and `finalUrl` when **Check HTTP status** is on.

**Cost:** pay per result, one result per URL kept. Filters run before results are saved. See the Pricing tab for current prices.

```json
{ "startUrls": ["https://docs.apify.com/sitemap.xml"], "maxUrlsPerSite": 1000 }
```

## Step 1 of a site audit

This Actor is built to be the first step. Its output is a clean URL list that you can feed to other tools:

- **Broken Link Auditor**, another Actor by the same author: check the status and redirects of every URL.
- **Bulk PageSpeed Checker**, another Actor by the same author: Core Web Vitals for every page.
- Your own crawler, or an SEO or AI audit that needs the full list of pages.

Export the dataset as CSV, JSON or Excel, or read the `url` column through the API.

### Example output (illustrative, abridged)

```json
{
  "url": "https://www.example.com/blog/first-post",
  "lastmod": "2026-03-04",
  "changefreq": null,
  "priority": 0.8,
  "imageCount": 1,
  "hreflang": [{ "lang": "de", "url": "https://www.example.com/de/blog/first-post" }],
  "sitemapUrl": "https://www.example.com/sitemap.xml",
  "site": "https://www.example.com",
  "statusCode": null,
  "finalUrl": null
}
```

## What it does

- Finds sitemaps from `robots.txt` and common paths (`/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`, `/wp-sitemap.xml`, `/sitemap/sitemap.xml`), or reads the sitemap URL you give.
- Follows sitemap indexes, compressed `.xml.gz` files and plain-text sitemaps.
- Returns `lastmod`, `changefreq`, `priority`, image counts and `hreflang` alternates when the sitemap publishes them.
- Optional include and exclude regular expressions and a "modified since" date, applied before results are saved.
- Optional HTTP status check (HEAD, GET if HEAD is refused) for 404s and redirects.
- Parses XML with a safe parser (`defusedxml`).

## Input

| Field | Meaning |
|---|---|
| `startUrls` (required) | Websites or sitemap URLs, one per line |
| `maxUrlsPerSite` | Cap per start entry, 1-1000000 (default 1000) |
| `includeRegex`, `excludeRegex` | Keep or drop URLs by pattern |
| `modifiedSince` | `YYYY-MM-DD` or a full ISO date-time; URLs with no `lastmod` are dropped when set |
| `checkStatus` | Add `statusCode` and `finalUrl` (default off) |
| `maxSitemaps` | Cap on sitemap files per start entry, 1-10000 (default 500) |

Input is checked before any request is made:

- Entries that are not an http or https address (for example `not a url`, `mailto:` or `ftp:`) are saved to `INVALID_INPUTS` in the key-value store, logged once and not charged.
- A `modifiedSince` that is not a date stops the run at once with "modifiedSince must look like 2026-01-31". Nothing is charged.
- If a server cannot be reached the log says `could not connect (reason)`, for example `dns lookup failed`.

## Notes and limits

- The Actor reads what a site publishes in its sitemaps. It does not crawl pages and does not log in. Pages missing from the sitemap will not appear.
- If a site has no sitemap, the run log says so and nothing is charged for that site.
- Without a `lastmod` in the sitemap, **modified since** cannot match the URL.

## Example tasks

These ready-made inputs are saved as tasks on this Actor's page; open one and press Start.

- **Apify docs: first 200 URLs**: Follow a sitemap index and return up to 200 URLs with lastmod.
- **Apify blog: only /blog/ posts**: Filter a sitemap with an include regex.
- **Kubernetes docs: skip translations**: Exclude URLs matching a language-folder regex.
- **Single sitemap file: all URLs**: A plain urlset sitemap with no index.
- **MDN: first 100 URLs**: Large index with many files; limit the number of sitemap files read.
- **web.dev: HTTP status of 50 URLs**: Add the HTTP status of each URL to the output for an audit.
- **FastAPI docs: pages changed since 2025**: Keep only URLs with a lastmod on or after a date.
- **Two sites in one run**: Several websites at once, each with its own cap.
- **Start from a site address, not a sitemap**: Give a homepage; the Actor looks for the sitemap in robots.txt.
- **Sitemap export for an AI-audit crawler**: A small list of URLs to feed a crawler or an AI-readiness audit.

## FAQ

**Can I watch a site for new pages?** Yes. Schedule the Actor with Apify Schedules and set **modifiedSince** to a recent date.

**How big can a site be?** Up to 1,000,000 URLs per start entry per run (`maxUrlsPerSite`); the default is 1,000.

**What if I leave the start URLs empty?** The run stops with a message. Add at least one website or sitemap URL.

## Other Actors by the same author

- [Cold-Email List Pre-Check: DMARC, SPF & MX in Bulk](https://apify.com/looped_kite/bulk-dns-email-auth-checker)
- [Check 1,000 Startup Name Ideas at Once (DNS + RDAP)](https://apify.com/looped_kite/bulk-domain-availability-checker)
- [Domain Due Diligence Report: Check a Domain Before You Buy](https://apify.com/looped_kite/domain-checkup-report)
- [Site Migration QA: Check Old URLs Redirect to Live Pages](https://apify.com/looped_kite/broken-link-auditor)
- [Core Web Vitals for Every Page in Your Sitemap, as CSV](https://apify.com/looped_kite/bulk-pagespeed-checker)

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. It also saves an `INVALID_INPUTS` record in its own default key-value store.
