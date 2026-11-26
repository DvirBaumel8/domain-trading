# Site Migration QA: Check Old URLs Redirect to Live Pages

Site migration QA: check that every old URL redirects to a live page. Give a list of old URLs (or a sitemap) and get, for each one, the final status, the redirect chain and any 404.

**Returns** one row per URL: `url`, `category`, `statusCode`, `finalUrl`, `redirectChain`, `redirectLoop`, `error`, `responseTimeMs`, `contentType`, `sources` (crawl mode: the pages that link to it), `checkedAt`.

**Cost:** pay per result. A row is a result when the server answered with an HTTP status or the URL has a redirect loop. See the Pricing tab for current prices.

```json
{ "startUrls": ["https://example.com/old-pricing", "https://example.com/old-blog/post-1"], "mode": "list" }
```

## Migration check

1. Collect the old URLs (from your old sitemap, analytics or a crawl export) and paste them into **Start URLs**.
2. Run in **list** mode. Each URL is requested and its redirects are followed one hop at a time.
3. Export the dataset and filter: `category` `redirect` with `statusCode` 200 is a working redirect, `4xx` is a broken URL, and a long `redirectChain` or `redirectLoop` true needs fixing.

No sitemap for the old site? Step 1 can be the **Sitemap URL Extractor**, another Actor by the same author: it lists every URL of a site. Paste its URLs here, or set **mode** to `sitemap` and give the site address.

### Example output (illustrative, abridged)

Two old URLs on a made-up site. A real run returns the live answers of your own URLs.

```json
[
  {
    "url": "https://www.example.com/old-pricing",
    "category": "redirect",
    "statusCode": 200,
    "finalUrl": "https://www.example.com/pricing",
    "redirectChain": [
      { "status": 301, "url": "https://www.example.com/old-pricing" },
      { "status": 301, "url": "https://www.example.com/plans" }
    ],
    "redirectLoop": false,
    "error": null
  },
  {
    "url": "https://www.example.com/old-blog/post-1",
    "category": "4xx",
    "statusCode": 404,
    "finalUrl": "https://www.example.com/old-blog/post-1",
    "redirectChain": [],
    "redirectLoop": false,
    "error": null
  }
]
```

The first URL works but goes through two redirects (a chain you may want to shorten to one). The second is a 404: it has no redirect to a live page.

## Monthly broken-link report

Use **crawl** mode and schedule the run with Apify Schedules. The Actor follows links on the same site up to `maxDepth` and, for each broken URL, lists in `sources` the pages and anchor texts that link to it. Each row is pushed as soon as its URL is checked, so a run that is stopped or times out keeps every row it already has. A `sources` list holds the links found on earlier levels, not links found later in the crawl.

## Modes

| `mode` | What is checked |
|---|---|
| `list` (default) | Exactly the URLs you give |
| `sitemap` | The sitemap of the given site (from `robots.txt` or `/sitemap.xml`, or a sitemap URL you give), including nested sitemap indexes, `.gz` and text sitemaps. If none is found the run ends with the message "No sitemap found for <host> (robots.txt and /sitemap.xml checked)." |
| `crawl` | Same-site links from the start page, up to `maxDepth`; `checkExternal` also checks links to other sites |

## How it checks

- Reads `robots.txt` (switch off with `respectRobots`), spaces requests per host and runs up to `maxConcurrency` at once.
- Follows redirects itself, so every row has its chain and final URL. More than 10 hops is flagged as a loop.
- Retries only timeouts, connection resets and HTTP 429 or 5xx answers. A host that does not exist (DNS failure), a TLS error or a refused connection fails at once without a retry.
- `error` gives a plain reason: `dns_failure`, `connection_refused`, `connection_reset`, `connect_timeout`, `tls_error` or `other`.
- Rows with no HTTP answer (DNS failure, TLS error, timeout, ...) and URLs skipped by `robots.txt` are returned but not charged.
- Input lines that are not http or https URLs (for example `ftp:`, `mailto:`, `javascript:` or `not a url`) are saved to `INVALID_INPUTS` in the key-value store, logged once and not charged. The log also says how many duplicates were merged.

## Input

| Field | Meaning |
|---|---|
| `startUrls` (required) | URLs, site address or sitemap, depending on the mode |
| `mode` | `list`, `sitemap` or `crawl` (default `list`) |
| `maxPages` | Cap on unique URLs, 1-100000 (default 1000) |
| `maxDepth` | Crawl depth, 0-10 (default 3) |
| `checkExternal` | Crawl mode: also check external links (default off) |
| `maxConcurrency` | Parallel checks, 1-20 (default 5) |
| `respectRobots` | Obey robots.txt (default on) |
| `debugNetwork` | Log connect details of failed requests (default off) |

## Other Actors by the same author

- Sitemap URL Extractor: every page URL from a website's sitemaps.
- Bulk PageSpeed Checker: Core Web Vitals for many pages.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset. It also saves an `INVALID_INPUTS` record in its own default key-value store.
