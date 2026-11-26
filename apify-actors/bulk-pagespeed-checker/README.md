# Bulk Core Web Vitals & PageSpeed Checker

Core Web Vitals for every page in your sitemap, as CSV. Paste a list of URLs and the Actor tests each one with Google's official PageSpeed Insights API v5, for mobile, desktop or both. Use **Sitemap URL Extractor** (another Actor by the same author) as step 1 to list the URLs of a site.

**Returns** one row per URL and strategy: `url`, `strategy`, `status`, `scores` (Lighthouse category scores), `labMetrics` (`lcpMs`, `cls`, `tbtMs`, `fcpMs`, `speedIndexMs`, `ttiMs`), `fieldDataPresent`, `fieldData` and `originFieldData` (real-user Core Web Vitals when Google has them), `error` and `checkedAt`.

**Cost:** pay per result, one result per successful test; error rows are not charged. See the Pricing tab for current prices.

**Example input:**

```json
{
  "urls": ["https://example.com/", "https://example.com/pricing"],
  "strategies": ["mobile", "desktop"],
  "categories": ["performance"]
}
```

## Every page in your sitemap, as CSV

1. Run **Sitemap URL Extractor** on your site and export the `url` column.
2. Paste those URLs into **URLs** here and click Start.
3. Export the dataset as CSV (or Excel, JSON). The nested fields `scores`, `labMetrics` and `fieldData` can be flattened in the Apify export options.

Each URL is tested once per strategy, so 100 URLs with mobile and desktop make 200 rows.

## API key and the per-run cap

The `apiKey` input is optional. It is your own Google API key with the PageSpeed Insights API enabled.

- **With your own key:** every URL and strategy you give is tested. This Actor sets no cap (Google's quota for your key still applies).
- **Key field left empty:** the Actor uses a default key supplied on the server and tests at most 50 URL/strategy rows per run. Rows beyond that are not checked, and the run message says how many were left out. Add your own key to check more.

The key is kept secret: it is never logged and never written to the results. If the Actor has no usable key at all, the run stops with a message asking you to add one.

## What you get

- **Category scores:** 0-100 Lighthouse scores for the categories you select (`performance` by default; `accessibility`, `best-practices` and `seo` are optional), in `scores`.
- **Lab metrics:** Largest Contentful Paint, Cumulative Layout Shift, Total Blocking Time, First Contentful Paint, Speed Index and Time to Interactive, in `labMetrics`.
- **Field data (real users):** Core Web Vitals (LCP, INP, CLS, with Google's category) for the page in `fieldData` and for its whole origin in `originFieldData`, when Google has enough data. `fieldDataPresent` tells you whether the page itself had data.
- **Errors:** a failed test is shown as an error row with a plain reason (bad key or URL, API not enabled for the key, quota exceeded) and is not charged. If your quota is exceeded, the run stops at once.

All data comes from the official PageSpeed Insights API. The Actor does not scrape any website.

### Output example (abridged)

```json
{
  "url": "https://example.com/",
  "strategy": "mobile",
  "status": "ok",
  "error": null,
  "scores": {"performance": 87},
  "labMetrics": {"lcpMs": 2413, "cls": 0.046, "tbtMs": 120, "fcpMs": 1200, "speedIndexMs": 3100, "ttiMs": 4000},
  "fieldDataPresent": true,
  "fieldData": {
    "lcpMs": {"value": 2100, "category": "FAST"},
    "inpMs": {"value": 180, "category": "FAST"},
    "cls": {"value": 0.05, "category": "FAST"},
    "overallCategory": "FAST"
  },
  "originFieldData": null,
  "checkedAt": "2026-11-25T09:30:00+00:00"
}
```

The values above are illustrative.

## Cost

You pay per result: one result per successful test. Error rows are shown but not charged. See the Pricing tab for current prices.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. If you supply a Google API key, it is used only to call the PageSpeed Insights API; that is a Google credential, not an Apify permission.
