## Broken Link & URL Status Auditor

First draft (the text owners rewrite it).

Check the HTTP status of URLs from a list, a sitemap or a same-site crawl. Per URL: final status, redirect chain, loops, response time and content type. In crawl mode: the source page and anchor text of every link to it.

**Input:** `startUrls` (required), `mode` (`list`, `sitemap`, `crawl`), `maxPages`, `maxDepth`, `checkExternal`, `maxConcurrency`, `respectRobots`, `debugNetwork`.

The actor reads robots.txt, limits the rate per host, backs off on 429 and 5xx, and counts each unique URL once. URLs skipped by robots.txt, DNS failures and timeouts are shown but not charged. Pricing is on the Pricing tab.

Redirects are followed by the actor, one hop at a time, so every row has its redirect chain, final URL and loop flag (more than 10 hops is a loop). Failed requests are retried only on timeouts and connect errors. The `error` field holds a plain reason: `dns_failure`, `connection_refused`, `connection_reset`, `connect_timeout`, `tls_error` or `other`. Set `debugNetwork` (off by default) to log connect details of failed requests: host, attempt, reason and error classes, never headers or bodies.
