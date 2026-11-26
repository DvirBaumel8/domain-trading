# Sitemap URL Extractor for SEO & AI Audits

Get every URL of a site for an SEO or AI audit, or to feed a crawler. The Actor finds a site's XML sitemaps, follows sitemap indexes and `.gz` files, and returns one row per page URL.

**Returns** one row per URL: `url`, `lastmod`, `changefreq`, `priority`, `imageCount`, `hreflang`, `sitemapUrl`, `site`, and, if you turn on **Check HTTP status**, `statusCode` and `finalUrl`.

**Cost:** pay per result, one result per URL kept. Filters run before results are saved, and **Max URLs per site** caps a run. See the Pricing tab for current prices.

**Example input:**

```json
{
  "startUrls": ["https://example.com"],
  "maxUrlsPerSite": 1000
}
```

## Step 1 of a site audit

The URL list is the first step of a typical audit. Export it as CSV or JSON, then:

- paste it into **Site Migration QA & Broken Link Checker** (another Actor by the same author) to check status codes and redirect chains, or
- paste it into **Bulk Core Web Vitals & PageSpeed Checker** (another Actor by the same author) to test every page, or
- feed it to your own crawler or an SEO or AI audit tool.

## Use cases

- SEO teams building a complete URL list for an audit, a crawl seed or a migration.
- Content and competitor research: schedule a run and look for new pages.
- Developers who need a clean URL inventory, with `lastmod` and `hreflang`, without writing a crawler.
- Quick 404 and redirect check: turn on **Check HTTP status**.

## Features

- Finds sitemaps through `robots.txt` and common locations such as `/sitemap.xml`.
- Follows sitemap indexes and compressed `.xml.gz` files.
- Returns `lastmod`, `changefreq`, `priority`, image counts and `hreflang` alternates when the sitemap publishes them.
- Optional include and exclude regular expressions and a "modified since" date, applied before results are saved.
- Optional HTTP status check (HEAD, then GET if HEAD is refused) to see 404s and redirects.
- Parses XML with a safe parser that rejects entity-expansion tricks.
- Follows the [Sitemaps XML protocol](https://www.sitemaps.org/protocol.html).

## How to use it

1. Add websites (for example `https://example.com`) or direct sitemap URLs to **Websites or sitemap URLs**.
2. Optional: set **Max URLs per site** (default 1,000), the include and exclude expressions, **Only URLs modified since**, or **Check HTTP status**.
3. Click **Start**, then export the dataset or call the Actor from the API.

### Input example with filters

```json
{
  "startUrls": ["https://wordpress.org/news/"],
  "includeRegex": "/news/20",
  "modifiedSince": "2024-01-01",
  "maxUrlsPerSite": 5000,
  "checkStatus": true
}
```

### Output example

```json
{
  "url": "https://wordpress.org/news/2025/12/sotw-2025/",
  "lastmod": "2025-12-03T17:45:05Z",
  "changefreq": null,
  "priority": null,
  "imageCount": 0,
  "hreflang": [],
  "sitemapUrl": "https://wordpress.org/news/video-sitemap-1.xml",
  "site": "https://wordpress.org/news/",
  "statusCode": 200,
  "finalUrl": "https://wordpress.org/news/2025/12/sotw-2025/"
}
```

## Cost

You pay per result: one result per URL kept. Filters run before results are saved, so dropped URLs are not charged. If a site has no sitemap, the run log says so and nothing is charged for that site. The default **Max URLs per site** is 1,000. See the Pricing tab for current prices.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/sitemap-url-extractor`), or from a language client. Schedule runs in Apify Console and export results as JSON, CSV, Excel or HTML. You can also add an Apify webhook to a run.

## Notes and limits

- The Actor reads only what a site publishes in its sitemaps. It does not crawl pages or log in.
- Pages missing from a site's sitemap will not appear. Use a crawler for those.
- Up to 1,000,000 URLs per site per run (`maxUrlsPerSite`) and 500 sitemap files by default (`maxSitemaps`).

## FAQ

**Can I watch a site for new pages?** Schedule the Actor with **Only URLs modified since** set to a recent date. Only URLs whose sitemap entry has a `lastmod` date are kept when that filter is on.

**What happens if I leave the start URLs empty?** The run does not start. Add at least one website or sitemap URL.

## Other tools from this developer

- [Pre-Send Lead List Checker](https://apify.com/looped_kite/bulk-dns-email-auth-checker) - DMARC, SPF, DKIM and MX checks for lead lists.
- [Startup Name Availability Checker](https://apify.com/looped_kite/bulk-domain-availability-checker) - DNS plus official RDAP registry checks.
- [Domain Due Diligence Report](https://apify.com/looped_kite/domain-checkup-report) - registration, DNS, safety, for-sale signals, and a 0-100 score.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset.
