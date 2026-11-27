# Core Web Vitals for Every Page in Your Sitemap, as CSV

Core Web Vitals for every page in your sitemap, as CSV: give a list of page URLs and get Google PageSpeed Insights results for each one, for mobile and desktop. Export the dataset as CSV, Excel or JSON.

**Returns** one row per URL and strategy: `url`, `strategy`, `status`, `scores` (Lighthouse category scores), `labMetrics` (LCP, CLS, TBT, FCP, speed index, TTI), `fieldDataPresent`, `fieldData` and `originFieldData` (real-user Core Web Vitals when Google has them), `error`, `checkedAt`.

**Cost:** pay per result. A finished test is a result; error rows are not charged. See the Pricing tab for current prices.

```json
{ "urls": ["https://example.com/", "https://example.com/pricing"], "strategies": ["mobile", "desktop"], "categories": ["performance"] }
```

## From a sitemap to a CSV

1. Get the page URLs of the site. The **Sitemap URL Extractor** is another Actor by the same author that lists every URL in a site's sitemaps.
2. Paste the URLs into **URLs** (this Actor does not read sitemaps itself).
3. Run, then export the dataset as CSV.

Each URL is tested once per strategy, so 100 URLs with both strategies is 200 rows.

## API key and the per-run cap

- **With your own `apiKey`** (a Google API key with the PageSpeed Insights API enabled): no cap from this Actor. Google's own quota for your key applies. The key is never logged or written to the results.
- **Without `apiKey`**: the Actor uses its own default key if one is configured, and tests at most **50 URL/strategy rows per run** (this is the Actor's default cap; it is not an input). The run's final message says how many rows were not tested. If no default key is configured, the run stops and asks you for a key.
- If Google answers that the quota is exceeded (HTTP 429), the run stops at once and keeps the results it already has.

## What you get

| Field | Meaning |
|---|---|
| `scores` | Lighthouse category scores 0-100 for the categories you chose (default: performance) |
| `labMetrics` | Lab measurements from one Lighthouse run: largest contentful paint, cumulative layout shift, total blocking time, first contentful paint, speed index, time to interactive |
| `fieldData` | Real-user Core Web Vitals for this exact URL: `lcpMs`, `inpMs`, `cls`, each with a category, plus `overallCategory`. `null` when Google has no data for the URL |
| `originFieldData` | The same for the whole site (origin), when Google has it |
| `status` / `error` | `ok`, or `error` with a plain reason (bad key or URL, API not enabled for the key, quota exceeded, Lighthouse error) |

### Example output (illustrative, abridged)

```json
{
  "url": "https://example.com/",
  "strategy": "mobile",
  "status": "ok",
  "scores": { "performance": 87 },
  "labMetrics": { "lcpMs": 2413, "cls": 0.046, "tbtMs": 120, "fcpMs": 1200, "speedIndexMs": 3100, "ttiMs": 4000 },
  "fieldDataPresent": true,
  "fieldData": { "lcpMs": { "value": 2100, "category": "FAST" }, "inpMs": { "value": 180, "category": "FAST" }, "cls": { "value": 0.05, "category": "FAST" }, "overallCategory": "FAST" },
  "originFieldData": null,
  "error": null
}
```

Lab metrics come from a single simulated test, so they can differ between runs. Field data is what real Chrome users measured, and only exists for pages with enough traffic.

## Input

| Field | Meaning |
|---|---|
| `urls` (required) | Page URLs, one per line |
| `strategies` | `mobile`, `desktop` or both (default both) |
| `categories` | `performance` (default), `accessibility`, `best-practices`, `seo` |
| `apiKey` | Optional Google API key, kept secret |

The Actor calls only Google's official PageSpeed Insights API v5, with requests spaced out and 3 at a time. It does not scrape anything. Lines that are not valid URLs are skipped; if none is valid, the run stops with a message and charges nothing.

## Example tasks

These ready-made inputs are saved as tasks on this Actor's page; open one and press Start.

- **Mobile and desktop for one page**: Lighthouse performance and real-user data when Google has it.
- **Mobile only: 3 pages**: Test mobile only to halve the number of rows.
- **Desktop only: 3 pages**: Test desktop only.
- **All four Lighthouse categories**: Performance, accessibility, best-practices and SEO for one URL.
- **SEO score for a docs site**: SEO category only, on mobile.
- **Accessibility check: 2 pages**: Accessibility category on two public pages.
- **Compare a homepage and a blog page**: Two URLs from the same site side by side.
- **Best-practices audit for 2 pages**: Best-practices category only.
- **Five key pages, performance, mobile**: A typical small batch.
- **Use your own Google API key**: Paste your own key in the apiKey field to lift the per-run cap.

## Other Actors by the same author

- [Cold-Email List Pre-Check: DMARC, SPF & MX in Bulk](https://apify.com/looped_kite/bulk-dns-email-auth-checker)
- [Sitemap URL Extractor: Every URL of a Site for Audits](https://apify.com/looped_kite/sitemap-url-extractor)
- [Check 1,000 Startup Name Ideas at Once (DNS + RDAP)](https://apify.com/looped_kite/bulk-domain-availability-checker)
- [Domain Due Diligence Report: Check a Domain Before You Buy](https://apify.com/looped_kite/domain-checkup-report)
- [Site Migration QA: Check Old URLs Redirect to Live Pages](https://apify.com/looped_kite/broken-link-auditor)

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. Its Google API key comes from the `apiKey` input or from the Actor's environment; it is not an Apify permission.
