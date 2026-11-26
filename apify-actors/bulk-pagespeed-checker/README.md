## Bulk PageSpeed & Core Web Vitals Checker

First draft (the text owners rewrite it).

Test many URLs with Google's official PageSpeed Insights API v5 (`runPagespeed`). No scraping.

**Input:** `urls` (required), `strategies` (`mobile`, `desktop`; both by default), `categories` (`performance` by default; optionally `accessibility`, `best-practices`, `seo`), `apiKey` (optional: your own Google API key with the PageSpeed Insights API enabled, kept secret; a default key is used if left empty, limited to 50 URL/strategy rows per run; your own key has no cap).

**Output, one row per URL and strategy:** category scores, lab metrics (LCP, CLS, TBT, FCP, Speed Index, TTI), real-user Core Web Vitals for the page and its origin when Google has them, and whether field data was present.

Failed tests are shown as error rows with a plain reason (bad key or URL, API not enabled for the key, quota exceeded) and are not charged. If your quota is exceeded the run stops at once. Pricing is on the Pricing tab.
