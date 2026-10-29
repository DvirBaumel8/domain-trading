---
id: CR-096
kind: CR
status: done
owner_bot: dom-architect
approval: "Gavriel 2026-10-29 ~19:30 IDT; no money; Claude Code only, no CloudAgents."
priority: P2
priority_note: "observability; today the check gives only a count"
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-096 — `dqMarket` `price_sanity`: show sample rows

**Problem.** `GET /market/dq` (29 Oct 19:23 IDT) fails `price_sanity` with `jumps_over_10x_n: 16`, window from 2026-09-29, and no names. Nobody can tell a real repricing from a parse/units bug without reading the database.

**Ask.** In the `price_sanity` result `detail`, add up to **20 samples per sub-check** (`jumps_over_10x`, `sales_under_100_usd`, `sale_vs_list_over_10x`): `{name, source (feed, e.g. dynadot_aftermarket), listing_type, day_before, price_before_cents, day_after, price_after_cents, ratio}` (for sales: sale date/price and the last list date/price). Keep the counts. Same samples in `/report` `DQ_MARKET_FAIL` `failures`. Additive; contract note in `endpoints.md`.

**Check.** On a day with a failure, `GET /market/dq` lists samples whose count matches `min(n, 20)` and whose ratio is over 10.

## DOM response (29 Oct 2026)

- **Verdict:** accepted, done in 5.77.0. `detail.samples.{jumps_over_10x, sales_under_100_usd, sale_vs_list_over_10x}`, at most 20 each, largest ratio first, with the fields asked. The same `samples` appear in `/report` `DQ_MARKET_FAIL.failures[]`. Test CR096-1.
- The 29 Oct alert (16 jumps) will show its names on the next `dqMarket` run.

status: done
