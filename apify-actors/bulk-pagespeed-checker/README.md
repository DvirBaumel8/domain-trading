## Bulk PageSpeed & Core Web Vitals Checker

First draft (the text owners rewrite it).

Test many URLs with Google's official PageSpeed Insights API v5 (`runPagespeed`). No scraping.

**Input:** `urls` (required), `strategies` (`mobile`, `desktop`; both by default), `categories` (`performance` by default; optionally `accessibility`, `best-practices`, `seo`), `apiKey` (optional, your own, kept secret).

**Output, one row per URL and strategy:** category scores, lab metrics (LCP, CLS, TBT, FCP, Speed Index, TTI), real-user Core Web Vitals for the page and its origin when Google has them, and whether field data was present.

Without a key the actor runs slowly within Google's keyless quota. Failed tests are shown as error rows and are not charged. Pricing is on the Pricing tab.
