# CR-102: prove the prior-kill lookup is indexed, and time it

Status: proposed (DOM Architect, 2026-11-04). Maintenance only, no new behavior.

## Why
Dvir asked whether the CR-101 prior-kill check is efficient. internal/auctions.md says `priorKillJoin` is one `left join lateral` over `auction_kills (domain)`, but the docs don't give the index name or definition, and the shortlist doesn't report how long the step takes. auction_kills now has 3,468 rows (1,399 names). Measured from the box on Nov 4 at about 22:50 IST: GET /auctions/shortlist?limit=200 took 1.1 to 1.4 s warm and 7.4 s cold. That total includes the proxy.

## Ask
1. Confirm a btree index on `auction_kills (domain)` exists, ideally `(domain, killed_at desc)`. If none exists, add it. Write its name and definition in docs/internal/auctions.md.
2. Confirm in docs that the lookup uses that index (an index scan per served row, not a seq scan). Include the EXPLAIN shape in the doc note.
3. Add `prior_kill_ms` (server time of the exclusion step) to GET /auctions/shortlist and GET /auctions/funnel, next to `prior_kill_excluded_n`.

## Tests
- CR102-T1: EXPLAIN of the shortlist query with 10k kills shows an Index Scan on the auction_kills domain index and no Seq Scan on auction_kills.
- CR102-T2: `prior_kill_ms` is present and is a number of 0 or more.
- CR102-T3: CR101-T11 still passes (p95 under 800 ms with 10k stored rows and 5k kills).
- No contract break: only a new field is added.
