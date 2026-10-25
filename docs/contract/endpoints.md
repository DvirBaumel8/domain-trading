# Endpoints (contract v5.38.0)

Derived from the route registrations in `src/app.ts` and the zod schemas in the route files under `src/modules/*/api/`. A test (`tests/contract/contract-doc.test.ts`) fails if a registered route is missing here, or if a route here isn't registered.

## Start here: the main routes by task

Scopes: READ = every `GET`; WRITE = every route (README §Who may call); intake and data tokens are narrower (see the table below). Every POST needs `Idempotency-Key`. Details for each route are in the sections further down.

| Task | Routes | Scope |
|---|---|---|
| Check a name's price across registrars | `GET /check` | READ |
| Buy (needs Dvir's `approval_ref` and a complete `screening_pack`; try `dry_run: true` first) | `POST /buy` | WRITE |
| Import a bought S8 name (aftermarket, lane S8) | `POST /portfolio/import` | WRITE |
| Set the listing plan, list, record a hand listing | `GET /pricing/preview`, `POST /list/{domain}`, `POST /listings/{domain}/venue` | READ, WRITE, WRITE |
| Export marketplace files and confirm the upload | `GET /export/afternic.csv`, `GET /export/sedo.csv`, `POST /export/{venue}/uploaded` | READ, READ, WRITE |
| Offers and sales | `POST /offers`, `POST /offers/{id}/outcome`, `GET /offers`, `POST /sold/{domain}` (evidence needed without approval) | WRITE (GETs READ) |
| Reports and books | `GET /report`, `GET /report/pricing-review`, `GET /ledger`, `GET /portfolio`, `GET /portfolio/{domain}`, `GET /audit` | READ |
| Costs and the private books (5.25.0, CR-070) | `POST /ledger/costs`, `PUT /portfolio/{domain}/forward-costs`, `GET /portfolio/{domain}/forward-costs`, `GET /costs/forward`, `GET /books.csv` | WRITE or bots for the writes; READ or bots for the GETs |
| Load data for the scoring engine and score names | `POST /engine/sales`, `POST /engine/unsold`, `POST /data/*` (rdap, live-checks, tm-kills, bigco-names, sales-comps), `POST /score`, `GET /engine/health` | WRITE or data token for the loads; READ for `GET` and `POST /score` |
| Selection and screening | `GET /selection/settings`, `POST /selection/evaluate`, `POST /screening/runs`, `POST /screening/packs`, `GET /selection/buy-hold`, `POST /candidates/intake`, `GET /candidates/daily` | READ for `GET`, WRITE for `POST` (`/candidates/intake` also takes an intake or data token) |
| Count visitors of the listed names (off until Dvir's line) | `POST /visits/forward/{domain}`, `POST /visits/settings`, `POST /visits/import`, `GET /visits`, `GET /visits/weekly` (the counting itself is `POST /visits/hit`, visits token only) | WRITE, WRITE, WRITE or data, READ, READ |
| Look up RDAP facts of .com names with a cache and a daily limit (5.29.0, CR-074) | `GET /rdap/{domain}`, `POST /rdap/batch`, `GET /lookups/usage` | READ or bots (the batch is a read-only POST) |
| Jobs | `POST /jobs/run` (`tick`, `daily`, `datasave`), `GET /jobs/runs` | job token or WRITE; READ |
| Health | `GET /health/ping` (no token), `GET /health` | none, READ |

**Notation:** `field: type` · `?` = optional · `| null` = may be `null` · "USD number" = a JSON number with at most 2 decimals · "money pair" = `x_cents` + `x` (README §Conventions). Every POST needs `Idempotency-Key` (README §Idempotency). Every body schema is **strict**: an unknown field → 422 `VALIDATION_ERROR` (exception: `pricing_evidence` on `/buy` is checked by the comps rules, so an extra key or a bad comp → 422 `COMPS_INVALID`). The cross-cutting errors (401, 403, 429, `IDEMPOTENCY_KEY_*`, `INVALID_BODY`, `INTERNAL`, `AUDIT_WRITE_FAILED`) apply everywhere and aren't repeated per route.

| Method | Path | Token | Section |
|---|---|---|---|
| GET | `/health/ping` | none | Health |
| GET | `/health` | READ/WRITE | Health |
| GET | `/openapi.json` | READ | API description (3.3.0) |
| GET | `/check` | READ | Buying |
| POST | `/buy` | WRITE | Buying |
| GET | `/pricing/preview` | READ | Listing |
| POST | `/list/{domain}` | WRITE | Listing |
| POST | `/listings/{domain}/venue` | WRITE | Listing (3.7.0) |
| POST | `/listings/{domain}/observed` | WRITE or bots | Listing (5.27.0) |
| POST | `/portfolio/{domain}/display-name` | WRITE or bots | Listing (5.27.0) |
| GET | `/export/afternic.csv`, `/export/sedo.csv` | READ | Exports |
| POST | `/export/{venue}/uploaded` | WRITE | Exports |
| POST | `/offers`, `/offers/{id}/outcome` | WRITE | Offers |
| GET | `/offers`, `/report/offers` | READ | Offers |
| POST | `/sold/{domain}` | WRITE | Sales |
| GET | `/report`, `/report/pricing-review` | READ | Reports (`reports.md`) |
| GET | `/portfolio`, `/portfolio/{domain}`, `/ledger`, `/deals/{id}`, `/audit` | READ | Reads |
| GET | `/portfolio/outcomes`, `/portfolio/outcomes/monthly`, `/portfolio/outcomes/quarterly` | READ | Portfolio outcomes (4.0.0) |
| POST | `/portfolio/{domain}/horizon`, `/portfolio/{domain}/stats` | WRITE | Portfolio outcomes (4.0.0) |
| POST | `/portfolio/{domain}/renewal-price` | WRITE or bots | Portfolio outcomes (5.20.0, BUG-047) |
| POST | `/ledger/costs` | WRITE or bots | Costs and books (5.25.0, CR-070) |
| PUT | `/portfolio/{domain}/forward-costs` | WRITE or bots | Costs and books (5.25.0, CR-070) |
| GET | `/portfolio/{domain}/forward-costs`, `/costs/forward`, `/books.csv` | READ or bots | Costs and books (5.25.0, CR-070) |
| POST | `/tokens/bots/rotate` | WRITE or bots | Health (Shared bots token, 5.20.0, CR-069) |
| POST | `/portfolio/import` | WRITE | S8 import lane (5.8.0, CR-059) |
| POST | `/outreach/emails` | WRITE | Outreach log (4.0.0) |
| GET | `/outreach/emails/summary` | READ | Outreach log (4.0.0) |
| POST | `/patterns/sales` | WRITE | Sales patterns (4.0.0) |
| GET | `/patterns/latest` | READ | Sales patterns (4.0.0) |
| POST | `/lessons` | WRITE | Scout lessons (5.3.0) |
| PATCH | `/lessons/{id}` | WRITE | Scout lessons (5.3.0) |
| GET | `/lessons`, `/lessons/check`, `/lessons/report` | READ | Scout lessons (5.3.0) |
| POST | `/engine/sales`, `/engine/unsold` | WRITE or data (5.10.0) | Scoring engine (5.4.0, 5.10.0) |
| POST | `/data/rdap`, `/data/live-checks`, `/data/tm-kills`, `/data/bigco-names`, `/data/sales-comps` | WRITE or data | Loaded data tables (5.12.0, CR-063) |
| GET | `/data/rdap`, `/data/live-checks`, `/data/tm-kills`, `/data/bigco-names`, `/data/sales-comps` | READ (a data token gets 403) | Loaded data tables (5.12.0, CR-063) |
| POST | `/data/sales` | WRITE, bots or data | Market data (5.23.0, CR-075) |
| PUT | `/data/sales`, `/data/sales/{id}` | none: always 405 `APPEND_ONLY` | Market data (5.23.0, CR-075) |
| PATCH | `/data/sales`, `/data/sales/{id}` | none: always 405 `APPEND_ONLY` | Market data (5.23.0, CR-075) |
| DELETE | `/data/sales`, `/data/sales/{id}` | none: always 405 `APPEND_ONLY` | Market data (5.23.0, CR-075) |
| GET | `/market/episodes`, `/market/matched`, `/market/dq`, `/market/coverage` | READ or bots (a data token gets 403) | Market data (5.23.0, CR-075) |
| GET | `/auctions/live` | READ or bots (a data token gets 403) | GoDaddy auctions inside the buying range, with bids (5.37.0) |
| POST | `/pickproof/{date}/picks` | WRITE or bots (non-money; a READ or data token gets 403) | Pick-proof (5.28.0, CR-073) |
| GET | `/pickproof/{date}/manifest`, `/pickproof/{date}/arms`, `/pickproof/{date}/pool`, `/pickproof/report` | READ or bots (a data token gets 403) | Pick-proof (5.28.0, CR-073; pool 5.30.0, CR-073a) |
| POST | `/engine/train` | WRITE | Scoring engine (5.5.0, 5.6.0) |
| POST | `/engine/holdout-date` | WRITE only (not a data token) | Holdout guard (5.10.0, CR-061) |
| GET | `/engine/holdout-date` | READ | Holdout guard (5.10.0, CR-061) |
| POST | `/visits/hit` | visits token only | Visitor counter (5.18.0, CR-068) |
| POST | `/visits/import` | WRITE or data | Visitor counter (5.18.0, CR-068) |
| POST | `/visits/settings`, `/visits/forward/{domain}` | WRITE only | Visitor counter (5.18.0, CR-068) |
| GET | `/visits`, `/visits/weekly` | READ (data and visits tokens get 403) | Visitor counter (5.18.0, CR-068) |
| GET | `/engine/health`, `/engine/train/{id}` | READ | Scoring engine (5.4.0, 5.5.0) |
| GET | `/owned/{domain}/endings` | READ | Owned-name endings watch (5.7.0, CR-058) |
| POST | `/score` | READ (the one read-only POST: no `Idempotency-Key`, no audit row) | Scoring engine (5.5.0) |
| GET | `/selection/settings`, `/selection/lists/{name}`, `/selection/sibling-methods/{method}`, `/selection/test-sets/{name}`, `/selection/drop-lists`, `/selection/drop-lists/{name}`, `/selection/cohorts/{name}`, `/selection/cohorts/report`, `/selection/namebio`, `/selection/sibling-scan/{domain}`, `/demand/keywords`, `/selection/replays/{id}`, `/selection/buy-hold`, `/selection/holdout-suites` | READ | Selection (`selection.md`) |
| POST | `/selection/settings`, `/selection/settings/{label}/activate`, `/selection/lists/{name}`, `/selection/sibling-methods/{method}/approve`, `/selection/test-sets`, `/selection/test-sets/{name}/seal`, `/selection/test-sets/{name}/cancel`, `/selection/drop-lists`, `/selection/cohorts`, `/selection/sibling-scan`, `/demand/keywords`, `/selection/evaluate`, `/selection/labelled-names`, `/selection/replays`, `/selection/holdout-suites` | WRITE | Selection (`selection.md`) |
| POST | `/screening/runs`, `/screening/runs/{id}/cancel`, `/screening/runs/{id}/manual`, `/screening/runs/{id}/verdicts`, `/quotes/manual` | WRITE | Screening |
| GET | `/screening/runs/{id}`, `/screening/runs/{id}/report.csv`, `/screening/evidence/{id}` | READ | Screening |
| POST | `/screening/packs` | WRITE | Screening packs |
| GET | `/screening/packs`, `/screening/packs/{id}` | READ | Screening packs |
| POST | `/tranches`, `/tranches/{id}/members`, `/tranches/{id}/close` | WRITE | Tranches |
| GET | `/tranches` | READ | Tranches |
| POST | `/jobs/run` | job token | Jobs (`jobs.md`) |
| GET | `/jobs/runs` | READ | Jobs (`jobs.md`) |
| POST | `/jobs/preview` | WRITE | Jobs (`jobs.md`) |
| GET | `/rdap/{domain}`, `/lookups/usage` | READ or bots (a data token gets 403) | RDAP lookup service (5.29.0, CR-074) |
| POST | `/rdap/batch` | READ, bots or WRITE (a read-only POST like `/score`: no `Idempotency-Key`, no audit row) | RDAP lookup service (5.29.0, CR-074) |
| GET | `/snapshots`, `/snapshots/missing` | READ | Daily data saves (`jobs.md`, 5.21.0) |
| POST | `/snapshots/dynadot` | WRITE or bots | Dynadot rows uploaded by the bots (5.22.0, CR-071 R-8, R-9) |
| POST | `/company/document`, `/company/forbidden-terms`, `/company/forbidden-terms/{id}/retire` | WRITE | Company and reviews |
| GET | `/company/document/versions`, `/company/document/versions/{n}`, `/company/forbidden-terms` | READ | Company and reviews |
| POST | `/reviews/packet`, `/reviews/run`, `/reviews/settings`, `/reviews/{packet_id}/feedback`, `/reviews/items/{id}/status` | WRITE | Company and reviews |
| GET | `/reviews/packets/{id}`, `/reviews/items`, `/reviews/cost`, `/reviews/settings`, `/reviews/settings/history` | READ | Company and reviews |
| POST | `/candidates/{domain}/records` | WRITE | Candidates |
| POST | `/candidates/intake` | WRITE or intake | Candidates |
| GET | `/candidates/daily` | READ | Candidates |
| GET | `/candidates/closeouts` | READ or bots | Candidates (5.26.0, CR-072) |
| POST | `/candidates/daily/rebuild` | WRITE | Candidates |
| POST | `/candidates/screen` | WRITE | Candidates (3.3.0) |
| GET | `/candidates/{domain}/records` | READ | Candidates |

---

## Health

### `GET /health/ping`
The only public route. No auth, no DB access (Render's health check uses it). **200** `{status: "ok", version, commit}` (3.7.0, CR-034: `commit` is the deployed git commit, null when unknown; the `deploy-live` workflow uses it).
- **200** `{"status":"ok"}`.

### `GET /openapi.json`
READ (3.3.0, CR-023 F). An OpenAPI 3.1 description of every route (3.4.0, CR-024: itself included; every POST has a `requestBody`, or `x-no-body: true` when it takes none): method, path, `x-scope` (`none`, `read`, `write`, `write or intake`, `write or intake or data`, `write or data`, `write or bots` (5.20.0), `write or job-trigger token`), a one-line summary, path parameters, and the request body's JSON schema where the route has one. A test keeps it equal to the registered routes and this route table. This contract stays the binding text; the document is a convenience.

### `GET /health`
Any valid bot token (READ or WRITE).
- **200** `{status: "ok", db: "ok", db_size: {...} | null, jobs: "ok" | "overdue", version: string, adapters: [{name: string, enabled: boolean}]}`; **503** with `status: "degraded"`, `db: "down"` (and `jobs: "unknown"`) when the DB can't be reached.
- `db_size` (5.17.0): `{bytes, limit_bytes, percent, warn_percent}`, the database size against Neon's free 1 GB (`percent` to one decimal; `/report` warns `DB_SIZE_HIGH` above `warn_percent`, 70). `null` when the size can't be read (and in the 503 answer). Since 5.38.0 it also has `tables`: the 10 largest tables of the public schema, largest first, `[{table, bytes, rows_estimate}]` (`bytes` = table + indexes + TOAST; `rows_estimate` = Postgres's planner estimate, `null` before the table was first analysed).
- Removed in 5.2.0 (CR-057): `posting` and `posting_reason` are no longer in the answer.
- `review_reason` (3.1.0): present only when `review` is `failed`: Google's status and short reason from the latest review, never a key. 3.2.0 (CR-017 N-4): `CODE: text`, where CODE is Google's status (e.g. `UNAVAILABLE`) or `HTTP <n>`; at most **200 characters**, cut at a word and ending with `…` when longer.
- `dq_market` (5.23.0, CR-075, additive): `ok` (the latest `dqMarket` run passed every check), `alert` (a check failed; `GET /market/dq` names it; `/report` has `DQ_MARKET_FAIL`) or `unknown` (no run yet). It does not change `status`.
- `datasave` (5.21.0, CR-071, additive): `ok` (every configured GoDaddy inventory file has a complete save within the last 26 hours and the last `datasave` run did not fail), `partial` (some files saved, some not, or the last run failed for some), `error` (the last run's `godaddyInventory` step failed and no file is saved within 26 h), `overdue` (nothing complete within 26 h, also before the first run). It never changes the top-level `status`; the Dynadot steps (`not_configured`) never count. `/report` raises `DATASAVE_MISSED` for any value but `ok` once a save or a run exists.
- `jobs` is also `overdue` (3.1.0) when `JOB_MISSED` or `JOB_RUN_INCOMPLETE` applies.
- `review` (2.11.0, additive; `disabled` and `review_model` 2.11.2): `disabled` (the switch is off), `ok` (the latest Gemini feedback is ok), `failed` (it is unknown), `not_configured` (no key), `unknown` (no review yet).
- `jobs_last` (5.20.0, BUG-047, additive): `{daily: ISO | null, tick: ISO | null}`, when each scheduled job last ran (a run counts from the moment it was created; `null` = never). `jobs` is also `overdue` when no `tick` run was created in the last 26 hours (a job that missed its schedule for more than 26 h fails `jobs`, so the next day shows it).
- `jobs` (2.1.0, additive) is `overdue` when no `daily` run has finished in the last 26 hours (the same rule as the `/report` warning `JOB_OVERDUE`), else `ok`. A run started by hand counts. `GET /health/ping` is unchanged (no DB).
- `version` is the service build version (`package.json`), not the contract version. The only scheduled job is the daily run at 00:05 UTC (`jobs.md`); its rows are in `GET /audit` (scope `job`). No secret, key prefix or balance is ever shown.

### `POST /tokens/bots/rotate`
WRITE or bots (5.20.0, CR-069). The only token-creation route: it can make only a `bots`-scope token named `bots-shared`, and only a WRITE token or a bots token (self-rotation) may call it; anyone else 403 `SCOPE_FORBIDDEN`. No body. Idempotency-Key required, audited, normal POST rate limit. **200** `{token, expires_old_at, audit_id}`: `token` is the new raw value, shown **once** (the audit row and the idempotency store never hold it); `expires_old_at` is when the previous `bots-shared` token stops working (10 minutes from now, so a bot that has not picked up the new value keeps working meanwhile) or `null` when there was none. A **replay** of the same Idempotency-Key answers **200** `{token: null, expires_old_at, note: "already rotated; ...", audit_id}`: rotate again with a new key for a new value. The scope table is in `README.md` (Who may call). DOM retires the older per-bot READ tokens and the `data-engineer-upload` token by a later migration, once Gavriel confirms the shared token works.

---

## Buying

### `GET /check`
Availability and live prices from every enabled registrar, compared on **first year + exactly one renewal**.
- **Query:** `domain: string` (required). Other query parameters are ignored.
- **Behaviour:** normalises the name (lowercase, `.com` second-level only), asks RDAP (Verisign) and every enabled adapter in parallel (8 s timeout each), stores every quote under a new `check_id`, and caches the answer per domain for 60 s (a cached answer is replayed whole, same `check_id`). `two_year = first_year + renewal + 2 × paid privacy`. The winner is the lowest `two_year` among eligible quotes (tie-break: prepaid model, Afternic Fast Transfer, then adapter order). Any disagreement between RDAP and the adapters, or among adapters → `availability: "unknown"` and no winner. `available` needs at least one enabled adapter to confirm the name can be registered at a normal price: RDAP `not_registered` alone (for example with **no enabled adapter**) → `availability: "unknown"`, because reserved and premium names also look unregistered in RDAP. `taken` needs RDAP `registered` or an adapter saying so.
- **200:**
  ```
  { domain, check_id: "chk_…", checked_at: ISO,
    availability: "available" | "taken" | "unknown",
    rdap: "not_registered" | "registered" | "rdap_unknown",
    winner: null | { registrar, first_year, renewal, two_year, first_year_cents, renewal_cents, two_year_cents },
    quotes: [{ registrar, eligible: bool, exclusion_reason?, error_code?, available: bool|null, premium: bool|null,
               first_year_cents, renewal_cents, privacy_cents_per_year, two_year_cents, first_year, renewal, two_year }],
    warnings: [string] }
  ```
  `winner` is set only when `availability` is `available`. Quote cents and display fields may be `null`.
- **`exclusion_reason`:** `NO_CUSTOM_NAMESERVERS`, `NO_AVAILABILITY_ACCESS` (management-only adapter, e.g. GoDaddy), `REGISTRAR_NOT_ALLOWED`, `ADAPTER_ERROR` (with `error_code`, a registrar adapter code: see the code index), `NOT_AVAILABLE`, `PREMIUM`, `NOT_USD`, `MULTI_YEAR_MINIMUM`, `NO_FIRST_YEAR_PRICE`, `NO_RENEWAL_PRICE`.
- **Errors:** 400 `VALIDATION_ERROR` (no `domain`) · 422 `DOMAIN_INVALID` · 422 `TLD_NOT_SUPPORTED`.

### `POST /buy`
Registers a domain at the cheapest qualifying registrar, **only with Dvir's approval**. WRITE. Gavriel tests with `dry_run: true`.
- **Body:**

  | Field | Type | Rule |
  |---|---|---|
  | `domain` | string | required; normalised like `/check` |
  | `max_price` | USD number | required; cap on the **first-year** charge |
  | `max_two_year_price` | USD number \| null | optional cap on first year + one renewal |
  | `approval_ref` | `{text, approved_at}` \| null | **required**: missing or invalid → 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` (checked first; must name the domain) |
  | `category` | string | **required**: `geo`, `trend`, `b2b`, `collision`, `regulation`, `buzzword`, `other` |
  | `price_grade` | `"strong"` \| `"weaker"` \| null | required for `geo`; refused for other categories |
  | `proposed_listing` | object \| null | the buy card's sell plan: `{mode: string, bin?: number\|null, floor?, walkaway?, min_offer?: number\|null, lto_max_months?: int\|null, pricing_exception?: bool\|null, pricing_exception_reason?: string\|null}` (strict; whole USD). The server recomputes the plan and refuses a mismatch **before** any registrar call |
  | `pricing_evidence` | object | **required in v1.0.0**: `{comps: [2–3 × {domain, price_usd > 0, sold_on: YYYY-MM-DD not in the future, venue, source_url: https://…}], rationale?: string}` (the counts come from the current `pricing_settings`) |
  | `expected_settings_version` | int \| null | the `settings_version` the card's `/pricing/preview` used; must equal the current version |
  | `override`, `override_reason` | bool?, string \| null | only when `proposed_listing` needs a guard override (uses this call's `approval_ref`) |
  | `deal_id` | string \| null | `D-` + 3 or more digits; creates/updates the deal |
  | `registrar` | string \| null | pin one registrar; no fallback |
  | `dry_run` | bool \| `"strict"`? | default `false`. `true`: a dry run. `"strict"` (2.1.0): a dry run that returns the first real-buy gate refusal as the error (below). Any other value → 422 `VALIDATION_ERROR` |
  | `auto_list` | bool? | default `true`: after the buy, point NS at the lander and store the listing |
  | `stre` | number 0..1 | **required (4.0.0, CR-046 item 3)**: the scout's expected sell-through over the renewal period; missing → 400 `VALIDATION_ERROR` |
  | `stre_reason` | string 3..500 | **required (4.0.0)**: why |
  | `horizon` | `"evergreen"` \| `"trend"` \| `"regulation"`? | (4.0.0, CR-045 item 2, CR-048) default `evergreen`. A trend or regulation name should be bought with `drop_policy: at_first_expiry`; otherwise the dry run and the 201 carry the warning `HORIZON_DROP_POLICY_MISMATCH`. Its `sell_or_drop_by` is set to the buy date + `renewal.horizon_months` (12) |

- **Checks, in order (any failure stops the call; no registrar call before check 6):** approval (`APPROVAL_INVALID` / `APPROVAL_EXPIRED`) → `proposed_listing.mode` (`MODE_INVALID`) → category (`CATEGORY_REQUIRED`) → grade (`GEO_GRADE_REQUIRED` / `GRADE_NOT_GEO`) → the listing rules for `proposed_listing` (the `/list` listing codes, plus `PRICING_FORMULA_MISMATCH`; a geo BIN must equal the grade price; under `pricing_settings` v3 also `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED`) → comps (`COMPS_REQUIRED` / `COMPS_INVALID`) → settings version (409 `SETTINGS_VERSION_CHANGED`) → **buy hold** (409 `BUY_HOLD`, real buys only, see below) → **screening pack** (409 `SCREENING_PACK_REQUIRED`, real buys only, v2.0.0) → **open tranche** (409 `NO_TRANCHE`, real buys only, v2.0.0) → not owned (409 `ALREADY_OWNED_OR_PENDING` / `ALREADY_IN_PORTFOLIO`) → domain cap (409 `DOMAIN_CAP_REACHED`) → live re-check, no cache (409 `NOT_AVAILABLE` / `NO_ELIGIBLE_REGISTRAR` / `PINNED_REGISTRAR_INELIGIBLE`) → price caps, then the cheapest two-year (409 `PRICE_ABOVE_MAX`, `details.cheapest`) → registrar account (409 `REGISTRAR_STATE_UNKNOWN` / `REGISTRAR_AUTO_TOPUP_ON` / `REGISTRAR_FUNDS`; since 2.16.0 a real buy is also refused with `REGISTRAR_STATE_UNKNOWN` (`details.registrar_code: AUTO_TOPUP_UNKNOWN`) when the registrar doesn't say whether auto top-up is on, founder rule 6; a dry run warns `AUTO_TOPUP_UNKNOWN` instead) → the registrar's own dry run with the exact cost (409 `REGISTRAR_DRY_RUN_FAILED` with `details.registrar_code`; a price change re-quotes once and re-checks the caps; an ambiguous answer → 409 `REGISTRAR_DRY_RUN_AMBIGUOUS`).
- **Display name and drop policy (3.7.0, CR-033 G-2, G-9):**
  - **`display_name` (optional):** must equal the domain case-insensitively, else 422 `DISPLAY_NAME_MISMATCH`. Without it, the default comes from the newest intake `words`, each capitalised, else the domain. It is stored like `POST /list`'s display name and used by the next export.
  - **`drop_policy` (optional):** `after_one_renewal` (the default) or `at_first_expiry` (the `drop_date` is the first expiry; nothing renews).
  - **In the dry run and the 201:** `display_name`, `drop_policy`, `renewal_committed_cents` (0 for `at_first_expiry`) and `drop_policy_line`. `sell_plan_line` adds the policy only for `at_first_expiry`. **On a dry-run error** (for example `REGISTRAR_FUNDS`), `details` carry `display_name`, `drop_policy`, `renewal_committed_cents` and `drop_policy_line` too (3.7.1, CR-038). Since 3.9.0 the drop date is set in the same database transaction as the booking, so `DROP_POLICY_FAILED` can no longer occur (the code is removed); the reconciler honours the policy of the stored request when it books a purchase.
- **Renewal maths gate (4.0.0, CR-046 item 3).** `ratio = BIN x (1 - commission) x STRe / renewal cost`, in integer cents and basis points. BIN is the proposed plan's, else the grade price (geo) or the current default BIN; the commission comes from the settings (`buy.commission[buy.math_venue]`, Afternic 20%). A ratio under `buy.renewal_math_min` (1.0) is **422 `RENEWAL_MATH_FAIL`** with `details.renewal_math {venue, bin_cents, commission_bp, stre_bp, renewal_cents, expected_net_cents, ratio, min, pass}`, in a dry run too. A passing ratio is in the dry-run body and the 201 as `renewal_math` and stored on the name with STRe and its reason (`domains.buy_card`).
- **Horizon, group and cap (4.0.0, CR-045 items 2 and 3).** The dry run and the 201 carry `horizon` and `screening_group`: `borderline` when the name's latest screening run holds a `FLAG` result, else `passed` (the groups of the 40-name test). The domain cap is **40** (migration; was 50), of which **10 are reserved for S8** (5.8.0, CR-059; Line 1 holds at most 30): a real `/buy` at the cap is 409 `DOMAIN_CAP_REACHED`; a dry run reports it as `would_be_blocked: "DOMAIN_CAP_REACHED"` and `dry_run: "strict"` returns it as the error.
- **Lease-to-own by name type (4.0.0, CR-048).** `proposed_listing.lto_max_months` is refused with 422 `LTO_NOT_ALLOWED` (no override helps) when `horizon` is `trend` or `regulation`, or the drop policy is `at_first_expiry`; the lease would run past the drop date. On an evergreen name the existing LTO rules apply.
- **Comps (CR-033 G-10):** the number required is `pricing_settings` `comps_min`, which is **0 under v3** (current). An empty `comps` list is valid.
- **Small-buy exception (3.6.0, CR-030; approved by Dvir).** Optional body field `small_buy_exception: true`. When `approval_ref.text` also names the domain **and** contains "small buy" (any case), `BUY_HOLD` is skipped for that call, and only then. Two more checks apply when the flag and the words are present:
  - **Price:** the quote must not be premium, and its first year must be at most **$11.08**. Else 409 `SMALL_BUY_PRICE` `{max_first_year_cents, cost_cents, premium}`.

  The limit is fixed in code; changing it needs a release (5.0.0, G-86: the former $50 weekly small-buy cap is gone; the service holds no money total, Gavriel owns the budget). Every other gate is unchanged: screening pack, tranche, domain cap, approval rules, registrar checks. The hold itself (`GET /selection/buy-hold`) is never changed. The purchase row (`small_buy_exception`) and the audit summary (`small buy`) mark the buy. A dry run with the flag reports `SMALL_BUY_PRICE` as `would_be_blocked`.
- **Buy hold (v1.1.0, additive).** A domain that has a screening result is held (a run that lists the domain but has written no result for it yet counts too) when the settings version of the **latest** screening run that screened it has `buy_hold` on, is a backtest, or is no longer the active version (the same rule as `would_buy`). A real `/buy` of a held name → 409 `BUY_HOLD` (`details.settings_version`, `details.run_id`), before any registrar call. A domain that was **never screened** is not held: `/buy` behaves as in v1.0.x. A dry run is never refused; it adds `would_be_blocked: "BUY_HOLD"` to its 200. Since v2.0.0 a real `/buy` also needs a complete screening pack and an open tranche (next two bullets).
- **`dry_run: true`** stops after the checks. **200:**
  ```
  { dry_run: true, domain, check_id, registrar, first_year/renewal/two_year (money pairs),
    domains_owned: int (owned + listed + delisted + pending purchases),
    registrar_dry_run: { would_succeed: true, cost, cost_cents },
    proposed_listing: null | <plan view, with the schedule anchored today and drop date +24 months>,
    settings_version: int, would_be_blocked: null | "BUY_HOLD" | "SCREENING_PACK_REQUIRED" | "NO_TRANCHE" | "SMALL_BUY_PRICE" | "DOMAIN_CAP_REACHED" (4.0.0),
    screening_pack: { status: "none" | "complete" | "incomplete", pack_id: string | null, version: int | null, issued_at: string | null },
    advisories: [string], warnings: [string] }
  ```
  Writes only the audit row and the quotes. The same key can't be reused for a real buy (different body → 409).
  **`dry_run: "strict"` (2.1.0, additive).** The same call as `dry_run: true` (same checks, same 200 body when nothing blocks, same side effects: only the audit row and the quotes), except that the first real-buy gate refusal is returned **as the error**, in the contract order: 409 `BUY_HOLD`, then `SCREENING_PACK_REQUIRED` (with `details.reason` and `details.pack_id`), then `NO_TRANCHE`. These errors carry exactly the details a real buy gives (no `would_be_blocked` field). It never registers or charges. Use it to see each gate's real error without a purchase; use `dry_run: true` to see which gate would block.
  **Dry-run errors after the DOM gates (2.0.2, additive).** In a dry run, any error thrown after the DOM gates were evaluated (from the not-owned check on: `ALREADY_OWNED_OR_PENDING`, `DOMAIN_CAP_REACHED`, `NOT_AVAILABLE`, `NO_ELIGIBLE_REGISTRAR`, `PINNED_REGISTRAR_INELIGIBLE`, `PRICE_ABOVE_MAX`, `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_FUNDS`, `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_DRY_RUN_AMBIGUOUS`, and so on) adds `would_be_blocked`, `screening_pack` and `advisories` to its `error.details`, with the same shapes as the 200 body. Errors before the gates (approval, validation, comps, settings version) and all real buys are unchanged. Example: with the Porkbun balance at $0, a dry run answers 409 `REGISTRAR_FUNDS` with `details.would_be_blocked: "BUY_HOLD"` (or the first blocking gate).
  **`would_be_blocked` (2.0.0, breaking type change: was the literal `"BUY_HOLD"`).** The first gate a real `/buy` would refuse on now, in this order, or `null`: `BUY_HOLD` → `SCREENING_PACK_REQUIRED` → `NO_TRANCHE`. `screening_pack` is the **latest** pack of the domain (`none` when it has none). `advisories` is unchanged (`"SCREENING_PACK_REQUIRED"` unless that pack is `complete`, `"PACK_NOT_FROM_LATEST_RUN"` when its run is not the domain's latest); it duplicates the gate and is kept for callers of 1.2.0.
- **Screening pack gate (2.0.0, breaking).** A real `/buy` (not a dry run) needs the domain's **latest** pack to be `complete`, from the domain's **latest** screening run, issued while its settings version was active and still **the active version**, and issued at most `pack.max_age_at_buy_hours` (default 72) before the call. Otherwise 409 `SCREENING_PACK_REQUIRED` with `details.reason` (`NO_PACK`, `INCOMPLETE`, `NOT_FROM_LATEST_RUN`, `SETTINGS_NOT_ACTIVE`, `PACK_TOO_OLD`) and `details.pack_id` (null for `NO_PACK`). Checked after `BUY_HOLD` and before any registrar call or money write. Manual imports (`import-domain`) are not affected.
- **Tranche gate (2.0.0, breaking).** A real `/buy` needs the domain to be an active member of the **open** tranche, else 409 `NO_TRANCHE`. The check is repeated under the global buy lock. The purchase row records the tranche id. (5.0.0, G-86: the tranche `spend_cap` and its `TRANCHE_SPEND_CAP` code are removed; the service holds no money total.)
- **201 (bought):**
  ```
  { domain, registrar, order_id, charged (pair), renewal (pair), two_year (pair),
    expiry_date: YYYY-MM-DD, drop_date: YYYY-MM-DD (expiry + 1 year), renewals_used: 0,
    domains_owned: int (owned + listed + delisted only),
    post_buy: { privacy: "on"|"off"|"unknown", auto_renew: "off"|"unconfirmed",
                lander: "<target> ns set"|"pending"|"mismatch"|"failed"|"skipped", listing: null | <plan view> },
    warnings: [string], audit_id }
  ```
  A post-buy failure never undoes the purchase; it is a warning (`PRIVACY_OFF`, `PRIVACY_UNKNOWN`, `AUTO_RENEW_FAILED`, `AUTO_RENEW_NOT_CONFIRMED`, `API_ACCESS_DISABLED`, `LANDER_CUSTOM`, `LANDER_MISMATCH`, `LANDER_FAILED`, `NS_PENDING`, `EVIDENCE_SAVE_FAILED`, `LISTING_SAVE_FAILED`, `POST_BUY_FAILED`, `TOTALS_UNAVAILABLE`, `EXPIRY_ESTIMATED`, `FOUND_IN_ACCOUNT`, `CHARGE_ABOVE_MAX`, `RECONSTRUCTED`). Warnings are strings that start with the code (`"CODE: text"`).
- **202 (state unknown):** `{status: "unknown", code: "PURCHASE_STATE_UNKNOWN", domain, purchase_id, audit_id, message}`. The registrar may have registered it; the reconciler (a step of the daily job since 2.1.0) books or fails it. Retry only with the **same** key (re-evaluated, never re-registered).
- **409 after contacting the registrar:** `REGISTRAR_REJECTED` (`details.registrar`, `details.registrar_code`; nothing charged), `PURCHASE_ABANDONED`, and on a replay `PURCHASE_FAILED` (3.9.0: set only by the administrator's `resolve-purchase` command after checking the registrar account; the reconciler never fails a `register_sent` or `unknown` purchase, it leaves it open and `/report` shows `PURCHASE_UNRESOLVED` after 30 minutes).
- **Other errors:** 422 `VALIDATION_ERROR` (schema, or an amount that isn't a positive USD amount with ≤ 2 decimals) · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED` · 409 `IDEMPOTENCY_KEY_MISMATCH` (the key was used for another domain) · 500 `PRICING_SETTINGS_MISSING`.

---

## Listing

**Pricing version (v2 or v3).** When the current `pricing_settings` version has a price list (**v3**, created only by the admin command), a **new** non-geo plan needs a BIN on the list and at or above the non-geo minimum (the x95 and minimum-BIN rules of v2 do not apply). Floor = 65% of the BIN to the whole dollar (never below $750); walk-away as in v2 (nearest $5, never below $500). Drops are one rung down the list (non-geo at M6 and M18, geo at M12 down to $299), with floor and walk-away recomputed from the new BIN (an exception does not carry through a drop); the final push is the lowest list price at or above the floor (none for geo) and changes **only the BIN**: the floor and walk-away stay as the last drop (or the plan) set them, so a walk-away above the formula's value for the pushed BIN is expected (CR-006 Q-1; e.g. M6 1088 / 750 / 520, then final push 788 / 750 / 520). **An override never waives the price list** (an override relaxes mode guards only): under v3 every non-carried BIN in any mode, geo included, must be on the list. A plan keeps the settings version it was made under: its stored schedule and its manual changes follow that version, so v2 plans are unchanged unless replanned (a replan uses the current version). `settings_version` in every response says which applies.

### `GET /pricing/preview`
The sell plan the server would store: floor, private walk-away, min offer, drop schedule. No side effects (no audit row).
- **Query (strict):** `category` (required: `geo`/`trend`/`b2b`/`collision`/`regulation`/`buzzword`/`other`), `bin` (USD string, ≤ 2 decimals; required unless geo), `grade` (`strong`/`weaker`; geo), `floor` + `walkaway` (USD strings; preview an approved exception), `listed_on` (YYYY-MM-DD, default today), `drop_date` (YYYY-MM-DD, default listed date + 24 months), `domain` (optional; then `drop_date` comes from the DB and `display_name` is used in `afternic_row`).
- **200:**
  ```
  { settings_version, category, mode, pricing_source: "formula"|"approved_exception", grade,
    bin_cents, floor_cents, walkaway_cents, min_offer_cents,
    display: { bin, floor, walkaway: "$960 (private)", min_offer },
    net_at_15pct: { bin, floor, walkaway },
    schedule: [{ event, due_on, bin?, floor?, walkaway?, status }],
    afternic_row: "Name.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N" | null,
    sell_plan_line: string, warnings: [string] }
  ```
- **Errors:** 400 `VALIDATION_ERROR` (unknown parameter, bad date or amount, `drop_date` not after `listed_on`, `drop_date` together with `domain`) · 422 `CATEGORY_REQUIRED` · 422 plan rule codes: `GEO_GRADE_REQUIRED`, `GEO_BIN_NOT_GRADE_PRICE`, `BIN_MODE_NO_NEGOTIATION`, `HYBRID_FIELDS_REQUIRED`, `BIN_NOT_NICE`, `BIN_BELOW_FLOOR_MIN` (v2 plans), `BIN_NOT_IN_PRICE_LIST`, `LANDER_EXCEPTION_REQUIRED` (v3 plans), `HYBRID_PRICES_INVALID`, `FLOOR_BELOW_MIN`, `WALKAWAY_BELOW_MIN`, `PRICING_FORMULA_MISMATCH`, `VALIDATION_ERROR` · 404 `DOMAIN_NOT_FOUND` · 500 `PRICING_SETTINGS_MISSING`.
- **Warnings:** `FLOOR_AUTO_ACCEPT`, `FLOOR_RAISED_TO_MIN`, `PRICING_EXCEPTION`, `BIN_OVER_FAST_TRANSFER_MAX`, `CATEGORY_OTHER`.

### `POST /listings/{domain}/venue`
WRITE (3.7.0, CR-031 C). Records a listing made by hand on a venue, append-only. Body (strict) `{venue: afternic|sedo, listed_at (ISO, not in the future), shown?: {mode, price_usd: number|null, min_offer_usd: number|null}, evidence?: {source, ref}, note?, delisted?: bool, provenance?: "ours_confirmed"|"unknown"}` (5.27.0: `provenance` defaults to `ours_confirmed`; `observed_public` is 422, it has its own route). A **bots** token is refused: 403 `SCOPE_FORBIDDEN` (a hand listing is a money-route record; WRITE only). `shown` is required unless `delisted: true`. Any other field, a walk-away included, gives 422 `VALIDATION_ERROR`. **201** with the record.
- **Shown in `GET /portfolio/{domain}`** as `export.<venue>.listed_by_hand_at`, `shown` and `delisted_by_hand_at`.
- **`pending`:** false while the latest record isn't a delisting and its shown price and min offer are null or equal the current plan's BIN and min offer. A scheduled price change makes a priced listing pending again.
- **`/sold`:** its checklist names the venues listed by hand to pull the listing from.
- **Provenance (5.27.0, CR-076):** every record carries `provenance` (`ours_confirmed` | `observed_public` | `unknown`), shown in the 201. Records made before 5.27.0 are `unknown`, except the migration seed (Afternic $1,488 `ours_confirmed` for promptinjectionaudit.com, ukcbamcompliance.com, aievalsconsulting.com, roofingvoiceagent.com; mineunited.com Afternic `observed_public`). `listed_venues` counts only the latest `ours_confirmed` record per venue (not a removal); a sighting (below) is never a hand listing for `export.<venue>`, `pending` or the `/sold` checklist.

### `POST /listings/{domain}/observed`
WRITE or bots (5.27.0, CR-076 R-2; `Idempotency-Key`; audited; a record route, not a money route). Logs a listing **seen on a public page**, stored as `observed_public`. Body (strict) `{venue: afternic|sedo, price_usd: "1488" (a USD string, up to 2 decimals), url (http/https), seen_at (ISO with an offset, not in the future), dry_run?: bool}`. Any other key, **`provenance` included**, gives 422 `VALIDATION_ERROR` and nothing is stored. `dry_run: true` answers **200** and stores nothing; otherwise **201** `{id, domain, venue, provenance: "observed_public", seen_price_cents, seen_price, seen_url, seen_at, audit_id}`.
- **Changes nothing else:** not the listing, the price, an export, the plan, `listing_history`, `export_pending_since` or `listed_venues`. It adds the venue to `observed_venues` (`GET /portfolio`, `GET /books.csv`).
- **Errors:** 404 `DOMAIN_NOT_FOUND` · 422 `VALIDATION_ERROR` (bad price, URL or `seen_at`, unknown key).

### `POST /portfolio/{domain}/display-name`
WRITE or bots (5.27.0, CR-076 R-5; `Idempotency-Key`; audited). Body (strict) `{display_name}`: the domain with different ASCII capitalisation only (same letters, digits, hyphens and dots), else **422 `DISPLAY_NAME_MISMATCH`**. **200** `{domain, display_name, changed, export_pending, audit_id}`. The name is in the export rows, so it takes effect in the **next export**: for a `listed` name that changes, `export_pending_since` is set like a plan change (`export_pending: true`); the same name again changes nothing (`changed: false`). Errors: 404 `DOMAIN_NOT_FOUND` · 422 `DISPLAY_NAME_MISMATCH`, `VALIDATION_ERROR`.

### `POST /list/{domain}`
Points the domain at the for-sale lander and/or sets its listing mode and prices. WRITE. The domain must be `owned` or `listed`.
- **Body (all optional):**

  | Field | Type | Meaning |
  |---|---|---|
  | `mode` | `bin` \| `hybrid` \| `offer` \| null | required when any price is sent; `offer` and a non-geo plain `bin` need an override |
  | `bin`, `floor`, `walkaway`, `min_offer` | number \| null | whole USD. Hybrid: send `bin`; floor and walk-away are **computed**; `min_offer` is fixed by settings ($100) |
  | `pricing_exception`, `pricing_exception_reason` | bool \| null, string \| null | an approved floor/walk-away off the formula; needs a reason and `approval_ref` |
  | `lto_max_months` | number \| null | lease-to-own, 2–60; override only, hybrid only, BIN $495–$5M, ends before `drop_date` |
  | `category`, `price_grade` | string \| null, `strong`\|`weaker` \| null | change them; relabelling a non-geo name to `geo` is an override |
  | `replan` | bool? | recompute from the stored BIN with the **current** `pricing_settings` |
  | `pricing_hold`, `pricing_hold_reason` | bool \| null, string \| null | pause/resume the drop schedule; `true` needs a reason |
  | `override`, `override_reason` | bool?, string \| null | pass a category guard (with `approval_ref`) |
  | `lander` | string? | `afternic` (default from settings) \| `sedo` \| `custom` (`dan` → `LANDER_RETIRED`) \| `none` (2.1.0): store or change the listing and plan with **no nameserver action** (no registrar call, no DNS lookup); `ns` is refused. The name is `lander_pending` until a later call picks a lander |
  | `ns` | string[] \| null | only with `custom`: 2–4 hostnames |
  | `display_name` | string \| null | same name, other ASCII capitalisation |
  | `dry_run` | bool? | validate and preview only |
  | `approval_ref` | `{text, approved_at}` \| null | required only for an exception, an override, or an off-grade geo BIN (422 `APPROVAL_REQUIRED`) |

  No price field means "nameservers/lander only". No `approval_ref` is needed for a change within the rules. A geo BIN that is within range but is neither the grade price nor the scheduled strong → weaker step is a sell decision: without a valid `approval_ref` → 422 `APPROVAL_REQUIRED`.
- **Behaviour:** validates (order: `MODE_INVALID`, field checks, the listing rules, then `approval_ref` if sent), sets the nameservers through the registrar (compared as a set), checks public DNS, saves the plan, appends `listing_history`, creates or regenerates the `price_schedule` rows (the first listing anchors the drop clock) and flags the export as pending. Runs under the per-domain lock shared with `/buy`.
- **200:**
  ```
  { domain, status, category, listing: null | <plan view>, pricing_hold: bool, lander, ns: [string],
    lander_pending: bool, ns_status: "set"|"mismatch"|"unverified"|"manual"|"pending"|"skipped", manual_steps?: [string],
    ns_public: "match"|"pending"|"unknown", checklist: [string], warnings: [string] }
  ```
  **`lander: "none"` (2.1.0, additive):** the response has `lander_pending: true` (while the name has no lander), `ns_status: "skipped"`, `ns_public: "unknown"`, and `lander` / `ns` show what is stored (`null` / `[]` when no lander was ever set). `/report` carries the info-level warning `LANDER_PENDING` instead of any nameserver warning. A later call with `lander: "afternic"` (or `sedo` / `custom`, or no `lander` for the default) switches the nameservers as usual and clears `lander_pending`. Every other response has `lander_pending: false`. The price fields, the plan, the schedule and `listing_history` work exactly as without `none`. A dry run with `none` adds `lander_pending`.
  `manual` = the registrar has no NS API for this domain (do it by hand; `manual_steps`). `pending` = the registrar accepted but is still applying (warning `NS_PENDING`). The daily DNS check confirms either.
- **200 dry run:** `{dry_run: true, valid: true, domain, category, listing: null | <plan view>, lander, ns, preview: {afternic: row | null, sedo: row | null}, warnings}`. Nothing is written except the audit row.
- **Plan view** (also in `/buy`): `{mode, category, price_grade, bin (pair), floor (pair), walkaway_cents, walkaway: "$… (private)", min_offer (pair), lto_max_months, pricing_source, settings_version, override: bool, schedule: [{event, due_on, bin?, floor?, walkaway?, status}] (schedule prices are whole-dollar display strings only, with no `_cents`; the walk-away there has no `(private)` suffix), sell_plan_line: string | null}`. Events: `drop1_m6`, `drop2_m18`, `geo_drop_m12`, `final_push`, `delist`. Statuses: `planned`, `applied`, `skipped_at_minimum`, `skipped_no_change`, `skipped_disabled`, `superseded`, `superseded_by_final_push`, `cancelled`, `failed`.
- **Listing rule codes (422):** `MODE_INVALID`, `CATEGORY_REQUIRED`, `GEO_GRADE_REQUIRED`, `GRADE_NOT_GEO`, `LISTING_PRICE_INVALID` (not a positive whole-dollar amount), `BIN_REQUIRED`, `BIN_MODE_NO_NEGOTIATION`, `OFFER_MODE_HAS_BIN`, `MIN_OFFER_REQUIRED`, `MIN_OFFER_TOO_LOW`, `FLOOR_BELOW_MIN_OFFER`, `WALKAWAY_NOT_ALLOWED`, `HYBRID_FIELDS_REQUIRED`, `BIN_NOT_NICE`, `BIN_BELOW_FLOOR_MIN` (v2 plans), `BIN_NOT_IN_PRICE_LIST` (v3: the BIN is not on the price list or is below the non-geo minimum; `details` `allowed_bins_cents`, `min_bin_cents`; an exception never waives it; also a manual geo change to a price not on the list), `LANDER_EXCEPTION_REQUIRED` (v3: a lander-exception BIN needs LANDER-1 evidence from the screening pack; until that pack exists it is always refused, `details.needs`), `PRICING_FORMULA_MISMATCH` (details show the computed values), `HYBRID_PRICES_INVALID`, `FLOOR_BELOW_MIN`, `WALKAWAY_BELOW_MIN`, `MIN_OFFER_FIXED`, `LTO_NOT_ALLOWED`, `LTO_INVALID`, `GEO_MODE_NOT_ALLOWED`, `GEO_BIN_NOT_GRADE_PRICE`, `GEO_BIN_OUT_OF_RANGE` (manual geo change outside $299–$499), `MODE_NOT_ALLOWED_FOR_CATEGORY`, `OVERRIDE_NEEDS_APPROVAL`, `EXCEPTION_REASON_REQUIRED`, `APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `APPROVAL_EXPIRED`, `HOLD_REASON_REQUIRED`, `REPLAN_NOTHING_LISTED`, `DROP_DATE_UNKNOWN`, `DISPLAY_NAME_MISMATCH`, `LANDER_RETIRED`, `LANDER_INVALID`, `NS_INVALID`.
- **Listing warnings:** `FLOOR_AUTO_ACCEPT`, `FLOOR_RAISED_TO_MIN`, `PRICING_EXCEPTION`, `NO_BIN_LESS_EXPOSURE`, `BIN_OVER_FAST_TRANSFER_MAX`, `HIGH_VALUE_LOW_BIN`, `CATEGORY_OTHER`, `NS_PENDING`, `NS_SET_AFTER_AMBIGUOUS`.
- **Other errors:** 404 `NOT_IN_PORTFOLIO` (not `owned`/`listed`) · 409 `API_ACCESS_DISABLED` (turn on API access for the domain at the registrar) · 409 `REGISTRAR_REJECTED` (`details.registrar_code`) · 503 `REGISTRAR_UNAVAILABLE` (nothing saved; the key is released) · 503 `DOMAIN_BUSY` (lock wait > 30 s) · 409 `LISTING_CHANGED_CONCURRENTLY` (retry with a new key) · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED`.

---

## Exports
Formats are in `formats.md`.

### `GET /export/afternic.csv`
The **full** Afternic bulk-upload file (every `listed` domain), for an **Update** upload. READ.
- **Query:** none. **Any** query parameter → **422** `VALIDATION_ERROR` (no file is generated).
- **200** `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="afternic-YYYY-MM-DD.csv"`, and headers:
  - `X-Export-Id`: `exp_…`, the id to confirm the upload with;
  - `X-Pending-Changes`: count of listed names changed since the snapshot of this venue's last confirmed upload (all listed names if none);
  - `X-Manual-Delist`: comma list of names sold, delisted or dropped since that snapshot, which must be removed by hand at the marketplace;
  - `X-Export-Warnings`: `;`-separated, e.g. `name.com:MIN_OFFER_BELOW_20` (row skipped), `DISPLAY_NAME_IGNORED:name.com`, `name.com:AFTERNIC_ROUNDS_DOWN`, `row:<i>:DOMAIN_NOT_ASCII`, `delist:<i>:DOMAIN_NOT_ASCII`.
- Writes one `export_runs` row (id, snapshot time, names). Excludes rows with min offer < 20 (`MIN_OFFER_BELOW_20`; only listed names are read, so `NOT_LISTED` never appears in `X-Export-Warnings`).

### `GET /export/sedo.csv`
The full Sedo file, built from `templates/sedo_template.json`. Same query rule and headers as Afternic (warnings may include `name.com:SEDO_ROUNDS_DOWN`).
- **501** `SEDO_TEMPLATE_MISSING` until the template exists; **501** `SEDO_TEMPLATE_INVALID` if it is malformed. The service never guesses Sedo's headers.

### `POST /export/{venue}/uploaded`
Records that a bot uploaded that file on the marketplace site. WRITE. `venue` = `afternic` | `sedo` (else 404 `NOT_FOUND`, after the auth and `Idempotency-Key` checks).
- **Body:** `export_id: string` (required), `uploaded_at?: string` (ISO with offset; default now), `note?: string | null` (≤ 500 chars, no `@`), `approval_ref?: {text, approved_at} | null` (optional; when valid its time becomes `uploaded_at`; it need not name a domain).
- **200:** `{venue, export_id, domains: int, uploaded_at: ISO, pending_after: int, still_pending: [domain]}`. Moves the venue's pending boundary to that file's snapshot time; for Afternic, clears `export_pending_since` for the file's names unchanged since the snapshot.
- **Errors:** 404 `EXPORT_NOT_FOUND` (unknown id, or another venue's) · 409 `EXPORT_ALREADY_CONFIRMED` · 422 `UPLOADED_AT_INVALID` (malformed, in the future, or before the file) · 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` (also an approval older than the file) · 422 `NO_PII` · 503 `DOMAIN_BUSY`.

---

## Offers
Every offer received is logged as a demand signal. Recording never contacts anyone and never changes a price.

### `POST /offers`
WRITE. **`dry_run: true` (3.7.0, CR-031 B):** runs every check and the classification and returns the offer view with `id: null`, `dry_run: true`, `next_step` and `warnings`, with 200. It writes no offer row, takes no hold and claims no dedupe key; only the audit row is written.
- **Body:** `domain: string`, `amount_usd: string` ("450.00": > 0, ≤ 2 decimals), `source: string` (`afternic`, `godaddy`, `sedo`, `domainagents`, `email_inbound`, `outbound_reply`, `other`), `received_at: string` (ISO with offset, ≤ 5 min in the future); optional: `buyer_type` (`end_user`, `investor`, `broker`, `unknown`; default `unknown`), `buyer_ref`, `external_ref` (dedupe key per source; may be a Message-ID), `note`, `pricing_hold: bool | null` + `pricing_hold_reason` (pause the drop schedule; reason required), `approval_ref`. No `@` in `buyer_ref` or `note`.
- **Classification** against the prices in force at `received_at`. `band`: `below_min`, `below_walkaway`, `mid_range`, `at_or_above_floor`, `at_or_above_bin`, `geo_below_bin`, `unpriced`. `routing`: `auto_decline` (outcome `declined_auto`), `dvir` (mid-range, `unpriced` for a non-email source, and every email offer ≥ walk-away), `auto_accept` (≥ floor on afternic/godaddy), `accept_preapproved` (≥ floor elsewhere).
- **201:** the offer view + `next_step: string` + `warnings: [string]` (`OFFER_ON_UNLISTED`, `OFFER_AT_OR_ABOVE_FLOOR`).
- **200 duplicate** (same `source` + `external_ref`, or without `external_ref` the same domain + amount + source + time): the existing offer view + `duplicate: true`; nothing written.
- **Offer view:** `{id, domain, amount (pair), source, received_at, buyer_type, buyer_ref, external_ref, note, band, routing, outcome, outcome_at, outcome_note, snapshot: {bin (pair), floor (pair), walkaway_cents, walkaway: "… (private)", min_offer (pair)}, listing_history_id, recorded_by}`.
- **Errors:** 404 `DOMAIN_NOT_FOUND` · 404 `NOT_IN_PORTFOLIO` (hold on a name that isn't owned/listed) · 422 `AMOUNT_INVALID`, `SOURCE_INVALID`, `BUYER_TYPE_INVALID`, `RECEIVED_AT_IN_FUTURE`, `VALIDATION_ERROR` (bad `received_at`), `NO_PII`, `HOLD_REASON_REQUIRED`, `APPROVAL_INVALID`, `APPROVAL_EXPIRED` · 409 `EXTERNAL_REF_CONFLICT` (that `external_ref` belongs to another domain's offer) · 503 `DOMAIN_BUSY`.

### `POST /offers/{id}/outcome`
WRITE. `id` = the offer id (digits; anything else → 404 `OFFER_NOT_FOUND`, but an invalid body is checked first and gives 422).
- **Body:** `outcome: string` (`declined`, `countered`, `accepted`, `expired`, `withdrawn`, `sold`), `note?: string | null` (no `@`), `approval_ref?`.
- **Rules:** `countered` / `accepted` on an offer whose routing isn't `auto_accept` / `accept_preapproved` **needs `approval_ref`** naming the domain (a sell decision). From `open` or `declined_auto` any outcome is allowed; `countered` → `countered`/`accepted`/`declined`/`expired`/`withdrawn`; `accepted` → `sold`/`withdrawn`; `declined`, `expired`, `withdrawn` and `sold` are final. `sold` needs the domain recorded as sold first (`/sold`, which can also set it via `offer_id`).
- **200:** the offer view + `outcome_approval_text`.
- **Errors:** 404 `OFFER_NOT_FOUND` · 422 `VALIDATION_ERROR` (unknown outcome) · 422 `NO_PII` · 422 `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 409 `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OFFER_SOLD_MISMATCH`, `OUTCOME_CHANGED_CONCURRENTLY`.

### `GET /offers`
READ. Logged offers, newest first, at most 500.
- **Query (strict):** `domain`, `from`, `to` (a `YYYY-MM-DD` IDT day, or an ISO time with an offset), `band`, `source` (enums as above).
- **200:** `{offers: [<offer view>], truncated: bool}`.
- **Errors:** 400 `VALIDATION_ERROR` (unknown parameter, bad date, `from` after `to`, bad domain).

### `GET /report/offers`
READ. Offer aggregates for any window.
- **Query (strict):** `from`, `to` (`YYYY-MM-DD`; default: the last 90 IDT days including today), `group_by` (`domain` default, `category`, `source`, `month`).
- **200:** `{from, to, group_by, rows: [{key, count, highest: {cents, display} | null, median_pct_of_bin: number | null, max_pct_of_bin: number | null, band_shares: {<band>: number}}]}`.
- **Errors:** 400 `VALIDATION_ERROR`.

---

## Sales

### `POST /sold/{domain}`
Records a sale. WRITE. **System-triggered:** Gavriel calls it on a marketplace sale notification; no approval needed when evidence is sent.
- **Body:**

  | Field | Type | Rule |
  |---|---|---|
  | `venue` | string | `afternic`, `sedo`, `afternic_checkout`, `escrow`, `other` |
  | `sale_price` | USD number | > 0, ≤ 10,000,000 |
  | `commission` | USD number | ≥ 0 |
  | `other_fees` | USD number? | ≥ 0 |
  | `payout_fee` | USD number? | ≥ 0; becomes a `payout_fee` ledger row |
  | `sold_at` | string | ISO with offset; not > 5 min in the future; not before the buy date |
  | `transaction_ref` | string? | required without `approval_ref`; no `@` |
  | `evidence` | `{source, ref}`? | required without `approval_ref`. `source`: `afternic_email`, `sedo_email`, `afternic_dashboard`, `sedo_dashboard`, `escrow`, `other`; `ref` 1–200 chars: a Message-ID `<id@host>` for `*_email`, otherwise no `@` |
  | `offer_id` | positive int? | an `open`/`countered`/`accepted` offer on this domain; its outcome becomes `sold` |
  | `approval_ref` | `{text, approved_at}` \| null | optional; marks the sale `confirmed`; must not predate `sold_at` |

  `commission + other_fees + payout_fee` must not exceed `sale_price`. There is **no** `payout` object (sending one → 422).
- **Behaviour (one transaction):** ledger rows `sale` (+), `commission` (−, if > 0), `fee` (−, if > 0), `payout_fee` (−, if > 0); one `sales` row (`recorded_by` = token name, `confirmed` = approval given); status → `sold`; open schedule rows cancelled. The domain must be `owned`, `listed` or `delisted`.
- **200:**
  ```
  { domain, status: "sold",
    sale: { id, confirmed: bool, recorded_by, evidence_source, evidence_ref },
    sale_price, commission, fees, sale_costs, net_proceeds, acquisition_costs, profit (all money pairs),
    checklist: [string], warnings: [string] }
  ```
  `fees` = other fees + payout fee. The checklist always starts with "Remove the listing on the *other* marketplace now". Warning `COMMISSION_UNEXPECTED` when the commission differs from the expected rate by more than $1 (Afternic 15% with Afternic NS at the sale, else 25%, min $15; Sedo 10/15/20%; Afternic checkout 5%).
- **Errors:** 422 `EVIDENCE_REQUIRED` · 422 `NO_PII` · 422 `VALIDATION_ERROR` (schema, fees above the price, `sold_at` before the buy) · 422 `SOLD_AT_IN_FUTURE` · 422 `OFFER_MISMATCH` · 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 404 `NOT_IN_PORTFOLIO` · 409 `NOT_SELLABLE_STATE` · 409 `SALE_ALREADY_RECORDED` (same `venue` + `transaction_ref`, any domain) · 503 `DOMAIN_BUSY`.

---

## Reports
`GET /report` and `GET /report/pricing-review` are in `reports.md`.

### `GET /report`
See `reports.md`.

### `GET /report/pricing-review`
See `reports.md`.

---

## Reads

### `GET /portfolio`
READ. `{domains: [<per_domain row>]}` (the row shape is in `reports.md` §per_domain). Pending purchases are never listed.
- **Query (strict):** `status` = `owned` | `listed` | `delisted` | `sold` | `dropped`. Anything else → 400 `VALIDATION_ERROR`.
- **Venue fields (5.27.0, CR-076):** each row also carries `listed_venues` (sorted array: venues whose latest `ours_confirmed` record is not a removal) and `observed_venues` (venues whose latest record is a public sighting).

### `GET /portfolio/{domain}`
READ. One domain: `registrar_state` (3.7.0, CR-033 G-6: `{auto_renew, privacy, ns, checked_at}` from the daily `registrarCheck`, read-only `domain/get` and `domain/getNs` at Porkbun; null for other registrars or before the first check), the `per_domain` row plus
`ledger` (the `/ledger` JSON rows), `purchases: [{id, state, dry_run, registrar, cost (pair), created_at}]`, `quotes` (from the latest check: `{registrar, quoted_at, available, premium, first_year (pair), renewal (pair), eligible, exclusion_reason}`), `listing_history: [{id, at, source, category, mode, bin/floor (pairs), walkaway_cents, walkaway, min_offer (pair), price_grade, pricing_source, pricing_settings_version, override, override_reason, approval_text, approval_at}]` (newest first), `schedule: [{event, due_on, status, settings_version, bin/floor (pairs), walkaway_cents, walkaway, applied_at, note}]`, `sale: null | {venue, transaction_ref, sale_price/commission/other_fees (pairs), sold_at, evidence_source, evidence_ref, confirmed, recorded_by, offer_id}`, `export: {afternic, sedo}` (each `{pending: bool, last_confirmed_upload_at, last_uploaded: null | {bin, floor, min_offer (pairs)}}`; never the walk-away), `offers` (the latest 50: `{id, amount (pair), source, received_at, buyer_type, band, routing, outcome, note}`).
- **Errors:** 404 `DOMAIN_NOT_FOUND`.

### `GET /ledger`
READ. Ledger rows in date order.
- **Query (strict):** `type` (`registration`, `renewal`, `fee`, `commission`, `sale`, `payout_fee`, `refund`, `tool`, `ai`, `adjustment`), `domain`, `from`, `to` (`YYYY-MM-DD`, inclusive), `format` (`json` default, `csv`).
- **200 JSON:** `{count, rows: [{id, date, type, domain, deal_id, amount (pair, signed: negative = money out), amount_usd: "-11.08", counterparty, receipt_ref, note}]}`. **CSV:** `formats.md` §Ledger.
- **Errors:** 400 `VALIDATION_ERROR`.

### `POST /ledger/costs`
WRITE or bots (5.25.0, CR-070 R-1). `Idempotency-Key` required; audited (the audit row has the count and the total). Appends **non-money cost rows** to the ledger. Body (strict): `{rows: [{date, type, amount_usd, note, domain?}], dry_run?}`, 1..500 rows.
- `date` `YYYY-MM-DD` (a real day); `type` is `tool`, `ai` or `adjustment` only; `amount_usd` is a signed USD string with at most 2 decimals, not zero (a cost is negative, `"-1.20"`; a reversal is positive); `note` 1..200 characters; `domain` optional (a name in the portfolio; the row is then tied to it).
- **200** with `dry_run: true`, **201** otherwise: `{dry_run, received_n, accepted_n, rejected_n, total (pair), total_usd, audit_id}`. A dry run stores nothing. Rows are written in one transaction.
- **Corrections** are reversing rows: send the opposite amount with a note. The ledger refuses UPDATE and DELETE.
- **Errors:** 422 `VALIDATION_ERROR` for any other `type` (registration, renewal, sale, commission, refund, fee, payout_fee come only from their own routes), a bad amount, date or note, an unknown field or an unknown `domain`; `details.issues` = `[{index, field, message}]`; nothing is stored when one row is wrong. 403 `SCOPE_FORBIDDEN` for a READ token.

### `PUT /portfolio/{domain}/forward-costs`
WRITE or bots (5.25.0, CR-070 R-2). `Idempotency-Key` required; audited. Body (strict): `{lines: [{month: "YYYY-MM", item, planned_usd, basis, cost_type}]}`, 0..240 lines (`[]` clears the plan). `planned_usd` is a USD string with at most 2 decimals, 0 or more; `item` 1..200, `basis` 1..300, `cost_type` 1..60 characters.
- **Replaces the planned lines of that name as a set.** The old set stays as an earlier version; nothing is deleted. **200** `{domain, version, previous_version, lines_n, lines: [{month, item, planned (pair), planned_usd, basis, cost_type}], planned_total (pair), audit_id}`.
- **Derived numbers are computed, never typed:** a field named `walkaway`, `walk_away`, `floor`, `min_offer`, `bin`, `renewal_due`, `renewal_due_date`, `renewal_cost`, `renewal`, `renewal_price`, `forward_total`, `committed_forward`, `total`, `planned_total`, `spend`, `expiry`, `expiry_date`, `drop_date`, `cost` or `price` (also with `_cents` or `_usd`), at the top level or in a line, is **422 `DERIVED_FIELD`** (`details.fields`), checked before anything else. DOM does not compare plans with a budget (G-86).
- **Errors:** 422 `DERIVED_FIELD`, 422 `VALIDATION_ERROR` (any other unknown key, a bad month or amount), 404 `DOMAIN_NOT_FOUND`, 403 `SCOPE_FORBIDDEN` (READ token).

### `GET /portfolio/{domain}/forward-costs`
READ or bots. `{domain, current: null | {version, created_at, token_name, lines}, versions: [{version, created_at, token_name, lines}]}`, newest first (every earlier plan included). 404 `DOMAIN_NOT_FOUND`.

### `GET /costs/forward`
READ or bots. Query (strict): `from`, `to` (`YYYY-MM`; default `from` = the current IDT month and `to` = 11 months later; `from` alone gives 12 months; at most 36 months, `from` not after `to`, else 400 `VALIDATION_ERROR`).
- **200:** `{from, to, months: [{month, planned: [{domain, month, item, planned (pair), planned_usd, basis, cost_type}], renewals: [{domain, due_on, renewal (pair or null), counted, reason?, renewal_price_source?}], planned_total (pair), renewals_total (pair), total (pair), incomplete}], totals: {planned_total, renewals_total, total (pairs), incomplete}, warnings: [{code: "RENEWAL_PRICE_UNKNOWN", domain, month, message}]}`.
- **Planned lines** are the current plan of every name. **Renewals** are computed from `domains.renewal_price_cents` with the rule `/report` uses for `spend.committed_forward`: a live name (not sold, dropped or pending) with `renewals_used` 0, due in the month of its `expiry_date`. A name whose `drop_date` is its `expiry_date` is not renewed: `renewal` 0, `counted: false`, `reason: "DROPS_AT_FIRST_EXPIRY"`. A name with **no renewal price** has `renewal: null` (cents and display both null), `counted: false`, `reason: "RENEWAL_PRICE_UNKNOWN"`, a warning, and its month and the totals are **`incomplete: true`**: an unknown price is never added as 0 (record it with `POST /portfolio/{domain}/renewal-price`).

### `GET /books.csv`
READ or bots; never public (it carries the **private walk-away**, which no `/export/*` file ever has). `text/csv; charset=utf-8`, one row per live name (owned, listed or delisted; sold, dropped and pending names are left out), ordered by domain. Columns and cell rules: `formats.md` §Books CSV. Every value equals the same name's `GET /portfolio` row.

### `GET /deals/{id}`
READ. `{id, domain, strategy, status_note, created_at, approvals: [{audit_id, at, method, path, approval_text, approval_at, status_code, dry_run}]}` (audit rows with an approval that cite the deal or its domain). `dry_run` (2.2.0, additive) is `true` when that call was a dry run (`dry_run: true` or `"strict"`), so one approval used for a dry run and then the real call shows as one dry run plus one real row.
- **Errors:** 404 `DEAL_NOT_FOUND`.

### `GET /audit`
READ. Newest first.
- **Query (strict):** `since` (ISO with offset), `limit` (1–500, default 100).
- **200:** `{rows: [{id, at, token_id, token_name (2.16.0; the admin name of the token, never its secret; null for job and admin rows), scope: "read"|"write"|"intake"|"data"|"visits"|"bots"|"job"|"admin"|null, method, path, idempotency_key, approval_text, approval_at, request (the redacted request as a JSON object, or null; not a string), status_code, result_summary, client_ip, bot_name (5.20.0, CR-069: the optional X-Bot-Name header of the call, else null)}]}`. Job runs appear with scope `job` (`path` `/jobs/run`, or `job tick|daily` for a CLI run). **Large lists (5.14.0):** in `request`, any array of more than 50 items (at any depth; drop-list rows, test-set or labelled names, intake lists, document sections) is stored as the string `"[N items, sha256:<hex>]"`, N the count and the hash taken over the array's JSON, so a call can still be matched to what was sent; an upload to `/engine/*` or `/data/*` keeps its `"[N rows]"` form. Approval text and time are never elided.
- **Errors:** 400 `VALIDATION_ERROR`.

---

## Portfolio outcomes (4.0.0)

Life of each bought name from idea to outcome (CR-044 item 2, CR-045, CR-046 item 4, CR-049 item 5). No registrar and no venue is contacted. No floor or walk-away is shown.

### `GET /portfolio/outcomes`
READ. `{as_of, judge_sales_after_months: 24, names: [...]}`, one row per name that is not a pending purchase: `domain, status, category, horizon, screening_group, buy_date, days_held, card {lane, tier, words, sld_len, length_band, lookalikes_registered, lookalikes_in_use, pack_id}` (from the latest screening pack and the latest lookalike re-check), `sell_or_drop_by, drop_date, expiry_date, renewals_used, cost (pair), renewal_paid (pair), sold {price (pair), sold_at, venue} | null, sale_judged` (bought at least 24 months ago), `offers_logged, stats {views, leads, inquiries, offers}, stats_by_venue {afternic?, sedo?, sellerhub?}, inquiries_6m, inquiries_12m` (inquiries plus leads up to 6 and 12 months after the buy month), `listing_changes, interest` (any offer, inquiry, lead or sale).

### `GET /portfolio/outcomes/monthly`
READ. Query (strict): `month=YYYY-MM` (default the current IDT month; anything else 422). `{month, as_of, by_feature, passed_vs_borderline, by_venue, per_name_and_venue, venue_comparison_after_12_months}`:
- **`by_feature`:** for each of `lane, word_count, length_band, tier, lookalikes_registered, category`, groups `{value, names, with_interest, without_interest, views, leads, offers, sales}`. Interest in the month = a stats row of that month with leads, inquiries or offers.
- **`passed_vs_borderline`:** `[{group: "passed"|"borderline", names, with_interest, views, leads, offers, inquiries_6m, inquiries_12m, sales, sales_judged_after_months: 24, names_old_enough_to_judge_sales}]`.
- **`by_venue`:** `[{venue, month {views, leads, offers}, all_time {...}, sales}]` for afternic, sedo and sellerhub; `per_name_and_venue` the same per name; `venue_comparison_after_12_months` is `null` until a name has been held 12 months.

### `GET /portfolio/outcomes/quarterly`
READ. `{quarters: [{quarter: "2027-Q3", renewals, renewal_cost (pair), registration_cost (pair), sales, sales_total (pair), sales_minus_renewals (pair)}]}`: the renewal cost against the sales per calendar quarter.

### `POST /portfolio/{domain}/horizon`
WRITE. Body (strict) `{horizon: "evergreen" | "trend" | "regulation", approval_ref}`. **Dvir's `approval_ref` is required** (it names the domain; a missing or bad one is 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED`) because it changes the plan of a bought name. For `trend` and `regulation` it sets `sell_or_drop_by` = buy date + `renewal.horizon_months` (12) and moves `drop_date` to the first expiry (the same regeneration of the price schedule as the admin `drop-at-first-expiry`); calling it again changes nothing more. `evergreen` clears `sell_or_drop_by` and leaves `drop_date`. **200** `{domain, horizon, sell_or_drop_by, drop_date, expiry_date, warnings, audit_id}`; `warnings` may hold `LTO_STILL_ON` (a lease is set on the name: change it with `POST /list`). Errors: 404 `DOMAIN_NOT_FOUND` (not a live name), 422 `MAX_ONE_RENEWAL_USED` (a renewed name can no longer drop at its first expiry).

### `POST /portfolio/{domain}/stats`
WRITE. Append-only. Body (strict) `{as_of: YYYY-MM-DD (not in the future), month?: YYYY-MM (default the month of as_of), venue?: "afternic" | "sedo" | "sellerhub" (default afternic), views?, leads?, inquiries?, offers?: int >= 0, source: string 1..100}`; at least one count is required. **201** `{id, domain, as_of, month, venue, views, leads, inquiries, offers, source, audit_id}`. Errors: 404 `DOMAIN_NOT_FOUND`, 422 `VALIDATION_ERROR`, 422 `NO_PII` (`source` with `@`).

### `POST /portfolio/{domain}/renewal-price`
WRITE or bots (5.20.0, BUG-047). Not a money action: it records a number, buys and changes nothing at a registrar or venue. Body (strict) `{renewal_price: string "11.08" (a leading $ is allowed, above zero, at most 2 decimals), source: string 1..200 (no @), as_of: YYYY-MM-DD (a real date, not in the future)}`. Sets the name's renewal price (the number `/report` uses for forward renewal cost and the `RENEWAL_PRICE_UNKNOWN` warning) and stores its source and date; a second call replaces them. **200** `{domain, renewal_price_cents, renewal_price, previous_renewal_price_cents, renewal_price_source, renewal_price_as_of, audit_id}`. `GET /portfolio/{domain}` shows `renewal_price_source` and `renewal_price_as_of` (null when never recorded). Errors: 404 `DOMAIN_NOT_FOUND`, 422 `VALIDATION_ERROR`, 422 `NO_PII` (`source` with `@`).

## S8 import lane (5.8.0, CR-059; pricing, overrides and expiry window changed in 5.9.0, CR-060)

Line 2 of the company: an existing .com that Dvir bought on a registrar website (a GoDaddy or Dynadot closeout, a fixed-price listing or a public auction) is recorded here. Line 1 is hand registration through `/buy`; every other name is Line 1. The line is stored on the name (`lane`: absent = Line 1, `S8` = Line 2) and shown by `/report` (`lines`, `per_domain[].line`).

### `POST /portfolio/import`
WRITE, `Idempotency-Key`, audited. `dry_run: true` validates, computes the plan and reports what would refuse the import, and writes nothing (200 instead of 201). No registrar or marketplace is contacted except the read-only lookup of an enabled registrar adapter (`godaddy`, `porkbun`); for any other registrar (e.g. `dynadot`) the import is manual and `expiry_date` is required.

Body (strict):
`{domain: ".com name", approval_ref: {text, approved_at}, lane: "S8", registrar: string (where the name sits now, e.g. "godaddy", "dynadot"), source: "closeout" | "fixed" | "auction", price_paid: USD number > 0 (2 decimals; the all-in price), buy_date: "YYYY-MM-DD", expiry_date?: "YYYY-MM-DD" (required unless the registrar adapter reads it), category: geo|trend|b2b|collision|regulation|buzzword|other, price_grade?: "strong" | "weaker" (geo only, required for geo), comps_value?: USD number > 0 (optional since 5.9.0: stored as evidence only), bin_override?: int cents > 0, floor_override?: int cents > 0 (5.9.0, see Pricing), pricing_evidence?: {comps?, rationale?} (optional, as at /buy), renewal_price?: USD number, order?: string, deal_id?: "D-NNN", dry_run?: bool}`.

- **Approval (founder rule 1):** `approval_ref` is required and validated exactly as at `/buy` (text names the domain, `approved_at` not in the future and at most 72 h old): 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED`. The server cannot prove a human said it; same accepted trust boundary.
- **Refusals (400):** `S8_SOURCE_INVALID` (source is not one of the three), `BACKORDER_SOURCE_REFUSED` (NameJet, SnapNames or DropCatch as `source` or `registrar`, in any spelling), `S8_PRICE_CAP` (`price_paid` over the per-name cap, $250 since 5.36.0, was $50; `details {price_paid_cents, s8_max_price_cents}`). Cloudflare Registrar is refused (founder rule 5). **409:** `S8_SLOTS_FULL` (the reserved S8 slots are all taken; `details {s8_names, s8_reserved_slots}`), `DOMAIN_CAP_REACHED` (40 names held), `ALREADY_IN_PORTFOLIO`, `NOT_IN_ACCOUNT`. **422:** `CATEGORY_REQUIRED`, `GEO_GRADE_REQUIRED`, `COMPS_INVALID`, `EXPIRY_UNKNOWN`, `REGISTRATION_TERM_INVALID` (expiry after `buy_date` + 2 years + 30 days since 5.9.0; Line 1 and `/buy` stay at one year + 7 days), `APPROVAL_INVALID` also when an override price is not named in `approval_ref.text` (`details.override` = `bin_override` or `floor_override`), plus `VALIDATION_ERROR` for a bad field.
- **Caps (founder rule 2):** `settings.s8_max_price_cents` (25,000 = $250 since 5.36.0) and `settings.s8_reserved_slots` (10) change only by migration, never through the API. The service holds **no money total** for S8 (G-86). Of the 40 names, 10 are reserved: a `/buy` is refused with 409 `DOMAIN_CAP_REACHED` once Line 1 holds 30 names (`details` adds `line1_domains`, `line1_max`, `s8_reserved_slots`; a `/buy` dry run reports it as `would_be_blocked: "DOMAIN_CAP_REACHED"`), and an S8 import needs fewer than 10 S8 names and fewer than 40 names in all.
- **Pricing (5.9.0, CR-060; replaces the 5.8.0 comps rung):** an S8 BIN is **not** on the Line 1 price list (Dvir's decision, CR-060; the list check and the LANDER-1 exception check do not apply to a `lane: "S8"` name anywhere: import, `POST /list`, `replan`, the daily price job). Without an override the BIN comes from the **S8 ladder** by name length (characters before `.com`; stored in `settings.s8_bin_ladder`, migration only): up to 8 characters **$4,888**, 9 to 12 **$3,488**, 13 or more **$2,488**. `comps_value` no longer picks the BIN. Floor = 65% of the BIN to the whole dollar, walk-away = max(48% of BIN, $500) and never above the floor, minimum offer $100, all from `pricing_settings` (no new version). A geo S8 name keeps the grade-price strict BIN and refuses overrides (422 `VALIDATION_ERROR`).
- **Approved overrides (5.9.0):** `bin_override` and `floor_override` (integer cents; S8 only). Each price must be named in `approval_ref.text` as a dollar amount (`$3,488`, `$3488`, `$3,488.00` or `$3488.00`, exact match; `$13,488` does not name `$3,488`), else 422 `APPROVAL_INVALID` with `details.override`. `floor_override` above the BIN is 422 `VALIDATION_ERROR`. A floor override is stored as an approved pricing exception (`pricing_source: approved_exception`, `PRICING_EXCEPTION` warning); the walk-away is then min(floor override, formula walk-away).
- **Schedule (5.9.0):** an S8 name has **no M6/M18 drops** (3-year hold). It keeps the final push at `drop_date - 90` (BIN to the lowest list price between floor and BIN, else to the floor) and the delist at `drop_date - 7`. `drop_date = expiry + 1 year`. A geo S8 name follows the geo rule (grade price, one drop at month 12).
- **Books (one transaction):** the `domains` row (`lane: "S8"`, status `listed`, `registrar_api` `none`/`manage`/`full`, `drop_date = expiry + 1 year`), one `registration` ledger row of `-price_paid` (note `import; S8 <source>`), the `pricing_evidence` row, the plan and its `listing_history`/`price_schedule` rows, the `deals` row when `deal_id` is given. Auto-renew is not confirmable here: the `warnings` say `AUTO_RENEW_UNCONFIRMED`; turn it off at the registrar.
- **201 / 200:** `{domain, lane: "S8", status, registrar_api, expiry_date, drop_date, listing (the plan view), warnings: [string], s8: {source, comps_value_cents, bin_cents, floor_cents, bin_source: "override" | "ladder" | "grade_price", floor_source: "override" | "formula" | null, s8_names, s8_reserved_slots, s8_max_price_cents}, audit_id}`; a dry run also has `dry_run: true` and `would_be_blocked: null | "S8_SLOTS_FULL" | "DOMAIN_CAP_REACHED"`.

## Outreach log (4.0.0)

The service never sends email (founder rule 10). Gavriel logs each send; the log enforces the cap (CR-045 item 5, as amended).

### `POST /outreach/emails`
WRITE. Body (strict) `{domain, recipient_domain, sent_at (ISO with an offset, not in the future), reply?: bool, outcome?: "interested" | "declined" | "offer" | "sold" | "bounced" | "other" | null}`. `recipient_domain` is the company's domain only (for example `acme.com`); anything with `@`, spaces, a path or a scheme is 422 `NO_PII`, anything else that is not a domain name 422 `VALIDATION_ERROR`. **201** `{id, domain, recipient_domain, sent_at, reply, outcome, emails_for_name, max_emails_per_name, audit_id}`. The **6th** email for one name (`outreach.max_emails_per_name` 5) is **409 `EMAIL_CAP`** `{domain, emails, max_emails_per_name}` and nothing is stored. Posting the same send again (same `domain`, `recipient_domain`, `sent_at`) is **200** and only sets its `reply` and `outcome`; it is not another email. Errors: 404 `DOMAIN_NOT_FOUND`. The "10 sends and no reply" stop rule cannot trigger under a cap of 5 and is not built.

### `GET /outreach/emails/summary`
READ. `{emails, replies, sales_after_outreach, replies_per_100_emails, sales_per_100_emails, max_emails_per_name, names: [{domain, emails, replies, sold_after_outreach, at_cap}]}`. A sale counts when it happened at or after the name's first logged email. The rates are `null` before the first email.

## Scout lessons (5.3.0)

The scouts keep what they learn from rejected near-misses here, so the same dead end is not rediscovered (CR-053). One row is one pattern (`sector` + `rule`) with the names it was seen on. It is not a funnel and keeps no conversion numbers; it changes nothing in `/buy`, selection or scoring, and the scouts decide what a lesson means. The service writes nothing into the repository: Gavriel commits what the report returns. Rows are editable (not append-only), every write is audited, and the table is not in the backup export.

### `POST /lessons`
WRITE (`Idempotency-Key` required). Body (strict): one lesson or an array of 1 to 200. A lesson is `{scout (tzofeh-geo | rules | signals | drops | other; default other), sector (S2 | S3 | S4 | S6 | S7 | cross; required), rule (1 to 20 characters, stored lowercased; required), lesson (1 to 300 characters; required), domain (a string, several names comma-separated), domains (an array, at most 50; both may be sent, the names are joined), recheck_if (1 to 200 characters; default `never`), source_file (up to 200 characters, optional)}`. Every name goes through the domain normaliser (lowercase, a second-level `.com`); one bad name rejects the whole call and nothing is stored. The names are stored as a `domains` array. A lesson with no name is stored as given and never merges.

**Merge:** a lesson with the same `sector` and `rule`, a name that overlaps a stored lesson, and that stored lesson not superseded, is not stored again. The call returns the stored id with `merged: true`, adds the names to its `domains`, sets `recheck_if` to the new value, appends the new `lesson` text to the row's `notes` (`{at, lesson}`, dated; skipped when the text equals the row's text or a note; at most 20, the oldest drops) and keeps the row's `scout`. The oldest matching row wins. The array is merged in order, in one transaction, so a duplicate inside one call merges too.

**201:** `{results: [{id (les_<hex>), merged}] (same order as the input), audit_id}`. **Errors:** 422 `VALIDATION_ERROR` (missing `sector`, `rule` or `lesson`, a value outside the lists, a text over its length, an unknown key, an empty array or more than 200; `details.issues[]`) · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED` · 400 `IDEMPOTENCY_KEY_REQUIRED` · 403 `SCOPE_FORBIDDEN` for a READ token. A rate limit of 10 writes a minute applies per token, so import many lines as arrays.

### `GET /lessons`
READ. Query (strict, every field optional): `sector`, `since` (YYYY-MM-DD, from 00:00 Israel time that day), `rule` (case-insensitive), `q` (case-insensitive substring of the lesson, its notes or its names), `limit` (default 200, max 1,000). Newest first. **200:** `{count, lessons: [Lesson]}` where a Lesson is `{id, created_at, updated_at, scout, sector, domains, rule, lesson, notes [{at, lesson}], recheck_if, source_file, superseded_by, created_by}`. 400 `VALIDATION_ERROR` for a bad query.

### `GET /lessons/check`
READ. Query `domain` (one name, normalised). **200:** `{domain, count, lessons: [Lesson]}`: every lesson naming it, superseded ones included (read `superseded_by`), newest first. 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED`.

### `PATCH /lessons/{id}`
WRITE (`Idempotency-Key` required). Body (strict, at least one key): `recheck_if` (1 to 200), `lesson` (1 to 300), `superseded_by` (the id of another lesson, or `null` to clear). Nothing else can be changed. **200:** `{lesson: Lesson, audit_id}`. **Errors:** 404 `LESSON_NOT_FOUND` · 422 `VALIDATION_ERROR` (an unknown key, an empty body, `superseded_by` naming no lesson or the lesson itself).

### `GET /lessons/report`
READ. Query (strict) `month` (YYYY-MM, required; Israel calendar month of `created_at`), `format` (`json` default, or `md`). **200 JSON:** `{month, lessons_n, sectors: [{sector, lessons_n, top_rules: [{rule, count, recurring, flag?, examples: [{id, domains, lesson}]}]}], recurring: [{sector, rule, count, flag}]}`. Per sector (only those with lessons, in the order S2, S3, S4, S6, S7, cross): the top 5 rules by count (ties by rule), two example lessons each (the oldest of the month). A rule with 3 or more lessons that month has `recurring: true` and `flag` = `recurring – is the rule or the method wrong?`, and is repeated in `recurring`. `format=md` answers `text/markdown` with the same content. 400 `VALIDATION_ERROR` for a bad `month` or `format`.

## Scoring engine (5.4.0 data, 5.5.0 model; CR-056)

The data the name-scoring engine learns from: names that sold, names that did not, and, for every one of those names, whether the same name exists on .net, .co, .org, .io and .ai (and the .com's own registry creation date, 5.5.0) and since when. 5.4.0 stores and reports the data; 5.5.0 adds the model (`POST /engine/train`, `GET /engine/train/{id}`, `POST /score`). Drift, the bars report and the ablation come in 5.6.0. The service fetches nothing from marketplaces: Gavriel uploads the rows. Nothing here changes `/buy`, selection or listing, and the retention job never touches these tables.

### `POST /engine/sales`
WRITE or data token (`Idempotency-Key` required). Body (strict) `{rows: [{domain, price_usd, sale_date, venue, source, source_url?}]}`, 1 to 20,000 rows per call (body limit 8 MB; chunks of 5,000 to 10,000 are comfortable). A rate limit of 10 writes a minute applies per token. Each row is checked on its own: a bad row is rejected with a reason and the other rows are stored.
- `domain`: a second-level `.com` name (letters, digits, hyphens; normalised to lower case). The word-shape (regime) filter is applied at training, not here.
- `price_usd`: a number greater than 0 and at most 100,000,000 (a numeric string such as `"1250.50"` is accepted; at most 2 decimals are kept). Stored as integer cents.
- `sale_date`: a real `YYYY-MM-DD` day from 2000-01-01 to today (Israel day); a future date is rejected. 5.10.0 (CR-061): a date after the holdout date (`GET /engine/holdout-date`, default 2026-10-14) is rejected with `HOLDOUT_SEALED`.
- `venue` (1 to 60 characters), `source` (1 to 200), `source_url` (optional, up to 500).
- **Duplicates:** a row for a name that already has a stored sale within 20 days of its `sale_date` (before or after, also a repeat inside the same call) is a duplicate: not stored, only counted. The first row of a call wins.

**201:** `{upload_id, received_n, accepted_n, duplicate_n, rejected_n, rejects: [{row, domain, reason}], db_bytes_before, db_bytes_after, audit_id}` (`db_bytes_*` 5.10.0: `pg_database_size` before and after the load, same on `/engine/unsold`). **Size guard (5.10.0):** when `db_bytes_before` plus the size of the rows would pass 70% of 1 GB (0.5 GB before 5.13.0), nothing is stored and the answer is 409 `DB_SIZE_HIGH` (`details.db_bytes_before`, `payload_bytes` (5.14.0: the request body size from `Content-Length` when the client sent one, else the rows as JSON), `limit_bytes`, `warn_percent`). `row` is the 0-based position in `rows`; `domain` is the name as normalised, or as sent when it could not be read (null for a row that is not an object); `rejects` holds the first 200. Reasons: `ROW_INVALID`, `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED`, `PRICE_INVALID`, `DATE_INVALID`, `DATE_IN_FUTURE`, `HOLDOUT_SEALED`, `VENUE_INVALID`, `SOURCE_INVALID`, `SOURCE_URL_INVALID`. `accepted_n + duplicate_n + rejected_n = received_n`. **Errors:** 422 `VALIDATION_ERROR` (no `rows`, empty, more than 20,000, an unknown key) · 400 `IDEMPOTENCY_KEY_REQUIRED` · 401 · 403 `SCOPE_FORBIDDEN` for a READ token · 413 when the body exceeds 8 MB. Repeating a call with the same `Idempotency-Key` returns the same answer and stores nothing again. The audit log records the call by its row count, not the rows.

### `POST /engine/unsold`
WRITE or data token. Body (strict) `{rows: [{domain, type, observation_date, caught_by_catcher?}]}`, 1 to 20,000 rows. `type` is `dropped_after_held` or `registered_unsold`; `observation_date` is the day the name was seen (same date rule as `sale_date`); `caught_by_catcher` is an optional boolean. **Duplicates:** the same name with the same `observation_date` (the first row wins, whatever its `type`). Answer and errors as above; reasons: `ROW_INVALID`, `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED`, `TYPE_INVALID`, `DATE_INVALID`, `DATE_IN_FUTURE`, `HOLDOUT_SEALED` (5.10.0: `observation_date` after the holdout date), `CAUGHT_BY_CATCHER_INVALID`.

### `GET /engine/holdout-date`
5.10.0 (CR-061). The holdout guard: sales and unsold rows dated after `engine.sales_max_date` (default `2026-10-14`, an Israel calendar day, stored in `settings.engine_sales_max_date`) are rejected per row with `HOLDOUT_SEALED`; the other rows of the call are stored, and `accepted_n + duplicate_n + rejected_n = received_n` still holds. A future date is still `DATE_IN_FUTURE`; a row with no valid date keeps its `DATE_INVALID`.
READ: `{sales_max_date}`.

### `POST /engine/holdout-date`
WRITE only ( a data token is `SCOPE_FORBIDDEN`; `Idempotency-Key` required; audited): body (strict) `{date: "YYYY-MM-DD", approval_ref: {text, approved_at}}`. The approval is Dvir's line after the Scoring Scientist logs the unseal: `text` must name the date (for example contain `2026-10-20`), `approved_at` ISO 8601 with an offset, not in the future, not older than the settings approval age (72 h). **200:** `{sales_max_date, previous, approved_at, audit_id}`. **Errors:** 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 422 `VALIDATION_ERROR` (not a real date, an unknown key) · 400 `IDEMPOTENCY_KEY_REQUIRED` · 403 `SCOPE_FORBIDDEN` for a READ or data token.

### `GET /engine/health`
READ. `{model_version, trained_at, train_rows, test, chosen_weighting, ablation, bar4_pass, drift, slices, bars, bars_passed, last_training, data: {sales_n, unsold_n, sales_newest, unsold_newest, data_age_days: {sold, unsold}, last_upload: {sales, unsold}}, endings: {names_n, pairs_n, checked_n, unknown_n, pending_n, by_tld: {net|co|org|io|ai: {checked_n, registered_n, unknown_n, pending_n}}}}`. `sales_newest` / `unsold_newest` are the newest `sale_date` / `observation_date` (null when empty); `data_age_days` counts Israel days from that date to today (null when empty). `last_upload.sales|unsold` is `{upload_id, at, by, received_n, accepted_n, duplicate_n, rejected_n}` or null. **Endings:** `names_n` = distinct names (the part before `.com`) in the two sets; `pairs_n` = `names_n` x 6 (the five other endings and, since 5.5.0, the name's own .com); `checked_n` = pairs whose newest registry answer says registered or not registered; `unknown_n` = pairs whose last ask got no answer (timeout, error, refusal); `pending_n` = pairs the next daily run would ask (never asked, unanswered for 6 hours, or an answer older than 30 days). `registered_n` counts the names registered on that ending. **Model fields (5.5.0):** `model_version` (e.g. `eng-1.0.3`, the newest finished training; null before the first), `trained_at` (ISO), `train_rows {sold, unsold}`, `test {window {label, from, to_exclusive}, n_sold, n_unsold, auc, auc95 [low, high], p_top1, p_top1_ci95, p_top5, p_top5_ci95, p_top1_at_1pct_base}`, `chosen_weighting` (`unweighted` or `half_life_12m`), and `last_training {train_id, status, at, error}` (the newest run of any status, so a failure is visible). All null before the first model. `auc95` is a seeded 1,000-resample bootstrap; `p_top1` / `p_top5` are the precision among the top 1% / 5% of the frozen test file by score (Wilson 95% ranges in `*_ci95`); `p_top1_at_1pct_base` is the precision in the top 1% of the test file re-weighted so that there is one sold name per 100 unsold. 
**Hold-time slices (5.7.0, CR-058):** `slices` (null before a model, and for a model trained before 5.7.0) = `{threshold, quick, held, unknown_n}` on the latest model's frozen test rows, sold rows only. `quick` = sold less than 91 days after the `.com`'s registry creation date (looks like a drop-catch resale), `held` = 91 days or more, `unknown_n` = sold rows whose `.com` creation date is unknown (in neither slice). Each slice is `{n, recall, net_pit_share, auc}`: `recall` = share of the slice's rows with a model score at or above `threshold` (0.5, the probability cut-off; the engine has no other), `net_pit_share` = share with `net_pit` = 1, `auc` = the slice's sold rows against **all** unsold test rows (null when the slice has under 2 rows). `recall`, `net_pit_share` and `auc` are null when `n` is 0. Reporting only; not a model feature.

**Health report (5.6.0):** `ablation {auc_without_endings, auc95, delta, p_top1_at_1pct_base, removed [features], features_kept}` (the same boosting model refitted without `net_pit`, `co_pit`, `org_pit`, `io_pit`, `ai_pit`, `n_endings_pit` on the same frozen split and weighting; `delta` = full AUC minus AUC without; null before a model, or when the model holds no ending feature); `bar4_pass` (`delta` at most 0.05, or null); `drift` (null before a model): `{"<year>": <period>, ..., "last_quarter": <period>}` with one year per year present in the sold data and the newest full calendar quarter; `<period>` = `{window {from, to_exclusive, label? (last_quarter)}, sold <block>|null, dropped <block>|null}`; `<block>` = `{n, net_pit_share, two_word_share, median_length, com_date_known_share, handreg_share (null under 30% known)}` plus, for `sold`, `median_price_cents` and `median_price_by {net_pit {yes, no}, words {two, three}, acq {handreg, other}}`. Each row's features are as of its own sale / observation date (a `.net` created later never counts). Computed at training time and stored in the model's `metrics` (`ablation`, `drift`, also in `GET /engine/train/{id}`). `bars` = six entries `{id 1..6, name, status "pass"|"fail"|"not_measured", value, detail}`: 1 (health green 3 days) and 5 (`/score` deterministic, under 5 s for 20 names) are always `not_measured` (Gavriel's checks); 2 = at least 10,000 sold and 10,000 unsold stored; 3 = test AUC at least 0.80 and `p_top1` at least 0.90 with at least 3 unsold per sale in the test file (a thinner mix fails); 4 = `bar4_pass`; 6 = test AUC at least the prototype's 0.850 (indicative: different split; the point-in-time trend reference is 0.809). `bars_passed` = the ids with status `pass`.

### `POST /engine/train`
WRITE (`Idempotency-Key` required). Body `{}` (strict). Starts a training run on the job queue (job `train`, one step `trainModel`) and answers at once.
- **202** `{train_id: "eng-1.0.<n>", status: "running", poll: "/engine/train/<train_id>", audit_id}`.
- **At most one training per 24 hours:** a run that is running or finished less than 24 hours ago → **409** `TRAIN_TOO_SOON` with `details {last_train_id, last_status, next_allowed_at}`. A failed run does not count. The weekly retrain (below) obeys the same rule.
- **What it trains on:** sold = a `.com` sale of $100 or more whose name is in the regime (letters only, 6 to 20 characters, 2 or 3 known words); unsold = a `dropped_after_held` row not marked `caught_by_catcher: true`, in the regime (`registered_unsold` rows are stored and counted but not used in 5.5.0). **Split:** the test file is the sold rows of the newest *full* calendar quarter that has sales (today's quarter never counts); train = every sold row before that quarter. Unsold rows: once the dropped rows span 90 days or more and the quarter holds some, test = those observed in the quarter and train = earlier; until then a seeded sha256 of the name puts 20% in the test file. The test file keeps at most 3 unsold per sale (all of them when fewer); training keeps at most 10 unsold per sold row. The test file is hashed (sha256 of the sorted `domain|label|as_of` lines) and the hash stored **before** any model sees a row; nothing is tuned on it.
- **Models:** a histogram gradient-boosting model (the score), a logistic regression (the `reasons`) and a 4-class gradient-boosting price-tier model on sold rows (under $1k, $1k to $5k, $5k to $25k, over $25k). Two score models are trained, unweighted and with a 12-month half-life on row age, and the 12-month one is kept only if its test AUC is at least 0.01 higher. All point-in-time features are listed in `docs/internal/engine.md`; a feature with no value on any training row, or the `.com` creation date features when that date is known for under 30% of the unsold rows (a dropped name has no registry record, so having it would reveal the label), is left out and listed in `feature_list.excluded`.
- **Weekly retrain:** the daily step `engineTrain` (`jobs.md`) starts a training when there is no model yet and data exists, or when a sales upload arrived since the active model and it is Monday (Israel) or the active model is 7 days old. So: upload sales, and the model follows by itself; call `POST /engine/train` only to retrain on demand.

### `GET /engine/train/{id}`
READ. `{train_id, status: "running" | "done" | "failed", created_at, finished_at, trained_by, error, dataset, test_sha256, chosen_weighting, feature_list {model [..], excluded [{feature, reason}]}, metrics, slices}`. `slices` (5.7.0) is the hold-time split of this run's test rows, the same block as in `GET /engine/health` (also under `metrics.slices`). `dataset` holds the row counts (eligible, train, test, the quarter, `unsold_mode` `dated` or `hash`). `metrics` holds `test` (as in `GET /engine/health`, plus `auc_logit`), `weighting {unweighted_auc, half_life_12m_auc, rule, chosen}`, `tier {n_train, n_test, accuracy, logloss}`, `quantiles {sold, dropped}` (101 test-score points per class, used for the percentiles), `importance` (share of split gain per feature), and `train` counts. A failed run's `error` starts with a code: `NOT_ENOUGH_DATA` (too few rows on one side: details in the text), `TRAIN_TIME_BUDGET` (the 25-minute limit), or the plain error text. A run that stopped without a worker for 45 minutes is marked failed. 404 `NOT_FOUND` for an unknown id. Each version keeps its metrics and test hash for good; the parameters and test rows of versions older than the newest four are dropped.

### `POST /score`
READ token (the one read-only POST: `Idempotency-Key` not needed, no audit row; see README §Idempotency). Body (strict) `{domains: ["name.com", ...], as_of?: "YYYY-MM-DD"}`: 1 to 500 second-level `.com` names (normalised to lower case; a bad one is 422 `DOMAIN_INVALID` or `TLD_NOT_SUPPORTED` for the whole call); `as_of` defaults to today (Israel) and may not be in the future (422 `VALIDATION_ERROR`). **409** `MODEL_NOT_READY` before the first finished training.
- **200** `{model_version, as_of, count, results: [<one per name, in the order sent>]}`. Each result:
  ```
  { domain, score (0..1), percentile_vs_dropped, percentile_vs_sold, in_regime, warning? (only when in_regime is false),
    price_tier {lt1k, 1k_5k, 5k_25k, gt25k}, reasons [{feature, value, effect: "+"|"-", text}],
    likely_buyers [{host, registered (YYYY-MM-DD), source: "rdap", live_business? (only when the newest sibling scan of the name has it)}],
    features {...}, features_as_of, model_version }
  ```
- `score` is the boosting model's probability on a training mix that is not the real base rate: **use it to rank and through the percentiles, not as a chance of selling**. `percentile_vs_dropped` / `percentile_vs_sold` place the score among the frozen test file's dropped and sold names (0 to 100). `price_tier` is the probability of each price band **if the name sells** (sums to 1). `reasons` are the 3 to 5 largest contributions of the logistic model (coefficient x standardised value): `+` pushes toward "sold", `-` away; `text` is plain English. `features` shows every feature value (null = unknown) and `acq` (`handreg`, `aftermarket_or_old`, `created_after` or null).
- **Point in time:** every feature uses only what was dated before `as_of` (sales and unsold rows, registry creation dates, keyword uploads). Registry answers are today's state, so an old `as_of` is approximate for a name that was registered and dropped since (the accepted RDAP-only bias).
- **Registry answers:** endings with no stored answer (or an unanswered one) are asked live from the registries (RDAP only), in parallel per registry, inside a 4-second budget, and cached in `engine_endings`. What is not answered in time is null (unknown), never guessed; ask again later. 20 names with stored answers answer in well under a second.
- **Deterministic:** the same input and the same stored data give the same output. **Information only:** no gate uses the score until Dvir activates one (phase 2, a settings draft with his own line).
- **Errors:** 409 `MODEL_NOT_READY` · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED` / `VALIDATION_ERROR` · 401. A WRITE token is accepted too.

**The endings fill** is the daily step `engineEndings` (`jobs.md`; since 5.5.0 it also asks the name's own `.com` at Verisign, for the `acq_*` / `com_age_years` features: `handreg` when the .com was created 36 months or less before `as_of`, `aftermarket_or_old` when older, `created_after` when it was created on or after `as_of`). Per name and ending it keeps: registered or not, the registry creation date, when it was asked, the HTTP status and, for an unanswered ask, the reason. The answers are kept permanently (unlike the screening RDAP cache), so a later model can use them point-in-time: "registered on .net with a creation date before the sale".

### `GET /owned/{domain}/endings` (5.7.0, CR-058)
READ. The other endings of a name we own (status `owned`, `listed` or `delisted`). `{domain, buy_date, endings: [{tld, host, registered, created, registrar, checked_at}], events: [{id, tld, kind, registered, created, registrar, at}]}`. `endings` has one entry for each of `net`, `co`, `org`, `io`, `ai` with the newest registry answer (`registered` null and the rest null when never answered; `created` = the registry creation date; `registrar` = the registrar entity's name from RDAP, null when the registry gives none; times ISO 8601 with offset). `events` are the append-only changes, oldest first: `kind` `baseline` (the first answer after the buy), `newly_registered` (not registered before and registered now, or the first answer shows a registry creation date after the buy date) or `re_registered` (the creation date changed). An ending that is dropped writes no event. 404 `DOMAIN_NOT_FOUND` when the name is not an owned domain. `/report` raises `ENDING_REGISTERED` for each non-baseline event for 30 days. Nothing is sent; the registrant is a lead for Sochen's draft and Dvir's per-email approval.

## Loaded data tables (5.12.0, CR-063)

Five tables the bots load once so Buyer, Shomer and the Scoring Scientist read one copy instead of box CSVs. They are stored and readable only: nothing here changes `/check`, `/buy`, selection, listing or `/company/forbidden-terms` (feeding the screening checks from `tm_kills` / `bigco_names` is a separate CR). **Scopes:** loads (`POST /data/...`) take a WRITE token or a `data` token; reads (`GET /data/...`) take a READ or WRITE token and a `data` token gets 403 `SCOPE_FORBIDDEN`; a READ token gets 403 on the loads.

### `POST /data/rdap`
The five loads share one shape; the other four are `POST /data/live-checks`, `/data/tm-kills`, `/data/bigco-names` and `/data/sales-comps` (their headings follow).

Body `{rows: [..], dry_run?: boolean}`, 1 to 20,000 rows, 8 MB. `Idempotency-Key` required (also with `dry_run`). Each row is checked on its own: a bad row is rejected with a reason, the rest are stored (one transaction). `dry_run: true` runs every check and counts, and stores nothing.

| Path | Row fields | Notes |
|---|---|---|
| `/data/rdap` | `host` (.com), `reg` (bool), `checked_at` (or `checked_utc`; ISO instant or day), optional `created`, `expires` (ISO instant or day), `registrar`, `kind` (ignored, always `rdap`) | **Only names in the candidate pool are stored:** a non-removed `candidate_intake` name or a kept `drop_list_rows` name. Others are counted in `skipped_not_in_pool_n` (not a reject). One row per host: a row with a newer `checked_at` updates it (counted accepted), an equal or older one is a duplicate. |
| `/data/live-checks` | `host` (.com), `source` (`live` \| `livefail` \| `cc`), `checked_at` (or `checked_utc`), optional `label`, `park`, `value_json` (any JSON, 20,000 characters at most) | Duplicate = same `(host, source, checked_at)`. |
| `/data/tm-kills` | `term`, optional `reason`, `source`, `raw` (object), `supersedes` (id of an earlier `tm_kills` row) | **Append-only** in the database (`reject_mutation`: no UPDATE, DELETE or TRUNCATE). A wrong row is fixed by a new row with `supersedes`; an unknown id is rejected `SUPERSEDES_NOT_FOUND`. Duplicate = same `(term, reason, source, supersedes)`. |
| `/data/bigco-names` | `name`, optional `reason`, `source`, `raw`, `supersedes` | As `tm-kills`. |
| `/data/sales-comps` | `domain`, `sale_date`, `price_usd`, `tier` (`T1`..`T4`), optional `year_flag`, `sale_year` (must equal the year of `sale_date`; default from it), `reg_date_at_sale`, `net_reg_at_sale`, `org_reg_at_sale`, `source_url`, `dup_sources` | The holdout guard of `/engine/sales` applies: `sale_date` after `GET /engine/holdout-date` is `HOLDOUT_SEALED`. `engine_sale_id` is set when an `engine_sales` row has the same domain, `sale_date` and price. Duplicate = same `(domain, sale_date, price)`. |

**201:** `{table, dry_run, received_n, accepted_n, duplicate_n, rejected_n, skipped_not_in_pool_n (rdap only), rejects: [{row, domain, reason}], db_bytes_before, db_bytes_after, rows: {domain_rdap, live_checks, tm_kills, bigco_names, sales_comps}, audit_id}`. `accepted_n + duplicate_n + rejected_n (+ skipped_not_in_pool_n) = received_n`. `rows` = rows per table after the load. `rejects` holds the first 200. The same numbers are in the audit row summary (`GET /audit`). **Size guard:** when `db_bytes_before` plus the size of the rows would pass 70% of 1 GB (0.5 GB before 5.13.0) the answer is 409 `DB_SIZE_HIGH` and nothing is stored (same as `/engine/sales`). Reject reasons: `ROW_INVALID`, `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED`, `REG_INVALID`, `CHECKED_AT_INVALID`, `CHECKED_AT_IN_FUTURE`, `CREATED_INVALID`, `EXPIRES_INVALID`, `REGISTRAR_INVALID`, `SOURCE_INVALID`, `LABEL_INVALID`, `PARK_INVALID`, `VALUE_JSON_INVALID`, `TERM_INVALID`, `NAME_INVALID`, `REASON_INVALID`, `RAW_INVALID`, `SUPERSEDES_INVALID`, `SUPERSEDES_NOT_FOUND`, `DATE_INVALID`, `DATE_IN_FUTURE`, `HOLDOUT_SEALED`, `PRICE_INVALID`, `TIER_INVALID`, `SALE_YEAR_INVALID`, `YEAR_FLAG_INVALID`, `REG_DATE_INVALID`, `NET_REG_INVALID`, `ORG_REG_INVALID`, `SOURCE_URL_INVALID`, `DUP_SOURCES_INVALID`. **Errors:** 422 `VALIDATION_ERROR` (no rows, more than 20,000, unknown key) · 400 `IDEMPOTENCY_KEY_REQUIRED` · 401 · 403 `SCOPE_FORBIDDEN` · 409 `DB_SIZE_HIGH` · 413. The audit log records the call by its row count.

### `POST /data/live-checks`
Load as described under `POST /data/rdap` (row fields in the table above).

### `POST /data/tm-kills`
Load as described under `POST /data/rdap` (row fields in the table above).

### `POST /data/bigco-names`
Load as described under `POST /data/rdap` (row fields in the table above).

### `POST /data/sales-comps`
Load as described under `POST /data/rdap` (row fields in the table above).

### `GET /data/rdap`
READ. Query `host` (exact; `domain` for sales-comps, `term` / `name` for the two term tables), `since` (a day or ISO instant with an offset: `checked_at` for rdap and live checks, `created_at` for the term tables, `sale_date` for sales comps), `limit` (1 to 5,000, default 1,000). Newest first. Answer `{table, count, rows}`. **`domain_rdap` rows carry `stale: true` when `checked_at` is older than 24 hours.** `/check` and `/buy` always do their own live lookups and never read `domain_rdap`; a stale or fresh row is information for the bots only. `sales_comps` rows add `price_cents` and `price`.

### `GET /data/live-checks`
Read as described under `GET /data/rdap`.

### `GET /data/tm-kills`
Read as described under `GET /data/rdap`.

### `GET /data/bigco-names`
Read as described under `GET /data/rdap`.

### `GET /data/sales-comps`
Read as described under `GET /data/rdap`.

**Retention (daily step `retention`, `jobs.md`):** `live` and `livefail` rows older than 3 days, `cc` rows older than 14 days, and `domain_rdap` rows of names that left the pool are deleted. `tm_kills`, `bigco_names` and `sales_comps` are never pruned.

## Market data (5.23.0, CR-075)

The data program's test bed: one row per **name x venue x listing episode** (`market_names`), labelled sold / unsold / unknown by fixed rules, fed by the sealed daily snapshots (`## Daily data saves`) and by sales the bots report. Built so a fair sold-versus-offered-never-sold comparison exists in the same price band and calendar window. Nothing here sends anything, calls a venue or touches money. **NameBio is never used** (its terms ban automated use): a sale whose `source` or `source_url` contains `namebio` is refused. The daily `datasave` job derives the episodes (steps `episodes`, `dqMarket`, `jobs.md`); no route writes an episode.

**What is stored (CR-075 Q1):** only episodes that can be a positive or a matched negative, and **nothing under $500**: every reported sale of $500 or more; Dynadot Buy-Now listings of $500 or more; Dynadot closed auctions and GoDaddy auction endings whose final price is $500 or more. The 40-dollar closeouts stay in the 3-day pool and are not in `market_names`. `GET /market/coverage` shows `db_rows`.

**Episodes.** `episode_id` = sha1 of `name|venue|first_seen` (for an auction, `name|venue|first_seen|auction`, so a Buy-Now listing and an auction of one name that begin the same day never collide). `first_seen` / `last_seen` are the **source's data dates** (the sealed snapshot days), never the run date. A name seen on two sealed snapshot days with no sealed day between them where it is absent is one episode, however many days apart; it is **split** only when it was absent from a sealed day and the gap between the two sightings is **more than 7 days**. `days_listed` = `last_seen - first_seen`.

**Labels (`outcome`, `outcome_rule`)** are recomputed on every run from the sealed sources and the sales (the same inputs give the same rows):
| `outcome_rule` | `outcome` | Meaning |
|---|---|---|
| `SOLD_REPORTED` | `sold` | A sale report (`POST /data/sales`, price >= $500) for the same name on a date from `first_seen` up to 90 days after `last_seen` (the same venue wins, else any venue). A sale with no episode creates a **sold-only** episode (`sale_only: true`, `first_seen = last_seen = sale_date`, `days_listed` 0). |
| `SOLD_BIDS` | `sold` | A GoDaddy auction ending, or a Dynadot closed auction, with at least 1 bid; the sale price is the final price and the sale date the UTC date of the end time. Counted separately from `SOLD_REPORTED`; a later reported sale for the same episode replaces it. |
| `UNSOLD_60D` | `unsold` | Seen on two or more sealed snapshot days spanning **60 or more days**, still on the source's latest days (last seen within 7 days of its latest sealed day), never sold. A name that has since left the source counts as `UNSOLD_60D` only once **90 days** have passed since `first_seen` with no sale report (a sale may explain the disappearance). |
| `UNSOLD_30D` | `unsold` | Provisional, an early read only: the same, spanning 30 to 59 days. |
| `SEEN_ONCE` | `unknown` | Seen on one snapshot day only. |
| `DISAPPEARED` | `unknown` | Left the source (or an ended auction with no bid) and not yet explained by 90 days. |
| `TOO_SHORT` | `unknown` | Still listed, spanning 1 to 29 days. |
`unknown` is never counted as sold or unsold. `outcome: "delisted"` is reserved and not produced.

**Sources, `tier`, `source_sha256`.** `tier` is the quality of the source: **`A`** = GoDaddy's official inventory files (auction endings), **`B`** = the bots' Dynadot API uploads (`POST /snapshots/dynadot`), and a reported sale carries the `tier` (`A`..`D`) the bot sends (required). An episode that has a reported sale takes the **best** (lowest letter) tier of its snapshot and its sale rows. `source` is `dynadot_aftermarket`, `dynadot_closed_auctions`, `godaddy_auction_end`, or the sale's own source for a sold-only episode. `source_sha256` is the manifest sha256 of the last snapshot day (Dynadot), a hash of the ending (GoDaddy) or of the sale row (sold-only). `price_band` (cents): `500-999`, `1k-2.5k` (1,000-2,499), `2.5k-5k`, `5k-10k`, `10k+`, from the sale price when sold, else the last list price. `feat_asof` is the as-of date of any feature a later program attaches to the row; the episodes job never writes or clears it (the leakage check reads it).

### `POST /data/sales`
5.23.0, CR-075 R-4. **WRITE, bots or data token** (a READ token is 403 `SCOPE_FORBIDDEN`). `Idempotency-Key` required; audited (the audit row keeps only `[n rows]`). Body limit 4 MB, 1 to 5,000 rows. Body `{rows: [..], dry_run?: boolean}`; each row is strict:
```
{ "name": "name.com", "venue": "dnjournal", "sale_price_cents": 125000, "sale_date": "2026-10-14",
  "source": "dnjournal_weekly", "source_url": "https://..." /* optional */, "tier": "A" | "B" | "C" | "D",
  "listing_type": "bin" | "offer" | "auction" | "closeout" /* optional, default bin */ }
```
`name` is lowercased (IDN as punycode); `venue` is a lowercase label (letters, digits, `_ . -`, 40 characters); `sale_price_cents` an **integer** (cents, 1 or more; a sale under $500 is stored as a report but makes no episode, counted in `below_floor_n`); `sale_date` a real date, not in the future (UTC). **One bad row rejects the whole call: 422 `VALIDATION_ERROR`, nothing stored,** `details.rejects` = `[{row, reason}]` with reasons `SOURCE_REQUIRED`, `SOURCE_NAMEBIO_FORBIDDEN` (`source` or `source_url` contains `namebio`, any case), `TIER_REQUIRED`, `TIER_INVALID`, `NAME_INVALID`, `VENUE_INVALID`, `PRICE_NOT_INTEGER_CENTS`, `DATE_INVALID`, `DATE_IN_FUTURE`, `SOURCE_URL_INVALID`, `LISTING_TYPE_INVALID`, `UNKNOWN_FIELD:<key>`.
**Add-only.** The key of a row is `(name, venue, sale_date, source)`. The same key re-posted with the **same price** is a duplicate (counted, nothing stored). The same key with a **different price** is **409 `APPEND_ONLY`** for the whole call (`details.conflicts` = `[{row, name, venue, sale_date, source, stored_price_cents, sent_price_cents}]`), nothing stored. The same sale from a **different source** is a new row: all rows are kept; the episode uses the highest tier and lists the other sources in `dup_sources`.
**201** `{dry_run, received_n, accepted_n, duplicate_n, rejected_n (0), below_floor_n, audit_id}`. `dry_run: true` runs every check and stores nothing. The sale shows in `GET /market/episodes` after the next `episodes` step (the 15:00 UTC datasave run).

### `PUT /data/sales`
Always **405 `APPEND_ONLY`** (header `Allow: POST`), for any token, with or without an `Idempotency-Key`. Sale reports have no update.

### `PUT /data/sales/{id}`
Always 405 `APPEND_ONLY`, as `PUT /data/sales`.

### `PATCH /data/sales`
Always 405 `APPEND_ONLY`, as `PUT /data/sales`.

### `PATCH /data/sales/{id}`
Always 405 `APPEND_ONLY`, as `PUT /data/sales`.

### `DELETE /data/sales`
Always 405 `APPEND_ONLY`, as `PUT /data/sales`. Sale reports have no delete; a wrong report is superseded by a correct row from a better source or tier. (The table itself refuses UPDATE, DELETE and TRUNCATE.)

### `DELETE /data/sales/{id}`
Always 405 `APPEND_ONLY`, as `DELETE /data/sales`.

### `GET /market/episodes`
READ (or bots; a data token is 403). Query (all optional; a bad value → **400** `VALIDATION_ERROR`): `outcome` (`sold` | `unsold` | `unknown`), `rule` (an `outcome_rule`), `band`, `from`, `to` (`YYYY-MM-DD`, filter on `first_seen`), `venue`, `limit` (1..1000, default 100). **200:**
```
{ summary: { total, by_outcome: {...}, by_rule: {...}, by_band: {...},
             disappeared_by_tag: { bought, deleted, unknown } },   // 5.34.0: the DISAPPEARED rows by RDAP tag; over all rows that match the filters, before the limit
  limit, returned,
  rows: [ { episode_id, name, sld, tld, venue, listing_type,
            list_price_first_cents, list_price_first, list_price_last_cents, list_price_last, price_changes,   // null when unknown (an auction has no first price)
            first_seen, last_seen, days_listed, seen_days, outcome, outcome_rule,
            sale_price_cents, sale_price, sale_date, source, source_url, source_sha256, tier, feat_asof,
            dup_group, dup_sources, price_band, letters_only, sale_only,
            disappearance_tag, disappearance_tag_reason } ] }   // newest first_seen first
```
**5.34.0 (BUG-052):** `disappearance_tag` is `bought` | `deleted` | `unknown` on a row with `outcome_rule: DISAPPEARED` (`unknown` with reason `NOT_CHECKED` until the datasave step `buildPanel` has looked it up; rules in `jobs.md` row `datasave`), and `null` on every other row. `disappearance_tag_reason`: `NOT_REGISTERED`, `STATUS:<the status>`, `RE_REGISTERED`, `REGISTRAR_CHANGED:<before> -> <now>`, `SAME_REGISTRAR`, `NO_BASELINE`, `NO_REGISTRAR`, `TLD_NOT_CHECKED`, `NOT_CHECKED`, or an RDAP error (`TIMEOUT`, `SOURCE_ERROR`, `RATE_LIMITED`). The tag never changes `outcome` or `outcome_rule`.

### `GET /auctions/live`
**5.37.0.** READ (or bots; a data token is 403). The GoDaddy public auctions that are **inside our buying range** and already have bids, from the latest daily save (datasave step `godaddyInventory`, `jobs.md` row `datasave`). **Stored rule (the `band`):** `.com`, not adult, price up to `settings.s8_max_price_cents` (the S8 per-name cap, 25000 = $250 now; the band follows the cap at each run) and at least `settings.datasave_auction_live_min_bids` (1) bids. Rows are kept 7 days. The list is a tip sheet: GoDaddy's price and bid count are as of the file (built about 14:40 UTC), not live. Query (all optional; an unknown parameter or a bad value → **400** `VALIDATION_ERROR`): `date` (`YYYY-MM-DD`, default the latest stored data date), `max_price` (USD number > 0), `min_bids` (integer >= 0), `ends_within_hours` (1..240), `type` (exact `auction_type`, any case), `sort` (`end_time` ascending, the default | `bids` descending | `price` ascending), `limit` (1..500, default 100), `offset` (>= 0, default 0), `include_ended` (`true` | `false`, default `false`: only auctions whose `end_time` is after now). **200:**
```
{ data_date,              // null when nothing is stored yet (then total 0, rows [])
  as_of,
  band: { max_price_cents, min_bids },
  total,                  // rows that match the filters, before limit and offset
  rows: [ { domain, end_time, auction_type, price_cents, price, bid_count,
            domain_age, valuation_cents, pageviews } ] }   // domain_age, valuation_cents, pageviews: null when the file had none
```

### `GET /market/matched`
READ (or bots). Query: `asof` (`YYYY-MM-DD`, required), `ratio` (1..20, default 4), `seed` (integer 0..4294967295, default 1). A bad value → **400**. Each **positive** is a sold `.com` episode with `sale_date <= asof`; it gets up to `ratio` **negatives**: `UNSOLD_60D` `.com` episodes (first seen at least 60 days before `asof`) of the **same price band**, the **same letters-only flag** (the name before `.com` is only a-z or not) and whose listing overlaps the **60-day window** centred on the sale date (sale date -30 days .. +30 days). A negative is used for one positive only. The draw is seeded (a hash of `asof|ratio|seed|episode_id` feeds a mulberry32 shuffle), so it never depends on row order. Rows with a feature as-of date after `first_seen` or after the sale date (the leakage check) are **excluded**; `unknown` episodes are never in the set.
**Frozen and sealed:** the first call for `(asof, ratio, seed)` stores the set with a `sha256` over its canonical JSON (keys sorted) and returns it; every later call with the same triple returns the stored set and the same `sha256`, even after new data arrived. The stored set cannot be changed or deleted. **As-of limit (5.25.0):** an `asof` later than the newest sealed source day (the newest `data_date` of a complete `dynadot_aftermarket`, `dynadot_closed_auctions` or `godaddy_inventory` snapshot, or today UTC when none is sealed) is **409 `MATCHED_ASOF_FUTURE`** (`details.asof`, `details.newest_sealed_day`) and nothing is stored. **A set with no positives** is returned (`frozen: false`, `frozen_at: null`, the `sha256` of that empty set) but **not stored**, so a later call, once data exists, freezes a real set. **200:**
```
{ asof, ratio, seed, rule: "m1",
  summary: { positives_n, negatives_n, unmatched_positives_n, excluded_leakage_n },
  pairs: [ { positive: <episode row>, window: {from, to}, negatives: [ <episode row> ] } ],
  sha256, frozen: true | false (false only for a set with 0 positives), frozen_at }
```

### `GET /market/dq`
READ (or bots). The latest `dqMarket` run: `{id, checked_at, status: "ok" | "alert" | "unknown", failed_checks: [string], results: [{check, status: "pass" | "fail", source?, day?, detail}]}` (`unknown`, empty results, before the first run). Checks: **`duplicates`** (two episodes of one name, venue and listing type with overlapping days), **`survivorship`** (the share of Dynadot Buy-Now episodes first seen on the source's first snapshot day; fails above 90% once the source has 30 sealed days), **`leakage`** (a row whose `feat_asof` is after `first_seen` or `sale_date`; the row is left out of `/market/matched`), **`price_sanity`** (a more than 10x jump between consecutive snapshot days of a name in the last 30 days, a reported sale under $100 that looks like dollars read as cents, a sale more than 10x or less than a tenth of the last list price), **`coverage`** (rows per source per day, for `dynadot_aftermarket` and `dynadot_closed_auctions`: a sealed day of the last 7 with fewer rows than **half the median of the 7 days before it** fails, one entry per source and `day` with `rows` and `median_7d`; needs 3 prior days), **`tier_present`** (a tier on 100% of rows). Any failed check makes `GET /health` `dq_market: "alert"` and `/report` the warning `DQ_MARKET_FAIL` naming the checks.

### `GET /market/coverage`
READ (or bots). Query `days` (1..120, default 30). **200:** `{as_of, window, per_source_daily: [{source, day, rows, sealed}], labels: {<outcome_rule>: n}, bands: {<band>: {sold, unsold_60d, unsold_30d, unknown}}, unsold_30d_n, unsold_60d_n, unsold_60d_matched_n, sold_n, targets: [{name, label, target, by, current, progress_pct, days_left, met}], db_rows: {market_names, market_sales, market_dq_runs, market_matched_sets, market_names_bytes}}`. `per_source_daily` sources: `dynadot_aftermarket`, `dynadot_closed_auctions` (rows stored per data day), `godaddy_auction_end` (auctions that ended that day), `sales_reported` (sale rows posted that day). `unsold_30d_n` = episodes unsold for 30 days or more (`UNSOLD_30D` plus `UNSOLD_60D`); `unsold_60d_matched_n` = the negatives a matched set for today (`ratio` 4, `seed` 1) would hold. Targets: **1,000** `unsold_30d` by **2026-11-25**, **2,000** `unsold_60d_matched` by **2026-12-20** (`days_left` is negative once past). Nothing is stored by this call.

**Retention:** `market_names` and `market_sales` are never pruned (small by design: only $500+ episodes; `db_rows.market_names_bytes` shows the size); the last 90 `dqMarket` runs are kept. Source rows (`dynadot_rows`, ended auctions) are pruned at 120 days as before; an episode whose oldest rows were pruned keeps its `first_seen` and first price.

## Pick-proof (5.28.0, CR-073)

Mechanics of the test "do the Buyer's picks beat random names and a simple rule?", so that the picking bot neither draws the comparison arms nor grades itself. DOM freezes the pool, draws the random arms by code, seals the day and computes the statistics. Everything it reports is **a proxy, not profit**: a closeout name registered by someone else within 30 days is demand evidence, not a sale and not money. No money action, no LLM, no email. Rules, the exact recipe and the test IDs are in `docs/internal/pickproof.md`.

**Pick day `D`.** Picks for `D` are made on `D` (UTC) before the **deadline** (16:00 UTC of `D`, `settings.pickproof_deadline_hour_utc`). The **pool** is the sealed CR-071 save of the evening before (data date `D-1`, the 15:00 UTC run): closeout rows of GoDaddy (`datasave` pool) and of a sealed Dynadot closeouts upload, `.com`, at most $40 (`settings.pickproof_pool_max_price_cents`, 4000), without sales-graded names (`engine_sales`, or a sold `market_names` episode), sorted by domain in byte order, one row per domain (lowest price wins). The pool is **frozen when first used** for `D` (a pick, a manifest call): later changes or pruning of the datasave rows change nothing. `pool_sha256` = SHA-256 of the JSON array `[[domain, source, price_cents], ...]`; the **seed** is the first 8 hex digits of it as an unsigned 32-bit number. Without a sealed GoDaddy closeouts snapshot of `D-1`: **409 `SNAPSHOT_MISSING`** (details `{date, data_date, source}`).

**Arms**, `k` names each (`settings.pickproof_k`, default 100, raise-only up to 300, migration only: the database refuses a lower value): **A** = the Buyer's picks; **B1** = `k` random names from the pool; **B2** = `k` random from the K1-passing names (the stored closeouts `filter_code` is null on a processed row; `GET /candidates/closeouts`); **C1** = `k` random from the names whose SLD is letters only, at most 10 letters and exactly two tokens that the form check does not fail; **C2** (.net-registered) is **`not_built`** (deferred; the report and manifest say so). Draws use the CR-008 seeded recipe (MT19937 init by array, Fisher-Yates) with one derived seed per arm; with fewer than `k` names in a sub-pool the arm takes them all and says `short: true`.

### `POST /pickproof/{date}/picks`
WRITE or bots (audited, `Idempotency-Key` required). Body (strict) `{names: ["x.com", ...]}`, 1 to 300 names (at most the day's `k`, else 422 `VALIDATION_ERROR`; a name twice is 422 too); names are lower-cased. Every name must be in the day's frozen pool, else **422 `NOT_IN_POOL`** with `details {date, names (up to 100), not_in_pool_n, pool_sha256}` and nothing stored. A new call **replaces** the earlier list until the day is closed. From the deadline on, and after the seal, **409 `PICKPROOF_SEALED`** (nothing changes). 409 `SNAPSHOT_MISSING` as above. **200** `{date, arm: "A", n, k, deadline, pool_sha256, sealed: false, audit_id}`. Every call is kept in an append-only history.

### `GET /pickproof/{date}/manifest`
READ or bots. The **seal**. The first call at or after the deadline draws B1, B2 and C1 from the frozen pool, stores them and seals the day (a sealed day cannot change, not even in the database); every later call returns the same answer (same seed, hashes and draws). Before the deadline the call only freezes the pool and shows A as open. A day is frozen only after the daily save of D-1 has run its filter step; before that every call that would freeze it answers 409 `POOL_NOT_READY` (5.31.0). **Since 5.35.0 the daily save seals the days nobody sealed:** its step `pickproofSeal` (before `snapshotRetention`) freezes and seals every pick day before today (UTC) that is still unsealed, exactly as this call would (same pool rule, seed and draw). A day it had to freeze itself shows `sources.frozen_by: "datasave"`. Today is never touched, so a bot's own freeze, picks and seal still come first. A day whose source rows are already gone is refused (`POOL_SOURCE_PRUNED`), never frozen empty.
```
{ date, data_date, pool_n, pool_sha256, seed, k,
  sources: { godaddy: {manifest_sha256, rows}, dynadot: {status: "sealed"|"missing", manifest_sha256, rows},
             excluded_sales_graded: [domain] },   // 5.30.0; absent on days frozen before it
  arms: { A: {n, sha256, short, sealed} | {status: "open", n, sealed: false},
          B1, B2, C1: {n, sha256, short, sealed} | {status: "pending_seal", sealed: false},
          C2: {status: "not_built"} },
  recipe: { version: "pickproof-v1" | "pickproof-v2", draw, pool_rule, labels_rule },   // the version the day was frozen with; SHA-256 of its rule texts
  deadline, sealed: bool, sealed_at }
```
An arm's `sha256` is the SHA-256 of the JSON array of its names in rank order. **`pickproof-v2`** (5.33.0, CR-073a PP-V2) applies to every day frozen from that release on and changes only `is_two_word` (so C1): two common words of 3+ letters each, from a frozen list (`docs/internal/pickproof.md`); days frozen before keep `pickproof-v1` and their flags. The bots append the seal line (this answer) to `docs/requests/pick-proof-seals.md`; DOM does not commit data. 400 `VALIDATION_ERROR` for a date that is not real; 409 `SNAPSHOT_MISSING`.

### `GET /pickproof/{date}/pool` (5.30.0, CR-073a)
READ or bots. The frozen pool of the day, so anyone can check `pool_sha256` (freezes the day on first use, like the manifest; shows no arm). **200** `{date, data_date, pool_n, pool_sha256, seed, sources, fields: ["domain","source","price_cents","passes_k1","is_two_word"], rows: [[...], ...]}`, rows sorted by domain in byte order. `pool_sha256` = SHA-256 of the compact JSON of `[[domain, source, price_cents], ...]` (the first three fields of every row). About 130,000 rows (some MB). The recipe that rebuilds the pool from the snapshot files is in `docs/internal/pickproof.md` ("Pool-hash recipe"). **410 `PICKPROOF_POOL_PRUNED`** once the rows are removed (45 days; `details.pool_sha256`); 409 `SNAPSHOT_MISSING`; 400 for a date that is not real.

### `GET /pickproof/{date}/arms`
READ or bots. Query (strict) `arm` = `A`, `B1`, `B2`, `C1` or `C2`. Only for a **sealed** day, and only after the first manifest call that sealed it; before that **409 `PICKPROOF_NOT_SEALED`** (so the Buyer cannot see the random arms before picking). **200** one arm `{date, pool_sha256, seed, arm, n, sha256, short, names: [{rank, domain, price_cents}]}`, or all arms under `arms` without `arm`; `C2` answers `{status: "not_built"}`.

### `GET /pickproof/report`
READ or bots. Query (strict) `from`, `to` (`YYYY-MM-DD`; sealed days only; `from` after `to` is 400). Labels are the T30 labels of the `pickproofLabels` datasave step (`jobs.md`): `taken` = RDAP registered and its status list has neither `redemption period` nor `pending delete` (any case or spacing, e.g. `redemptionPeriod`, `pendingDelete`), whatever the creation date (the creation date and `created_after_d` are stored for the Challenger and do not decide: a bought closeout keeps its old creation date); `not_taken` = registered in redemption period or pending delete (an unsold closeout lingers there, then disappears) or not registered (404); `unknown` (excluded from rates, counted in `unknown_n`) (excluded from rates, counted in `unknown_n`; names whose day is not 30 days old yet are `pending_n`). **200**
```
{ label: "proxy, not profit", from, to, days: {sealed_n, list},
  arms: { A|B1|B2|C1: {names_n, n (labelled), events (taken), rate, unknown_n, pending_n, label}, C2: {status: "not_built"} },
  primary:   <comparison A vs C1>,
  secondary: [<A vs B1>, <A vs B2>],
  notes }
comparison = { vs, role, label, alpha: 0.05, status: "OK" | "UNPOWERED", method: "fisher" | "permutation",
  n_a, n_b, events_a, events_b, rate_a, rate_b, events_total, overlap_n, overlap_pct,
  p_value, p_adjusted, result: "pass" | "fail" | null, fisher_p,
  permutation: {p_value, observed, shuffles: 10000, seed} | null, cmh: {strata: [{band, a, b, c, d}], chi2, z, p_value, odds_ratio, used_strata_n} | null }
```
One-sided tests that A has the higher taken rate. `method` is `fisher` (hypergeometric, exact) unless the share of A's names that also sit in the other arm (`overlap_pct`) is above 5%, then `permutation` (within-day shuffles of the pooled labelled names, 10,000 shuffles, seeded from the range's seal hashes, so the same range gives the same p). `cmh` is the Cochran-Mantel-Haenszel test over the price bands $0-9.99, $10-19.99, $20-40 (normal approximation, no continuity correction). `p_value` is the chosen method's p; for the two secondaries `p_adjusted` is the Holm adjustment over the powered ones and `result` uses it; for the primary `p_adjusted` equals `p_value`. With **fewer than 10 events in total** (or an arm without a labelled name) `status` is `UNPOWERED`: `p_value`, `p_adjusted`, `result` are null and nothing is passed or failed.

## Visitor counter (5.18.0, CR-068)

A $0 count of visitors to our listed names. The Porkbun URL forward of a name points at the counting redirect `GET /r/{domain}` on the api-proxy Worker (the stable public URL, `PUBLIC_BASE_URL`). The Worker answers `302` to `https://www.afternic.com/domain/{domain}` at once (no cookie, nothing cached), then sends one count to `POST /visits/hit` with a `visits` token. **Counts only:** per name, UTC day and source: `human_hits`, `bot_hits`, `capped` and referrer **hosts**. No IP (raw or hashed), cookie, path, query or user-agent string is sent or stored; the body of a hit has exactly three fields. If the Mac host is down, the visitor is still redirected and the count is dropped. Rows are kept 400 days (retention job). **Off until Dvir's line:** `visits.enabled` is false (`POST /visits/hit` → 409 `VISITS_DISABLED`, nothing stored). Names on Afternic's nameservers (`ns1/ns2.afternic.com`) cannot be counted (Afternic serves their page): their Afternic Views and Leads (CR-037) are loaded with `POST /visits/import` and shown by `GET /visits/weekly`.

### `POST /visits/hit`
`visits` token only (README §Who may call): a WRITE, READ or data token is 403 `SCOPE_FORBIDDEN`, and a visits token can call nothing else. `Idempotency-Key` required (the Worker sends a random UUID per hit). Body (strict) `{domain, ua_class: "human"|"bot", referrer_host?: string|null}`. `referrer_host` is reduced to a lowercase host (a URL that slips in loses scheme, user info, port, path, query and fragment; a value that is not a host, or over 253 characters, is stored as `other`). Per name per UTC day: the first 1,000 hits (human + bot) are counted; every further hit only adds to `capped` and changes no other count. Per day, the first 10 distinct referrer hosts keep their own count, the rest add to `other`. **Not audited per hit** (one `audit_log` row per redirected visitor would be the bulk of the log): the `visit_daily` row is the record; the other `/visits` writes are audited. Its token has its own limit of 600 calls per minute. **202** `{counted, capped}`. **Errors:** 409 `VISITS_DISABLED` · 422 `DOMAIN_NOT_LISTED` (not in the portfolio, status not `listed`, or on Afternic's nameservers) · 422 `VALIDATION_ERROR` (an unknown key such as `ip`) · 400 `IDEMPOTENCY_KEY_REQUIRED` · 403 `SCOPE_FORBIDDEN`. **5.19.1 (BUG-046):** counted only for a `listed` name with an active forward (`POST /visits/forward`); otherwise 422 `DOMAIN_NOT_LISTED`.

### `POST /visits/import`
WRITE or data token. Body (strict) `{domain, date: "YYYY-MM-DD", views_30d, leads_30d}` (integers ≥ 0; `date` a real day, not in the future): Afternic's 30-day Views and Leads read on `date` (CR-037). Stored as the `afternic` source row of that day; a re-import of the same `(domain, date)` replaces it. **200** `{domain, date, source: "afternic", views_30d, leads_30d, audit_id}`. **Errors:** 422 `DOMAIN_NOT_LISTED` (a name that is not in the portfolio) · 422 `VALIDATION_ERROR` · 400 `IDEMPOTENCY_KEY_REQUIRED` · 403 for a READ token.

### `POST /visits/settings`
WRITE only (audited, `Idempotency-Key` required). Body (strict) `{enabled?: boolean, token?: "request", approval_ref: {text, approved_at}}`, at least one of `enabled` and `token`. The `approval_ref` is Dvir's line: its `text` must contain `visits` (case-insensitive), and `visits token` for `token: "request"`; `approved_at` ISO 8601 with an offset, not in the future, not older than 72 h. `enabled` switches the counter (`visits.enabled`). `token: "request"` sets `visits.token_request` to `requested`: the Mac host then creates a `visits` token named `visit-counter` (revoking the older one), puts it into the GitHub secret `VISIT_COUNTER_TOKEN` and starts `deploy-api-proxy`, which sets it on the Worker; no person and no API response ever shows the token. **200** `{enabled?, previous?, token_request?: "requested", token_request_before?, approved_at, audit_id}`. **Errors:** 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 422 `VALIDATION_ERROR` · 403 for a READ, data or visits token. **5.19.0:** `approval_ref` is optional and ignored (Dvir, 19 Oct 2026: an approved CR needs no further lines); the counter is on and the token requested by the 5.19.0 migration.

### `POST /visits/forward/{domain}`
WRITE only (audited, `Idempotency-Key` required). Body (strict) `{approval_ref: {text, approved_at}, revert?: boolean, dry_run?: boolean}`. The `approval_ref` must name the domain and contain `visits`. Allowed only for a name that is `listed`, registered at Porkbun and not on Afternic's nameservers. It reads the name's URL forwards at Porkbun, deletes the root and `www` ones, and adds temporary (302) forwards, wildcard as the old root forward had it (default yes), path not appended, to `{PUBLIC_BASE_URL}/r/{domain}` (the root, and `www` when it had one). `revert: true` restores `https://www.afternic.com/domain/{domain}`. Other forwards (for example a `blog` subdomain), nameservers and DNS records are never touched. `dry_run: true` reads the current forwards and returns the plan; nothing is changed. The state is kept per name (`visit_forwards`). **200** `{domain, before: [forward], after: [forward], dry_run, audit_id}` with forward = `{subdomain ("" = root), location, type, include_path, wildcard}`. **Errors:** 404 `DOMAIN_NOT_FOUND` · 422 `FORWARD_NOT_ALLOWED` (`details.reason`: `not_listed`, `registrar`, `afternic_ns`) · 422 `PUBLIC_BASE_URL_UNSET` (the server's `PUBLIC_BASE_URL` is still the default, so the redirect address is unknown) · 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 502 `REGISTRAR_ERROR` (`details.registrar_code`) · 503 `REGISTRAR_UNAVAILABLE` (Porkbun adapter not configured) · 403 for a READ, data or visits token. **5.19.0:** `approval_ref` is optional and ignored. Afternic NS (BUG-045) is decided by the **live** nameservers (also on `dry_run`), falling back to the stored `lander_ns` when the lookup fails; `lander: "afternic"` alone (the listing venue) no longer counts as Afternic NS. `GET /visits/weekly` uses the same live check.

### `GET /visits`
READ (a data or visits token is 403). Query `from`, `to` (`YYYY-MM-DD`, UTC days; default the last 30 days; at most 400 days; an unknown parameter or `from` after `to` is 422 `VALIDATION_ERROR`). **200** `{from, to, enabled, rows: [{domain, date, source: "dom_redirect"|"afternic", human_hits, bot_hits, capped, referrer_hosts: {host: n}, views_30d, leads_30d}]}` (`views_30d`/`leads_30d` only for the `afternic` source, null otherwise).

### `GET /visits/weekly`
READ. Query `week_ending=YYYY-MM-DD`, required, must be a Saturday (else 422 `VALIDATION_ERROR`); the week runs Sunday to Saturday in UTC. **200** `{week_ending, week_start, enabled, rows, not_countable}`. `rows`: one per listed name that is counted (an active forward to the counting redirect, not on Afternic's nameservers; zeros when nothing came): `{domain, source: "dom_redirect", human_hits, bot_hits, capped, top_referrers: [{host, n}]}` (top 5). `not_countable`: the other listed names, `{domain, reason: "afternic_ns"|"not_forwarded", afternic_views_30d, afternic_leads_30d, afternic_read_date}` where the Afternic fields come from the newest imported row (any date; null when none).

## Sales patterns (4.0.0)

The service fetches no sales data (NameBio blocks bots; no source allows an automated pull). Gavriel uploads them (CR-044 item 4).

### `POST /patterns/sales`
WRITE. Body (strict) `{csv: string}` of at most 60,000 characters and 2,000 rows; the header is exactly `domain,price_usd,date,venue` (`venue` may be empty; double quotes and a `$` or thousands separators in the price are read). Any bad row, a wrong header or no rows is 422 `PATTERN_CSV_INVALID` (`details.errors[] {line, error}`) and nothing is stored. **201** `{upload_id, rows, audit_id}`. Append-only.

### `GET /patterns/latest`
READ. Query (strict) `min_usd`, `max_usd` (whole dollars; default `portfolio.patterns_min_cents` / `portfolio.patterns_max_cents`, $1,000 to $5,000), `tld` (default `com`); a reversed band is 422. Clusters the **latest** upload within the filter, split with the frozen `bt1@v3` split: `{upload_id, uploaded_at, method, filter {min_price (pair), max_price (pair), tld}, rows_in_upload, rows_after_filter, rows_split, rows_unsplit, by_word_count, by_structure, by_length_band, topic_tokens}`. Each cluster is `{value, n, median_price (pair), examples[]}`; `by_structure` writes each word as `city`, `special` (company suffix, acronym, general term) or `word`, for example `word+city`; `topic_tokens` are the 25 most common words `{token, n}`. 404 `NO_PATTERN_UPLOAD` before the first upload. The service writes nothing into the repository: Gavriel turns this answer into `docs/requests/patterns/<date>.md`.

## Selection
The selection settings, the word lists and the pure tier + money evaluation. Shapes, defaults and meanings of every setting are in `selection.md`. **Settings drafts and list edits are WRITE and take effect only as a draft or a new list version; activating a settings version and freezing a census list need Dvir's `approval_ref`** naming the label or the list. `pricing_settings` is **not** reachable here: it changes only through DOM's admin command.

### `GET /selection/settings`
READ. Query (strict): `label?`.
- **Without `label`, 200:** `{active: {label, values, activated_at, approval_text}, versions: [{label, created_at, created_by, based_on: string | null, active: bool}]}` (oldest first).
- **With `label`, 200:** `{label, values, created_at, created_by, based_on, note, active, activated_at: ISO | null, approval_text: string | null}`.
- **Errors:** 404 `SETTINGS_NOT_FOUND` · 400 `VALIDATION_ERROR` (another query key).

### `POST /selection/settings`
WRITE. Creates a **draft** version; nothing changes for runs until it is activated. A version is immutable once created.
- **Body (strict):** `label` (`^[a-z0-9][a-z0-9._-]{0,31}$`), `based_on?` (a label; default: the active one), `set` (an object of dotted paths to JSON values, at least one, e.g. `{"thresholds.registered_share_min": 0.4}`), `note?` (≤ 500 chars).
- **Paths:** a path must exist in the settings document. New keys may be added only under `thresholds`, `tier.clauses` and `run.gates`. An array element is addressed by its index (`price.forbidden_bands_cents.0`). A path may name a whole object.
- **201:** `{label, values, based_on}` (the full resulting document).
- **Errors:** 422 `SETTINGS_KEY_UNKNOWN` (`details.path`) · 422 `SETTINGS_KEY_LOCKED` (the priors `tier.p_passive`, `lead.p_lead` and `priors_v91` can't be changed by a draft, whether by a leaf path or by replacing a parent (a different value of any type or shape, e.g. `"tier.p_passive": 0.1`, is `SETTINGS_KEY_LOCKED`, not `SETTINGS_INVALID`, since 2.1.0); only a migration changes them; `holdout` is locked too; the check also compares with the active version; `details.path`) · 422 `SETTINGS_INVALID` (the resulting document breaks a rule: `details.issues[] {path, message}`; see `selection.md` §Validation) · 422 `SETTINGS_NO_CHANGE` (identical to the active version; a copy of a version that is not active is allowed, which is how an older version is brought back) · 409 `SETTINGS_LABEL_TAKEN` · 404 `SETTINGS_NOT_FOUND` (`based_on`) · 422 `VALIDATION_ERROR`.

### `POST /selection/settings/{label}/activate`
WRITE. Makes a draft the active version, for runs started afterwards (a run keeps the version it started with).
- **Body (strict):** `{approval_ref}`, required (Dvir's words, valid as in README §Conventions; the text must **name the settings `label`** on label boundaries, else 422 `APPROVAL_INVALID`).
- **200:** `{active: label, activated_at: ISO}`.
- **Rules:** a version can be activated **once**; to bring an older version back, draft a new one based on it. Clearing the buy hold (the active version has `buy_hold: true`, the target `false`) also needs every `holdout.required_suites` suite to have passed as a **holdout-mode** replay on that target version (`POST /selection/replays`; `GET /selection/buy-hold?settings=<label>` shows the state), judged by the active version's `holdout` settings; DOM never clears the hold without the `approval_ref` as well. The activation and the check run in one transaction, after the previous activation row is locked.
- **Errors:** 422 `APPROVAL_REQUIRED` · 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 404 `SETTINGS_NOT_FOUND` · 409 `SETTINGS_ALREADY_ACTIVE` · 409 `SETTINGS_ALREADY_ACTIVATED` (activated before, then replaced) · 409 `HOLDOUT_NOT_PASSED` (`details.suites`).

### `GET /selection/sibling-methods/{method}`
READ (2.4.0, CR-008). A **sibling method** builds a name's 20 census siblings from its words, the same way every time, without looking at whether a sibling is registered. Three methods, all CR-008 Appendix B exactly, with the pools frozen from `bt1_pools_v1.json` (sha256 `a984b85e06ed79cf972590518214ccd35c6ea12887a8e08d8a5e807e1a7df48b`). They differ only in the word split they start from: **`bt1@v1`** uses DOM's `form` tokens; **`bt1@v2`** (2.6.0, CR-009) uses a frozen split that prefers common words (`data/bt1/bt1_v2_split.json`, sha256 `69e659c242ef3a6ea7f55c76dba5680db2199c81ef281d0e80adaf1547f80d73`: the reading with the lowest total cost, where each piece costs 0.5 plus a cost by how common it is (SCOWL size levels 35 to 70, DOM's term lists as common, a place-only piece as rare), ties keeping the shorter first piece; no reading → no siblings). **`bt1@v3`** (2.13.0, CR-012, approved to build by Dvir) is `bt1@v2` plus a fixed general token list (company suffixes, common acronyms and country codes, British spellings, contractions without the apostrophe; `data/bt1/bt1_v3_split.json`, sha256 `a76396a60d25d38c699ae94194b28d6ea354551419c4baf9c9b70d1d33f70d5e`; agrees with the research split on 1,826 of 1,900 names). Each method is approved on its own. `{method}` may be sent as `bt1@v1` or `bt1%40v1`.
- **Query (strict, optional, at most one):** `domain` (a `.com`; the method's own split: the `form` tokens for `bt1@v1`, the frozen split for `bt1@v2`) or `tokens` (comma-separated lower-case words, at least 2: your split). Both → 400 `VALIDATION_ERROR`.
- **200:** `{method, pools_sha256, split_sha256: string | null (2.6.0; null for `bt1@v1`), pools: {first_pool, last_pool, tech, trades} (in their frozen order, duplicates kept), approved: bool, approval_text: string | null, approved_at: ISO | null, siblings?: {tokens: [string], list: [label] (in order, without ".com"), size: int}}`. `siblings` is there when `domain` or `tokens` is given; `size` below 20 is shown as it is (the census then answers `CENSUS_LIST_SIZE`).
- **Errors:** 404 `SIBLING_METHOD_NOT_FOUND` · 400 `VALIDATION_ERROR` · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED`.

### `POST /selection/sibling-methods/{method}/approve`
WRITE (2.4.0). Dvir approves a method version **once**; after that the census accepts it for any name with no per-name approval (CR-007 G-3, CR-008 C-2). Append-only: an approval is never changed or withdrawn (a new method needs a new version).
- **Body (strict):** `{approval_ref}`, whose text must **name the method** (`bt1@v1`; label-boundary match, as for a settings activation).
- **201:** `{method, approved: true, approval_text, approved_at}`.
- **Errors:** 404 `SIBLING_METHOD_NOT_FOUND` · 409 `SIBLING_METHOD_ALREADY_APPROVED` · 422 `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 422 `VALIDATION_ERROR`.

### `GET /selection/lists/{name}`
READ. Query (strict): `version?` (integer ≥ 1; default the newest).
- **200:** `{name, version, terms: [string], created_at, created_by}`.
- **Errors:** 404 `LIST_NOT_FOUND` (unknown name, no such version, or a list nobody has uploaded yet such as `brand`) · 400 `VALIDATION_ERROR`.

### `GET /selection/namebio`
READ. `?keywords=a,b,c` (1 to 50 words of letters, digits and hyphens; lower-cased, duplicates dropped; anything else, an empty list or an unknown query key → 400 `VALIDATION_ERROR`). Stats come from the stored copies only: **this route never calls NameBio**. Since 5.11.0 (CR-062) the numbers are NameBio's **free** RetailStats (keyword aggregates, retail sales of $100 or more; never per-sale rows), stored by the daily `referenceRefresh` step when `sources.namebio` is on (off by default; turning it on is a settings activation with Dvir's OK). 200:
```
{ cache_date: "YYYY-MM-DD"|null, data_as_of: "YYYY-MM-DD"|null, source: "namebio_free",
  attribution: "Data from NameBio", attribution_url: "https://namebio.com", stale?: bool,
  status?: "UNKNOWN", reason_code?: "STALE_DATA"|"SOURCE_DISABLED",
  keywords: { <word>: { start_count, end_count, exact_count, middle_count, fetched_at,
                        placements: { exact|start|end|middle: { sale_count, price_sum, price_avg, price_max, price_stddev } } } | null } }
```
`data_as_of` is the fetch date of the oldest requested keyword that is stored (none stored: the newest fetch date of the table; empty table: null). Older than `namebio.max_cache_age_hours`, or empty, is 200 with `stale: true`, `status: "UNKNOWN"`, `reason_code: "STALE_DATA"`; the disabled source is `SOURCE_DISABLED` (every keyword null). A word not stored is `null`. The `*_count` fields are the placement `sale_count`s (kept from earlier versions; `source` changed from `nightly_csv` to `namebio_free`). Every response carries `attribution` and `attribution_url`; show them on any card that uses the numbers.

### `POST /selection/sibling-scan`
WRITE (CR-050 part 1, 4.1.0). Body (strict): `{domains: [string]}`, 1 to 20 names, each a second-level `.com` name (case and a trailing dot are normalised; duplicates are scanned once). A name that is not a valid `.com` name refuses the whole call before anything is fetched. Idempotent (`Idempotency-Key`) and audited. Scans each name in turn and stores one scan per name (append-only table `sibling_scans`, with `fetched_at`).
- **Siblings checked** (the `siblings` settings, `selection.md`): the same SLD on each ending of `siblings.endings` (default net, org, io, co, ai, us, co.uk), the hyphenated `.com` forms (4.2.1, CR-052: a hyphen before the longest dictionary word ending the name, after the longest one starting it, and after a number followed by a letter, so `drs-compliance.com`, `ppwr-labelling.com`, `ets2-compliance.com`, `fsma204-audit.com`; then the form with every point, where a letter followed by a number also splits, `fsma-204-audit.com`; then the best split's boundaries when it has at most three words of 3+ letters), and `get<sld>.com` / `try<sld>.com`, at most `siblings.max_checks` names per scan (`skipped_n` counts the rest). Each is asked by RDAP only (never system DNS); `.co`, `.us` and `.io`, missing from IANA's RDAP list, are asked at their registries' own RDAP servers (4.2.1); `.co.uk` is answered by Nominet's RDAP (the `uk` entry in IANA's list), so it is a real true/false; an ending with no RDAP service is `registered: null`, `reason_code: NO_REGISTRY_SERVICE`, never guessed. A registered sibling whose home page title is a web-server or hosting default or placeholder ("Default Site", "Welcome to nginx", "Index of /", "Coming soon", "Under construction"…) is `site_state: "default_page"`, `live_business: false`, `company: null`, and counts like a parked one (4.2.2). A registered one has its home page fetched through the outbound guard (robots.txt, paced, `https` first, at most 3 redirects, timeout and size from `lookalikes`) and read with the parked / for-sale signature lists. Reuses the CR-043 lookalike check; the RDAP answers are cached like other checks.
- **200:** `{scans: [Scan]}`, one per name, in order. `Scan` = `{domain, fetched_at, settings_version, complete, skipped_n, upstream_calls, siblings: [Sibling], lead_points}`.
  - `Sibling` = `{domain, kind: "ending"|"hyphen"|"prefix", registered: true|false|null, reason_code, live_business: true|false|null, site_state, url, http_status, fetched_at, title, company, contact_url}`.
  - `registered` true / false from RDAP; `null` = unknown, with `reason_code` (`TIMEOUT`, `NO_REGISTRY_SERVICE`, `SOURCE_ERROR`, `SOURCE_DISABLED`, `RATE_LIMITED`).
  - `live_business`: `true` = the home page answered 200 with real content (a site in use). `false` = not registered, or registered and parked, for sale, redirecting to another site (a marketplace included), a 4xx page, or too little content. `null` = not determined (RDAP unknown, or the page could not be read: a 401/403/429, a timeout, a client-rendered page). `site_state`: `in_use`, `parked_or_for_sale`, `redirect_off_domain`, `registered_no_site`, `unknown` or `null` (no page read).
  - `url` and `http_status`: the page read (the final URL after same-site redirects; for a redirect off the site, the target); null when no page was fetched. `fetched_at`: when the page was read, else when RDAP answered.
  - `title`: the page `<title>`. `company`: `og:site_name`, else the title, trimmed to 120 characters. `contact_url`: for a live sibling, the first link on the home page, on the same site, whose path or text says "contact" (URL only, without query or fragment); null when none. **No email address and no person name is ever stored or returned**: a word containing `@` is dropped from `title` and `company`, `mailto:` links are ignored, and the scout opens the contact page itself.
  - `lead_points` = `{points, formula, live_n, parked_n}`. `points` = `min(max, points_live x min(live_n, live_counted_max) + points_parked x min(parked_n, parked_counted_max))` with the `siblings` settings (default 10 per live business sibling counted up to 3, 2 per registered-but-parked sibling counted up to 3, at most 30; 0 when nothing is registered). `parked_n` counts registered siblings that are parked, for sale or redirect off the site. `formula` states the mapping with the counts.
  - `complete`: false when part of the scan hit the time budget (`siblings.time_budget_seconds`, default 80 s for the whole call; those siblings carry `reason_code: TIMEOUT`); scan again, cached RDAP answers make it quick.
- **Errors:** 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED` (a name that is not a valid second-level `.com`) · 422 `VALIDATION_ERROR` (no names, more than 20, an unknown key) · 400 `IDEMPOTENCY_KEY_REQUIRED` · 403 `SCOPE_FORBIDDEN` for a READ token.

### `GET /selection/sibling-scan/{domain}`
READ. The newest stored scan of the `.com` name, in the shape of one `Scan` above (`skipped_n` as stored). **Errors:** 404 `SIBLING_SCAN_NOT_FOUND` (never scanned) · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED`.

### `POST /demand/keywords`
WRITE (CR-044 item 3, 4.2.0). Dvir exports the Keyword Planner report on the 1st of each month (United States, Saved keywords tab, CSV); Gavriel base64-encodes the file as it is and posts it. Body (strict): `{file_base64, location?, month?}`: `file_base64` the whole file (at most 1,000,000 bytes), `location` free text (at most 60 characters), `month` `YYYY-MM`. The file is read as the real export is: UTF-16LE with a BOM and tabs (UTF-8 and UTF-16BE, with or without a BOM, are accepted too); the lines before the header (the title and the date range in the account's language) are kept as text; **columns are found by header name**, not position. Required headers: `Keyword`, `Avg. monthly searches`, `Competition (indexed value)`; read when present: `Three month change`, `YoY change` (raw text, e.g. `0%`). The localized `Competition` text column and every other column are ignored. Rows with an empty Keyword (the segmentation rows) and repeats of a keyword (the first wins) are skipped and counted. Keywords are stored lower-case with single spaces; an empty or non-numeric `Avg. monthly searches` is `null` (unmeasured), a `Competition (indexed value)` outside 0 to 100 is `null`. At most 5,000 keywords. Idempotent (`Idempotency-Key`), audited (the audit row records the file's size, not its bytes), append-only (every upload is kept; the newest row of a keyword is its demand).
- **201:** `{upload_id, uploaded_at, rows, skipped, date_range_line, audit_id}`.
- **Errors:** 422 `KEYWORD_CSV_INVALID` (a required header absent: `details.missing_headers`; no header row; an empty file; no keyword rows; more than 5,000 keywords; a file over the limit; nothing is stored) · 422 `VALIDATION_ERROR` (not base64, a bad `month`, an unknown key) · 400 `IDEMPOTENCY_KEY_REQUIRED` · 403 `SCOPE_FORBIDDEN` for a READ token.

### `GET /demand/keywords`
READ. Query (strict): `keyword` (required; matched lower-case, spaces collapsed). **200:** the newest stored row of the keyword: `{keyword, avg_monthly_searches (number | null), competition_index (0..100 | null), three_month_change, yoy_change (raw text | null), upload_id, uploaded_at, date_range_line, location, month}`. **Errors:** 404 `KEYWORD_NOT_FOUND` (no upload has it) · 422 `VALIDATION_ERROR` (no `keyword`).

### `POST /selection/lists/{name}`
WRITE. Writes version n+1 of a list; older versions stay readable. Names: the fixed lists `dictionary_extra`, `city_extra`, `trade`, `regime`, `tech`, `generic_head`, `state`, `legal`, `brand`, `bigco`, `event`, `sig_harmful_strong`, `sig_harmful_weak`, `sig_parked`, `sig_forsale`; or a **census list** `bt1_<sld>` / `s6_regime_audit`.
- **Body (strict):** `replace?: [string]` **or** `add?: [string]` and `remove?: [string]`; `note?`; `approval_ref?` (required for a census list). At most 5000 terms (body limit 64 KB). Terms are lowercased and trimmed; duplicates collapse.
- **Term shapes:** word lists `^[a-z]{2,40}$`; `regime` also takes digits after a letter, `^[a-z][a-z0-9]{1,39}$` (3.8.0, CR-039: `ets2`, `iso27001`); `brand`, `bigco`, `event` also multi-word phrases of lowercase words separated by single spaces (stored with the spaces; matched without them, so `new balance` and `newbalance` are one term); signature lists `class:phrase` with class in `adult, pharma, gambling, malware, phishing, hacked_spam, pbn, scam, trademark` (`sig_harmful_*`), `parked` (`sig_parked`), `forsale` (`sig_forsale`).
- **Census lists:** replaced whole (`replace`), exactly `census.sibling_count` (default 20) distinct second-level `.com` names, normalised like every domain (case, trailing dot); stored sorted. The target name of `bt1_<sld>` is not its own sibling. Freezing needs `approval_ref` whose text names the list name or the target sld (Gavriel writes the list, Dvir approves it); the approval text is stored with the list. Each frozen list is a version: `bt1_<sld>@v1`.
- **201:** `{name, version, terms_n}`.
- **Errors:** 422 `LIST_NAME_INVALID` · 422 `LIST_TERM_INVALID` (`details.terms`, `details.expected`) · 422 `LIST_NO_CHANGE` (also `replace` together with `add`/`remove`) · 422 `CENSUS_LIST_SIZE` (`details.expected`, `details.got`) · 422 `CENSUS_LIST_INVALID` (`details.invalid[] {term, reason}` or `details.duplicates`; also add/remove on a census list) · 422 `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` (census list) · 422 `VALIDATION_ERROR`.

### `POST /selection/evaluate`
WRITE (it writes only the audit row; nothing else is stored). Evaluates the tier (CAP-24) and the money rules (CAP-18) for one candidate from features the caller already has. Gavriel uses it for a quote check, a what-if or a backtest of a draft.
- **Body (strict):** `lane` (`S2` geo, `S3`, `S4`, `S6`, `S7`), `features: {registered_share?: 0..1 | null, prior_history?: 0|1|null, alt_tld_before_n?: int | null, n_words?: int | null, sld_chars?: int | null, is_geo?: 0|1 (default: lane is S2), gform1_pass?: 0|1|null, short?: 0|1|null, sellers_verified_n?: int (3.3.0; default 0), sellers_unknown_n?: int (3.4.1; default 0)}` (an omitted or null feature is **unknown**), `leads_ab` (int ≥ 0), `bin_usd?`, `price_grade?` (`strong`|`weaker`, geo), `first_year_usd?`, `renewal_usd?`, `lander_ns?` (`afternic` default | `other`), `retail_start?`, `retail_end?` (NameBio counts), `form?: {geo_band_raw?, sld_len, word_count, short, syllables?}`, `domain?` (only for the syllable count), `risk_flag?`, `intent_raw?`, `timing_raw?` (0..10), `parked_only?`, `settings?` (a label: evaluate against that version instead of the active one). USD fields are positive numbers with at most 2 decimals.
- **Missing BIN:** non-geo uses the current `pricing_settings` default non-geo BIN; geo uses the grade price (`price_grade`, else the `price.geo_default_grade` setting) of the current pricing settings.
- **Missing form:** taken from `features` when `sld_chars` and `n_words` are given, otherwise A-Form is unknown (0 points).
- **200:** `{settings_version: label, backtest: bool (true when `settings` is not the active version), pricing_version: int, bin_cents, tier: {tier: "A"|"I"|"B"|"G"|"none", tier_exact, clauses: {A: "true"|"false"|"unknown", ...}, demand2: "PASS"|"FAIL"|"UNKNOWN", fired: string | null, inputs}, money: {...}, warnings: [string]}`. `money` and `tier` are described in `selection.md` §Tier and §Money. A missing quote makes `ev_cents`, `ratio_at_bin`, `ratio_at_floor` and their `passes` null.
- **Warnings:** `PRICING_V3_MISSING` (the current pricing version has no price list: `bin_in_allowed_set` is null and a non-geo LANDER-1 cannot pass).
- **Errors:** 422 `FORBIDDEN_FEATURE` (any key from `score.forbidden_feature_keys` anywhere in the body, found before validation; `details.path`) · 404 `SETTINGS_NOT_FOUND` · 422 `BIN_REQUIRED` (no BIN sent and the current pricing settings have no default non-geo BIN) · 422 `VALIDATION_ERROR`.

### `POST /selection/labelled-names`
WRITE. The CAP-21a **name registry**: every labelled name is recorded once, as `fit`, `dev` or `test`, with its source, slice, recorded features and `as_of` (CR-002 v10.1). Append-only: a recorded name is never changed.
- **Body (strict), one of:** `rows` (1 to 200 JSON rows) or `csv` (text, the same 200-row limit; header row required). Body limit 1 MB for this route.
  - **Row:** `{domain, role: fit|dev|test, label: sold|dropped, source (1–120 chars), slice (1–60 chars), report_lane?: expired|fresh|aged|geo, price_usd? (sale price of a sold name), as_of? (YYYY-MM-DD or null), features: {registered_share?: 0..1|null, prior_history?: 0|1|null, pre_cls?: string|null, alt_tld_before_n?: int|null, n_words?: int|null, sld_chars?: int|null, is_geo?: 0|1, city_trade_ok?: bool|null, short?: 0|1|null, geo_city?, geo_trade?, archive_span_years?, input_dates?: {<input>: YYYY-MM-DD}, gates?: {tm_us?, tn?, hist2?, hist2_guard?: {result: PASS|FAIL|FLAG|UNKNOWN, source: string, date: YYYY-MM-DD}}}}`. A missing or null feature is **unknown**; nothing is imputed.
  - **CSV columns** (a leading BOM is ignored): `domain,label,slice,role` (as in `features.csv`; `role` was called `split` in the plan, and it is `role` everywhere in the API), optional `source` (default: the slice), `report_lane`, `sale_price_usd`, `as_of`, `registered_share`, `prior_history`, `pre_cls`, `alt_tld_before_n`, `n_words`, `sld_chars`, `is_geo` (explicit; else derived: either `geo_city` or `geo_trade` filled makes the row geo), `geo_city`, `geo_trade`, `archive_span_years`, `census_date`, `ext_dates_date`, `history_date` (become `input_dates.census`, `.ext_dates`, `.history`), and for each gate `g` in `tm_us`, `tn`, `hist2`, `hist2_guard`: `g_result`, `g_source`, `g_date`. An empty cell is null.
- **200:** `{inserted, duplicates, conflicts: [{domain, existing_role}]}`. An identical re-upload is a duplicate. The same domain with any different value is a conflict and is never overwritten (a name is recorded once).
- **Errors:** 422 `ROWS_INVALID` (`details.rows: [{index, domain, message}]`; nothing is recorded) · 422 `VALIDATION_ERROR` (neither or both of `rows` and `csv`, or not 1 to 200 rows) · 409 `LABELLED_NAME_CONFLICT` (rare: a concurrent upload recorded one of the names between the check and the insert; nothing from this call is stored; retry and the name shows as a duplicate or a conflict; `details.domain`).

### `POST /selection/replays`
WRITE. **CAP-21a replay** over the registered names. Every row goes through the same tier and DEMAND-2 code as live screening (`evaluateTier` with the chosen settings); nothing is a second implementation.
- **Body (strict):** `suite`, `mode` (`diagnostic` | `holdout`), `settings?` (a label; default the active version).
  - **`diagnostic`** also takes the filters `slices?`, `sources?`, `roles?`, `domains?` (AND) and `profit?`. `suite` is only a label. It refuses any selection that contains a `test` row: 422 `HOLDOUT_CONTAMINATED` ("Test rows are scored only by holdout replays").
  - **`holdout`** takes **only** `suite` and `settings` (any filter or `profit` → 422 `VALIDATION_ERROR`). `suite` must be one of `holdout.required_suites` with a frozen definition (`POST /selection/holdout-suites`). A suite that is **not** in `holdout.required_suites` → 422 `SUITE_UNKNOWN` (`details.required_suites`, checked first, v2.1.0; before it gave `SUITE_NOT_DEFINED`). A required suite with **no frozen definition** → 422 `SUITE_NOT_DEFINED`; the latest definition version selects the names and names the judged cell.
- **`diagnostic`:** decisions from the features alone, no gates; `gates_applied: false`; it **never counts toward the hold**. Missing as_of or gate columns are fine; an unknown `city_trade_ok` is unknown, not true.
- **`holdout`:** the selected names must all be registered as `test` (a `fit`/`dev` name in the selection is refused first), carry an `as_of`, all four gate results (`tm_us`, `tn`, `hist2`, `hist2_guard`, each with source and date) and an input date for every non-null dated feature (`input_dates.census` for `registered_share`, `ext_dates` for `alt_tld_before_n`, `history` for `prior_history`, `pre_cls`, `archive_span_years`). DOM **recomputes** CAP-01 (form: word count, length, G-FORM-1, a form `FAIL`) and CAP-02 (the `brand` and `bigco` lists at their current versions) from the domain; the supplied gate results and `is_geo` are trusted as uploaded, with their source. Decisions are shown **before** and **after** the gates. A row is `reject` when any gate fails; an `accept` becomes `undecided` when a gate is unknown (an uploaded `UNKNOWN`, or no `brand`/`bigco` list); a `reject` stays a reject. `FLAG` results count as pass (as in live screening).
- **Decisions:** `accept` / `reject` / `undecided`. A row is `undecided` unless the decision is the same whichever way the missing data falls; rates use n **including** undecided; undecided is never dropped.
- **201:** `{replay_id: "rpl_<12 hex>", suite, mode, settings_version, gates_applied, report, pass}`.
  - `report`: `{mode, gates_applied, counts_toward_buy_hold, pooled, by_slice, by_band, by_lane, history_types, judged_cell, judged, leakage_lint, before_gates? (holdout: {pooled}), profit? }`. `judged_cell` is `pooled` or `lane:<lane>` (the definition's); `judged` is that cell's counts. `pooled`, each `by_slice`/`by_lane` entry: `{sold: {n, accepted, rejected, undecided, accept_rate}, dropped: {n, accepted, rejected, undecided, reject_rate}, precision_at: {"0.01": x, "0.02": y}, meets_thresholds}` (`precision_at` keys are `holdout.base_rates`; precision = s·b / (s·b + (1−r)(1−b))). `by_band` covers sold names with a price, split at `holdout.report_bands` (USD): `{"<$1000", "$1000-<$2500", ">=$2500": {n, accepted, ...}}`. `by_lane`: the row's `report_lane`, else geo / `expired` (prior history) / `fresh` (none) / `unknown`. `history_types`: `pre_cls` × label × decision.
  - `pass`: true only for a **holdout** replay whose `judged` cell has `meets_thresholds` (sold accepted ≥ `holdout.sold_accept_min`, dropped rejected ≥ `holdout.drop_reject_min`, both n ≥ `holdout.min_n`) and **0 leaking rows** (and no row without dated inputs). A diagnostic replay is always `pass: false`.
  - `leakage_lint`: `{rows_checked, rows_leaking, rows_without_as_of, rows_without_dated_inputs}`. A row leaks when any dated input (`features.input_dates` and the gate dates) is dated on or after its `as_of` (strictly before is the rule).
  - `profit` (when `profit: true`): `{accepted_sold, accepted_dropped, cost_cents, cost_per_name_cents, net_factor, bin_price_cents, as_computed, without_top3, bin_capped}`, each figure `{gross_cents, net_cents, profit_cents, break_even_base_rate}`. Needs `sale_price_usd` on **every** sold row. Net = gross × `money.net_factor_afternic`; cost = every accepted name (sold or dropped) × `profit.cost_per_name_year_cents` × `money.hold_years`; `without_top3` removes the three highest accepted sales; `bin_capped` caps each price at `profit.bin_price_cents`; `break_even_base_rate` is the base yearly sale rate b at which an accepted name's expected net sale value (precision(b) × mean net price) equals its yearly cost.
- **Errors:** 404 `SETTINGS_NOT_FOUND` · 422 `REPLAY_EMPTY` (no registered name matches) · 422 `SUITE_NOT_DEFINED` · 422 `SUITE_UNKNOWN` · 409 `SUITE_MEMBERSHIP_CHANGED` (holdout: the selected names differ from the frozen set, checked after the contamination check; nothing is stored; `details.frozen_count`, `current_count`) · 422 `HOLDOUT_CONTAMINATED` (holdout: a selected name is registered as fit or dev; diagnostic: a selected name is `test`; `details.domains`, `details.count`) · 422 `AS_OF_REQUIRED` (holdout, `details.domains`) · 422 `REPLAY_INVALID_NO_GATES` (holdout, `details.required`, `details.rows: [{domain, missing: [gate or input_dates.<input>]}]` first 20, `details.count`) · 409 `VARIANT_NOT_PREREGISTERED` (holdout: the settings were created after the first holdout replay of this suite; variants are chosen on fit/dev data and recorded before test slices are scored) · 422 `PROFIT_REPORT_INCOMPLETE` (`details.sold_without_price`) · 422 `VALIDATION_ERROR`.

### `POST /selection/holdout-suites`
WRITE. Freezes a **pre-registered suite definition**, before any holdout scoring: which registered names the suite scores and which cell is judged. Nothing is seeded; Gavriel uploads the definitions. Versioned and append-only (a changed definition is a new version).
- **Body (strict):** `suite` (any id `^[A-Z0-9][A-Z0-9-]{1,31}$`, since 2.5.0; before, only `holdout.required_suites`), `gates_not_assessed?` (2.5.0: any of `tm_us`, `tn`, `hist2`, `hist2_guard`, no repeats: the gates this suite's rows do not carry), `clears_hold?` (2.5.0, default false: this suite counts toward clearing the buy hold), `slices?`, `sources?` (at least one; they select every registered name in them, all of which must be `test`), `cell?` (`pooled` default, or `lane:expired` / `lane:fresh` / `lane:aged` / `lane:geo`: BT10-11 judges `lane:expired`), `approval_ref` (Dvir's words, which must **name the suite id**, validated as in README §Conventions; since 2.5.0 also **each gate** in `gates_not_assessed` by its id, and, with `clears_hold: true`, the words **"clears hold"**; anything missing → 422 `APPROVAL_INVALID` saying what).
- **Frozen at freeze time:** the selection is computed from the registry as it is now; the `test` names in it are stored as `member_count` and `member_hash` (sha256 of the sorted domain list, newline-joined). A holdout replay recomputes the selection and refuses on any difference.
- **201:** `{suite, version, slices, sources, member_hash, member_count, cell, created_at, created_by, approval_text}`.
- **Errors:** 409 `SUITE_ALREADY_SCORED` (the suite already has a holdout replay: no new definition version, `details.replay_id`) · 409 `SUITE_OVERLAP` (the selection shares a name with another required suite's latest definition; `details.other_suite`, `count`, `examples` up to 5) · 422 `SUITE_EMPTY` (no test names, or the judged cell has no sold or no dropped test name) · 422 `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 422 `SUITE_UNKNOWN` (`details.required_suites`) · 422 `VALIDATION_ERROR`.

### `POST /selection/test-sets`
WRITE (2.5.0, CR-007 G-4a/b, CR-008 AC-10). DOM builds a test set from source rows, or re-scores names already registered, and computes their features **as of each row's `as_of`**. Body limit 2 MB. Two purposes:
- **`new`:** `{name (^[A-Z0-9][A-Z0-9-]{2,31}$, becomes the registry slice), purpose: "new", seed (1–64 chars), test_share? (0 to 1 exclusive, default 0.5), filters?: {min_words?, max_words?, max_chars?, exclude_geo? (default true), min_price_usd? (sold rows), as_of_from?, as_of_to?}, rows (1–2,000): [{domain, label: sold|dropped, as_of (YYYY-MM-DD, not in the future), source (1–120 chars), price_usd?, report_lane?}]}`.
  - **Removed rows** (each with a reason; the call still succeeds): `DOMAIN_INVALID`, `DUPLICATE_IN_UPLOAD`, `ALREADY_REGISTERED` (in the name registry under any role, or kept by an earlier test set: a name is never used twice), `FORM_FILTER` (DOM's `form` analysis: digits, hyphens, words, length, geo), `PRICE_BELOW_MIN`, `OUTSIDE_WINDOW`.
  - **Split:** the kept rows ordered by the sha256 of `<seed>:<domain>`; the first `round(test_share × n)` are `test`, the rest `dev`. The same rows and seed always give the same split.
- **Both (2.6.0):** `sibling_method?` (`bt1@v1` | `bt1@v2` | `bt1@v3` (2.13.0), default `bt1@v2`), shown in the `GET`.
- **Rescore of the gaps (2.13.0):** `only_names_with_unknowns: true` with `from_set` (a finished rescore set; a `new` set → 422, an unfinished one → 409 `TEST_SET_NOT_READY`) takes only that set's names with an unknown feature; the report adds `gaps: {before, after}`.
- **Both (2.7.0, CR-010):** `max_answer_age_days?` (0 to 30, default 7): the oldest stored registry answer the set's run may reuse (0 = ask every name again). A stored answer is reused for a row's `as_of` only if it was read **on or after** that `as_of` (with `features_as_of: "now"`, only the age limit applies). Fresh lookups go to each registry at most 4 at a time and 250 ms apart; on a 429 or a refusal the run halves its rate (down to one at a time, 4 s apart) and counts it; after 5 refusals in a row from one registry (2.11.1), the run stops asking that registry and answers its remaining lookups UNKNOWN `RATE_LIMITED` at once (counted, never "not registered"); live screening has the same breaker; a lookup that still fails is UNKNOWN, never "not registered". Live screening keeps the settings' pacing and freshness.
- **`rescore`:** `{name, purpose: "rescore", slices (1–20), settings? (a label, default the active one), features_as_of? (2.6.0: `row` default, or `now` = registration as the registry shows it at the run, as the research measured)}`: every registered name in those slices; a `test` name → 422 `HOLDOUT_CONTAMINATED`; a name without `as_of` → 422 `AS_OF_REQUIRED`. Nothing is registered or changed.
- **Features (both):** a back-test screening run (`form`, `census` with the set's sibling method, default `bt1@v2`, and `ext_dates`), lane S7, at each row's `as_of` (00:00 IDT). A sibling or other extension counts only when the registry's creation date is **strictly before** `as_of`. Its deadline is 48 hours (normal runs keep `run.time_budget_minutes`); about 24 registry lookups per name. Answers already stored are reused (2.7.0); fresh ones run at about 3.9 per second (measured 7 Oct 2026), so a new set of about 900 names takes about 75 minutes and a rerun within the age limit a few minutes. The free server sleeps without traffic: poll the `GET` to keep it moving (the daily run also resumes it). **Known limit:** these features are reconstructed from today's registry, so a name registered before `as_of` and deleted since is not seen.
- **Needs** the sibling method approved for a `new` set (409 `SIBLING_METHOD_NOT_APPROVED`). A `rescore` may use a method not approved yet (2.6.0): it registers nothing and only reports.
- **202:** `{name, purpose, status: "computing", run_id, kept_n, removed_n, test_n, dev_n, poll}`.
- **Errors:** 409 `TEST_SET_NAME_TAKEN` · 422 `TEST_SET_EMPTY` (nothing kept or selected; nothing stored) · 409 `SIBLING_METHOD_NOT_APPROVED` · 422 `HOLDOUT_CONTAMINATED` · 422 `AS_OF_REQUIRED` · 404 `SETTINGS_NOT_FOUND` · 422 `VALIDATION_ERROR`.

### `GET /selection/test-sets/{name}`
READ. `{name, purpose, status: "computing" | "ready" | "sealed" | "cancelled" (2.9.0), unknowns (2.16.2: `null` while the run is going; 2.13.0: rescore sets `{total_n, truncated, entries: [{domain, features: [{check, reason_code, detail}]}]}` (at most 200; 2.16.0: also every **undecided** name, as `{check: tier, reason_code: DEMAND2_UNDECIDED, detail: {unknown_inputs}}`; `detail` is `{tokens, size, unread}` for `CENSUS_LIST_SIZE` (`unread`: the part of the name the split could not read), else `{lookups: [{name, source, reason_code, tries, last_try_at}]}`); `new` sets only `{total_n, by_check_reason}`, never names), settings_version, sibling_method, max_answer_age_days, lookups: {fresh, reused, unknown, rate_limited} | null (2.7.0, over the run's census and ext_dates answers; 2.16.2: `null` while the run is still going, so a progress poll stays light; `run.done_n` shows progress), timing: {started_at, finished_at | null, minutes | null} (2.7.0), seed, test_share, filters, created_at, kept_n, removed_n, test_n, dev_n, removed: [{domain, reason}], run: {id, status, names_n, done_n}, features: {census_known_n, alt_known_n} | null, sealed_at, member_count, member_hash, report}`. `ready` = the run finished (done or partial). **Seal needs a `done` run** (2.16.0): a `partial` or `cancelled` run → 409 `TEST_SET_NOT_READY` with `details.status`. A feature the run did not establish stays `null` (unknown), `is_geo` included. A `new` set never shows a row's label, features or decision (test rows are scored only by holdout replays). **`report`** (rescore sets, when ready): `{settings_version, sibling_method, features_as_of, sold: {n, accepted, rejected, undecided, accept_rate, wilson95: [lo, hi]}, dropped: {n, accepted, rejected, undecided, reject_rate, wilson95: [lo, hi]}, features_unknown_n, rows_changed_vs_registered, as_of_reconstructed: true}`. Each name keeps its registered features except `registered_share`, `alt_tld_before_n`, `n_words`, `sld_chars` and `is_geo`, which DOM's values replace (null stays unknown). Decisions come from the same tier code as replays, rates use n including undecided, `wilson95` is the Wilson score interval at 95%, and `rows_changed_vs_registered` counts names whose decision differs from the one on their registered (uploaded) features. 404 `TEST_SET_NOT_FOUND`.

### `POST /selection/test-sets/{name}/cancel`
WRITE (2.9.0, CR-010 F-1). Cancels the set's run exactly as `POST /screening/runs/{id}/cancel`; the set's status becomes `cancelled` (its `lookups` and `timing` keep their values; a cancelled `new` set can't be sealed: 409 `TEST_SET_NOT_READY`). **200** (5.13.0 adds `cancel_reason`, the stored `reason`): `{name, status: "cancelled", run_id, cancelled_at, cancelled_by, cancel_reason}`. **Errors:** 404 `TEST_SET_NOT_FOUND` · 409 `RUN_NOT_RUNNING`.

### `POST /selection/test-sets/{name}/seal`
WRITE. A `new` set, once ready: registers every kept row in the name registry (role `test` or `dev` from the split, slice = the set name, with DOM's features `registered_share`, `alt_tld_before_n`, `n_words`, `sld_chars`, `is_geo` and `input_dates` = the day before `as_of` for each non-null dated feature), in one transaction, and freezes the test membership (`member_count`, `member_hash` = sha256 of the sorted test names, newline-joined, as suites do). No approval is needed; freezing a **suite** from it does. History, trademark and same-name gates are not computed (a suite names them in `gates_not_assessed`). **201:** `{name, status: "sealed", registered_n, test_n, dev_n, member_count, member_hash}`. **Errors:** 404 `TEST_SET_NOT_FOUND` · 409 `TEST_SET_NOT_READY` · 409 `TEST_SET_ALREADY_SEALED` · 409 `TEST_SET_NOT_SEALABLE` (a rescore set) · 409 `LABELLED_NAME_CONFLICT` (a name was registered meanwhile; nothing stored).

### `POST /selection/drop-lists`
WRITE (2.8.0, CR-007 G-2 source A). Gavriel uploads a deleting list (SnapNames or any other); DOM never fetches one itself. Body limit 2 MB. **Body (strict):** `{name (^[a-z0-9][a-z0-9._-]{2,63}$), list_date (YYYY-MM-DD, not in the future), domains (1–20,000)}`. DOM keeps letters-only `.com` names of 2 or 3 words by the `bt1@v2` split; every other name is removed with a reason: `DOMAIN_INVALID`, `DUPLICATE_IN_UPLOAD`, `HAS_DIGIT`, `HAS_HYPHEN`, `NO_SPLIT`, `ONE_WORD`, `TOO_MANY_WORDS`. **201:** `{name, list_date, received_n, kept_n, removed: {<reason>: n}}`. The registry status is read by the daily step `dropWatch` (`jobs.md`). **Errors:** 409 `DROP_LIST_NAME_TAKEN` · 422 `VALIDATION_ERROR`.

### `GET /selection/drop-lists/{name}`
READ. `{name, list_date, received_n, kept_n, rows: [{domain, kept, reason, tokens, status, expected_drop_date, drop_date_source, checked_at}]}` (the latest check per name; `tokens` are shown for removed rows too when a split was made, e.g. `TOO_MANY_WORDS`, 2.15.0; `status` is `pending_delete`, `redemption`, `registered`, `not_registered`, `unknown`, or null before the first check). **Expected drop date:** pending delete → the registry's "last changed" date + 5 days (`rdap_last_changed`); redemption → + 35 days (`estimate`); otherwise null. 404 `DROP_LIST_NOT_FOUND`. **Lane fit (3.2.0, CR-020 A):** each row has `screening: {lane: S2 | S4 | S6 | null, reason: NO_KEPT_LANE | null}`; a `NO_KEPT_LANE` row stays kept (for idea mining) but is never screened.

### `GET /selection/drop-lists`
READ. Query (strict, both required, a window of at most 31 days): `drop_from`, `drop_to` (YYYY-MM-DD). **200:** `{names: [{domain, list_name, status, expected_drop_date, drop_date_source, tokens}]}`: the kept names whose expected drop date is in the window, one per domain (its latest check), ordered by date then name. Lists older than 60 days (after their `list_date`) are left out. 400 `VALIDATION_ERROR`.

### `POST /selection/cohorts`
WRITE (2.8.0, CR-007 G-1, the forward test). **Body (strict):** `{name (^[a-z0-9][a-z0-9._-]{2,63}$), settings (1–3 labels), sibling_method? (default bt1@v2)}` and exactly one of `names (1–200): [{domain, expected_drop_date, source}]` or `from_drop_lists: {drop_from, drop_to, sample_n (1–200), seed}` (pending-delete or redemption names of that window, ordered by the sha256 of `<seed>:<domain>`, first `sample_n`). Left out with a reason: `DOMAIN_INVALID`, `DUPLICATE_IN_UPLOAD`, `LATE` (expected drop date today or earlier), `IN_OPEN_COHORT` (in a cohort created in the last 120 days). DOM computes the features as a rescore does (registration now, `bt1@v2` census, `ext_dates`, form); when that run is done it **freezes** one decision per name and settings label (`accept` / `reject` / `undecided`, with the tier, by the same tier code as replays; `prior_history` is taken as 1, since every name in a cohort is about to drop after a registration). A decision frozen on or after the name's expected drop date is kept, marked `late`, and left out of the rates. **Only a `done` run freezes (2.16.0):** if the feature run ends `cancelled` or `partial`, the cohort becomes `abandoned` with no decisions, and its names may join a new cohort. Nothing is registered in the name registry. **202:** `{name, status: "computing", run_id, included_n, excluded: {<reason>: n}}`. **Errors:** 409 `COHORT_NAME_TAKEN` · 422 `COHORT_EMPTY` (2.15.0: with `from_drop_lists` and no pending names in the window, `details: {reason: NO_PENDING_NAMES_IN_WINDOW, drop_from, drop_to}`) · 404 `SETTINGS_NOT_FOUND` · 422 `VALIDATION_ERROR`.

### `GET /selection/cohorts/{name}`
READ. `{name, status: "computing" | "frozen" | "abandoned" (2.16.0), settings, included_n, excluded, names: [{domain, expected_drop_date, decisions: {<label>: {decision, tier, late}}, drop: {result, checked_at} | null, rereg: {d30, d60, d90: {result, created_at, registrar} | null}}], excluded_names, run: {id, status}, source, report: {<label>: …}}` (`report` per settings label, as below, for this cohort, once frozen). **Drop outcome** (daily step `cohortOutcomes`, from the day after the expected drop date): `available_after_drop`, `caught_at_drop` (registered, created on or after the expected drop date − 1), `restored` (registered, created earlier), `still_pending` (asked again next day), `unknown` (asked again on the next 5 daily runs, then it stays unknown). **Re-registration** of `available_after_drop` names at 30, 60 and 90 days after the drop: `yes` (with creation date and registrar; only when the registry's creation date is on or after the drop check day − 1), `no`, `unknown` (also a registered name with a missing or earlier creation date: fail closed). Each name is asked at most once per IDT day. 404 `COHORT_NOT_FOUND`.

### `GET /selection/cohorts/report`
READ. Query `settings` (a label, required), `cohorts?` (comma list; default every frozen cohort with that label). **200:** `{settings, cohorts, fwd_min_ratio, fwd_min_n, rereg: {d30, d60, d90: {accepted: {n, re_registered, unknown, rate, wilson95}, rejected: {...}, ratio, pass}}, counts: {names, caught_at_drop, restored, still_pending, unknown_drop, drop_not_checked, undecided, late}}` (2.15.0: the shape the service has always returned, CR-013 F-5), over `available_after_drop` names with a decision that is not late. An `unknown` re-registration is left out of `n` and never counted as re-registered or free. **FWD-1:** `pass` when both classes have at least 50 names and the accepted rate is at least 2× the rejected rate (`ratio` null when the rejected rate is 0). Both numbers are constants in the service; a change needs a release.

### `GET /selection/holdout-suites`
READ. `{suites: [<201 shape>]}`, every version, oldest first.

### `GET /selection/replays/{id}`
READ. The stored replay: `{replay_id, suite, mode, settings_version, filter, report, leakage_rows, pass, created_at, created_by}`. 404 `REPLAY_NOT_FOUND`.

### `GET /selection/buy-hold`
READ. **`small_buy` (3.7.0, CR-033 G-3; 5.0.0: reduced to the price ceiling):** `{max_first_year_cents, max_first_year}`, the first-year price limit of the small-buy exception (the weekly figures are gone). **Since 2.13.0 (CR-012 part D)** it also returns `steps: [{n, step, status: done|open|failed, evidence, next_actor: gavriel|dvir|null}]` and `ready` (steps 1–5 done), the path to a real buy, derived from the data and acting on nothing: 1 a sealed test set (Gavriel); 2 a sibling method approved (Dvir's line names it); 3 a `clears_hold` suite frozen (Gavriel; Dvir's line names the suite, each gate left out, "clears hold"; `failed` if any holdout replay of a `clears_hold` suite failed); 4 a draft with `buy_hold: false` (the active one if so, else the newest); 5 every hold suite passed on that draft (a failure sticks); 6 that draft activated (Dvir's line names its label; this lifts the hold); 7 an open production tranche, not the probe (name matching `probe`; Dvir chooses the cap). Query `settings?` (a label; default the active version). **200:** `{buy_hold (the active version's), settings_version (the version judged), target_buy_hold (that version's own buy_hold), hold_suites: [suite] and hold_suites_source: "clears_hold" | "required_suites" (2.5.0), required_suites: [{suite, replay_id | null, pass, sold_accept_rate, drop_reject_rate, n_sold, n_dropped, definition_version | null, failed_before, variants_scored}], clearable: bool}`. Per **hold suite** (2.5.0: the suites whose latest definition has `clears_hold: true`; when there are none, the active version's `holdout.required_suites` as before; the list keeps the name `required_suites`), for that settings version: **a failing holdout replay sticks** (`failed_before: true`, `pass: false`; a re-run or a changed definition never erases it). Otherwise the suite passes when a holdout replay on its **latest definition version** passes (judged cell, the active version's `holdout` settings, 0 leaking rows). `replay_id` is the failing replay, else the passing one, else the latest, else null. `variants_scored`: how many settings versions have a holdout replay of the suite (the pre-registered variants). `clearable` is true only when `target_buy_hold` is false and every suite passes. It is a report: clearing `buy_hold` is an activation that also needs Dvir's `approval_ref`. 404 `SETTINGS_NOT_FOUND`.

### `POST /screening/runs`
WRITE. Starts a screening run (CAP-20) over 1 to 50 names and returns at once; the run is stored per (name, check) and continues in the background (and after a restart: see `jobs.md` `screeningResume`). Poll `GET /screening/runs/{id}`.
- **Body (strict):** `mode?` (`live` default | `full`), `settings?` (a settings label; default the active version), `tranche_id?` (an existing tranche, else 404 `TRANCHE_NOT_FOUND`; concentration counts its real geo members for the geo cap), `checks?` (a subset of check ids: each lane's gate list is cut to it, in settings order; a lane left with nothing → 422 `VALIDATION_ERROR`), `names` (1–50) each `{domain, lane (S2 geo | S3 | S4 | S6 | S7), city?, state?, trade?, price_grade? (strong|weaker), bin_usd?, leads_ab? (default 0), census_list?, as_of? (ISO with offset, full mode only), rank? (int)}`.
- **Modes:** `live` stops a name at its first FAIL or UNKNOWN; `full` runs every planned check regardless. `live` needs the **active** settings version; a `full` run may name any version, and a non-active one makes it a `backtest` (results labelled, never a buy card).
- **Order:** gate by gate in the settings' plan order, names in `rank` order (lower first; unranked after ranked, then submission order), so CONCENTRATION-1 sees the names ranked ahead.
- **Per-name problems never fail the request:** an unreadable or duplicate name gets one `form` result FAIL `INPUT_INVALID` (`fields.cause` and the start of `reason`: `DUPLICATE` the same name again, `NOT_COM`, `DOMAIN_INVALID`) and the final status `invalid`.
- **202:** `{run_id, status: "running", mode, backtest, settings_version, buy_hold, names_n, poll: "/screening/runs/<id>"}`.
- **Buy hold:** a run labelled `backtest` (a non-active settings version), or whose settings version is no longer the active one, never reports `buy_candidate`: a name that passes is `would_buy`.
- **Errors:** 422 `DRAFT_NOT_ALLOWED_LIVE` (`settings` is not the active version in a live run; `details.active`) · 404 `SETTINGS_NOT_FOUND` · 422 `AS_OF_LIVE_REFUSED` (`as_of` on a live run) · 422 `VALIDATION_ERROR` (size, lane, unknown check, unknown key). · 404 `TRANCHE_NOT_FOUND` (`tranche_id`).

### `POST /screening/runs/{id}/cancel`
WRITE (2.9.0, CR-010 F-1). Body (strict) `{reason?}` (at most 200 characters; stored since 5.13.0, it used to be dropped). Stops a running run: its status becomes `cancelled`, `finished_at`, `cancelled_at`, `cancelled_by` (the token's name) and `cancel_reason` (the `reason`, else null) are set, the results written so far are kept, and every check not yet done becomes UNKNOWN `CANCELLED`. The worker stops within seconds and a cancelled run is **never** woken or reopened (not by a read, a recompute or the daily run). **200:** `{id, status: "cancelled", cancelled_at, cancelled_by, cancel_reason}`. `GET /screening/runs/{id}` shows `cancelled_at`, `cancelled_by` and `cancel_reason` on a cancelled run. **Errors:** 404 `RUN_NOT_FOUND` · 409 `RUN_NOT_RUNNING` (`details.status`).

### `GET /screening/runs/{id}`
READ. Each name has `words` and `split_source` (`scout` | `dictionary`, null before `form` ran; 3.4.0, CR-027). `?domain=` (one name), `?view=summary|full` (default `full`; `summary` leaves out `results`). **A READ poll may start background work:** a running run whose last row is older than 120 s (the service slept) continues now, and a finished run with a check to recompute is reopened (never a `cancelled` run, 2.9.0) (it writes result rows in the background); the answer does not wait for it and is not affected by it.
- **200:** `{run_id, status: "running"|"done"|"partial"|"cancelled" (2.9.0), unknowns (2.13.0, as for rescore test sets; `?domain=` filters it), lookups: {fresh, reused, unknown, rate_limited} (2.9.0, as for test sets), mode, backtest, settings_version, buy_hold, created_at, finished_at, progress: {checks_planned, checks_done}, names: [{domain, lane, final_status, first_fail: {check, gate, reason_code} | null, tier, short, flags: [check], pending_manual: [check], not_implemented: [check], verdicts: [{check, result_id, verdict, reason, decided_by, decided_at}] (1.2.0), source_lane: "expired_drop"|"fresh"|"unknown"|null, results?: [{check, gate, rule_ids, status, reason_code, reason, fields, data_as_of, checked_at, cached, source, settings_version, list_versions, duration_ms, upstream_calls, evidence: [id]}]}], funnel}`. `results` holds the latest result per check, in the order written. `tier` is the tier check's tier (null until that check exists); `short` is the form check's `short`; `source_lane` is the `history` check's inferred source lane (null until that check has a result). `verdicts` (1.2.0) lists the latest FLAG verdict of each result row that is **in force now** (a verdict on a superseded row is not shown); it never changes `final_status` or `flags`.
- Statuses, final statuses, the funnel and the reason codes: `selection.md` §Screening runs.
- **Errors:** 404 `RUN_NOT_FOUND` · 400 `VALIDATION_ERROR` (bad query).

### `GET /screening/runs/{id}/report.csv`
READ (3.10.0, CR-043). One CSV row per name of the run (`text/csv; charset=utf-8`, CRLF, proper quoting). Columns: `domain, lane, status` (the final status), `first_fail` (check id), `ev_cents`, `ratio` (`ratio_at_floor`), `score`, `tier`, `lookalikes_registered`, `lookalikes_in_use`, `topic`, `topic_reused` (`true`/`false`, empty with no topic), `sellers_verified_n`, `comps_n` (comparable sales sent at intake; 0 = none found), `reason_codes` (`;`-joined: the first fail, `LANE_NOT_FOR_BUY`, and every non-PASS result's code). A cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'` (spreadsheet formula injection). An empty cell is a value DOM does not have (a check not run). **Errors:** 404 `RUN_NOT_FOUND`.

### `POST /screening/runs/{id}/manual`
WRITE. Records a human result for a check no automated source answers: `web_risk` (Google Transparency Report, CAP-06), `tm_us` (USPTO wordmark search, CAP-08), `history` (HIST-2 and the prior-business guard, CAP-07; CR-002 Amendment B) or, since 1.2.0, `tm_eu` (EU and international trademark search, CAP-09). The server turns the record into a status by the settings' rules (below) and appends it; it supersedes the run's `MANUAL_REQUIRED` row for that name. The evidence URL is stored as an evidence row (`source: "manual"`, text = the JSON result).
- **Body (strict):** `domain` (a name of the run), `check` (`web_risk` | `tm_us` | `history` | `tm_eu`), `checked_at` (ISO with offset, not in the future and not older than the check's `freshness_hours` window; 168 h for `history`; `eu_tm.freshness_hours`, default 168, for `tm_eu`), `evidence_url` (an https URL; required for `web_risk`, `tm_us` and `tm_eu`, optional for `history`, whose links are in `result.evidence_urls`), `result`, `note?` (≤ 500 chars). `result` for `web_risk`: `{raw_status: int, threat_types?: [string]}`; for `tm_us`: `{phrases_queried: [string] (≥ 1), control_ok: bool, exact_or_core_live: [{mark, serial, owner, status}], generic_live: [{mark, serial, owner, status}], dead_n?: int, prior_name_live?: [{mark, serial, owner, status}]}`. When the run's `history` result found a prior business, `phrases_queried` must contain its phrase (`tm_us` `fields.prior_business_phrase`, compared uppercase without punctuation) or the record is UNKNOWN `PRIOR_NAME_NOT_QUERIED`; a non-empty `prior_name_live` is FAIL `TM_LIVE_MARK`. A `web_risk` "safe" record is PASS after a PASS or FLAG history, UNKNOWN `HISTORY_NOT_FINAL` (history unknown, not run, still MANUAL_REQUIRED or absent) or `HISTORY_NOT_CLEAN` (history FAIL).
- **`tm_eu` record (1.2.0, CAP-09).** `result`: `{phrases_queried: [string] (1-30, required: the phrases searched; compared uppercase without punctuation, as for `tm_us`), control_ok?: bool (false → UNKNOWN `CONTROL_FAILED`), checked_by: string, registers: ["euipo"|"wipo"|"ukipo"|"tmview"] (1-4), register_urls: [https URL] (1-10), result: "clear" | "hits", exact_or_core_live: [mark], generic_live: [mark]}` (strict), where `mark` is `{mark, number, owner, status, register: "euipo"|"wipo"|"ukipo"|"tmview"}`. `result: "clear"` with any mark listed, or `"hits"` with none, is 422 `VALIDATION_ERROR`. Status: any `exact_or_core_live` mark → FAIL `TM_LIVE_MARK`; only `generic_live` → FLAG `TM_GENERIC_HITS`; else PASS. The record is accepted for any name of the run, **even when `tm_eu` is not in its gate plan** (a screening pack reads it). Evidence and `recorded_by` as for the other manual checks.
- **`history` record (Amendment B).** `result`: `{result: "PASS" | "REJECT_HARMFUL" | "FLAG_PRIOR_BUSINESS", category?: "malware_phishing" | "spam" | "adult" | "scam" | "trademark_abuse" (required for, and only for, REJECT_HARMFUL), prior_business_name?: string (≤ 200), first_capture_year?: int, last_capture_year?: int, evidence_urls?: [string] (required when a capture year is given; each `https://web.archive.org/web/<timestamp>/<url>`; at least one for REJECT_HARMFUL and FLAG_PRIOR_BUSINESS), checked_by: string}` (strict). It is stored with the **field shape of the automated history result** (`hist2`, `hist2_fail_class`, `prior_history`, `prior_business_use` / `_name` / `_years`, `prior_business_guard`, `source_lane`, `com_prior_registration`, `evidence_urls`, `pre_cls`, plus `manual: true`, `checked_by`, `manual_result`, `first_capture_year`, `last_capture_year`), so the tier, `ext_dates`, `price`, `web_risk` and tranche admission read it like the automated one; `source` is `manual`, `recorded_by` is the calling token. Status: `PASS` → PASS; `REJECT_HARMFUL` → FAIL `HARMFUL_HISTORY` with `hist2_fail_class` = `category` (`pre_cls` `harmful`); `FLAG_PRIOR_BUSINESS` → FLAG `PRIOR_BUSINESS_FLAGGED` (a disclosed risk, shown on the card as the history flag with `prior_business_name`). **A1 guard:** when `prior_business_name` is given (any result) it runs through the `brand` and `bigco` lists of the run: a hit is FAIL `PRIOR_BUSINESS_BRAND_HIT` / `PRIOR_BUSINESS_BIGCO_HIT` (`hist2` stays as recorded), a missing list UNKNOWN `LIST_MISSING`; the manual `tm_us` record must then list that name's phrase in `phrases_queried` (UNKNOWN `PRIOR_NAME_NOT_QUERIED`). **Mapping:** `prior_history` is `1` when a capture year is given or the result is FLAG_PRIOR_BUSINESS, otherwise `null` (unknown, never `0`); `source_lane` is `expired_drop` and `com_prior_registration` `yes` when `prior_history` is 1, else `unknown`; `prior_business_use` is `yes` for a flag or a given name, else `unknown`. **Append-only, latest wins:** records add rows, earlier ones stay (the manual precedence of `beats`: a manual record outranks an auto or cached row, the highest id among manual rows wins). Recording a history result **re-reads this name's earlier manual `web_risk` and `tm_us` records against it** and appends a new row when the verdict changes (a TM record that lacks the prior name's phrase becomes UNKNOWN `PRIOR_NAME_NOT_QUERIED`; a Web Risk "safe" record waiting on history becomes PASS). **Same-run recompute (1.2.0):** a manual record (history, and `web_risk` / `tm_us` / `tm_eu`, which `price` reads) on a finished run reopens it (`status` back to `running`, a fresh time budget) while the checks that read history (`ext_dates`, `tier`, `price`, `tm_us`, and anything that reads them) are recomputed; new rows are appended, earlier ones stay, and the run ends `done` again. The response carries `recompute: boolean` (additive): `true` only when the posted record's check is read by a check in the name's plan and a recompute was started, or the run was still running and was kicked; `false` when none is in the plan, or (on a finished run) the name is already stopped by another failing check. Until a stale row is recomputed it counts as missing: the name is `running` while the run runs and `unknown` if the run ends first (a time-out turns it UNKNOWN `TIMEOUT`), and `POST /tranches/{id}/members` refuses a run that is still running (409 `NOT_SCREENED_OK`, `reason: RUNNING`). A manual row is never recomputed, and a recompute never reads the cache. (Before 1.2.0 the rows were left as they were and the name had to be screened again.) **Automated `history` with `sources.wayback` false (permanent, Amendment B1)** answers MANUAL_REQUIRED `MANUAL_SOURCE` (`fields.lookup_name`, `results`, `archive_url`), so the name is `pending_manual` with `history` listed and cannot join a tranche (409 `MANUAL_REQUIRED`, below). The audit row of the POST holds who (token), when, and the request body with the evidence URLs.
- **Status rules:** `web_risk`: `raw_status` in `web_risk.unsafe_statuses` → FAIL `UNSAFE`; in `safe_statuses` → PASS when `web_risk.requires_clean_history` is false or the name's latest `history` result in this run is PASS or PASS_WITH_NOTE, else UNKNOWN `HISTORY_NOT_FINAL` (record again once history is decided); any other value → UNKNOWN `STATUS_UNRECOGNISED`. `tm_us`: `control_ok` false → UNKNOWN `CONTROL_FAILED`; any `exact_or_core_live` → FAIL `TM_LIVE_MARK`; only `generic_live` → FLAG `TM_GENERIC_HITS`; else PASS.
- **201:** the new result: `{domain, check, gate, rule_ids, status, reason_code, reason, fields, data_as_of (= checked_at), checked_at, cached: false, source: "manual", settings_version, list_versions, duration_ms, upstream_calls, evidence: [id], recorded_by}`.
- **Errors:** 404 `RUN_NOT_FOUND` · 404 `NAME_NOT_IN_RUN` (not a screened name of the run; an `INPUT_INVALID` name is not one) · 422 `CHECK_NOT_MANUAL` (`details.manual`) · 422 `CHECKED_AT_INVALID` (in the future, or older than the freshness window; `details.freshness_hours`) · 422 `VALIDATION_ERROR` (shape, an http URL, a missing `evidence_url` for `web_risk` / `tm_us` / `tm_eu`; for `tm_eu`: `clear` with marks, `hits` without; for `history`: a missing `checked_by`, an unknown `result` or `category`, REJECT_HARMFUL without a category, REJECT_HARMFUL or FLAG_PRIOR_BUSINESS without an archive evidence URL, an evidence URL that is not a `web.archive.org/web/<timestamp>/…` capture link, inverted capture years).

### `POST /screening/runs/{id}/verdicts`
WRITE (since 1.2.0). Records a human PASS or REJECT on one **FLAG** result row (for example `tm_us` `TM_GENERIC_HITS`). The verdict is bound to that row's `result_id`: a newer record for the same check is a new row and does not inherit it. Append-only; the latest verdict of a result wins. A REJECT only affects the screening pack; `final_status` and `flags` of the run view keep their v1.1.0 meaning.
- **Body (strict):** `domain` (a name of the run), `check` (a check id), `result_id` (int > 0), `verdict` (`PASS` | `REJECT`), `reason` (1-500 chars), `decided_by` (1-80 chars: who decided), `decided_at` (ISO with offset; at most 60 s in the future).
- **201:** `{id, run_id, domain, check, result_id, verdict, reason, decided_by, decided_at, recorded_by}`.
- **Errors:** 404 `RUN_NOT_FOUND` · 404 `NAME_NOT_IN_RUN` · 404 `RESULT_NOT_FOUND` (no such result for that name and check in this run) · 409 `VERDICT_RESULT_STALE` (a newer row of that check is in force; `details.in_force_result_id`) · 409 `VERDICT_RESULT_NOT_FLAG` (`details.status`) · 422 `DECIDED_AT_INVALID` · 422 `VALIDATION_ERROR`.

### `GET /screening/evidence/{id}`
READ. One stored evidence row: `{id, source, url, retrieved_at, http_status, sha256, truncated, text}`. `text` is the extracted visible text (never raw HTML); `sha256` covers the full response body. 404 `EVIDENCE_NOT_FOUND`.

### `POST /quotes/manual`
WRITE. A renewal price entered by Dvir's bot for a registrar the machine cannot quote (for example a GoDaddy account with fewer than 50 domains; CAP-17). Append-only; the quote check (a later task) accepts it until `valid_until`.
- **Body (strict):** `domain` (a `.com`), `registrar` (a configured registrar name: `porkbun`, `dynadot`, `namecom`, `namecheap`, `godaddy`, `spaceship`, `namesilo`; case-insensitive), `renewal_usd` (> 0, at most 2 decimals), `first_year_usd?`, `source_note` (1–500 chars: where the figure was read), `source_url?`, `observed_at` (ISO with offset).
- **201:** `{id, domain, registrar (lowercased), renewal_cents, renewal, valid_until}` where `valid_until = observed_at + quote.manual_max_age_days` (30 in v1).
- **Errors:** 422 `OBSERVED_AT_INVALID` (in the future, or older than `quote.manual_max_age_days`; `details.max_age_days`) · 422 `REGISTRAR_NOT_ALLOWED` (`cloudflare`: never, founder rule 5) · 422 `REGISTRAR_UNKNOWN` (`details.known`) · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED` · 422 `VALIDATION_ERROR`.

## Screening packs (1.2.0, CAP-19)

A screening pack is the frozen evidence for one name of one finished screening run: every check's result row (with its verdict), the three judgment calls, the money figures and the quote. Packs are append-only and versioned per domain. In 1.2.0 `/buy` does not require one (see the dry-run advisory under `POST /buy`; enforcement is 2.0.0). Built only from a **finished** run (not `running`) that is not a backtest and used the full plan, and only from rows that are not stale. Required checks, the missing codes and the freeze rules are in `selection.md` §Screening pack.

**Pack summary:** `{pack_id: "pk_<12 hex>", domain, version, status: "complete"|"incomplete", missing: [{item, code, detail}], run_id, settings_version, content_sha256, issued_at, issued_by}`.

### `POST /screening/packs`
WRITE. Body (strict): `{run_id, domain, judgment: {van_test: {verdict: "PASS"|"REJECT", reason}, tn1: {...}, bigco: {...}, reason_not_to_buy (1–300), judged_by (1–80), judged_at (ISO with offset)}}`. A 3-lead spot check is not accepted (leads run after the buy decision): any extra key is 422 `VALIDATION_ERROR`. **201** with the summary when a new version was written; **200** with the summary and `unchanged: true` when the content (including status and missing) equals the domain's latest version (no new row). An incomplete pack is issued too. The judgment is declared by the caller; the server cannot prove who judged.
Errors: 404 `RUN_NOT_FOUND` · 404 `NAME_NOT_IN_RUN` · 409 `RUN_RUNNING` (`details.reason: "RUNNING"`) · 409 `NOT_SCREENED_OK` (`details.reason`: `BACKTEST` | `PARTIAL_PLAN`) · 422 `DOMAIN_INVALID` · 422 `JUDGED_AT_INVALID` (`judged_at` later than now plus 60 s, or earlier than the run's creation) · 422 `VALIDATION_ERROR`. The run, its rows and verdicts are read inside one transaction under the domain lock and the run-row lock, so a verdict or record committed before the call is always in the pack.

### `GET /screening/packs/{id}`
READ. The summary plus `content` (exactly as frozen: domain, lane, run, settings version, list versions, screened_at/by, status, missing, `gates` (every check of the plan and of the required set: `{check, gate, rule_ids, status, reason_code, result_id, source, recorded_by, checked_at, data_as_of, fields, evidence_ids, verdict, decides}`), `judgment`, `money`, `quote`). 404 `PACK_NOT_FOUND`.

### `GET /screening/packs`
READ. Query `domain` (required). `{packs: [<summary>]}` for the domain, newest version first. `domain` is required (400 `VALIDATION_ERROR` without it, or with any other parameter); 422 `DOMAIN_INVALID`.

## Tranches

A tranche is one batch of screened names bought together (CAP-04). One tranche is open at a time. Limits come from the **active** selection settings (`selection.md`: `tranche.size` 15, `tranche.min_main_lane` 10, `tranche.geo_max` 1). In v1.1.0 a tranche is a set of rules over its members; `/buy` does not look at it. A closed tranche is **read-only** and stays listed (also in `/report` `tranches`).

**Tranche view** (returned by every tranche route): `{id: "trn_<12 hex>", name, status: "open"|"closed", opened_at, opened_by, closed_at, closed_by, opened_under (the settings version active when it opened), members: [{domain, lane, is_geo, main_lane: bool, run_id, added_at}], counts: {members, geo, main_lane, non_main}, close_report: null | {...}}`. Members that were removed are not listed.

### `GET /tranches`
READ. `{tranches: [<tranche view>]}`, newest first (open and closed).

### `POST /tranches`
WRITE. Body (strict): `{name: string (unique)}` (5.0.0: `spend_cap` is gone; a body that still sends it is 422 `VALIDATION_ERROR`). **201** the tranche view. Errors: 409 `TRANCHE_ALREADY_OPEN` (`details.open_tranche`) · 409 `TRANCHE_NAME_TAKEN` · 422 `VALIDATION_ERROR`.

### `POST /tranches/{id}/members`
WRITE. Body (strict): `{action: "add"|"remove", domain, run_id?}` (5.0.0: `est_cost` is gone). **200** the tranche view (`add` adds `duplicate: bool`).
- **add** (`run_id` required): the name must be in that run (404 `NAME_NOT_IN_RUN`; 404 `RUN_NOT_FOUND`), the run must not be a backtest (409 `NOT_SCREENED_OK`, `details.reason: "BACKTEST"`) and must have used the **full** lane plan: a run with a `checks` subset, or any lane plan narrower than the settings' plan, never admits a name (409 `NOT_SCREENED_OK`, `details.reason: "PARTIAL_PLAN"`); its `history` result must not be MANUAL_REQUIRED (409 `MANUAL_REQUIRED`, `details.check: "history"`: record HIST-2 by hand and screen the name again; a rejected or invalid name gets its own refusal instead), and its final status there must be `would_buy`, `buy_candidate` or `pending_manual` (409 `NOT_SCREENED_OK`, `details.final_status`, `details.first_fail`). Adding a name already in the tranche is a 200 with `duplicate: true`. Checks in order: 409 `TRANCHE_CLOSED` → duplicate → 409 `NOT_SCREENED_OK` → 409 `TRANCHE_FULL` (members = `tranche.size`) → 409 `GEO_CAP` (geo members = `tranche.geo_max`; checked on **every** addition, so Gavriel adds geo names in Ratio order and the lowest-ranked is the one refused). A name is a geo member when its lane is S2.
- **`main_lane`** is read from the run's results: lane S7 with a `history` result PASS / PASS_WITH_NOTE and `source_lane` `expired_drop` (clean history), or lane S3 with a `tier` result PASS (DEMAND-2). A **manual** history record (Amendment B5.4) counts the same way, and a manual FLAG_PRIOR_BUSINESS (a disclosed risk, not a rejection) also counts when its `source_lane` is `expired_drop`. Anything else is `false`: another lane, a history that is not a pass, a `fresh` source lane, or an `unknown` one (the source lane is inferred from the archive, or taken from a manual record; with the archive off an S7 name has no `expired_drop` lane until its manual HIST-2 record says captures existed, and none joins at all before it has a record). A name whose main-lane standing cannot be told is **not** main-lane.
- **remove:** sets the member's removal time (open tranches only). 404 `MEMBER_NOT_FOUND`; 409 `TRANCHE_CLOSED`.
- Also 404 `TRANCHE_NOT_FOUND`, 422 `DOMAIN_INVALID`.

### `POST /tranches/{id}/close`
WRITE. Body (strict, may be empty): `{allow_below_target?: bool, reason?: string}` (`allow_below_target` needs a `reason`, else 422 `VALIDATION_ERROR`). **200** the tranche view, now `closed`, with `close_report: {target_size, members, below_target, reason, geo, geo_max, main_lane, non_main, required_main_lane, min_main_lane, settings_version_used, closed_with, domains}`. Checks, in order:
1. 409 `TRANCHE_CLOSED` if already closed.
2. 409 `GEO_CAP` if geo members exceed `tranche.geo_max` (the settings changed meanwhile).
3. A tranche **may close below its target** (`members` < `tranche.size`) only with `allow_below_target: true` and a `reason`, else 409 `TRANCHE_BELOW_TARGET`. `reason` is used only for this.
4. **Main-lane quota**, which still applies to the members present and has **no waiver**: at least `ceil(members x min_main_lane / size)` main-lane members (a full 15 needs 10, 3 members need 2), else 409 `MAIN_LANE_QUOTA` (`details.required_main_lane` and the counts). A reason does not help.

A closed tranche is read-only in the database as well (an update of the tranche or of a member is refused).

---

## Jobs

### `POST /jobs/run`
The job token, or (2.3.0) a WRITE bot token, at most 4 calls per hour per WRITE token (see `jobs.md`). Body `{"job": "tick" | "daily" | "datasave"}` (5.21.0: `datasave` added; strict; anything else → 422 `VALIDATION_ERROR`). Needs `Idempotency-Key`. **202 (3.0.0)** `{run_id, job, status: "queued" | "running", skipped, steps: [name]}`: the steps run in the background from a queue (`jobs.md`); read the results in `GET /jobs/runs`. **503** `JOBS_DISABLED` when the job token isn't configured.

---

### `GET /jobs/runs`
READ (any `GET` token; not the job token). Query (all optional; an unknown parameter or a bad value → **400** `VALIDATION_ERROR`): `job` (`tick` | `daily` | `screen` | `train` | `datasave`), `since` (ISO 8601 with an offset; runs that finished at or after it), `limit` (1 to 500, default 50). **200:**
```
{ runs: [ { run_id: string | null (3.0.0; null for older and CLI runs), status: "queued" | "running" | "finished" (3.0.0), job, trigger: "scheduled" | "manual" | "cli", triggered_by: string | null, scheduled_for: ISO | null,
            started_at, finished_at, skipped: bool, ok: bool,
            steps: { <step>: { ok (null while queued or running), status: queued|running|done|failed|skipped, attempts, ms, db?: {queries, ms, errors?, top?} (5.40.0), started_at, finished_at, skipped?, error?, summary } } } ],   // unfinished runs first, then newest first
  jobs: { tick: { last_run_at, last_ok_at, next_due_at: null },
          daily: { last_run_at, last_ok_at, next_due_at, last_scheduled: {run_id, status, ok} | null, missed_slot: ISO | null } },   // last_scheduled, missed_slot: 3.1.0                   // ISO | null
  reference: { popularity: { list_id, list_date, rows, refreshed_at } | null,
               iana: { refreshed_at: ISO | null }, namebio: { enabled: false } },
  backup: { configured: bool, last_status: "ok" | "failed" | "skipped" | null } }
```
- `trigger`: `scheduled` when the `Idempotency-Key` of the `POST /jobs/run` call is the Worker's `<job>-<ms>` (`scheduled_for` is that time), `manual` for any other call, `cli` for `npm run job`. `triggered_by` (2.3.0) is the bot token's name for a run a WRITE token started; 3.2.0 (CR-017 N-3): `job-token` for the job token (the Worker), `cli` for `npm run job`, so it is never `null` for new runs (older runs may be `null`). `steps` are the step results exactly as `POST /jobs/run` returned them (`jobs.md`). An unfinished run shows `finished_at: null`, `ok: null` and each step's current state. Since 3.0.0 a call that overlapped a running job adds no run (it answers with the running run's id). A failed run has `ok: false`.
- `last_run_at` / `last_ok_at` ignore skipped overlaps. `next_due_at` is the next 00:05 UTC for `daily`; `tick` has no schedule (`null`).
- `reference` is the snapshot in use now. `backup.last_status` is the last daily run's `backupExport` step (`null` before any run). Times use the Asia/Jerusalem offset. No secret, token or repository address is ever shown. Only runs since 2.1.0 are listed.

### `POST /jobs/preview`
WRITE. Body (strict): `{today?: "YYYY-MM-DD"}`. `today` is an Asia/Jerusalem day, default today, at most 3 years ahead; a past day, a later day, a non-date or an unknown field → **422** `VALIDATION_ERROR`. Needs `Idempotency-Key`. Runs `priceJob` and `dropJob` as a dry run on the real data as of that day. **200:**
```
{ today, priceJob: { would_apply: [{domain, event, rowId, bin_cents, floor_cents}] (2.16.0: no walk-away),
                      would_supersede: [row_id], held: [domain], would_delist: [domain],
                      would_cancel: [{row_id, domain, event}], would_fail: [{row_id, domain, event, reason}] },
  dropJob: { would_drop: [domain] } }
```
The arrays are the `applied`, `superseded`, `held`, `delisted`, `cancelled`, `failed` and `dropped` fields of the jobs' dry-run summaries (`jobs.md`). `would_cancel` (2.6.0, CR-009 N-2) lists the open rows the run would cancel (a due delist cancels the name's other open rows; a sold or dropped name's planned rows), and `would_fail` the due rows that would fail the price rules. `would_supersede` stays a list of row ids. A job that was already running adds `skipped: true`. Writes only the audit row (summary `preview <day>: ok`); it never calls a registrar, a marketplace or a nameserver, it does not touch the domains or the schedule, and it is **not** a run (it does not appear in `GET /jobs/runs` and does not satisfy `JOB_OVERDUE`). The other job steps are not previewed.

## RDAP lookup service (5.29.0, CR-074)

One place to ask "is this .com registered, since when, at whom, with which status?" so the bots stop repeating the same lookups. The answer comes from **one cache** (`rdap_cache`) that the internal steps share: the pick-proof T30 labels read it, and the screening checks, the drop-list watch, the cohort outcomes and the portfolio check fill it with every definite answer they get. Only `.com` names (the Verisign RDAP host). The service never scrapes a page and needs no key. Legal or trademark judgment is not part of it (`GET /tm/{term}` is **not built**: no official no-key USPTO source is known).

**Row shape** (the same in all three routes): `{domain, registered: true | false | null, created, expires, registrar, status: [string], checked_at, cache_age_s, source: "rdap", reason_code?}`. `created` and `expires` are ISO times with an offset (or `null`), `status` are the registry's EPP status words. `cache_age_s` is 0 for an answer just fetched. `registered: null` is **never** a "no": it means the registry could not be asked or did not answer, and `reason_code` says why: `TIMEOUT`, `SOURCE_ERROR` (any other failure, including a page that is not an RDAP answer), `RATE_LIMITED` (the registry answered 429), or `LOOKUP_LIMIT` (only in a batch row: the limit below was reached before this name). An error answer is **not cached** (the next call asks again) and a slot is still spent, because the registry was asked.

**Cache.** A stored answer younger than `lookups_rdap_ttl_hours` (default 24, migration only) is served with no live lookup and no limit used. `?fresh=true` (or `"fresh": true` in the batch body) skips the cache, asks the registry and counts against the limit; the answer fills the cache.

**Limit.** `lookups_rdap_daily_limit` (default 200, migration only) live lookups per **rolling 24 hours**, keyed on UTC timestamps: a lookup stops counting exactly 24 hours after it was made, so there is no midnight reset (and none at midnight Israel time). It counts only live lookups made by these routes (every token, bots and READ and WRITE alike share it). The internal daily steps read and fill the same cache but **never count**. A slot is reserved atomically before the lookup (two calls at once cannot pass the limit).

### `GET /rdap/{domain}`
READ or bots. Query `fresh` = `true` | `false` (strict, else 400 `VALIDATION_ERROR`). Domain: a second-level `.com` (422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED` like everywhere). **200** the row. A registry error is still 200 with `registered: null` and a `reason_code`. A needed live lookup with the limit used up: **429 `LOOKUP_LIMIT`**, `details {retry_after_s}` and a `Retry-After` header (seconds until the oldest counted lookup is 24 hours old). A cached answer is served even then.

### `POST /rdap/batch`
READ, bots or WRITE. **A read-only POST** (like `POST /score`): it writes only the cache and the usage log, so it needs no `Idempotency-Key` and leaves no audit row. Body (strict) `{domains: ["x.com", ...], fresh?: boolean}`, 1 to 500 names (501 or 0 names, or an unknown field: **400 `VALIDATION_ERROR`**; a name that is not a valid `.com`: 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED`, nothing looked up). Names are lower-cased; a name twice gives the same row twice, asked once.
**200** `{count, cached_n, live_n, limit_hit, retry_after_s?, rows: [row]}`; `rows` follow the order of `domains`. Cached names first; the rest are looked up live while slots remain. When the limit runs out, the remaining uncached names come back `registered: null, reason_code: "LOOKUP_LIMIT"` and the answer carries `limit_hit: true` and `retry_after_s`. The call is a whole **429 `LOOKUP_LIMIT`** only when no row at all could be answered (nothing was cached and no slot was free).

### `GET /lookups/usage`
READ or bots. **200** `{source: "rdap", used, limit, remaining, window_hours: 24, window_start, resets_gradually: true, next_slot_at}`. `used` is the live lookups of the last 24 hours; `next_slot_at` is when the oldest of them stops counting (`null` when none).

## Daily data saves (5.21.0, CR-071)

The `datasave` job (`jobs.md`) saves GoDaddy's official inventory files every day at 15:00 UTC and records one write-once manifest per file. The two GET routes only read. The only route that writes a snapshot is `POST /snapshots/dynadot` (5.22.0, the bots' Dynadot rows); no route re-parses or re-downloads a GoDaddy snapshot, and raw files are never served.

### `GET /snapshots`
READ (any `GET` token, bots included). Query (all optional; an unknown parameter or bad value → **400** `VALIDATION_ERROR`): `date` (`YYYY-MM-DD`, the **source's data date**, the UTC date of the file's `Last-Modified`, never the run date; default: the last 14 days), `source` (`godaddy_inventory` | `dynadot_closeouts` | `dynadot_aftermarket` | `dynadot_closed_auctions` | `godaddy_auction_end`), `rows` (5.22.0; 0..1000, with a Dynadot `source`: also return up to that many stored rows). **200:**
```
{ date: string | null, source: string | null,
  snapshots: [ { source, data_date, file_name, status: "complete" | "partial" | "error" | "not_configured", bytes: int | null, sha256: string | null,
                 last_modified: ISO | null, rows: int | null, rows_total: int | null, price_unit: "cents" | null, http_status: int | null, error: string | null,
                 raw_available: bool, raw_deleted_at: ISO | null, raw_note: string | null, sealed: bool, sealed_at: ISO | null,
                 origin: "fetch" | "bot_upload" } ],   // newest data_date first, at most 500 (5.22.0: origin)
  pool: [ { data_date, source: "godaddy_closeouts", rows: int } ],                                                                 // parsed rows still held (3 days)
  auctions?: [ { domain, end_time: ISO, auction_type, first_seen, last_seen, final_state_at, bid_count, final_price_cents, max_price_cents, price_unit: "cents" } ],   // only with source=godaddy_auction_end (5.22.0)
  rows?: [ ... ] }                                                                                                                  // only with a Dynadot source and rows=n; row shapes below
```
- `rows` is set only for the file that is parsed (`closeout_listings.json.zip`): the `.com` names with a price up to the cap (default $40), not adult; `rows_total` is every row of the file. **`rows: null` means not parsed or failed, never zero.** The other four files are fetched, hashed and kept raw only. `price_unit: "cents"` says every price in the parsed rows is integer cents.
- `status: "error"` carries `http_status` (the inventory host's answer, `null` for a network failure) and `error`; `rows` is `null`. `partial` is a file that was fetched but not parsed. Only `complete` rows are **sealed**; an error or partial row is replaced by the retry.
- `raw_available` is true only while the raw zip is on the server's disk (7 days at most; the folder `SNAPSHOT_DIR`); after that `raw_available: false` and `raw_deleted_at` is set, and the manifest (sha256, size, rows) stays for good. When the server has no writable disk, `raw_available` is `false` from the start and `raw_note` says why. No server path is ever shown.

- **`source=godaddy_auction_end`** (5.22.0, CR-071 R-10): `snapshots` is empty and `auctions` lists the GoDaddy auctions whose **final state** was recorded on a data date in the range (`date`, else the last 14 days; at most 1,000): they were followed (a `.com` auction that reached $500, kept once it did) and left all the auction files after their end time. `bid_count` and `final_price_cents` are the last values seen (0 bids means unsold), `max_price_cents` the highest price seen. Nothing is stored for auctions that never reached $500.
- `origin: "bot_upload"` marks a manifest made by `POST /snapshots/dynadot` (file name `bot_upload`, `bytes` null, no raw file). With `rows=n` and a Dynadot source the answer also has `rows`: aftermarket `{data_date, domain, listing_id, price_cents}`, closed auctions `{data_date, domain, end_time, bid_count, final_price_cents}`, closeouts `{data_date, domain, price_cents, ends_at}`.

### `POST /snapshots/dynadot`
5.22.0, CR-071 R-8, R-9. **WRITE or bots token** (non-money; a READ token is 403 `SCOPE_FORBIDDEN`). `Idempotency-Key` required; audited (the audit row keeps `[n rows]`, never the rows). Body limit **8 MB**. **Limits (5.32.0, BUG-051):** at most **50,000 rows per call** (send several calls with the same `kind` and `data_date`); every price field (`price_cents`, `final_price_cents`) at most **2,000,000,000** cents (about $20M), inclusive. Over the row limit: **422 `ROWS_LIMIT`** `details: {max_rows, received_n}`. A price over the cap: **422 `PRICE_CAP`** `details: {max_cents, rows: [index, up to 20], over_n}` (leave such rows out; prices are never clamped). The row limit is checked first; either way the whole call is refused and nothing is stored. Every other problem stays 422 `VALIDATION_ERROR`. `GET /openapi.json` shows both (`maxItems`, `maximum`). The server has no Dynadot key: the bots pull the data and upload it here.
```
{ "kind": "aftermarket" | "closed_auctions" | "closeouts",
  "data_date": "YYYY-MM-DD",          // UTC data date of the pull; not in the future
  "rows": [ ... ],                    // may be [] only with final: true
  "final": true,                      // optional: seal this (kind, data_date) with this call
  "dry_run": true,                    // optional: validate and count, store nothing
  "coverage": { ... } }               // optional (5.24.0, R-8b): how complete the pull was
```
`coverage` (5.24.0, CR-071 R-8b; strict, optional): `{partial: bool, calls_n: int, pages_planned: [int], pages_ok: [int], pages_failed: [int], rows_received_n: int}`, pages are whole numbers ≥ 1, and `pages_ok` and `pages_failed` must be subsets of `pages_planned` (else **422** `VALIDATION_ERROR`, nothing stored). A day is sealed by `final: true` even when `partial` is true. The latest part that sends `coverage` wins until the seal; after it, coverage is frozen with the manifest. `GET /snapshots` shows it as `coverage` (`null` when never sent).
Row shapes (strict: an unknown key or a wrong type → **422** `VALIDATION_ERROR` for the whole call, nothing stored; prices are **integer cents**, a decimal such as `500.5` is refused; domains are lowercased):
- `aftermarket`: `{domain, listing_id: string, price_cents: int}`. Rows with `price_cents < 50000` are dropped and counted. Unique per `listing_id` per day.
- `closed_auctions`: `{domain, end_time: ISO 8601, bid_count: int >= 0, final_price_cents: int >= 0}`. Unique per domain per day.
- `closeouts`: `{domain, price_cents: int >= 0, ends_at?: ISO 8601}`. Unique per domain per day.

**201** `{kind, data_date, dry_run, final, sealed, status: "partial" | "complete", received_n, accepted_n, duplicate_n, dropped_under_500_n, dropped_below_floor_n (same number), rows_stored_n, sha256: string | null, audit_id}`. `duplicate_n` counts rows repeated in the call or already stored for that day (the first one wins). `rows_stored_n` is the day's total so far.
- **Sealing.** The manifest (`GET /snapshots?source=dynadot_<kind>`) is `partial` and open while parts arrive. The call with `final: true` seals it: `status: "complete"`, `sealed: true`, `sha256` set. A sealed (kind, data_date) takes nothing more: **409 `SNAPSHOT_SEALED`** (`details` has `kind`, `data_date`, `sha256`, `rows`), nothing changes. Sealing a day with no stored rows is 422.
- **sha256** = SHA-256 (hex) of the UTF-8 text of `JSON.stringify` of the array of the day's stored rows sorted by `domain`, then `listing_id` (bytewise), each row an object with exactly these keys in this order: aftermarket `{domain, listing_id, price_cents}`; closed auctions `{domain, end_time, bid_count, final_price_cents}` with `end_time` as UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; closeouts `{domain, price_cents, ends_at}` with `ends_at` the same way or `null`.
- `dry_run: true` runs every check and returns the counts (with `sealed: false`) but stores nothing, not even a manifest; a sealed day still answers 409.
- Retention: `closeouts` rows 3 days (like the pool), `aftermarket` and `closed_auctions` rows 120 days (`datasave.dynadot_keep_days`); manifests stay for good.
- `/health.datasave` and `DATASAVE_MISSED` watch a kind only after its first upload ever, and expect the previous day's sealed upload until 16:00 UTC, today's after it.

### `GET /snapshots/missing`
READ. Query: `from`, `to` (`YYYY-MM-DD`; default the 14 days up to the last due data date, i.e. yesterday until 16:00 UTC); `from` after `to` or a range over 366 days → **400**. **200** `{source: "godaddy_inventory", from, to, expected_files: [file_name], missing: [{date, missing_files: [file_name], status: "missing" | "partial"}]}`: the days without a complete save of every configured file. A day nobody saved cannot be backfilled (the sources overwrite daily).

---

## Company and reviews
2.10.0, CR-011 part B. The daily outside review. **Since 2.11.0 DOM calls the reviewer itself** (founder rule 9 as changed by Dvir, 7 Oct 2026): Google Gemini, the model of `review.model` (2.11.2; default `gemini-3.8-flash` on the free tier; the env `GEMINI_MODEL` is gone), key `GEMINI_API_KEY` in the server environment only (from a Google project **without** billing while `review.tier` is `free`). The daily step `outsideReview` (`jobs.md`) builds the packet, calls the reviewer under a fixed instruction asking for at most 10 JSON items (category strategy / pricing / risk / operations / data / cost / other, severity, text), and stores the answer as feedback (provider `gemini`, the model, and the cost: 0 on the `free` tier, else Google's token counts at the model's list price in `allowed_models`). A bad key, a refusal, a timeout or an answer that is not the JSON asked for is stored as `unknown` feedback with Google's status and reason (never the key). Item texts that fail the block list are dropped and counted. `POST /reviews/{packet_id}/feedback` stays for a second opinion by hand. Request texts on these routes (`text`, `term`, `note`, `reason`) are stored in the audit row only as `[TEXT n chars]`.

**Block list.** Every text these routes take, and every packet, is checked first. A match is 422 `TEXT_BLOCKED` with `details.category` only (`secret`: a value DOM keeps as a secret, a DOM token shape, or a key shape: `pk1_` / `sk1_`, `AIza…`, `ghp_` / `github_pat_`, `sk-…` (incl. `sk-proj-`, `sk-ant-`), `xoxb-` / `xoxp-` / `xapp-`, `AKIA` + 16, `rnd_…`, and JWT-shaped `eyJ….….…` (2.15.0); `email`; `phone`: 9 or more digits, dates and money excepted; `listed_term`: a forbidden term, matched case-insensitively as a whole word, also with a trailing `s`, `es` or `'s` (2.15.0): `Shomer` blocks `shomer`, `Shomers`, `Shomer's`, `#Shomer`, `Shomer-bot`, but not `xshomerx`), **never the matched text**.

### `POST /company/document`
WRITE. Body (strict) `{text}` (Markdown, 1 to 65,536 characters). A text equal to the latest version → **200** `{version, sha256, created_at, changed: false}`; otherwise a new version → **201** `{version, sha256, created_at, changed: true}`. Returning to an older text makes a new version. **Errors:** 422 `TEXT_BLOCKED` · 422 `VALIDATION_ERROR`.

### `GET /company/document/versions`
READ. `{versions: [{version, sha256, created_at, created_by, bytes}]}`, newest first.

### `GET /company/document/versions/{n}`
READ. `{version, sha256, created_at, text, diff}`; `diff` is a unified diff against version n−1 (null for version 1). 404 `DOCUMENT_VERSION_NOT_FOUND`.

### `POST /company/forbidden-terms`
WRITE. Body (strict) `{term (2–200 characters), category? ("listed_term")}`. **201** `{id, category, created_at}`. A term is never returned by any route.

### `POST /company/forbidden-terms/{id}/retire`
WRITE (2.15.0, CR-013 F-2). Body `{reason?}`. A retired term no longer blocks; the history is kept (append-only, audited). **200** `{id, retired_at}`. **Errors:** 404 `TERM_NOT_FOUND` · 409 `TERM_ALREADY_RETIRED`.

### `GET /company/forbidden-terms`
READ. `{terms: [{id, category, created_at, retired_at}]}` (no term text).

### `POST /reviews/packet`
WRITE. `preview?` (query or body, boolean). Builds what the reviewer gets: `{kind: "daily" | "weekly", generated_at, document: {version, sha256, text (in full on a weekly packet or the first one, else null), diff_since: {from_version, diff} | null}, dom_changes: {since, service_version, settings_versions[], listing_changes[], offers[], sales[], failed_job_steps[]} (each list at most the newest 200), numbers (the /report object without any walk-away field)}`. **Weekly rule (2.15.0, CR-013 F-1; the one rule):** `kind` is `weekly`, and the document goes in full, on Sunday (IDT) or when no packet whose feedback is `ok` has carried the full document in the last 7 days; a packet whose feedback is `unknown`, or has none, never counts. **Actors (2.15.0, F-2):** every actor or token id DOM builds into a packet (`opened_by`, `created_by`, `triggered_by`, a token name …) is written as `operator`. The packet must pass the block list. `preview` → **200** `{preview: true, kind, content, sha256}`, nothing stored; otherwise **201** `{packet_id, kind, document_version, sha256, content}` and the packet is stored exactly as sent. **Errors:** 409 `DOCUMENT_MISSING` · 409 `REVIEW_COST_CAP` (`details.spent_usd`, `cap_usd`; a preview too) · 422 `TEXT_BLOCKED`.

### `POST /reviews/run`
WRITE (2.11.0). Runs a review now (for testing); only one review runs at a time (2.16.0: another call meanwhile → 409 `REVIEW_IN_PROGRESS`; the scheduled step skips with `IN_PROGRESS`): the same work as the daily step, but it never skips for "already done today". At most 3 calls per hour per WRITE token that **reach Google** (2.15.0: a refused call does not count; 429 `RATE_LIMITED`); each counts toward the monthly cap. **200:** `{packet_id, kind, status: "ok" | "unknown", items_n, new_n, repeat_n, cost_usd, dropped_n, attempts (3.1.0: tries made, 1–3), reason?}`. **Google 503 / UNAVAILABLE (3.1.0, CR-016):** retried inside the call, up to 3 tries (waits 20 s, then 40 s); never another key or model. A 429 is not retried in the call. **Errors:** 503 `REVIEWER_NOT_CONFIGURED` (no key) · 409 `REVIEW_DISABLED` (2.11.2, the switch is off) · 409 `REVIEW_COST_CAP` · 409 `DOCUMENT_MISSING` · 422 `TEXT_BLOCKED` (`details.category`).

### `GET /reviews/settings`
READ (2.11.2, CR-011 addendum C). `{enabled, model, tier: "free" | "paid", allowed_models: [{model, tier, input_usd_per_m, output_usd_per_m}], updated_at, updated_by}`. Defaults: `enabled: true`, `model: "gemini-3.8-flash"`, `tier: "free"`. Allowed: `gemini-3.8-flash` (free or paid; its paid prices are DOM's placeholders, $0.50 / $3.00 per million tokens), `gemini-3.1-pro-preview` (paid only, $2.00 / $12.00).

### `POST /reviews/settings`
WRITE (2.11.2). Body (strict, at least one of the first three): `{enabled?, model?, tier?, note? (1–300)}`. Every change is an append-only row with the old values (audited). `tier: "paid"` needs a `note` naming Dvir's approval (422 `VALIDATION_ERROR`). **200:** the new state plus `changed` (false, and no row, when nothing changed). **Errors:** 422 `REVIEW_MODEL_NOT_ALLOWED` (`details.allowed_models`) · 422 `REVIEW_MODEL_NEEDS_PAID` (a paid-only model on the free tier) · 422 `TEXT_BLOCKED` (note) · 400/422 `VALIDATION_ERROR`. A change takes effect from the next review; the feedback names the model used.

### `GET /reviews/settings/history`
READ (2.15.0, CR-013 F-10). `{changes: [{at, by, idempotency_key, old: {enabled, model, tier}, new: {enabled, model, tier}, note}]}`, newest first.

### `GET /reviews/packets/{id}`
READ. The stored packet. 404 `PACKET_NOT_FOUND`.

### `POST /reviews/{packet_id}/feedback`
WRITE. Once per packet. Body (strict), either `{status: "ok", provider, model, cost_usd (0–5 since 2.16.0; only `provider: gemini` feedback counts toward the monthly cap), items (0–50): [{category, severity: low|medium|high, text (1–2,000)}]}` or `{status: "unknown", provider, model?, cost_usd?, reason}` (the provider's status and reason, never a key). Texts pass the block list. Each item is `new` or `repeat`: compared with earlier items of the same category on their significant words (lower-case, common words dropped, numbers kept whole), a Jaccard overlap of at least 0.6 makes it a repeat of the closest (earliest on a tie) item's original. **201** `{feedback_id, items: [{id, category, severity, novelty, repeats_item_id}]}`. **Errors:** 404 `PACKET_NOT_FOUND` · 409 `FEEDBACK_EXISTS` · 422 `TEXT_BLOCKED` · 422 `VALIDATION_ERROR`.

### `GET /reviews/items`
READ. Query `view?` (`new` default: leaves out repeats of an item whose status is `rejected`; or `all`), `status?`, `limit?` (1–500, default 100). `{items: [{id, packet_id, created_at, kind, category, severity, text, novelty, repeats_item_id, status: {status, note, at} | null}]}`, newest first.

### `POST /reviews/items/{id}/status`
WRITE. Body (strict) `{status: acted|rejected|watching, note (1–500)}` (audited; the latest status counts). **201** `{item_id, status, note, at}`. 404 `REVIEW_ITEM_NOT_FOUND`.

### `GET /reviews/cost`
READ. `{month (UTC, YYYY-MM), spent_usd (the reported cost_usd summed), cap_usd (5, a constant), feedback_n, unknown_n, enabled, model, tier}` (the last three 2.11.2).

## Candidates
2.13.0, CR-012 part E. Trademark and history checks belong to the **domain**, not only to one run.

### `POST /candidates/{domain}/records`
WRITE. Body (strict) `{kind: tm_us|history|sellers (3.3.0: `record` is the `sellers` list, at most 10 `{name, url}`, fresh for `freshness_hours.sellers`, default 720 hours), record (exactly the manual record shape of `POST /screening/runs/{id}/manual` for that check), checked_by, evidence_url?, note?, checked_at? (2.16.0: ISO with an offset, not in the future, inside the kind's freshness window, else 422 `CHECKED_AT_INVALID`; default now)}` → **201** `{id, domain, kind, created_at, fresh_until}` (`fresh_until` counts from `checked_at`). **A `tm_us` record (2.16.0, CR-014 N-1)** needs an https `evidence_url`, and `record.phrases_queried` must contain the domain's own phrase (the name without `.com`, upper-case, letters and digits), else 422 `VALIDATION_ERROR` (`details.missing_phrase`). Append-only. `POST /screening/runs/{id}/manual` for `tm_us` and `history` also writes a domain record (with `source_run_id`). **Freshness:** `tm_us` 30 days, `history` 180 days, from `checked_at` (constants). **Reuse:** a live screening run of the domain uses its newest fresh record exactly as a manual row would (same conversion, the A1 prior-name rules and the brand / big-company guard included; the result is an automatic row with `fields.domain_record_id`). A manual row in the run still outranks it; while `sources.wayback` is on, the automated history check runs and never reads a record (an automated FAIL is never outranked); backtest runs never use records; a stale record counts as missing (MANUAL_REQUIRED). **Errors:** 422 `VALIDATION_ERROR` · 422 `DOMAIN_INVALID`.

### `POST /candidates/intake`
WRITE or **intake** (2.14.0, CR-012 part C). Scouts send names; the daily run screens them. Body (strict, limit 512 KB) `{names (1–100): [{domain, lane: S2|S3|S4|S6|S7, source (1–120), note? (≤ 500), words? (3.3.0, CR-022 A: 1–6 pieces `^[a-z0-9]+$` that join to the name without `.com`, else 422 `VALIDATION_ERROR` `details {index, field: words}`; every word rule then runs on these words instead of the dictionary split, and the census sibling split uses them too), sellers? (3.3.0, CR-023 B: at most 10 `{name (1–100), url (http/https)}`; an `@` → 422 `NO_PII` `field: sellers`), who_chases? (3.2.0, CR-020 B: ≤ 300, who already chases this kind of name and why they won't take this one; shown on the daily list, never scored), comps? (2–3, the `/buy` comps shape; a bad one is 422 `COMPS_INVALID`), topic? (3.10.0, CR-043: 1–60 characters, trimmed and lower-cased; absent = `<lane>:<first two content words of the split>`, words of 3+ letters)}]}`. **200** `{accepted: [{domain, intake_id, topic? (only when you sent one), flags?: [{code: "TOPIC_REUSED", topic, earlier: [{intake_id, domain, received_at}]}]}], duplicates: [{domain, first_intake_id}], removed: [{domain, reason}]}`. Removed: `DOMAIN_INVALID`, `NOT_COM`, `HAS_DIGIT` (3.8.0, CR-039: not when `words` are given and every piece with a digit is a term on the current `regime` list, such as `ets2`), `HAS_HYPHEN`, `NO_SPLIT`, `ONE_WORD`, `TOO_MANY_WORDS` (the drop-list word rules by the `bt1@v2` split; 3.3.0, CR-022 B: intake uses the **`bt1@v3`** split, the census method, while drop-list uploads keep `bt1@v2`; `NO_SPLIT` and `ONE_WORD` since 2.16.0), `OWNED` (owned or being bought), `DUPLICATE_IN_UPLOAD`, `SLD_TOO_LONG` (3.10.0: only while the active `form.max_sld_chars` is set and the name before `.com` is longer). **`TOPIC_REUSED` (3.10.0)** is a flag on an accepted name, never a rejection: another name carried the same topic in the last `intake.topic_window_days` (30) days; `earlier` lists their first intake ids and times. **Personal data (2.16.0, CR-015 I-1):** a `note`, `who_chases` or `source` with an `@`, an email or a phone-shaped number → 422 `NO_PII` (`details.index`, `field`); nothing is stored. **Comps:** a count outside 2–3 is 422 `VALIDATION_ERROR`; a bad comp is 422 `COMPS_INVALID`. A name taken in during the last **30 days** is a `duplicate` (its new source is still recorded). The audit row names the token.

### `GET /candidates/daily`
READ (2.14.0, CR-012 part B). Query `date?` (IDT day, default today), `limit?` (default 10, at most 25). The day's list is **built once by the daily run** (step `buildDailyList`, ready by about 03:30 IDT) and stored, so reads agree; a later rebuild that day keeps the first order, adds new names, and marks changes (`changed_since_first: {reason: STATE_CHANGED, changes}`; names that dropped out are in `sections.removed_since_first`). Before any build: 200 with empty `entries` and `summary.not_built: true`. **Entries** (never padded): names with final status `buy_candidate` or `would_buy` from a full-plan live run on the active settings in the last **72 hours**, no FAIL and no gating UNKNOWN, fresh `tm_us` and `history` records (2.16.0: judged from the domain records **at build time**, so records added after the run count), not owned. **Order:** exact tier first, then the money ratio at the floor (high first), then the score, then arrival. **Entry:** `{domain, rank, run_id, settings_version, lane, sources: [{source, received_at, token_name}], price: {registrar, first_year, renewal, quoted_at}, plan: {bin, floor, min_offer} (current pricing settings; never the walk-away), checks: [{check, status, reason_code}], flags, records: {tm_us, history: {result, checked_at, checked_by, source}}, comps, dates: {expiry_or_drop, buyable_from}, why: {tier, clause, ratio_at_bin, ratio_at_floor}, who_chases (3.2.0, newest intake value or null), words and split_source (3.3.0: `scout` | `dictionary`), sellers and sellers_verified_n (3.3.0: the newest intake list, and the verified count when a tier rule reads it; else null), origin (3.2.0: `intake` | `drop_list` | null), would_be_blocked: [code] (every code a real /buy would refuse with today; a /buy dry run reports the first), held}`. **Sections:** `almost_ready` (only a trademark or history record missing or stale: `RECORD_MISSING` / `NO_RECORD`, with what is missing), `upcoming` (drop names expected in 0–7 days that passed everything a registered name can pass), `removed_since_first`. **Summary:** `{screened_today, failed_by_check, waiting_for_records, unknown_by_reason, partial, why, screening_ended_partial, timeout_n, timeout_retry, dropping_n, dropping, leftovers_n, no_kept_lane_n, scout_screened_n, drop_list_screened_n, queued_waiting_n, left_for_tomorrow_n}`. A run older than 72 hours is `SCREENING_TOO_OLD`.
- **`partial` (3.2.0, CR-020 C):** only "a screening run of today was still running when the list was built". A rebuild re-reads it.
- **`screening_ended_partial`:** the screening run itself ended `partial` (deadline reached), with `timeout_n` names left `TIMEOUT`.
- **`timeout_retry`:** `{timed_out_first, resolved, still_timeout, tries: {n: count}}`. A timed-out availability lookup is retried at the end of the same run, up to 2 more times, 30 s apart, inside the deadline (CR-019 C-2).
- **`dropping`:** names in `pending_delete` / `redemption` (up to 50, with `expected_drop_date`). They are not screened and are not counted under `failed_by_check.availability` (CR-019 C-3).
- **`why` (3.2.0, CR-018 B):** one plain sentence from these facts, rebuilt on every build. Example: "Screened 30 names today: 27 already taken, 1 failed the name form, 2 timed out, 0 passed. 35 more wait for tomorrow." It also says when intake was empty, when only drop-list names were screened, how many were skipped for `NO_KEPT_LANE`, and when screening is still running.
- **`almost_ready` and `upcoming` rows** carry `who_chases`, `origin`, `run_id`, `words`, `split_source`, `sellers` and `sellers_verified_n` too.
- **Run ids and rejects (3.3.0, CR-021 B, CR-023 E):**
  - `summary.screening_run_ids` is every screening run of the day, oldest first; `screening_run_id` is the newest scheduled run, else the newest run.
  - `summary.rejected` (up to 30, total in `rejected_n`) lists each screened name that failed a gating check: `{domain, lane, origin, run_id, first_fail: {check, gate, reason_code, reason}, key_inputs}`. For `tier`, `key_inputs` is `{inputs, clauses, tier}`; for `price`, `{ev_cents, P_sale, p_passive}`.
  - `summary.failed_by_check_lane` gives counts per check and lane, and `why` names them, for example "6 failed the demand check (S6: 3, S4: 2, S3: 1)".
- **Automatic rebuild (3.2.0, CR-018 A):** when the day's intake screening run finishes after the daily build (for example after a restart), the list is rebuilt automatically (`built_by: auto`). That rebuild does not count toward the 6 manual rebuilds. Nothing in it is an approval.

### `POST /candidates/screen`
WRITE (3.3.0, CR-021). Screens the waiting names now, then rebuilds the day's list. Body (strict) `{}` or `{max_names (1–100)}` or (3.4.0, CR-026) `{domains: [1–30 names]}`.
- **`domains` (3.4.0):** only those names (no drop-list names). A waiting intake name goes in as usual. An already screened name goes in only if the active settings version differs from its last screening's, or a domain record (`tm_us`, `history`, `sellers`) or an intake row of that name was added after it. Others are listed in `skipped: [{domain, reason: NOT_CHANGED | NO_INTAKE | OWNED}]`; 202 always carries `skipped` (empty when none). All skipped → 200 `{run_id: null, names_n: 0, skipped: [...], allowance}`, and the list is still rebuilt. A name screened on demand earlier the same IDT day counts once. **Adding a record never re-queues a name by itself.** **`force: true`** (3.4.1, CR-028 A; only with `domains`, else 422 `VALIDATION_ERROR` `field: force`) re-screens the named names even when `NOT_CHANGED` would apply (`NO_INTAKE` and `OWNED` still skip). It counts against the allowance, and is stored in the run's params and the audit summary.
- **Order:** the same as the daily `intakeScreening`: scout names first (oldest first), then drop-list leftovers that fit a kept lane.
- **Allowance:** its own, at most `intake.on_demand_screen_daily_max` (default 30) distinct names per IDT day. Only names actually screened count. It never reduces the daily run's 30, and the daily run's 30 counts only its own names.
- **It touches nothing else:** no outside review or other daily step, and no effect on buying, spending or the buy hold.
- **Run:** a queue job `screen`, with steps `onDemandScreen` and `buildDailyList` (`GET /jobs/runs?job=screen`; `trigger: manual`, `triggered_by` the token name). The list it builds is `built_by: auto` and does not count toward the 6 manual rebuilds.
- **202** `{run_id (the queue run, as on /jobs/runs), names_n, allowance: {daily_max, used_today, remaining}}`. **200** `{run_id: null, names_n: 0, skipped: "NO_NAMES", allowance}` when nothing waits: no allowance used, and the list is still rebuilt.
- **Errors** (checked in this order):
  - 409 `ALREADY_RUNNING` (`details {run_id, job}`) while a daily or screen run is open;
  - 409 `ON_DEMAND_SCREEN_CAP` (`details`: the allowance and `next_allowed_at`) when the allowance is used up and the call would take no name. Since 3.9.0 a call with `domains` that names a name already screened on demand today (free, see above) is accepted (202) at the cap and re-screens only that name; a new name is still refused.
- **Replays:** a replay with the same key returns the first answer.
- **Which run ids:** list entries' `run_id` and `summary.screening_run_id(s)` are the **screening** run ids (`steps.onDemandScreen.summary.run_id`, or `steps.intakeScreening.summary.run_id` for the daily run), not the queue run id.

### `GET /candidates/closeouts`
READ or bots (5.26.0, CR-072). The day's **closeout rows** (the GoDaddy closeouts pool and the sealed Dynadot closeouts upload) or the **kept drop-list names**, minus the hard filters, ranked by the active scoring model (`POST /score`, model v12 or newer), so Buyer reads about 50 rows instead of thousands. **Read-only** (there is no POST; a bots token that tries one gets 403, a WRITE token 404): the filters and the scores are computed **once per day by the `datasave` step `scorePool`** (`jobs.md`), offline (no registry ask, no outside call), and stored with the rows; this route only reads them. Query (strict; an unknown key is 400):
- `date?` `YYYY-MM-DD`, the **data date** of the snapshot. Default: the newest date with a sealed snapshot for the source (for `drops`: the newest drop list with kept names).
- `source?` `godaddy` | `dynadot` | `all` | `drops`, default `all` (godaddy plus dynadot).
- `max_price?` **USD** (`"40"`, `"10.50"`; at most 2 decimals), $0.01..$40, default `40` (the pool cap; `max_price=40.01` is 400). The answer echoes it as `max_price_cents`. Pool rows above it are not in the pool. Ignored for `drops` (no price).
- `limit?` 1..200, default 50. `limit=500` is 400 `VALIDATION_ERROR`.

**200** `{date, source, max_price_cents, limit, rows, summary}`.
- `rows[]` (at most `limit`; sorted by `score` descending, a `null` score last, ties by lower `price_cents`, then by name): `{domain, source: "godaddy"|"dynadot"|"drops", price_cents, price ("$10.88"), ends_at, score, rank, filters_passed: true, words, score_reason?}`. `price_cents`, `price` and `ends_at` are `null` for a drop-list name (and `ends_at` for a Dynadot row without one). `words` is the selection split of the name (the `form` check's tokens). `score` is the engine probability of the model (4 decimals); a score that could not be computed is **`score: null` with `score_reason`**, never 0: `NO_ACTIVE_MODEL` (no trained model when the step ran; the row is scored by the first run after a model exists), `SCORE_FAILED`, or `NOT_SCORED_YET` (the step has not processed the row yet; it is listed after every scored row).
- `summary`: `{pool_n, filtered_by: {CODE: n}, ranked_n, returned_n, snapshot_sha256, sources_present? (all)}`. `pool_n` = rows of the source(s) for the date that are `.com` and at most `max_price`; `filtered_by` has a key for every filter code below (0 when none); **`pool_n - sum(filtered_by) = ranked_n`**; `returned_n` = `rows.length`. `snapshot_sha256` = the `sha256` of the sealed manifest as in `GET /snapshots` (`closeout_listings.json.zip` for `godaddy`, the sealed `bot_upload` for `dynadot`); a map `{godaddy, dynadot}` for `all` (only the sources present); `null` for `drops` (no snapshot).
- **Hard filters** (first failing code wins, in this order; each name is counted once): `SPELL-1` (the `form` check fails: digit outside a regime code, hyphen, a part no word list explains, too long), `BRAND-1` (the active `brand` list), `BIGCO-1` (the active `bigco` list or a current `bigco_names` row), `TM_KILL` (a current `tm_kills` term), `FORBIDDEN_TERM` (an active `/company/forbidden-terms` term inside the name), `DIGITS_OR_HYPHEN` (a digit or hyphen; the setting `closeouts_filter_digits_hyphen`, default on, changed by migration only), `OWNED` (the name is in the portfolio), `SALES_GRADED` (the name has a reported sale: `POST /engine/sales` or a sold market episode, `POST /data/sales`). A term matches a whole word or a run of consecutive words of the name (the same rule as the screening `brand_lists` check), or the whole name. Geo words (city, state) never make a brand hit.
- **`source=drops`** filters and scores the kept names of the date's drop list(s) at read time with the same functions (the list is small); a name seen on a list but already screened stays on the list.

**Errors:** 409 `SNAPSHOT_MISSING` when the date (or the default) has no sealed snapshot for the requested source, with `details {source, date?}`: it is not an empty list. For `all`, it is raised only when no source has a sealed snapshot; a day with only one of them returns that one (see `sources_present`). `source=dynadot` is 409 on every day without a sealed Dynadot closeouts upload. 400 `VALIDATION_ERROR` for a bad query. 401 without a token.

### `POST /candidates/daily/rebuild`
WRITE (2.16.0, CR-015 I-4). Rebuilds today's list now, from the runs already done and the fresh domain records (it does not wait for a run). It keeps the day's first order, adds new names and marks changes, as the nightly build does. **201** `{id, day, entries_n, almost_ready_n, upcoming_n, partial, version, rebuilds_today, rebuilds_left_today}` (3.3.1, CR-024 F-3: the contract now says what the code has always answered; read the list with `GET /candidates/daily`). At most **6 a day** (IDT) → 429 `RATE_LIMITED`.

### `GET /candidates/{domain}/records`
READ. Query `kind?`. `{domain, freshness_days: {tm_us: 30, history: 180}, freshness_hours: {sellers} (3.3.0), records: [{id, kind, record, checked_by, checked_at, evidence_url, note, created_at, source_run_id, fresh_until, fresh}]}`, newest first.

## Code index
Every code the service emits, by kind. Errors are `error.code`; warnings are strings in `warnings[]` (or `{code, level}` objects in `/report`, see `reports.md`).

**Cross-cutting errors:** `UNAUTHORIZED`, `SCOPE_FORBIDDEN`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_MISMATCH`, `IDEMPOTENCY_KEY_IN_USE`, `VALIDATION_ERROR`, `INVALID_BODY`, `INVALID_REQUEST`, `NOT_FOUND`, `INTERNAL`, `AUDIT_WRITE_FAILED`, `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED`, `JOBS_DISABLED`, `DOMAIN_BUSY`, `PRICING_SETTINGS_MISSING`.

**Buying errors:** `RENEWAL_MATH_FAIL` (422, 4.0.0), `SMALL_BUY_PRICE` (409, 3.6.0), `APPROVAL_INVALID`, `APPROVAL_EXPIRED`, `CATEGORY_REQUIRED`, `GEO_GRADE_REQUIRED`, `GRADE_NOT_GEO`, `COMPS_REQUIRED`, `COMPS_INVALID`, `SETTINGS_VERSION_CHANGED`, `MODE_INVALID`, `BUY_HOLD`, `SCREENING_PACK_REQUIRED` (409), `NO_TRANCHE` (409), `ALREADY_OWNED_OR_PENDING`, `ALREADY_IN_PORTFOLIO`, `DOMAIN_CAP_REACHED`, `NOT_AVAILABLE`, `NO_ELIGIBLE_REGISTRAR`, `PINNED_REGISTRAR_INELIGIBLE`, `PRICE_ABOVE_MAX`, `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_FUNDS` (`details.reason` may be `MONTHLY_SPEND_LIMIT`; `details.shortfall_cents` + `details.shortfall` when known), `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_DRY_RUN_AMBIGUOUS`, `REGISTRAR_REJECTED`, `PURCHASE_ABANDONED`, `PURCHASE_FAILED`, `PURCHASE_STATE_UNKNOWN` (202 body `code`).

**Listing errors:** the listing rule codes under `POST /list/{domain}`, plus `NOT_IN_PORTFOLIO`, `API_ACCESS_DISABLED`, `REGISTRAR_UNAVAILABLE`, `LISTING_CHANGED_CONCURRENTLY`, `DOMAIN_NOT_FOUND`, `DISPLAY_NAME_MISMATCH`, `REPLAN_NOTHING_LISTED`, `OVERRIDE_NEEDS_APPROVAL`, `DROP_DATE_UNKNOWN`, `LANDER_RETIRED`, `LANDER_INVALID`, `NS_INVALID`.

**Screening errors:** `RUN_NOT_RUNNING` (409, the cancel routes, 2.9.0), `RUN_RUNNING` (409, `POST /screening/packs`), `PACK_NOT_FOUND` (404, `GET /screening/packs/{id}`), `JUDGED_AT_INVALID` (422, `POST /screening/packs`), `MANUAL_REQUIRED` (409, `POST /tranches/{id}/members`), `DRAFT_NOT_ALLOWED_LIVE`, `AS_OF_LIVE_REFUSED`, `RUN_NOT_FOUND`, `NAME_NOT_IN_RUN`, `CHECK_NOT_MANUAL`, `EVIDENCE_NOT_FOUND`, `OBSERVED_AT_INVALID`, `CHECKED_AT_INVALID`, `VERDICT_RESULT_NOT_FLAG`, `VERDICT_RESULT_STALE`, `RESULT_NOT_FOUND`, `DECIDED_AT_INVALID` (1.2.0), `REGISTRAR_UNKNOWN` (and `REGISTRAR_NOT_ALLOWED`; and `SETTINGS_NOT_FOUND`, `VALIDATION_ERROR`). Result reason codes are in `selection.md` §Screening runs.

**Tranche errors:** `TRANCHE_NOT_FOUND` (404; also on a screening run), `TRANCHE_ALREADY_OPEN`, `TRANCHE_NAME_TAKEN`, `TRANCHE_CLOSED`, `TRANCHE_FULL`, `GEO_CAP`, `TRANCHE_BELOW_TARGET`, `MAIN_LANE_QUOTA`, `NOT_SCREENED_OK`, `MEMBER_NOT_FOUND` (and `NAME_NOT_IN_RUN`, `RUN_NOT_FOUND`, `DOMAIN_INVALID`, `VALIDATION_ERROR`).

**Costs and books (5.25.0, CR-070):** `DERIVED_FIELD` (422, `PUT /portfolio/{domain}/forward-costs`), `RENEWAL_PRICE_UNKNOWN` (a warning in `GET /costs/forward`, with `incomplete: true`; not an error status), `MATCHED_ASOF_FUTURE` (409, `GET /market/matched`); also `VALIDATION_ERROR`, `DOMAIN_NOT_FOUND`, `SCOPE_FORBIDDEN`.

**Scout lesson errors (5.3.0):** `LESSON_NOT_FOUND` (404, `PATCH /lessons/{id}`).

**Engine upload codes (5.10.0, CR-061):** `DB_SIZE_HIGH` (409, `POST /engine/sales` and `/engine/unsold`: the load would pass 70% of the 1 GB free-plan limit (0.5 GB before 5.13.0); the same code is a `/report` warning), `HOLDOUT_SEALED` (a per-row reject reason, not an error status).

**Visitor counter (5.18.0, CR-068):** `VISITS_DISABLED` (409), `DOMAIN_NOT_LISTED` (422), `FORWARD_NOT_ALLOWED` (422), `PUBLIC_BASE_URL_UNSET` (422); also `REGISTRAR_ERROR` (502, `POST /visits/forward`), `REGISTRAR_UNAVAILABLE`, `DOMAIN_NOT_FOUND`, `APPROVAL_INVALID`, `APPROVAL_EXPIRED`.

**Loaded data tables (5.12.0, CR-063):** `DB_SIZE_HIGH` (409) also on `POST /data/*`; per-row reject reasons are listed under `POST /data/rdap`.

**Scoring engine errors (5.5.0):** `TRAIN_TOO_SOON` (409, `POST /engine/train`; `details.next_allowed_at`), `MODEL_NOT_READY` (409, `POST /score`), and in a failed run's `error` text: `NOT_ENOUGH_DATA`, `TRAIN_TIME_BUDGET`. Upload reasons (5.4.0) are listed under `POST /engine/sales` and `/engine/unsold`.

**S8 import errors (5.8.0, CR-059, `POST /portfolio/import`):** `S8_SOURCE_INVALID` (400), `BACKORDER_SOURCE_REFUSED` (400), `S8_PRICE_CAP` (400), `S8_SLOTS_FULL` (409); also `DOMAIN_CAP_REACHED` (now also when Line 1 holds `max_domains - s8_reserved_slots` names), `ALREADY_IN_PORTFOLIO`, `NOT_IN_ACCOUNT`, `PRICING_SETTINGS_NO_PRICE_LIST` (409, current pricing settings without a price list), `ADAPTER_NOT_ENABLED`, `ACCOUNT_NOT_ELIGIBLE`, `REGISTRAR_ERROR`, `EXPIRY_UNKNOWN`, `REGISTRATION_TERM_INVALID`.

**Portfolio, outreach and pattern errors (4.0.0):** `EMAIL_CAP` (409, `POST /outreach/emails`), `PATTERN_CSV_INVALID` (422), `NO_PATTERN_UPLOAD` (404), `MAX_ONE_RENEWAL_USED` (422, `POST /portfolio/{domain}/horizon`), `LTO_NOT_ALLOWED` (422, also from `/buy` and `POST /list/{domain}` on a trend, regulation or first-expiry name), `DOMAIN_CAP_REACHED` (now 40 names).

**Export errors:** `SEDO_TEMPLATE_MISSING`, `SEDO_TEMPLATE_INVALID`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `UPLOADED_AT_INVALID`, `NO_PII`.

**Offer and sale errors:** `AMOUNT_INVALID`, `SOURCE_INVALID`, `BUYER_TYPE_INVALID`, `RECEIVED_AT_IN_FUTURE`, `HOLD_REASON_REQUIRED`, `EXTERNAL_REF_CONFLICT`, `OFFER_NOT_FOUND`, `APPROVAL_REQUIRED`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OFFER_SOLD_MISMATCH`, `OUTCOME_CHANGED_CONCURRENTLY`, `EVIDENCE_REQUIRED`, `SOLD_AT_IN_FUTURE`, `OFFER_MISMATCH`, `NOT_SELLABLE_STATE`, `SALE_ALREADY_RECORDED`, `DEAL_NOT_FOUND`.

**Response warnings (strings):** `/buy`: the post-buy list under `POST /buy` (incl. `RECONSTRUCTED`). Listing: `FLOOR_AUTO_ACCEPT`, `FLOOR_RAISED_TO_MIN`, `PRICING_EXCEPTION`, `NO_BIN_LESS_EXPOSURE`, `BIN_OVER_FAST_TRANSFER_MAX`, `HIGH_VALUE_LOW_BIN`, `CATEGORY_OTHER`, `NS_PENDING`, `NS_SET_AFTER_AMBIGUOUS`. Offers: `OFFER_ON_UNLISTED`, `OFFER_AT_OR_ABOVE_FLOOR`. Sales: `COMMISSION_UNEXPECTED`. Exports (`X-Export-Warnings`): `MIN_OFFER_BELOW_20`, `DISPLAY_NAME_IGNORED`, `AFTERNIC_ROUNDS_DOWN`, `SEDO_ROUNDS_DOWN`, `DOMAIN_NOT_ASCII`; skip reason `NOT_LISTED`.

**Market data (5.23.0, CR-075):** `APPEND_ONLY` (**405** on PUT, PATCH or DELETE of `/data/sales`; **409** on `POST /data/sales` for a stored `(name, venue, sale_date, source)` sent again with a different price). The `rejects[].reason` of a 422 `POST /data/sales`: `SOURCE_REQUIRED`, `SOURCE_NAMEBIO_FORBIDDEN`, `TIER_REQUIRED`, `TIER_INVALID`, `NAME_INVALID`, `VENUE_INVALID`, `PRICE_NOT_INTEGER_CENTS`, `DATE_INVALID`, `DATE_IN_FUTURE`, `SOURCE_URL_INVALID`, `LISTING_TYPE_INVALID`, `UNKNOWN_FIELD`. Episode labels (`outcome_rule`, not errors): `SOLD_REPORTED`, `SOLD_BIDS`, `UNSOLD_60D`, `UNSOLD_30D`, `SEEN_ONCE`, `DISAPPEARED`, `TOO_SHORT`. `/report` warning `DQ_MARKET_FAIL` (`reports.md`).

**RDAP lookup service (5.29.0, CR-074):** `LOOKUP_LIMIT` (429 on `GET /rdap/{domain}` and `POST /rdap/batch`, `details.retry_after_s` and a `Retry-After` header; also the `reason_code` of a batch row that the limit cut off). Row `reason_code` values (not errors, `registered` is `null`): `TIMEOUT`, `SOURCE_ERROR`, `RATE_LIMITED`, `LOOKUP_LIMIT`.

**Pick-proof (5.28.0, CR-073):** `PICKPROOF_SEALED` (409, `POST /pickproof/{date}/picks` from the deadline on or after the seal), `PICKPROOF_NOT_SEALED` (409, `GET /pickproof/{date}/arms` before the day is sealed), `NOT_IN_POOL` (422, picks outside the frozen pool; `details.names`); `PICKPROOF_POOL_PRUNED` (410, `GET /pickproof/{date}/pool` after the 45 days, 5.30.0); `POOL_NOT_READY` (409, any pick-proof call that would freeze a day while the closeout rows of D-1 are not yet through the daily filter step; `details.pending_n`; retry after the daily save, 5.31.0); `POOL_SOURCE_PRUNED` (410, a call that would freeze a day whose closeout rows of D-1 were already deleted by the 3-day retention; nothing is frozen, 5.35.0); `SNAPSHOT_MISSING` (409) is also returned when the evening-before snapshot of the pool is not sealed. The `UNPOWERED` status in the report is a result, not an error.

**Closeout candidates (5.26.0, CR-072):** `SNAPSHOT_MISSING` (409 from `GET /candidates/closeouts`: no sealed snapshot for that date and source). Filter codes in `summary.filtered_by` (not errors): `SPELL-1`, `BRAND-1`, `BIGCO-1`, `TM_KILL`, `FORBIDDEN_TERM`, `DIGITS_OR_HYPHEN`, `OWNED`, `SALES_GRADED`. Row `score_reason`: `NO_ACTIVE_MODEL`, `SCORE_FAILED`, `NOT_SCORED_YET`.

**Daily data save (5.21.0, CR-071):** `ROWS_LIMIT` and `PRICE_CAP` (422, `POST /snapshots/dynadot`, 5.32.0, BUG-051); `SNAPSHOT_SEALED` (a step result code in the `godaddyInventory` summary, per file: the data day's file was already saved and sealed, nothing was fetched or changed; since 5.22.0 also **HTTP 409** from `POST /snapshots/dynadot` for a sealed (kind, data_date)). Manifest `error` text prefixes: `FILE_NOT_LISTED` (the file is not in `metadata.json`), `SIZE_CAP` (a file over 200 MB is refused). Warning `DATASAVE_MISSED` (`reports.md`). RAW_EXPIRED (410) is reserved: no route re-parses or re-downloads, so it is not emitted.

**Candidate screening errors (3.3.0, CR-021):** `ON_DEMAND_SCREEN_CAP` (409; also the `onDemandScreen` skip reason), `ALREADY_RUNNING` (409; also a skip reason of the daily steps). Skip reasons of `POST /candidates/screen` `domains` (3.4.0): `NOT_CHANGED`, `NO_INTAKE`, `OWNED`. Form note (3.4.0): `SCOUT_WORDS`.

**Seller check reasons (3.3.0, CR-023 B; in `tier` `fields.sellers`, not errors):** `SELLERS_STALE`, `PARKED_OR_FOR_SALE`, `DUPLICATE_DOMAIN`, `REDIRECT_OFF_SITE`, plus the page fetch reasons of `same_name`.

**Company and review errors (2.10.0):** `REVIEW_IN_PROGRESS` (2.16.0; skip reason `IN_PROGRESS` for the steps), `TERM_NOT_FOUND`, `TERM_ALREADY_RETIRED` (2.15.0), `REVIEWER_NOT_CONFIGURED` (2.11.0), `ALREADY_DONE_TODAY` (2.11.0; a skip reason of the daily step, mapped to 409 internally; `POST /reviews/run` never returns it), `REVIEW_DISABLED`, `REVIEW_MODEL_NOT_ALLOWED`, `REVIEW_MODEL_NEEDS_PAID` (2.11.2), skip reasons `DISABLED` and `NOTHING_PENDING` (2.11.2, steps only), `TEXT_BLOCKED`, `DOCUMENT_VERSION_NOT_FOUND`, `DOCUMENT_MISSING`, `REVIEW_COST_CAP`, `PACKET_NOT_FOUND`, `FEEDBACK_EXISTS`, `REVIEW_ITEM_NOT_FOUND`.

**Selection errors:** `SETTINGS_NOT_FOUND`, `SIBLING_SCAN_NOT_FOUND`, `KEYWORD_CSV_INVALID` (422, `POST /demand/keywords`), `KEYWORD_NOT_FOUND` (404, `GET /demand/keywords`), `SETTINGS_KEY_UNKNOWN`, `SETTINGS_KEY_LOCKED`, `SETTINGS_INVALID`, `SETTINGS_NO_CHANGE`, `SETTINGS_LABEL_TAKEN`, `SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `ROWS_INVALID`, `REPLAY_EMPTY`, `HOLDOUT_CONTAMINATED`, `AS_OF_REQUIRED`, `REPLAY_INVALID_NO_GATES`, `SUITE_NOT_DEFINED`, `SUITE_UNKNOWN`, `SUITE_ALREADY_SCORED`, `SUITE_OVERLAP`, `SUITE_EMPTY`, `SUITE_MEMBERSHIP_CHANGED`, `LABELLED_NAME_CONFLICT`, `VARIANT_NOT_PREREGISTERED`, `PROFIT_REPORT_INCOMPLETE`, `REPLAY_NOT_FOUND`, `SELECTION_SETTINGS_MISSING` (500), `SELECTION_SETTINGS_INVALID` (500), `LIST_NOT_FOUND`, `LIST_NAME_INVALID`, `LIST_TERM_INVALID`, `LIST_NO_CHANGE`, `CENSUS_LIST_SIZE`, `CENSUS_LIST_INVALID`, `FORBIDDEN_FEATURE`, `BIN_REQUIRED`, `SIBLING_METHOD_NOT_FOUND`, `SIBLING_METHOD_ALREADY_APPROVED` (2.4.0), `SIBLING_METHOD_NOT_APPROVED`, `TEST_SET_NAME_TAKEN`, `TEST_SET_EMPTY`, `TEST_SET_NOT_FOUND`, `TEST_SET_NOT_READY`, `TEST_SET_ALREADY_SEALED`, `TEST_SET_NOT_SEALABLE` (2.5.0), `DROP_LIST_NAME_TAKEN`, `DROP_LIST_NOT_FOUND`, `COHORT_NAME_TAKEN`, `COHORT_EMPTY`, `COHORT_NOT_FOUND` (2.8.0). Selection warnings: `PRICING_V3_MISSING`. `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` also apply to an activation, a census list and a sibling method approval.

**`/report` warnings:** listed with levels in `reports.md`.

**`/check` exclusion reasons:** `NO_CUSTOM_NAMESERVERS`, `NO_AVAILABILITY_ACCESS`, `REGISTRAR_NOT_ALLOWED`, `ADAPTER_ERROR`, `NOT_AVAILABLE`, `PREMIUM`, `NOT_USD`, `MULTI_YEAR_MINIMUM`, `NO_FIRST_YEAR_PRICE`, `NO_RENEWAL_PRICE`. `PINNED_REGISTRAR_INELIGIBLE` may carry `exclusion_reason: NO_ADAPTER`.

**Registrar adapter codes** (in `/check` `error_code` and in `details.registrar_code`): the registrar's own code when it gives one (Porkbun e.g. `INSUFFICIENT_FUNDS`, `COST_MISMATCH`, `MONTHLY_SPEND_LIMIT_EXCEEDED`, `API_ACCESS_DISABLED`, `DOMAIN_NOT_FOUND`, `IDEMPOTENCY_KEY_IN_USE`, `IDEMPOTENCY_KEY_MISMATCH`; GoDaddy e.g. `ACCOUNT_NOT_ELIGIBLE`, `UNAUTHORIZED`, `RATE_LIMIT_EXCEEDED`, `GODADDY_HTTP_<status>`, `GODADDY_OPERATION_FAILED`), or one of the adapter's own: `REGISTRAR_TIMEOUT`, `REGISTRAR_NETWORK`, `REGISTRAR_HTTP_5XX`, `REGISTRAR_BAD_RESPONSE`, `UNKNOWN_REGISTRAR_ERROR`, `ADAPTER_FAILED`, `MULTI_YEAR_TERM`, `NOT_SUPPORTED`, `INVALID_COST`, `INVALID_IDEMPOTENCY_KEY`, `AUTO_RENEW_UPDATE_FAILED`. Timeouts, network errors, 5xx, bad responses and `IDEMPOTENCY_KEY_IN_USE` are **ambiguous** (the registrar may have acted).
