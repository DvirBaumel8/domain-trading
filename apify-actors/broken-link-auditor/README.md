# Site Migration QA & Broken Link Checker

Site migration QA: check that every old URL redirects to a live page. Give the Actor a list of old URLs (or a sitemap) and it shows which ones redirect, through how many hops, and which end in a 404 or another error. The same run works as a monthly broken-link report.

**Returns** one row per URL: `url`, `category`, `statusCode`, `finalUrl`, `redirectChain`, `redirectLoop`, `error`, `responseTimeMs`, `contentType`, `sources` (crawl mode: the pages that link to it) and `checkedAt`.

**Cost:** pay per result. A result is a URL that got an HTTP answer or a redirect loop; robots.txt skips, DNS failures and timeouts are shown but not charged. See the Pricing tab for current prices.

**Example input (migration check):**

```json
{
  "startUrls": ["https://example.com/old-pricing", "https://example.com/old-blog/", "https://example.com/old-careers"],
  "mode": "list"
}
```

## Example: site migration QA

You moved a site and kept a list of the old URLs. Paste them into **Start URLs**, leave **Mode** on `list` and click Start. Each URL is requested and every redirect is followed one hop at a time. In the result you can see:

- `category` `ok`: the old URL still answers directly.
- `category` `redirect`: the old URL redirects; `redirectChain` lists each hop and `finalUrl` is where it ends. A chain with more than one hop is a redirect chain worth shortening.
- `category` `4xx` or `5xx`: the old URL (or the end of its redirects) is broken. A 404 here is a page that did not get a redirect.
- `redirectLoop` `true`: the redirects loop or run past 10 hops.

Don't have the list of old URLs? Use **Sitemap URL Extractor** (another Actor by the same author) as step 1 to list every URL from the old site's sitemap, then paste that list here. You can also set **Mode** to `sitemap` and give the sitemap or site address directly.

### Example output (illustrative, not a real run)

The URLs below use a reserved example domain. Rows are abridged.

```json
[
  {
    "url": "https://example.com/old-pricing",
    "category": "redirect",
    "statusCode": 200,
    "finalUrl": "https://example.com/pricing",
    "redirectChain": [{"status": 301, "url": "https://example.com/old-pricing"}],
    "redirectLoop": false
  },
  {
    "url": "https://example.com/old-blog/",
    "category": "redirect",
    "statusCode": 200,
    "finalUrl": "https://example.com/blog/",
    "redirectChain": [
      {"status": 301, "url": "https://example.com/old-blog/"},
      {"status": 301, "url": "https://example.com/blog-archive/"}
    ],
    "redirectLoop": false
  },
  {
    "url": "https://example.com/old-careers",
    "category": "4xx",
    "statusCode": 404,
    "finalUrl": "https://example.com/old-careers",
    "redirectChain": [],
    "redirectLoop": false
  }
]
```

The second row is a two-hop redirect chain; the third is a 404 with no redirect.

## Monthly broken-link report

Use **Mode** `crawl` with your home page as the start URL. The Actor follows same-site links up to **Max crawl depth** and checks every URL it finds. For each broken URL, `sources` lists the pages that link to it, with the anchor text, so you know where to fix it. Turn on **Check external links** to also check links to other sites (those pages are not crawled). Schedule the run in Apify Console to repeat it every month.

## Modes

| Mode | What it checks |
|---|---|
| `list` (default) | Exactly the URLs you give. |
| `sitemap` | Every URL listed in the sitemap(s) found for each start URL. |
| `crawl` | The start page and the same-site links found from it, up to **Max crawl depth**. |

## How it works

- The Actor reads robots.txt, spaces out requests to each host, backs off on 429 and 5xx answers, and counts each unique URL once.
- Redirects are followed by the Actor itself, one hop at a time, so every row has its redirect chain, final URL and loop flag (more than 10 hops counts as a loop).
- Failed requests are retried only on timeouts and connect errors. The `error` field holds a plain reason: `dns_failure`, `connection_refused`, `connection_reset`, `connect_timeout`, `tls_error` or `other`.
- Turn on **Debug network** to log connect details of failed requests (host, attempt, reason, error classes); it never logs headers or bodies.

## Cost

You pay per result. URLs skipped by robots.txt, DNS failures and timeouts are shown in the dataset but not charged. Set **Max URLs** to cap a run. See the Pricing tab for current prices.

## Permissions

This Actor needs only limited permissions: it reads its input and writes to its own default dataset.
