# Afternic seller API (v5.61.0)

Afternic released an official seller API on 22 Oct 2026 (docs: https://api.afternic.com/docs/portfolio-api/). DOM uses it for three things: a daily read, a drift warning and an operator-run push. The browser path (`.claude/skills/afternic-listing/`) is the fallback.

## Rules
- Env `AFTERNIC_API_KEY`, `AFTERNIC_API_SECRET` (optional `AFTERNIC_API_BASE_URL`, default `https://api.afternic.com`). Header `Authorization: sso-key KEY:SECRET`. Both are in `Config.secretValues` (scrubbed from logs) and never in an error text. Without them: the step is `skipped` with `status: not_configured`, the route answers 503 `AFTERNIC_NOT_CONFIGURED`.
- Base path `/v3/aftermarket/customers/my`. Limit 150 requests a minute (sliding-window limiter in the client; a 429 waits `Retry-After` or 1/2/4 s, three retries, then `AFTERNIC_RATE_LIMITED`). Prices are micro-USD (cents x 10,000).
- Endpoints used: `GET /domains?limit=100&offset=N&order=NAME_ASC` (response `{domains: [...], pagination}`), `GET /domains/{name}`, `PATCH /domains/{name}` (200 or 204), `GET /stats/{name}?startDate=<UTC ISO>&days=30` (`{stats: [{date, views, leads}]}`). Not used: create, replace, delete, bulk `$each/*`, relist.
- Field map (plan value = the Afternic CSV cell of `afternicRow`): Buy Now Price `buynowPrice`, Floor Price `floorPrice`, Min Offer `minbidPrice`, Lease to Own `leasingEnabled`, Max Lease Period `maxLeasePeriod` (compared only when the plan has the lease on), Sale Lander `intakeStyle` (`Buy It Now` = `BUYNOW`, `Custom Lander` = `CUSTOM_LANDER`, sent with `landingPage: SALES_TYPE`), Show Buy Now / Lease to Own / Make Offer `showLanderBuynowOption` / `showLanderLeaseToOwnOption` / `showLanderMakeOfferOption`, Hidden `hidden`. `listStatus` must be `ACTIVE` (reported in the warning, not pushable). The private walk-away has no Afternic field and is never read or sent (AFN-12).
- Founder rule 4: the scheduled price job and drop job never call Afternic (AFN-15). The daily `afternicSync` only reads (AFN-7). Only `POST /export/afternic/push` (WRITE, an operator's deliberate action after a plan change) writes.
- The lease-to-own maximum is **12 months** from 27 Oct 2026 (Dvir; NameBio: 41% of finished lease-to-own deals cancelled, longer terms cancel more); `listing-strategy.md`, `docs/contract/formats.md`.
- `intakeViews` appears on live reads but is not in the docs; it is used only as the views fallback when the stats call fails. The 30-day views and leads come from the documented stats endpoint (1 call per portfolio name a day).

## Daily step `afternicSync`
After `listingSync`. Lists every Afternic listing, stores one row per name per UTC day in `afternic_listings_daily` (unique `(domain, day)`, a rerun replaces the row), records views and leads into `visit_daily` as source `afternic` (`importAfternic`; leads kept when null), and counts names that differ from the plan. Summary `{status, listings_n, drift_n, views_stored_n}`.

## Warnings (`reporting/report/afternic.ts`, from the newest stored read vs the CURRENT plan)
`AFTERNIC_DRIFT` (warn, `details: {domain, fields: [{field, plan, afternic}], read_day}`), `AFTERNIC_NOT_LISTED` (warn). Silent with no read or a read older than 3 days.

## `POST /export/afternic/push`
Body `{domains?, dry_run?}`. Reads the full listing, diffs each listed name, PATCHes only the differing pushable fields. Records the upload (`ExportService.recordApiPush`: an `export_runs` row at the start of the run, then the same confirm as `POST /export/afternic/uploaded`) only when every listed name was checked and none failed. Answer `{dry_run, pushed, unchanged, failed, skipped, upload}`. Not covered: creating a name at Afternic (`AFTERNIC_NOT_LISTED`; use Add Domains in the browser).

## Tests (`tests/modules/listing/afternic-api.test.ts`)
AFN-1 conversions and PATCH body · AFN-2 list pages, auth header · AFN-3 429 backoff · AFN-4 401 and no secret in errors · AFN-5 150/min limiter · AFN-6 not configured step · AFN-7 daily rows, views, read-only · AFN-8 daily run order · AFN-9 drift and not-listed warnings · AFN-10 not configured, scopes · AFN-11 dry run · AFN-12 real push, walk-away never sent, upload recorded, EXPORT_PENDING clears · AFN-13 failures and partial lists · AFN-14 API error 502 and idempotent replay · AFN-15 price job never calls Afternic · AFN-16 lease 12.
