> Status: Open

# BUG-047: mineunited.com record is wrong, and the scheduled jobs stopped after Oct 17
| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot), for Gavriel |
| Date | 2026-10-20 |
| Type | Maintenance and bug fix (allowed under the 2026-10-20 build freeze) |
| Build | Fix now, no date (README rule). Report here when it's live on `/health`. |

## 1. mineunited.com portfolio record
- **Got:** DOM records the Buy Now price as $3,488.
- **Expected:** $1,488, the price decided on 2026-10-19 (Gavriel).
- **Also missing:** the renewal price. Fill it from the registrar's current .com renewal rate (GoDaddy), not a guess, and record its source and date.
- This is a record fix only. If DOM's record differs from the live Afternic listing, report it here and don't change the listing. Listings stay with Gavriel.

## 2. The scheduled jobs didn't run
- **Got:** the daily scheduled runs on 2026-10-18 and 2026-10-19 didn't fire. The tick job last ran 2026-10-17 15:18 IDT.
- **Asks:**
  1. Find the cause and fix it. It may be connected to BUG-044 (missed slot on the Mac) or the v5.18 and v5.19 host changes.
  2. Restart the jobs, and say here whether the missed runs were caught up or skipped.
  3. Make `/health` turn `jobs` to a failing state when any scheduled job is more than 26h past its last run, so this is caught the next day.
  4. Don't ask Dvir to do anything (README rule).

## Acceptance tests
- **AT-1:** `GET /portfolio/mineunited.com` shows price $1,488 and a renewal price with its source.
- **AT-2:** the tick job and the daily run each show a run after the fix.
- **AT-3:** `/health` shows that a job missing for more than 26h fails.

<!-- DOM writes below this line -->

## DOM response (2026-10-20)

**2. The jobs: cause found, nothing broken in the code.**
- **Cause:** production was stopped from 18 Oct until 19 Oct 19:42 UTC, at Dvir's request (the G-109 pause), so the server wasn't there to take the calls. It wasn't caused by BUG-044 or the v5.18/v5.19 host changes.
- **Daily runs:** the scheduled runs for 18 and 19 Oct had no server to reach, and were **skipped, not replayed**. A run on 19 Oct at 19:42 UTC and the scheduled run on **20 Oct at 00:05 UTC (accepted, 202)** did run. The price and drop jobs work by date, so anything due on 18 and 19 Oct was applied on those runs.
- **Tick runs:** the GitHub `review-retry-tick` runs failed on 18 and 19 Oct for the same reason. It runs again on its next schedule. No restart is needed.
- **Ask 3 (v5.20.0):** `/health` `jobs` already turns `overdue` when the daily run misses its slot. v5.20.0 adds the same for `tick` (no run for 26 h) and a `jobs_last {daily, tick}` field. A server that is down can't answer `/health` at all; your missing reply is the signal then.

**1. mineunited.com: a real conflict, flagged and not changed.**
- **The record isn't a bug.** It holds **$3,488**, which Dvir approved in his own words on 16 Oct ("record mineunited.com in DOM at $24.19 cost, $3,488 Buy Now", CR-060). As far as the repo knows, it matches the live Afternic listing.
- **Why I won't change it on this request:** $1,488 is a price change. Founder rule 4 says an S8 BIN off the ladder needs Dvir's `bin_override` named in his approval, and your CR-069 item 2 keeps price changes behind his one-tap yes. I found no record of a 19 Oct decision by Dvir.
- **What I'll do:** put Dvir's line in this file, naming mineunited.com and $1,488. DOM then ships the change as a data fix in the next release: BIN 148800, with the floor and walk-away recomputed by the formula. The Afternic listing stays with you.
- **Renewal price:** the GoDaddy adapter is management-only and can't read prices, so DOM has no source of its own. v5.20.0 adds `POST /portfolio/{domain}/renewal-price {renewal_price, source, as_of}` (WRITE or `bots`). Record GoDaddy's current .com renewal rate there with its source and date; `GET /portfolio/mineunited.com` then shows it (AT-1, renewal part).

**bin_override approval (Dvir, 2026-10-20 17:24 IDT, verbatim, via Gavriel chat):** "Yes, set mineunited.com to $1,488" (in answer to: "Set mineunited.com to $1,488 Buy Now in DOM? It's $3,488 now.")

## DOM release (2026-10-20): v5.20.1 tagged, mineunited.com at $1,488

Applied with Dvir's line (17:24 IDT). The release's migration sets:

| Field | Value |
|---|---|
| BIN | $1,488 |
| Floor | $967 (formula) |
| Walk-away | $715 (private) |
| Min offer | $100 |
| Final push | $1,088 |

- **Dates:** the final push and the delist keep their dates.
- **History and export:** a `listing_history` row records the change, and the Afternic and Sedo exports are flagged pending.
- **The Afternic listing still shows $3,488.** Please update it from the next export; DOM doesn't touch it.
- **To check:** once `/health` shows 5.20.1, `GET /portfolio/mineunited.com` should show the new plan (AT-1 price part).

## Gavriel check (2026-10-20 23:41 IDT): v5.20.1 live, price part passes

- `/health` shows 5.20.1 (live 23:39 IDT), `db: ok`, `jobs: ok` (tick 2026-10-20 16:44 IDT, so the overdue flag cleared).
- `GET /portfolio/mineunited.com`: BIN $1,488, floor $967, walk-away $715 (private), min offer $100, next event final push at $1,088, renewal $23.19 with source and date. AT-1 (price and renewal parts) passes.
- `GET /export/afternic.csv` has `mineunited.com,1488,967,100,N,,Custom Lander,Y,N,Y,N`. The Afternic upload itself is next; I'll confirm it with `POST /export/afternic/uploaded` once the live listing shows $1,488.
