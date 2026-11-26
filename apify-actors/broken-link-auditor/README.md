## Broken Link & URL Status Auditor

First draft (the text owners rewrite it).

Check the HTTP status of URLs from a list, a sitemap or a same-site crawl. Per URL: final status, redirect chain, loops, response time and content type. In crawl mode: the source page and anchor text of every link to it.

**Input:** `startUrls` (required), `mode` (`list`, `sitemap`, `crawl`), `maxPages`, `maxDepth`, `checkExternal`, `maxConcurrency`, `respectRobots`.

The actor reads robots.txt, limits the rate per host, backs off on 429 and 5xx, and counts each unique URL once. URLs skipped by robots.txt, DNS failures and timeouts are shown but not charged. Pricing is on the Pricing tab.
