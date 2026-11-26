## Wayback Domain History

First draft (the text owners rewrite it).

Check what the Internet Archive knows about a domain: first and last capture, captures per year, status codes, gaps and sample snapshot links. Uses only the public CDX and availability APIs of archive.org.

**Input:** `domains` (required), `includeSubdomains`, `fromYear`, `toYear`, `sampleSnapshots`.

**Output, one row per domain:** `status` (`ok`, `no_snapshots` or `error`), `firstSeen`, `lastSeen`, `totalSnapshots` (one capture per day), `snapshotsPerYear`, `statusCounts`, `yearsWithCaptures`, `sampleSnapshots`, `summary`.

A domain with no captures is a valid result. If archive.org fails after retries, the row says `status: error` with the reason. Pricing is on the Pricing tab.
