# CR-102: prove the prior-kill lookup is indexed, and time it

Status: done (DOM, 2026-11-04, v6.5.0). Proposed by DOM Architect, 2026-11-04. Maintenance only, no new behavior.

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

## DOM response (2026-11-04, v6.5.0)
Accepted and built in **v6.5.0**, MINOR, with no migration.
1. **Index:** it already existed. `auction_kills_domain_idx` = `btree (domain)`, plus `auction_kills_supersedes_idx` = `btree (supersedes) WHERE supersedes IS NOT NULL` for the revoke check (migration `1769500000000_v6-4-0.sql`).
   - **Pushback:** no `(domain, killed_at desc)` index. A name has about 2.5 kills (3,468 rows over 1,399 names), so the sort is free and a second index would only cost disk (CR-100).
   - Names and definitions are in `docs/internal/auctions.md` ("Index proof and timing").
2. **Plan:** per shortlist row, a Nested Loop Anti Join of `Index Scan using auction_kills_domain_idx (domain = s.domain)` and `Index Only Scan using auction_kills_supersedes_idx (supersedes = k.id)`. There is no Seq Scan on `auction_kills`. The full shape is in the internal doc.
3. **Timing:** `prior_kill_ms` on `GET /auctions/shortlist`, and `shortlisted.prior_kill_ms` on `GET /auctions/funnel`.
   - It is the server time of the count query, which applies the exclusion to every eligible row. It is 0 when there is no data date.
   - Your 1.1 to 1.4 s is the whole round trip through the tunnel and proxy: compare it with this number on the same call.

**Tests:** CR102-T1 (EXPLAIN with 10,000 kills after ANALYZE: index scan, no Seq Scan) and CR102-T2 (the field is present and ≥ 0, also with no data). CR101-T11 (p95 under 800 ms) still passes. Full suite 3,137 passed.

**Check after deploy:** `GET /auctions/shortlist?limit=200` should show `prior_kill_ms` next to `prior_kill_excluded_n`.

## Gavriel check after deploy (2026-11-04, ~23:04 IDT, v6.5.0 live)
- CR102 check passes. `GET /auctions/shortlist?limit=200` (data_date 2026-11-04): `prior_kill_ms` 68 and 65 on two warm calls, `prior_kill_excluded_n` 96, total 129. Box round trip 1.17 s and 0.99 s, so nearly all of the wait is tunnel and proxy, not the lookup.
- `GET /auctions/funnel` shortlisted: names 2,795, served 2,795, prior_kill_excluded 950, prior_kill_ms 93.
- Index pushback accepted: no second index. Closed from my side.
