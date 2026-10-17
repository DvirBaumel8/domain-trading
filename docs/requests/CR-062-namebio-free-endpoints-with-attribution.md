> Status: Approved by Dvir 2026-10-17

# CR-062 — NameBio data from the free public endpoints only, with attribution
| Field | Value |
|---|---|
| CR id | CR-062 |
| From | DOM Architect (Grok Bot), on behalf of Dvir |
| Date | 2026-10-17 03:30 IDT |
| Approved by Dvir | 2026-10-17 03:07 and 03:18 IDT, relayed by Gavriel (see Approval) |
| Priority | P2 (adds keyword-level demand features for Scorer v11) |
| Owner bot | Scoring Scientist |

## 1. Business need
- Bots may not use NameBio per-sale search or CSV export. The paid API needs a Business membership and NameBio's written permission ("You MAY NOT use our Paid API for a product or service, whether free or paid, without obtaining written permission", https://api.namebio.com/docs/, updated 2026-07-18). Dvir said no paid NameBio.
- NameBio publishes **free endpoints**: "available to everyone at no cost and require no authentication. You may incorporate this data into other products and services, but attribution is required" (same page).
- Today `GET /selection/namebio` reads a nightly cache, and the source is off (`sources.namebio` false, `docs/contract/endpoints.md`).

## 2. Rules
- **R-1 (allowed sources only):**
  - **RetailStats:** `POST https://api.namebio.com/retailstats` with `keyword`. Stats per placement (exact/start/end/middle): sale_count, price_sum, price_avg, price_max, price_stddev. Retail sales of $100 or more only. Limit 4 requests a minute. A full CSV download is also offered.
  - **TLDStats:** `POST https://api.namebio.com/tldstats`. Limit 4 a minute. A CSV is offered.
  - **Verisign drop order:** `POST https://api.namebio.com/verisign`. At most 100 domains per call, 5 calls per 24 h per IP. Use the published file for more than 500 domains.
- **R-2:** never call the paid endpoints (comps, checkdomain, dailysales, topsales, keywordstats), the website search, or CSV exports. Never use login, cookies, or more than one IP.
- **R-3 (prefer the files):** pull the published RetailStats CSV, the TLDStats CSV and the drop-order file once a day as a DOM job. Use the per-keyword endpoint only for misses. Stay sequential and inside the rate limits above. On a rate-limit error, wait one minute (the docs' general rule). Data refreshes hourly, so caching for 24 h is fine.
- **R-4 (attribution):** every stored row keeps `source = "namebio_free"`, the source URL and the fetch date. Every API response that serves these numbers carries `attribution: "Data from NameBio"` plus a link to https://namebio.com. Cards that show the numbers must show it too.
- **R-5:** these are keyword aggregates, not per-sale rows. They must never go into `/engine/sales`.
- **R-6:** turning the source on (`sources.namebio`) is a settings change, so it needs Dvir's fresh OK at activation time.
- **R-7:** the size of the RetailStats CSV (100,000+ keywords, per NamePros) is logged in `/jobs/runs` against the 0.5 GB limit.

## 3. Acceptance criteria
- **AC-1:** `GET /selection/namebio?keywords=cloud,hosting` returns placement stats from the cache with `source: "namebio_free"`, `attribution` and a `data_as_of` date.
- **AC-2:** the job log shows only the allowed hosts/paths from R-1. An attempt to configure a paid path is refused.
- **AC-3:** a cache older than `namebio.max_cache_age_hours` → `stale: true`, as today.
- **AC-4:** job runs show rows stored, file bytes, and DB bytes before/after.
- **AC-5:** with `sources.namebio` false, nothing is fetched (`SOURCE_DISABLED`).

## 4. Open questions for DOM
- Q1: reuse the existing nightly cache table behind `/selection/namebio`, or add a new `namebio_keyword_stats` table?
- Q2: should the Verisign drop-order file feed `/selection/drop-lists`, ahead of the CR-050 free drop feed?
- Q3: the CSV download URLs aren't printed in the docs text we fetched. Please confirm them from the docs page.

## Approval (Dvir, 2026-10-17 IDT, relayed by Gavriel)
- 03:07, verbatim: "All bots are allowed to execute DOM read only actions or read/write but only for actions that are not impacting money (buy domain, sell domain, listing and more). For example fetch data online and write it to the database is allowed. I want us to decided on one only bot that will be in charge to do actions of buys sell and so on"
- 03:18, answering "named read-only tokens for the new bots, with the write token staying with Gavriel only", verbatim: "7. Yes they should"; and "Yes it can be you" (Gavriel is the only bot doing money actions).
- Coverage: 03:07 covers fetching NameBio free data online and writing it to the DB (non-money). Turning on `sources.namebio` is a settings change and still needs Dvir's fresh OK at activation.

<!-- DOM writes below this line -->
