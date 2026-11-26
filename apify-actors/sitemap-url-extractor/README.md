## Sitemap URL Extractor - All Website URLs

Get **every page URL from a website's sitemaps** in seconds. The Actor auto-discovers sitemaps from `robots.txt` and common paths, follows sitemap indexes and `.gz` files, and returns `lastmod`, `priority`, `hreflang` and an optional HTTP status for each URL.

You pay **per URL returned**. Current prices per 1,000 URLs, including any plan discounts, are on the **Pricing** tab. The default **Max URLs per site** is 1,000, so a first run on a huge site stays bounded. Raise that cap when you need a full list. The Apify Free plan includes monthly Store credit you can use for a first test — open the Pricing tab to see how far it goes at today's rates.

![Sample output from Sitemap URL Extractor](https://api.apify.com/v2/key-value-stores/dNe1hFUAqsMnqLOYE/records/sitemap-output.png)

## Use cases

- SEO teams building a complete URL list for an audit, crawl seed or migration.
- Content and competitor research: watch a site's sitemap daily for new pages.
- Developers who need a clean URL inventory, with lastmod and hreflang, without writing a crawler.
- Finding broken pages by turning on **Check HTTP status**.

## Features

- Auto-discovers sitemaps from `robots.txt` and common locations such as `/sitemap.xml`.
- Follows sitemap indexes and compressed `.xml.gz` files.
- Returns `lastmod`, `changefreq`, `priority`, image counts and `hreflang` alternates when the sitemap publishes them.
- Optional include/exclude regex and "modified since" date filters — applied before results are saved, so you only pay for URLs you keep.
- Optional HTTP status check (HEAD/GET) for 404s and redirects.
- Safe XML parsing, protected against malformed and malicious XML.
- Built against the official [Sitemaps XML protocol](https://www.sitemaps.org/protocol.html) and [Google sitemap documentation](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview).

## How to use it

1. Add websites (for example `https://example.com`) or direct sitemap URLs to **Websites or sitemap URLs**.
2. Optional: set **Max URLs per site** (default 1,000), include/exclude regex, **Only URLs modified since**, or **Check HTTP status**.
3. Click **Start**, then export the dataset or call the Actor from the API.

### Input example

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

## How much does it cost?

You pay **per URL returned** (the `result` event on the Pricing tab), plus a small start fee. Filters run before results are saved, so you only pay for the URLs you keep. Set **Max URLs per site** to cap spend on huge sites — the default is 1,000.

Because prices can change, this page does not hard-code a per-1,000 figure. Open the **Pricing** tab for the live rate and any Bronze, Silver or Gold discounts. Apify's Free plan monthly credit is enough for a first test of a typical site at usual rates.

## API, scheduling and export

Run this Actor from [Apify Console](https://console.apify.com), from the [API](https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor) (`looped_kite/sitemap-url-extractor`), or from a language client. Schedule runs in Apify Console, and export results as JSON, CSV, Excel or HTML. You can also connect a webhook, Slack, Make, Zapier, n8n or Google Sheets.

## Notes and limits

- The Actor reads only what a site publishes for search engines in its sitemaps. It does not crawl pages or log in.
- Pages missing from a site's sitemap will not appear. Use a crawler for those.
- If a site has no sitemap, the run log says so and nothing is charged for that site.

## FAQ

**Can I monitor new pages on a competitor's site?** Yes. Schedule the Actor daily with **Only URLs modified since** set to a recent date, and connect a webhook, Slack or email integration.

**Does it work with Shopify, WordPress, Wix, Squarespace and Webflow?** Yes. They all publish standard XML sitemaps.

**How big can a site be?** Up to 1,000,000 URLs per site per run (`maxUrlsPerSite`), and 500 sitemap files by default (`maxSitemaps`). The default cap is 1,000 URLs per site so a first run stays inexpensive.

**What happens if I leave the start URLs empty?** The run does not start. Add at least one website or sitemap URL.

## Other tools from this developer

- [Bulk DNS & Email Auth Checker](https://apify.com/looped_kite/bulk-dns-email-auth-checker) — SPF, DKIM, DMARC, MX, and a 0–100 email-auth score.
- [Bulk Domain Availability Checker](https://apify.com/looped_kite/bulk-domain-availability-checker) — DNS plus official RDAP registry checks.
- [Domain Checkup Report](https://apify.com/looped_kite/domain-checkup-report) — registration, DNS, safety, for-sale signals, and a 0–100 score.
