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

## Other Actors by the same author

- Sitemap URL Extractor: every page URL from a website's sitemaps.
- Broken Link Auditor: status, redirects and 404s for many URLs.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. Its Google API key comes from the `apiKey` input or from the Actor's environment; it is not an Apify permission.
