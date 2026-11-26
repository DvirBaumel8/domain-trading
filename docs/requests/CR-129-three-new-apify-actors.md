# CR-129: Three new Apify actors (link auditor, PageSpeed, Wayback history)

**Status:** Filed 26 Nov 2026 11:50 IST. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir (26 Nov 11:46, via Gavriel):** "כן אני בעד לבנות עוד כלים ולאט לאט להוסיף" ("Yes, I'm for building more tools and adding them slowly").

**Build after** CR-127 Part A has moved the actors to `apify-actors/`. If CR-127 isn't merged yet, build these in the same layout, and the same PR may carry both.

## Common rules (same as CR-127)

- One folder per actor under `apify-actors/`: `.actor/actor.json`, `input_schema.json`, `dataset_schema.json`, `README.md`, `CHANGELOG.md`, `src/`, and `tests/test_core.py`. Python on the Apify SDK. Reuse `shared/` where it fits.
- The tests are the contract. They run offline on recorded fixtures, with no network and no token, and `apify-actors.yml` CI runs them.
- The `requests-only.yml` text guard from CR-127 covers these folders too. The bots own README and the text keys. Claude Code writes only a first draft of the README and texts, which the bots then rewrite.
- **No hard-coded prices** anywhere: code, config, README or tests. Pricing is pay-per-event (PPE) and is set on Apify by Gavriel, with Dvir's yes, before publish. Each actor charges one `result` event per successful dataset row. Invalid input, failed lookups, timeouts and errors are **not charged**. Tests lock this.
- The main input is required. An empty input fails with a clear status message and no charge.
- Polite by default: bounded concurrency, a per-host rate limit, backoff on 429/5xx, and a clear User-Agent.
- No Apify push or publish without Dvir's OK on each release (from Dvir's machine, like CR-127 Part A item 5). Version 0.1.0 and a `CHANGELOG.md` for each.
- Never log a token or a key, including a user's own key.

## Actor 1: Sitemap + broken-link / URL status auditor

Folder `apify-actors/broken-link-auditor/`.
- **Input:** `startUrls` (a site, a sitemap URL, or a list of URLs; required). `mode`: `list` (check the given URLs), `sitemap` (expand sitemaps, nested and gz), or `crawl` (follow same-site links up to `maxPages`, default 1000, and `maxDepth`). `checkExternal` (bool, default false). `maxConcurrency` (default 5). `respectRobots` (default true).
- **Per URL:** final status, redirect chain (each hop's status and URL), final URL, `ok/redirect/4xx/5xx/error`, response time, and content type. In crawl mode, also the source page and anchor text for every link that points to it.
- **Behaviour:** read robots.txt and honour it when `respectRobots`. Try HEAD first and fall back to GET on 405/403/501 or an empty response. Cap redirects at 10 and flag loops. Count each unique URL once.
- **Tests:** a redirect chain and loop; the HEAD-to-GET fallback; a robots.txt disallow; source and anchor capture; dedupe; a DNS failure or timeout row is not charged; the maxPages cap.

## Actor 2: Bulk PageSpeed Insights / Core Web Vitals

Folder `apify-actors/bulk-pagespeed-checker/`.
- Uses only Google's official **PageSpeed Insights API v5** (`runPagespeed`). No scraping.
- **Input:** `urls` (required). `strategies` (`mobile`, `desktop`, or both; default both). `categories` (default `performance`; optional `accessibility`, `best-practices`, `seo`). `apiKey` (optional, bring your own, a secret input field).
- **Per URL and strategy:** category scores; lab metrics (LCP, CLS, TBT, FCP, Speed Index, TTI); field Core Web Vitals from `loadingExperience` (LCP, INP, CLS and their categories) and from the origin when available; and whether field data was present.
- **Behaviour:** without a key, run slowly within Google's keyless quota and say so in the status message. With a key, use a higher but still bounded rate. On a 429, back off. A failed URL gets an error row and is not charged. Never log the key or the request URL with the key.
- **Tests:** the full fixture with field data; a fixture without field data; a 429 then success; a 500 makes an uncharged error row; a key never appears in logs (a test that captures logs).

## Actor 3: Wayback domain history

Folder `apify-actors/wayback-domain-history/`.
- Uses only Internet Archive public APIs: the **CDX API** (`web.archive.org/cdx/search/cdx`, with `collapse` and `fl`, paged by `showResumeKey`) and the **availability API**.
- **Input:** `domains` (required; strip schemes and paths, lowercase). `includeSubdomains` (default false). `fromYear` / `toYear` (optional). `sampleSnapshots` (how many snapshot links to list per year, default 1).
- **Per domain:** first and last seen; total snapshots; snapshots per year; counts by status code (2xx/3xx/4xx/5xx); a list of the years with captures; one sample snapshot URL per year; and a short plain-text summary, for example "Archived 2004–2025, 1,240 captures, mostly 200; gap 2011–2016; recent captures redirect". No content judgement (no adult or spam guessing) in v0.1.
- **Behaviour:** about 1 request per second to archive.org, backoff on 429/5xx, and a hard per-domain timeout. If the archive errors after retries, the row says `status: error` with the reason and is **not charged**. A domain with zero captures is a valid, charged row (`no_snapshots`).
- **Note:** on 25–26 Nov, archive.org returned HTTP 500 to our box and to the prefilter. The actor must handle that cleanly. That is why the error-row rule above matters.
- **Tests:** a multi-year CDX fixture; resume-key paging; zero captures; a 500 with retries then an error row (no charge); input cleanup (`https://www.X.com/path` becomes `x.com`).

## Pricing (proposal only, not in code)

Each actor uses PPE with a single `result` event. Gavriel proposes the price from the GCOS-30 competitor notes, and Dvir approves it before publish. The repo holds no figures.

## Done means

- Three folders, green `apify-actors.yml` CI, and the text guard covering them.
- A local `apify run` works for each actor with a sample input (Dvir's machine).
- No push or publish. Gavriel gets the commit and CI result, then sets store texts and proposes prices.
