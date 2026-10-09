# Endpoints (contract v3.7.0)

Derived from the route registrations in `src/app.ts` and the zod schemas in `src/api/*.ts`. A test (`tests/contract/contract-doc.test.ts`) fails if a registered route is missing here, or if a route here isn't registered.

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
| GET | `/export/afternic.csv`, `/export/sedo.csv` | READ | Exports |
| POST | `/export/{venue}/uploaded` | WRITE | Exports |
| POST | `/offers`, `/offers/{id}/outcome` | WRITE | Offers |
| GET | `/offers`, `/report/offers` | READ | Offers |
| POST | `/sold/{domain}` | WRITE | Sales |
| GET | `/report`, `/report/pricing-review` | READ | Reports (`reports.md`) |
| GET | `/portfolio`, `/portfolio/{domain}`, `/ledger`, `/deals/{id}`, `/audit` | READ | Reads |
| GET | `/selection/settings`, `/selection/lists/{name}`, `/selection/sibling-methods/{method}`, `/selection/test-sets/{name}`, `/selection/drop-lists`, `/selection/drop-lists/{name}`, `/selection/cohorts/{name}`, `/selection/cohorts/report`, `/selection/namebio`, `/selection/replays/{id}`, `/selection/buy-hold`, `/selection/holdout-suites` | READ | Selection (`selection.md`) |
| POST | `/selection/settings`, `/selection/settings/{label}/activate`, `/selection/lists/{name}`, `/selection/sibling-methods/{method}/approve`, `/selection/test-sets`, `/selection/test-sets/{name}/seal`, `/selection/test-sets/{name}/cancel`, `/selection/drop-lists`, `/selection/cohorts`, `/selection/evaluate`, `/selection/labelled-names`, `/selection/replays`, `/selection/holdout-suites` | WRITE | Selection (`selection.md`) |
| POST | `/screening/runs`, `/screening/runs/{id}/cancel`, `/screening/runs/{id}/manual`, `/screening/runs/{id}/verdicts`, `/quotes/manual` | WRITE | Screening |
| GET | `/screening/runs/{id}`, `/screening/evidence/{id}` | READ | Screening |
| POST | `/screening/packs` | WRITE | Screening packs |
| GET | `/screening/packs`, `/screening/packs/{id}` | READ | Screening packs |
| POST | `/tranches`, `/tranches/{id}/members`, `/tranches/{id}/close` | WRITE | Tranches |
| GET | `/tranches` | READ | Tranches |
| POST | `/jobs/run` | job token | Jobs (`jobs.md`) |
| GET | `/jobs/runs` | READ | Jobs (`jobs.md`) |
| POST | `/jobs/preview` | WRITE | Jobs (`jobs.md`) |
| POST | `/company/document`, `/company/forbidden-terms`, `/company/forbidden-terms/{id}/retire` | WRITE | Company and reviews |
| GET | `/company/document/versions`, `/company/document/versions/{n}`, `/company/forbidden-terms` | READ | Company and reviews |
| POST | `/reviews/packet`, `/reviews/run`, `/reviews/settings`, `/reviews/{packet_id}/feedback`, `/reviews/items/{id}/status` | WRITE | Company and reviews |
| GET | `/reviews/packets/{id}`, `/reviews/items`, `/reviews/cost`, `/reviews/settings`, `/reviews/settings/history` | READ | Company and reviews |
| POST | `/posts`, `/posts/schema-check`, `/posts/{id}/remove`, `/posts/pause`, `/posts/burst` | WRITE | Posting to X |
| GET | `/posts`, `/posts/{id}/images/{part}/{position}` | READ | Posting to X |
| GET | `/media/{token}` | none (public) | Posting to X |
| POST | `/candidates/{domain}/records` | WRITE | Candidates |
| POST | `/candidates/intake` | WRITE or intake | Candidates |
| GET | `/candidates/daily` | READ | Candidates |
| POST | `/candidates/daily/rebuild` | WRITE | Candidates |
| POST | `/candidates/screen` | WRITE | Candidates (3.3.0) |
| GET | `/candidates/{domain}/records` | READ | Candidates |

---

## Health

### `GET /health/ping`
The only public route. No auth, no DB access (Render's health check uses it). **200** `{status: "ok", version, commit}` (3.7.0, CR-034: `commit` is the deployed git commit, null when unknown; the `deploy-live` workflow uses it).
- **200** `{"status":"ok"}`.

### `GET /openapi.json`
READ (3.3.0, CR-023 F). An OpenAPI 3.1 description of every route (3.4.0, CR-024: itself included; every POST has a `requestBody`, or `x-no-body: true` when it takes none): method, path, `x-scope` (`none`, `read`, `write`, `write or intake`, `write or job-trigger token`), a one-line summary, path parameters, and the request body's JSON schema where the route has one. A test keeps it equal to the registered routes and this route table. This contract stays the binding text; the document is a convenience.

### `GET /health`
Any valid bot token (READ or WRITE).
- **200** `{status: "ok", db: "ok", jobs: "ok" | "overdue", version: string, adapters: [{name: string, enabled: boolean}]}`; **503** with `status: "degraded"`, `db: "down"` (and `jobs: "unknown"`) when the DB can't be reached.
- `posting` (2.12.0, additive): `paused`, `not_configured`, `failed` (the latest post failed), else `ok`; `posting_reason` with the pause reason or the failure.
- `review_reason` (3.1.0): present only when `review` is `failed`: Google's status and short reason from the latest review, never a key. 3.2.0 (CR-017 N-4): `CODE: text`, where CODE is Google's status (e.g. `UNAVAILABLE`) or `HTTP <n>`; at most **200 characters**, cut at a word and ending with `…` when longer.
- `jobs` is also `overdue` (3.1.0) when `JOB_MISSED` or `JOB_RUN_INCOMPLETE` applies.
- `review` (2.11.0, additive; `disabled` and `review_model` 2.11.2): `disabled` (the switch is off), `ok` (the latest Gemini feedback is ok), `failed` (it is unknown), `not_configured` (no key), `unknown` (no review yet).
- `jobs` (2.1.0, additive) is `overdue` when no `daily` run has finished in the last 26 hours (the same rule as the `/report` warning `JOB_OVERDUE`), else `ok`. A run started by hand counts. `GET /health/ping` is unchanged (no DB).
- `version` is the service build version (`package.json`), not the contract version. The only scheduled job is the daily run at 00:05 UTC (`jobs.md`); its rows are in `GET /audit` (scope `job`). No secret, key prefix or balance is ever shown.

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

- **Checks, in order (any failure stops the call; no registrar call before check 6):** approval (`APPROVAL_INVALID` / `APPROVAL_EXPIRED`) → `proposed_listing.mode` (`MODE_INVALID`) → category (`CATEGORY_REQUIRED`) → grade (`GEO_GRADE_REQUIRED` / `GRADE_NOT_GEO`) → the listing rules for `proposed_listing` (the `/list` listing codes, plus `PRICING_FORMULA_MISMATCH`; a geo BIN must equal the grade price; under `pricing_settings` v3 also `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED`) → comps (`COMPS_REQUIRED` / `COMPS_INVALID`) → settings version (409 `SETTINGS_VERSION_CHANGED`) → **buy hold** (409 `BUY_HOLD`, real buys only, see below) → **screening pack** (409 `SCREENING_PACK_REQUIRED`, real buys only, v2.0.0) → **open tranche** (409 `NO_TRANCHE`, real buys only, v2.0.0) → not owned (409 `ALREADY_OWNED_OR_PENDING` / `ALREADY_IN_PORTFOLIO`) → domain cap (409 `DOMAIN_CAP_REACHED`) → live re-check, no cache (409 `NOT_AVAILABLE` / `NO_ELIGIBLE_REGISTRAR` / `PINNED_REGISTRAR_INELIGIBLE`) → price caps, then the cheapest two-year (409 `PRICE_ABOVE_MAX`, `details.cheapest`) → **tranche spend cap** (409 `TRANCHE_SPEND_CAP`, v2.0.0; also re-checked under the global buy lock) → POC cap $1,500 including open purchases (409 `POC_CAP_EXCEEDED`, `details` `cap_cents`, `spent_cents`, `spent`, `pending_cents`, `remaining_cents`, `remaining`, `cost_cents`) → registrar account (409 `REGISTRAR_STATE_UNKNOWN` / `REGISTRAR_AUTO_TOPUP_ON` / `REGISTRAR_FUNDS`; since 2.16.0 a real buy is also refused with `REGISTRAR_STATE_UNKNOWN` (`details.registrar_code: AUTO_TOPUP_UNKNOWN`) when the registrar doesn't say whether auto top-up is on, founder rule 6; a dry run warns `AUTO_TOPUP_UNKNOWN` instead) → the registrar's own dry run with the exact cost (409 `REGISTRAR_DRY_RUN_FAILED` with `details.registrar_code`; a price change re-quotes once and re-checks the caps; an ambiguous answer → 409 `REGISTRAR_DRY_RUN_AMBIGUOUS`).
- **Display name and drop policy (3.7.0, CR-033 G-2, G-9):**
  - **`display_name` (optional):** must equal the domain case-insensitively, else 422 `DISPLAY_NAME_MISMATCH`. Without it, the default comes from the newest intake `words`, each capitalised, else the domain. It is stored like `POST /list`'s display name and used by the next export.
  - **`drop_policy` (optional):** `after_one_renewal` (the default) or `at_first_expiry` (the `drop_date` is the first expiry; nothing renews).
  - **In the dry run and the 201:** `display_name`, `drop_policy`, `renewal_committed_cents` (0 for `at_first_expiry`) and `drop_policy_line`. `sell_plan_line` adds the policy only for `at_first_expiry`. If setting the policy fails after the purchase, the answer carries the warning `DROP_POLICY_FAILED`.
- **Comps (CR-033 G-10):** the number required is `pricing_settings` `comps_min`, which is **0 under v3** (current). An empty `comps` list is valid.
- **Small-buy exception (3.6.0, CR-030; approved by Dvir).** Optional body field `small_buy_exception: true`. When `approval_ref.text` also names the domain **and** contains "small buy" (any case), `BUY_HOLD` is skipped for that call, and only then. Two more checks apply when the flag and the words are present:
  - **Price:** the quote must not be premium, and its first year must be at most **$11.08**. Else 409 `SMALL_BUY_PRICE` `{max_first_year_cents, cost_cents, premium}`.
  - **Weekly cap:** the first-year costs of small buys in the last 7 days (rolling; open purchases count, failed and dry-run ones don't), plus this one, must be at most **$50**. Else 409 `SMALL_BUY_WEEKLY_CAP` `{cap_cents, spent_cents, cost_cents, next_allowed_at}`.

  Both limits are fixed in code; changing them needs a release. Every other gate is unchanged: screening pack, tranche, caps, approval rules, registrar checks. The hold itself (`GET /selection/buy-hold`) is never changed. The purchase row (`small_buy_exception`) and the audit summary (`small buy`) mark the buy. A dry run with the flag adds `small_buy: {cap_cents, spent_cents, cost_cents, remaining_cents}` and reports these codes as `would_be_blocked`.
- **Buy hold (v1.1.0, additive).** A domain that has a screening result is held (a run that lists the domain but has written no result for it yet counts too) when the settings version of the **latest** screening run that screened it has `buy_hold` on, is a backtest, or is no longer the active version (the same rule as `would_buy`). A real `/buy` of a held name → 409 `BUY_HOLD` (`details.settings_version`, `details.run_id`), before any registrar call. A domain that was **never screened** is not held: `/buy` behaves as in v1.0.x. A dry run is never refused; it adds `would_be_blocked: "BUY_HOLD"` to its 200. Since v2.0.0 a real `/buy` also needs a complete screening pack and an open tranche (next two bullets).
- **`dry_run: true`** stops after the checks. **200:**
  ```
  { dry_run: true, domain, check_id, registrar, first_year/renewal/two_year (money pairs),
    poc_spent (pair), poc_remaining_after (pair), domains_owned: int (owned + listed + delisted + pending purchases),
    registrar_dry_run: { would_succeed: true, cost, cost_cents },
    proposed_listing: null | <plan view, with the schedule anchored today and drop date +24 months>,
    settings_version: int, would_be_blocked: null | "BUY_HOLD" | "SCREENING_PACK_REQUIRED" | "NO_TRANCHE" | "TRANCHE_SPEND_CAP" | "SMALL_BUY_PRICE" | "SMALL_BUY_WEEKLY_CAP" (3.6.0),
    screening_pack: { status: "none" | "complete" | "incomplete", pack_id: string | null, version: int | null, issued_at: string | null },
    advisories: [string], warnings: [string] }
  ```
  Writes only the audit row and the quotes. The same key can't be reused for a real buy (different body → 409).
  **`dry_run: "strict"` (2.1.0, additive).** The same call as `dry_run: true` (same checks, same 200 body when nothing blocks, same side effects: only the audit row and the quotes), except that the first real-buy gate refusal is returned **as the error**, in the contract order: 409 `BUY_HOLD`, then `SCREENING_PACK_REQUIRED` (with `details.reason` and `details.pack_id`), then `NO_TRANCHE`, then `TRANCHE_SPEND_CAP` (after the quote is known; its `details` as for a real buy). These errors carry exactly the details a real buy gives (no `would_be_blocked` field). It never registers or charges. Use it to see each gate's real error without a purchase; use `dry_run: true` to see which gate would block.
  **Dry-run errors after the DOM gates (2.0.2, additive).** In a dry run, any error thrown after the DOM gates were evaluated (from the not-owned check on: `ALREADY_OWNED_OR_PENDING`, `DOMAIN_CAP_REACHED`, `NOT_AVAILABLE`, `NO_ELIGIBLE_REGISTRAR`, `PINNED_REGISTRAR_INELIGIBLE`, `PRICE_ABOVE_MAX`, `POC_CAP_EXCEEDED`, `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_FUNDS`, `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_DRY_RUN_AMBIGUOUS`, and so on) adds `would_be_blocked`, `screening_pack` and `advisories` to its `error.details`, with the same shapes as the 200 body. Errors before the gates (approval, validation, comps, settings version) and all real buys are unchanged. Example: with the Porkbun balance at $0, a dry run answers 409 `REGISTRAR_FUNDS` with `details.would_be_blocked: "BUY_HOLD"` (or the first blocking gate).
  **`would_be_blocked` (2.0.0, breaking type change: was the literal `"BUY_HOLD"`).** The first gate a real `/buy` would refuse on now, in this order, or `null`: `BUY_HOLD` → `SCREENING_PACK_REQUIRED` → `NO_TRANCHE` → `TRANCHE_SPEND_CAP`. `screening_pack` is the **latest** pack of the domain (`none` when it has none). `advisories` is unchanged (`"SCREENING_PACK_REQUIRED"` unless that pack is `complete`, `"PACK_NOT_FROM_LATEST_RUN"` when its run is not the domain's latest); it duplicates the gate and is kept for callers of 1.2.0.
- **Screening pack gate (2.0.0, breaking).** A real `/buy` (not a dry run) needs the domain's **latest** pack to be `complete`, from the domain's **latest** screening run, issued while its settings version was active and still **the active version**, and issued at most `pack.max_age_at_buy_hours` (default 72) before the call. Otherwise 409 `SCREENING_PACK_REQUIRED` with `details.reason` (`NO_PACK`, `INCOMPLETE`, `NOT_FROM_LATEST_RUN`, `SETTINGS_NOT_ACTIVE`, `PACK_TOO_OLD`) and `details.pack_id` (null for `NO_PACK`). Checked after `BUY_HOLD` and before any registrar call or money write. Manual imports (`import-domain`) are not affected.
- **Tranche gate (2.0.0, breaking).** A real `/buy` needs the domain to be an active member of the **open** tranche, else 409 `NO_TRANCHE`. If the tranche has a `spend_cap`, this buy's cost (the quote the buy uses) plus the cost of the tranche's purchases already made or in flight must stay at or below it, else 409 `TRANCHE_SPEND_CAP` (`details` `tranche_id`, `spend_cap_cents`, `spent_cents`, `cost_cents`). The check is repeated under the global buy lock, so two concurrent buys cannot both pass a cap that fits one. The purchase row records the tranche id. The POC caps are unchanged.
- **201 (bought):**
  ```
  { domain, registrar, order_id, charged (pair), renewal (pair), two_year (pair),
    expiry_date: YYYY-MM-DD, drop_date: YYYY-MM-DD (expiry + 1 year), renewals_used: 0,
    poc_spent_after (pair), poc_remaining (pair), domains_owned: int (owned + listed + delisted only),
    post_buy: { privacy: "on"|"off"|"unknown", auto_renew: "off"|"unconfirmed",
                lander: "<target> ns set"|"pending"|"mismatch"|"failed"|"skipped", listing: null | <plan view> },
    warnings: [string], audit_id }
  ```
  A post-buy failure never undoes the purchase; it is a warning (`PRIVACY_OFF`, `PRIVACY_UNKNOWN`, `AUTO_RENEW_FAILED`, `AUTO_RENEW_NOT_CONFIRMED`, `API_ACCESS_DISABLED`, `LANDER_CUSTOM`, `LANDER_MISMATCH`, `LANDER_FAILED`, `NS_PENDING`, `EVIDENCE_SAVE_FAILED`, `LISTING_SAVE_FAILED`, `POST_BUY_FAILED`, `TOTALS_UNAVAILABLE`, `EXPIRY_ESTIMATED`, `FOUND_IN_ACCOUNT`, `CHARGE_ABOVE_MAX`, `RECONSTRUCTED`). Warnings are strings that start with the code (`"CODE: text"`).
- **202 (state unknown):** `{status: "unknown", code: "PURCHASE_STATE_UNKNOWN", domain, purchase_id, audit_id, message}`. The registrar may have registered it; the reconciler (a step of the daily job since 2.1.0) books or fails it. Retry only with the **same** key (re-evaluated, never re-registered).
- **409 after contacting the registrar:** `REGISTRAR_REJECTED` (`details.registrar`, `details.registrar_code`; nothing charged), `PURCHASE_ABANDONED`, and on a replay `PURCHASE_FAILED` (the reconciler found it was never registered).
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
WRITE (3.7.0, CR-031 C). Records a listing made by hand on a venue, append-only. Body (strict) `{venue: afternic|sedo, listed_at (ISO, not in the future), shown?: {mode, price_usd: number|null, min_offer_usd: number|null}, evidence?: {source, ref}, note?, delisted?: bool}`. `shown` is required unless `delisted: true`. Any other field, a walk-away included, gives 422 `VALIDATION_ERROR`. **201** with the record.
- **Shown in `GET /portfolio/{domain}`** as `export.<venue>.listed_by_hand_at`, `shown` and `delisted_by_hand_at`.
- **`pending`:** false while the latest record isn't a delisting and its shown price and min offer are null or equal the current plan's BIN and min offer. A scheduled price change makes a priced listing pending again.
- **`/sold`:** its checklist names the venues listed by hand to pull the listing from.

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

### `GET /portfolio/{domain}`
READ. One domain: `registrar_state` (3.7.0, CR-033 G-6: `{auto_renew, privacy, ns, checked_at}` from the daily `registrarCheck`, read-only `domain/get` and `domain/getNs` at Porkbun; null for other registrars or before the first check), the `per_domain` row plus
`ledger` (the `/ledger` JSON rows), `purchases: [{id, state, dry_run, registrar, cost (pair), created_at}]`, `quotes` (from the latest check: `{registrar, quoted_at, available, premium, first_year (pair), renewal (pair), eligible, exclusion_reason}`), `listing_history: [{id, at, source, category, mode, bin/floor (pairs), walkaway_cents, walkaway, min_offer (pair), price_grade, pricing_source, pricing_settings_version, override, override_reason, approval_text, approval_at}]` (newest first), `schedule: [{event, due_on, status, settings_version, bin/floor (pairs), walkaway_cents, walkaway, applied_at, note}]`, `sale: null | {venue, transaction_ref, sale_price/commission/other_fees (pairs), sold_at, evidence_source, evidence_ref, confirmed, recorded_by, offer_id}`, `export: {afternic, sedo}` (each `{pending: bool, last_confirmed_upload_at, last_uploaded: null | {bin, floor, min_offer (pairs)}}`; never the walk-away), `offers` (the latest 50: `{id, amount (pair), source, received_at, buyer_type, band, routing, outcome, note}`).
- **Errors:** 404 `DOMAIN_NOT_FOUND`.

### `GET /ledger`
READ. Ledger rows in date order.
- **Query (strict):** `type` (`registration`, `renewal`, `fee`, `commission`, `sale`, `payout_fee`, `refund`, `tool`, `ai`, `adjustment`), `domain`, `from`, `to` (`YYYY-MM-DD`, inclusive), `format` (`json` default, `csv`).
- **200 JSON:** `{count, rows: [{id, date, type, domain, deal_id, amount (pair, signed: negative = money out), amount_usd: "-11.08", counterparty, receipt_ref, note}]}`. **CSV:** `formats.md` §Ledger.
- **Errors:** 400 `VALIDATION_ERROR`.

### `GET /deals/{id}`
READ. `{id, domain, strategy, status_note, created_at, approvals: [{audit_id, at, method, path, approval_text, approval_at, status_code, dry_run}]}` (audit rows with an approval that cite the deal or its domain). `dry_run` (2.2.0, additive) is `true` when that call was a dry run (`dry_run: true` or `"strict"`), so one approval used for a dry run and then the real call shows as one dry run plus one real row.
- **Errors:** 404 `DEAL_NOT_FOUND`.

### `GET /audit`
READ. Newest first.
- **Query (strict):** `since` (ISO with offset), `limit` (1–500, default 100).
- **200:** `{rows: [{id, at, token_id, token_name (2.16.0; the admin name of the token, never its secret; null for job and admin rows), scope: "read"|"write"|"intake"|"job"|"admin"|null, method, path, idempotency_key, approval_text, approval_at, request (the redacted request as a JSON object, or null; not a string), status_code, result_summary, client_ip}]}`. Job runs appear with scope `job` (`path` `/jobs/run`, or `job tick|daily` for a CLI run).
- **Errors:** 400 `VALIDATION_ERROR`.

---

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
READ. `?keywords=a,b,c` (1 to 50 words of letters, digits and hyphens; lower-cased, duplicates dropped; anything else, an empty list or an unknown query key → 400 `VALIDATION_ERROR`). Counts come from the stored nightly cache only: **this route never calls NameBio** (the source is disabled in this release: `sources.namebio` false). 200:
```
{ cache_date: "YYYY-MM-DD"|null, data_as_of: "YYYY-MM-DD"|null, source: "nightly_csv", attribution: "Data from NameBio", stale?: bool,
  status?: "UNKNOWN", reason_code?: "STALE_DATA"|"SOURCE_DISABLED",
  keywords: { <word>: { start_count, end_count, exact_count } | null } }
```
A missing or too old cache (`namebio.max_cache_age_hours`) is 200 with `stale: true`, `status: "UNKNOWN"`, `reason_code: "STALE_DATA"` and every count null; the disabled source is `SOURCE_DISABLED`. A word not in the cache is `null`. Show `attribution` on any card that uses the numbers.

### `POST /selection/lists/{name}`
WRITE. Writes version n+1 of a list; older versions stay readable. Names: the fixed lists `dictionary_extra`, `city_extra`, `trade`, `regime`, `tech`, `generic_head`, `state`, `legal`, `brand`, `bigco`, `event`, `sig_harmful_strong`, `sig_harmful_weak`, `sig_parked`, `sig_forsale`; or a **census list** `bt1_<sld>` / `s6_regime_audit`.
- **Body (strict):** `replace?: [string]` **or** `add?: [string]` and `remove?: [string]`; `note?`; `approval_ref?` (required for a census list). At most 5000 terms (body limit 64 KB). Terms are lowercased and trimmed; duplicates collapse.
- **Term shapes:** word lists `^[a-z]{2,40}$`; `brand`, `bigco`, `event` also multi-word phrases of lowercase words separated by single spaces (stored with the spaces; matched without them, so `new balance` and `newbalance` are one term); signature lists `class:phrase` with class in `adult, pharma, gambling, malware, phishing, hacked_spam, pbn, scam, trademark` (`sig_harmful_*`), `parked` (`sig_parked`), `forsale` (`sig_forsale`).
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
WRITE (2.9.0, CR-010 F-1). Cancels the set's run exactly as `POST /screening/runs/{id}/cancel`; the set's status becomes `cancelled` (its `lookups` and `timing` keep their values; a cancelled `new` set can't be sealed: 409 `TEST_SET_NOT_READY`). **Errors:** 404 `TEST_SET_NOT_FOUND` · 409 `RUN_NOT_RUNNING`.

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
READ. **`small_buy` (3.7.0, CR-033 G-3):** `{cap_cents, cap, spent_7d_cents, spent_7d, remaining_cents, remaining, next_freed_at, purchases: [{domain, cost_cents, cost, at}]}`, the rolling-7-day state of the small-buy exception. **Since 2.13.0 (CR-012 part D)** it also returns `steps: [{n, step, status: done|open|failed, evidence, next_actor: gavriel|dvir|null}]` and `ready` (steps 1–5 done), the path to a real buy, derived from the data and acting on nothing: 1 a sealed test set (Gavriel); 2 a sibling method approved (Dvir's line names it); 3 a `clears_hold` suite frozen (Gavriel; Dvir's line names the suite, each gate left out, "clears hold"; `failed` if any holdout replay of a `clears_hold` suite failed); 4 a draft with `buy_hold: false` (the active one if so, else the newest); 5 every hold suite passed on that draft (a failure sticks); 6 that draft activated (Dvir's line names its label; this lifts the hold); 7 an open production tranche, not the probe (name matching `probe`; Dvir chooses the cap). Query `settings?` (a label; default the active version). **200:** `{buy_hold (the active version's), settings_version (the version judged), target_buy_hold (that version's own buy_hold), hold_suites: [suite] and hold_suites_source: "clears_hold" | "required_suites" (2.5.0), required_suites: [{suite, replay_id | null, pass, sold_accept_rate, drop_reject_rate, n_sold, n_dropped, definition_version | null, failed_before, variants_scored}], clearable: bool}`. Per **hold suite** (2.5.0: the suites whose latest definition has `clears_hold: true`; when there are none, the active version's `holdout.required_suites` as before; the list keeps the name `required_suites`), for that settings version: **a failing holdout replay sticks** (`failed_before: true`, `pass: false`; a re-run or a changed definition never erases it). Otherwise the suite passes when a holdout replay on its **latest definition version** passes (judged cell, the active version's `holdout` settings, 0 leaking rows). `replay_id` is the failing replay, else the passing one, else the latest, else null. `variants_scored`: how many settings versions have a holdout replay of the suite (the pre-registered variants). `clearable` is true only when `target_buy_hold` is false and every suite passes. It is a report: clearing `buy_hold` is an activation that also needs Dvir's `approval_ref`. 404 `SETTINGS_NOT_FOUND`.

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
WRITE (2.9.0, CR-010 F-1). Body (strict) `{reason?}` (at most 200 characters). Stops a running run: its status becomes `cancelled`, `finished_at`, `cancelled_at` and `cancelled_by` (the token's name) are set, the results written so far are kept, and every check not yet done becomes UNKNOWN `CANCELLED`. The worker stops within seconds and a cancelled run is **never** woken or reopened (not by a read, a recompute or the daily run). **200:** `{id, status: "cancelled", cancelled_at, cancelled_by}`. **Errors:** 404 `RUN_NOT_FOUND` · 409 `RUN_NOT_RUNNING` (`details.status`).

### `GET /screening/runs/{id}`
READ. Each name has `words` and `split_source` (`scout` | `dictionary`, null before `form` ran; 3.4.0, CR-027). `?domain=` (one name), `?view=summary|full` (default `full`; `summary` leaves out `results`). **A READ poll may start background work:** a running run whose last row is older than 120 s (the service slept) continues now, and a finished run with a check to recompute is reopened (never a `cancelled` run, 2.9.0) (it writes result rows in the background); the answer does not wait for it and is not affected by it.
- **200:** `{run_id, status: "running"|"done"|"partial"|"cancelled" (2.9.0), unknowns (2.13.0, as for rescore test sets; `?domain=` filters it), lookups: {fresh, reused, unknown, rate_limited} (2.9.0, as for test sets), mode, backtest, settings_version, buy_hold, created_at, finished_at, progress: {checks_planned, checks_done}, names: [{domain, lane, final_status, first_fail: {check, gate, reason_code} | null, tier, short, flags: [check], pending_manual: [check], not_implemented: [check], verdicts: [{check, result_id, verdict, reason, decided_by, decided_at}] (1.2.0), source_lane: "expired_drop"|"fresh"|"unknown"|null, results?: [{check, gate, rule_ids, status, reason_code, reason, fields, data_as_of, checked_at, cached, source, settings_version, list_versions, duration_ms, upstream_calls, evidence: [id]}]}], funnel}`. `results` holds the latest result per check, in the order written. `tier` is the tier check's tier (null until that check exists); `short` is the form check's `short`; `source_lane` is the `history` check's inferred source lane (null until that check has a result). `verdicts` (1.2.0) lists the latest FLAG verdict of each result row that is **in force now** (a verdict on a superseded row is not shown); it never changes `final_status` or `flags`.
- Statuses, final statuses, the funnel and the reason codes: `selection.md` §Screening runs.
- **Errors:** 404 `RUN_NOT_FOUND` · 400 `VALIDATION_ERROR` (bad query).

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

**Tranche view** (returned by every tranche route): `{id: "trn_<12 hex>", name, status: "open"|"closed", opened_at, opened_by, closed_at, closed_by, opened_under (the settings version active when it opened), spend_cap_cents, spend_cap, committed_cents, committed, members: [{domain, lane, is_geo, main_lane: bool, run_id, added_at, est_cost_cents}], counts: {members, geo, main_lane, non_main}, close_report: null | {...}}`. `committed` is the sum of the members' `est_cost`. Members that were removed are not listed.

### `GET /tranches`
READ. `{tranches: [<tranche view>]}`, newest first (open and closed).

### `POST /tranches`
WRITE. Body (strict): `{name: string (unique), spend_cap?: USD number (at most the POC cap, else 422 `VALIDATION_ERROR`)}`. **201** the tranche view. Errors: 409 `TRANCHE_ALREADY_OPEN` (`details.open_tranche`) · 409 `TRANCHE_NAME_TAKEN` · 422 `VALIDATION_ERROR`. `spend_cap` is a limit on the sum of the members' `est_cost` (it is not the POC cap; the POC cap on `/buy` is unchanged and does not count renewals).

### `POST /tranches/{id}/members`
WRITE. Body (strict): `{action: "add"|"remove", domain, run_id?, est_cost?: USD number (at most the POC cap, else 422 `VALIDATION_ERROR`)}`. **200** the tranche view (`add` adds `duplicate: bool`).
- **add** (`run_id` required): the name must be in that run (404 `NAME_NOT_IN_RUN`; 404 `RUN_NOT_FOUND`), the run must not be a backtest (409 `NOT_SCREENED_OK`, `details.reason: "BACKTEST"`) and must have used the **full** lane plan: a run with a `checks` subset, or any lane plan narrower than the settings' plan, never admits a name (409 `NOT_SCREENED_OK`, `details.reason: "PARTIAL_PLAN"`); its `history` result must not be MANUAL_REQUIRED (409 `MANUAL_REQUIRED`, `details.check: "history"`: record HIST-2 by hand and screen the name again; a rejected or invalid name gets its own refusal instead), and its final status there must be `would_buy`, `buy_candidate` or `pending_manual` (409 `NOT_SCREENED_OK`, `details.final_status`, `details.first_fail`). Adding a name already in the tranche is a 200 with `duplicate: true`. Checks in order: 409 `TRANCHE_CLOSED` → duplicate → 409 `NOT_SCREENED_OK` → 409 `TRANCHE_FULL` (members = `tranche.size`) → 409 `GEO_CAP` (geo members = `tranche.geo_max`; checked on **every** addition, so Gavriel adds geo names in Ratio order and the lowest-ranked is the one refused) → 409 `TRANCHE_SPEND_CAP` (when the tranche has a spend cap, `est_cost` is required, else 422 `VALIDATION_ERROR`, and the sum may not pass the cap). A name is a geo member when its lane is S2.
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
The job token, or (2.3.0) a WRITE bot token, at most 4 calls per hour per WRITE token (see `jobs.md`). Body `{"job": "tick" | "daily"}` (strict; anything else → 422 `VALIDATION_ERROR`). Needs `Idempotency-Key`. **202 (3.0.0)** `{run_id, job, status: "queued" | "running", skipped, steps: [name]}`: the steps run in the background from a queue (`jobs.md`); read the results in `GET /jobs/runs`. **503** `JOBS_DISABLED` when the job token isn't configured.

---

### `GET /jobs/runs`
READ (any `GET` token; not the job token). Query (all optional; an unknown parameter or a bad value → **400** `VALIDATION_ERROR`): `job` (`tick` | `daily`), `since` (ISO 8601 with an offset; runs that finished at or after it), `limit` (1 to 500, default 50). **200:**
```
{ runs: [ { run_id: string | null (3.0.0; null for older and CLI runs), status: "queued" | "running" | "finished" (3.0.0), job, trigger: "scheduled" | "manual" | "cli", triggered_by: string | null, scheduled_for: ISO | null,
            started_at, finished_at, skipped: bool, ok: bool,
            steps: { <step>: { ok (null while queued or running), status: queued|running|done|failed|skipped, attempts, ms, started_at, finished_at, skipped?, error?, summary } } } ],   // unfinished runs first, then newest first
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

## Posting to X
2.12.0, CR-011 part A and addendum A. Founder rule 10 (changed by Dvir, 7 Oct 2026): the service publishes to the company's own X account **through Buffer only** and never replies, quotes, likes, follows or messages anyone; no route for any of that exists. Key `BUFFER_API_KEY` (server env only); channel `BUFFER_CHANNEL_ID`, or the account's only X channel. Request texts are audited as `[TEXT n chars]`, images as `[IMAGE n chars]`.

**Checks (every post, dry run included; a dry run answers 200 with `ok: false` and the reasons, only a real post answers 422, 2.15.0 doc fix):** each part's text has an X weighted length of at most 280 (a link counts 23, CJK and emoji 2, other characters 1: a simplified form of X's rule) → 422 `POST_TOO_LONG` (`details.length`, `limit`, `part`); text and alt text pass the block list → 422 `TEXT_BLOCKED` (`category`, never the match). **Images:** up to 4 per part, PNG or JPEG (by content), at most 5 MB, 4 to 8,192 px each side, alt text 1 to 1,000 characters; metadata is stripped before storing (JPEG APP1–APP15 and comments, which also drops ICC colour profiles; PNG text, time and EXIF chunks and every other non-essential chunk). Any image problem → 422 `POST_INVALID` with `details.images: [{part, position, reason (IMAGE_TYPE, IMAGE_CORRUPT, IMAGE_TOO_LARGE, IMAGE_DIMENSIONS, ALT_MISSING, ALT_TOO_LONG, ALT_BLOCKED, TOO_MANY_IMAGES), category?}]`.

**Daily cap:** 1 post per IDT day (a thread counts as one), or the burst cap set for that day (2–6). A failed post uses no allowance.

### `POST /posts`
WRITE. Body (strict) `{text, images?: [{data_base64, alt}], thread?: [{text, images?}] (up to 2 more parts), dry_run?}`; body limit 40 MB on this route. **Dry run** → **200** `{dry_run: true, ok, parts: [{part, length, limit, ok, reason? (TOO_LONG or TEXT_BLOCKED), category?}], images: [{part, position, ok, reason?, width, height, bytes}], allowance: {today_cap, used_today, remaining}}`: nothing is stored, sent or counted. **Real:** the images are stored and served at `/media/{token}`, then Buffer is asked to publish now (`shareNow`, images with alt text in order, the thread parts). **No double post (2.16.0):** under one database lock the pause and the cap are checked and a `pending` row is written **before** Buffer is called. Buffer success → `posted`; a refusal or 4xx → `failed` (no allowance); a lost answer, timeout or 5xx → `unknown` (it **counts** toward the cap, since the post may be live; the daily `postsRefresh` resolves it with Buffer when it can, and a `pending` row older than 15 minutes becomes `unknown`). From the `pending` row on, the `Idempotency-Key` keeps its answer: a retry with the same key replays it and never calls Buffer again. **201** `{post_id, buffer_post_id, status: "posted", external_link (may be null until Buffer reports it), images: [{part, position, sha256}], allowance}`. **Errors:** 409 `POSTING_PAUSED` · 503 `POSTING_NOT_CONFIGURED` · 409 `POST_DAILY_CAP` (`details.next_allowed_at`) · 422 `POST_TOO_LONG` / `POST_INVALID` / `TEXT_BLOCKED` · 502 `POST_FAILED` (`details`: `outcome` `failed` or `unknown` (2.16.0), `post_id` when `unknown`, `step` channel or create, `kind` rate_limited / refused / unavailable, Buffer's `status`, `message`, `retry_after`; the post is recorded as `failed`). **Known limit:** the post record is written after Buffer answers; a server crash in that moment would leave a published post without a record (and a retry with the same key could post again).

### `POST /posts/schema-check`
WRITE (3.2.0, CR-017 R-A2). Asks Buffer's GraphQL API for its input types (introspection: read-only, publishes nothing) and checks the exact `createPost` input DOM would send for a sample post with one image and a thread part: every field exists, list and nesting match, required fields are present, enum values are valid. **Body (3.3.0, CR-022 F-2):** empty, which checks a fixed sample, or the same body as `POST /posts` (same limit and validation, same 422 codes), which checks the input DOM would build for **that** post (images as placeholder `/media` URLs; nothing is stored or sent). **200** `{ok, problems: [string], checked: "post" | "sample" (3.3.0), checked_types: [string], types (3.2.1): {<TypeName>: {kind, fields?: {<field>: <type, e.g. String!>}, values?: [enum values]}}}` (Buffer's own definitions of every input type reachable from `CreatePostInput`, following only X's metadata, at most 25; names and types only). The answer is cached in memory for 1 hour; a mismatch is not cached. **Errors:** 503 `POSTING_NOT_CONFIGURED` without a Buffer key; 502 `POST_FAILED` (`details.step: "schema"`) when Buffer can't be asked. **A real `POST /posts` runs the same check first (3.2.0):** a mismatch is 502 `POST_FAILED` with `details {step: "schema", outcome: "failed", problems, checked_types}`, nothing is sent to Buffer, no post row is written (the day's allowance is unused) and the Idempotency-Key is released. The input DOM sends (3.2.2, from Buffer's live schema) is `{channelId, text, mode: shareNow, schedulingType: automatic, needsApproval: false, assets: [{image: {url, metadata: {altText}}}] (always present, may be empty), metadata: {twitter: {thread: [{text, assets}]}}}`.

### `GET /posts`
READ. Query `limit?` (1–200, default 50). `{posting, allowance, posts: [{post_id, created_at, text, thread, status: pending|posted|failed|unknown|removed (2.16.0), buffer_post_id, external_link, sent_at, error, removed_at, removed_reason, images: [{part, position, mime, bytes, width, height, sha256, alt}]}]}`, newest first. Reach and replies are not read (Buffer's free plan; Dvir accepted).

**Allowance and retries (3.2.0, CR-017 R-A3/R-A4):** a `failed` post does not count toward `allowance.used_today` (only `posted`, `unknown` and `removed` count). **Vendor test posts (3.3.1, CR-025)** never count: DOM lists its own test posts in an append-only exclusion list, by a migration only (there is no API for it, so no caller can free a slot). The first is DOM's 2026-10-09 04:13 IDT test post `pst_c1eaba454a6a`. To retry after a failure, send the same body with a **new** Idempotency-Key; the old key replays the old 502. The failed row stays as history. `/health` `posting` follows the latest post, so a successful post makes it `ok` again.

### `GET /posts/{id}/images/{part}/{position}`
READ. The stored image bytes. 404 `NOT_FOUND` (also when the bytes were not kept, after a restore: the backup leaves image bytes out).

### `POST /posts/{id}/remove`
WRITE. Body `{reason (1–300), marked_removed_by_hand?}`. Only a `posted` post (else 409 `POST_NOT_REMOVABLE`; an unknown id is 404 `NOT_FOUND`). DOM asks Buffer to delete it: success → **200** `{..., status: "removed", deleted_on_buffer: true}`; Buffer refuses → 409 `POST_DELETE_UNSUPPORTED` (Buffer's message), unless `marked_removed_by_hand: true` (Dvir deleted it on X), which marks it removed. 503 `POSTING_NOT_CONFIGURED` without a key (unless marked by hand).

### `POST /posts/pause`
WRITE. `{paused, reason?}` → **200** the state. While paused a real post is 409 `POSTING_PAUSED`; a dry run still works.

### `POST /posts/burst`
WRITE. `{day (today or later, IDT), cap (2–6; 6 since 3.5.0, CR-029 A)}` → **201**. Phase 1's launch posts on one day. The cap is the day's total, so posts already made that day count toward it.

### `GET /media/{token}`
**Public** (no token). The image bytes with their type and `Cache-Control: public, max-age` = at most 3600 and never past the link's expiry (2.16.0), for 7 days after the post; then 404 `NOT_FOUND`. At most 120 a minute per client IP → 429 `RATE_LIMITED`. Writes nothing. A READ or intake token on `POST /posts` is refused (403) before the body is read.

## Candidates
2.13.0, CR-012 part E. Trademark and history checks belong to the **domain**, not only to one run.

### `POST /candidates/{domain}/records`
WRITE. Body (strict) `{kind: tm_us|history|sellers (3.3.0: `record` is the `sellers` list, at most 10 `{name, url}`, fresh for `freshness_hours.sellers`, default 720 hours), record (exactly the manual record shape of `POST /screening/runs/{id}/manual` for that check), checked_by, evidence_url?, note?, checked_at? (2.16.0: ISO with an offset, not in the future, inside the kind's freshness window, else 422 `CHECKED_AT_INVALID`; default now)}` → **201** `{id, domain, kind, created_at, fresh_until}` (`fresh_until` counts from `checked_at`). **A `tm_us` record (2.16.0, CR-014 N-1)** needs an https `evidence_url`, and `record.phrases_queried` must contain the domain's own phrase (the name without `.com`, upper-case, letters and digits), else 422 `VALIDATION_ERROR` (`details.missing_phrase`). Append-only. `POST /screening/runs/{id}/manual` for `tm_us` and `history` also writes a domain record (with `source_run_id`). **Freshness:** `tm_us` 30 days, `history` 180 days, from `checked_at` (constants). **Reuse:** a live screening run of the domain uses its newest fresh record exactly as a manual row would (same conversion, the A1 prior-name rules and the brand / big-company guard included; the result is an automatic row with `fields.domain_record_id`). A manual row in the run still outranks it; while `sources.wayback` is on, the automated history check runs and never reads a record (an automated FAIL is never outranked); backtest runs never use records; a stale record counts as missing (MANUAL_REQUIRED). **Errors:** 422 `VALIDATION_ERROR` · 422 `DOMAIN_INVALID`.

### `POST /candidates/intake`
WRITE or **intake** (2.14.0, CR-012 part C). Scouts send names; the daily run screens them. Body (strict, limit 512 KB) `{names (1–100): [{domain, lane: S2|S3|S4|S6|S7, source (1–120), note? (≤ 500), words? (3.3.0, CR-022 A: 1–6 pieces `^[a-z0-9]+$` that join to the name without `.com`, else 422 `VALIDATION_ERROR` `details {index, field: words}`; every word rule then runs on these words instead of the dictionary split, and the census sibling split uses them too), sellers? (3.3.0, CR-023 B: at most 10 `{name (1–100), url (http/https)}`; an `@` → 422 `NO_PII` `field: sellers`), who_chases? (3.2.0, CR-020 B: ≤ 300, who already chases this kind of name and why they won't take this one; shown on the daily list, never scored), comps? (2–3, the `/buy` comps shape; a bad one is 422 `COMPS_INVALID`)}]}`. **200** `{accepted: [{domain, intake_id}], duplicates: [{domain, first_intake_id}], removed: [{domain, reason}]}`. Removed: `DOMAIN_INVALID`, `NOT_COM`, `HAS_DIGIT`, `HAS_HYPHEN`, `NO_SPLIT`, `ONE_WORD`, `TOO_MANY_WORDS` (the drop-list word rules by the `bt1@v2` split; 3.3.0, CR-022 B: intake uses the **`bt1@v3`** split, the census method, while drop-list uploads keep `bt1@v2`; `NO_SPLIT` and `ONE_WORD` since 2.16.0), `OWNED` (owned or being bought), `DUPLICATE_IN_UPLOAD`. **Personal data (2.16.0, CR-015 I-1):** a `note`, `who_chases` or `source` with an `@`, an email or a phone-shaped number → 422 `NO_PII` (`details.index`, `field`); nothing is stored. **Comps:** a count outside 2–3 is 422 `VALIDATION_ERROR`; a bad comp is 422 `COMPS_INVALID`. A name taken in during the last **30 days** is a `duplicate` (its new source is still recorded). The audit row names the token.

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
  - 409 `ON_DEMAND_SCREEN_CAP` (`details`: the allowance and `next_allowed_at`).
- **Replays:** a replay with the same key returns the first answer.
- **Which run ids:** list entries' `run_id` and `summary.screening_run_id(s)` are the **screening** run ids (`steps.onDemandScreen.summary.run_id`, or `steps.intakeScreening.summary.run_id` for the daily run), not the queue run id.

### `POST /candidates/daily/rebuild`
WRITE (2.16.0, CR-015 I-4). Rebuilds today's list now, from the runs already done and the fresh domain records (it does not wait for a run). It keeps the day's first order, adds new names and marks changes, as the nightly build does. **201** `{id, day, entries_n, almost_ready_n, upcoming_n, partial, version, rebuilds_today, rebuilds_left_today}` (3.3.1, CR-024 F-3: the contract now says what the code has always answered; read the list with `GET /candidates/daily`). At most **6 a day** (IDT) → 429 `RATE_LIMITED`.

### `GET /candidates/{domain}/records`
READ. Query `kind?`. `{domain, freshness_days: {tm_us: 30, history: 180}, freshness_hours: {sellers} (3.3.0), records: [{id, kind, record, checked_by, checked_at, evidence_url, note, created_at, source_run_id, fresh_until, fresh}]}`, newest first.

## Code index
Every code the service emits, by kind. Errors are `error.code`; warnings are strings in `warnings[]` (or `{code, level}` objects in `/report`, see `reports.md`).

**Cross-cutting errors:** `UNAUTHORIZED`, `SCOPE_FORBIDDEN`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_MISMATCH`, `IDEMPOTENCY_KEY_IN_USE`, `VALIDATION_ERROR`, `INVALID_BODY`, `INVALID_REQUEST`, `NOT_FOUND`, `INTERNAL`, `AUDIT_WRITE_FAILED`, `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED`, `JOBS_DISABLED`, `DOMAIN_BUSY`, `PRICING_SETTINGS_MISSING`.

**Buying errors:** `DROP_POLICY_FAILED` (a 201 warning, 3.7.0), `SMALL_BUY_PRICE`, `SMALL_BUY_WEEKLY_CAP` (409, 3.6.0), `APPROVAL_INVALID`, `APPROVAL_EXPIRED`, `CATEGORY_REQUIRED`, `GEO_GRADE_REQUIRED`, `GRADE_NOT_GEO`, `COMPS_REQUIRED`, `COMPS_INVALID`, `SETTINGS_VERSION_CHANGED`, `MODE_INVALID`, `BUY_HOLD`, `SCREENING_PACK_REQUIRED` (409), `NO_TRANCHE` (409), `ALREADY_OWNED_OR_PENDING`, `ALREADY_IN_PORTFOLIO`, `DOMAIN_CAP_REACHED`, `NOT_AVAILABLE`, `NO_ELIGIBLE_REGISTRAR`, `PINNED_REGISTRAR_INELIGIBLE`, `PRICE_ABOVE_MAX`, `POC_CAP_EXCEEDED`, `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_FUNDS` (`details.reason` may be `MONTHLY_SPEND_LIMIT`; `details.shortfall_cents` + `details.shortfall` when known), `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_DRY_RUN_AMBIGUOUS`, `REGISTRAR_REJECTED`, `PURCHASE_ABANDONED`, `PURCHASE_FAILED`, `PURCHASE_STATE_UNKNOWN` (202 body `code`).

**Listing errors:** the listing rule codes under `POST /list/{domain}`, plus `NOT_IN_PORTFOLIO`, `API_ACCESS_DISABLED`, `REGISTRAR_UNAVAILABLE`, `LISTING_CHANGED_CONCURRENTLY`, `DOMAIN_NOT_FOUND`, `DISPLAY_NAME_MISMATCH`, `REPLAN_NOTHING_LISTED`, `OVERRIDE_NEEDS_APPROVAL`, `DROP_DATE_UNKNOWN`, `LANDER_RETIRED`, `LANDER_INVALID`, `NS_INVALID`.

**Screening errors:** `RUN_NOT_RUNNING` (409, the cancel routes, 2.9.0), `RUN_RUNNING` (409, `POST /screening/packs`), `PACK_NOT_FOUND` (404, `GET /screening/packs/{id}`), `JUDGED_AT_INVALID` (422, `POST /screening/packs`), `MANUAL_REQUIRED` (409, `POST /tranches/{id}/members`), `DRAFT_NOT_ALLOWED_LIVE`, `AS_OF_LIVE_REFUSED`, `RUN_NOT_FOUND`, `NAME_NOT_IN_RUN`, `CHECK_NOT_MANUAL`, `EVIDENCE_NOT_FOUND`, `OBSERVED_AT_INVALID`, `CHECKED_AT_INVALID`, `VERDICT_RESULT_NOT_FLAG`, `VERDICT_RESULT_STALE`, `RESULT_NOT_FOUND`, `DECIDED_AT_INVALID` (1.2.0), `REGISTRAR_UNKNOWN` (and `REGISTRAR_NOT_ALLOWED`; and `SETTINGS_NOT_FOUND`, `VALIDATION_ERROR`). Result reason codes are in `selection.md` §Screening runs.

**Tranche errors:** `TRANCHE_NOT_FOUND` (404; also on a screening run), `TRANCHE_ALREADY_OPEN`, `TRANCHE_NAME_TAKEN`, `TRANCHE_CLOSED`, `TRANCHE_FULL`, `GEO_CAP`, `TRANCHE_SPEND_CAP`, `TRANCHE_BELOW_TARGET`, `MAIN_LANE_QUOTA`, `NOT_SCREENED_OK`, `MEMBER_NOT_FOUND` (and `NAME_NOT_IN_RUN`, `RUN_NOT_FOUND`, `DOMAIN_INVALID`, `VALIDATION_ERROR`).

**Export errors:** `SEDO_TEMPLATE_MISSING`, `SEDO_TEMPLATE_INVALID`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `UPLOADED_AT_INVALID`, `NO_PII`.

**Offer and sale errors:** `AMOUNT_INVALID`, `SOURCE_INVALID`, `BUYER_TYPE_INVALID`, `RECEIVED_AT_IN_FUTURE`, `HOLD_REASON_REQUIRED`, `EXTERNAL_REF_CONFLICT`, `OFFER_NOT_FOUND`, `APPROVAL_REQUIRED`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OFFER_SOLD_MISMATCH`, `OUTCOME_CHANGED_CONCURRENTLY`, `EVIDENCE_REQUIRED`, `SOLD_AT_IN_FUTURE`, `OFFER_MISMATCH`, `NOT_SELLABLE_STATE`, `SALE_ALREADY_RECORDED`, `DEAL_NOT_FOUND`.

**Response warnings (strings):** `/buy`: the post-buy list under `POST /buy` (incl. `RECONSTRUCTED`). Listing: `FLOOR_AUTO_ACCEPT`, `FLOOR_RAISED_TO_MIN`, `PRICING_EXCEPTION`, `NO_BIN_LESS_EXPOSURE`, `BIN_OVER_FAST_TRANSFER_MAX`, `HIGH_VALUE_LOW_BIN`, `CATEGORY_OTHER`, `NS_PENDING`, `NS_SET_AFTER_AMBIGUOUS`. Offers: `OFFER_ON_UNLISTED`, `OFFER_AT_OR_ABOVE_FLOOR`. Sales: `COMMISSION_UNEXPECTED`. Exports (`X-Export-Warnings`): `MIN_OFFER_BELOW_20`, `DISPLAY_NAME_IGNORED`, `AFTERNIC_ROUNDS_DOWN`, `SEDO_ROUNDS_DOWN`, `DOMAIN_NOT_ASCII`; skip reason `NOT_LISTED`.

**Posting errors (2.12.0):** `POST_INVALID`, `POST_TOO_LONG`, `POSTING_PAUSED`, `POSTING_NOT_CONFIGURED`, `POST_DAILY_CAP`, `POST_FAILED`, `POST_NOT_REMOVABLE`, `POST_DELETE_UNSUPPORTED`.

**Candidate screening errors (3.3.0, CR-021):** `ON_DEMAND_SCREEN_CAP` (409; also the `onDemandScreen` skip reason), `ALREADY_RUNNING` (409; also a skip reason of the daily steps). Skip reasons of `POST /candidates/screen` `domains` (3.4.0): `NOT_CHANGED`, `NO_INTAKE`, `OWNED`. Form note (3.4.0): `SCOUT_WORDS`.

**Seller check reasons (3.3.0, CR-023 B; in `tier` `fields.sellers`, not errors):** `SELLERS_STALE`, `PARKED_OR_FOR_SALE`, `DUPLICATE_DOMAIN`, `REDIRECT_OFF_SITE`, plus the page fetch reasons of `same_name`.

**Company and review errors (2.10.0):** `REVIEW_IN_PROGRESS` (2.16.0; skip reason `IN_PROGRESS` for the steps), `TERM_NOT_FOUND`, `TERM_ALREADY_RETIRED` (2.15.0), `REVIEWER_NOT_CONFIGURED` (2.11.0), `ALREADY_DONE_TODAY` (2.11.0; a skip reason of the daily step, mapped to 409 internally; `POST /reviews/run` never returns it), `REVIEW_DISABLED`, `REVIEW_MODEL_NOT_ALLOWED`, `REVIEW_MODEL_NEEDS_PAID` (2.11.2), skip reasons `DISABLED` and `NOTHING_PENDING` (2.11.2, steps only), `TEXT_BLOCKED`, `DOCUMENT_VERSION_NOT_FOUND`, `DOCUMENT_MISSING`, `REVIEW_COST_CAP`, `PACKET_NOT_FOUND`, `FEEDBACK_EXISTS`, `REVIEW_ITEM_NOT_FOUND`.

**Selection errors:** `SETTINGS_NOT_FOUND`, `SETTINGS_KEY_UNKNOWN`, `SETTINGS_KEY_LOCKED`, `SETTINGS_INVALID`, `SETTINGS_NO_CHANGE`, `SETTINGS_LABEL_TAKEN`, `SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `ROWS_INVALID`, `REPLAY_EMPTY`, `HOLDOUT_CONTAMINATED`, `AS_OF_REQUIRED`, `REPLAY_INVALID_NO_GATES`, `SUITE_NOT_DEFINED`, `SUITE_UNKNOWN`, `SUITE_ALREADY_SCORED`, `SUITE_OVERLAP`, `SUITE_EMPTY`, `SUITE_MEMBERSHIP_CHANGED`, `LABELLED_NAME_CONFLICT`, `VARIANT_NOT_PREREGISTERED`, `PROFIT_REPORT_INCOMPLETE`, `REPLAY_NOT_FOUND`, `SELECTION_SETTINGS_MISSING` (500), `SELECTION_SETTINGS_INVALID` (500), `LIST_NOT_FOUND`, `LIST_NAME_INVALID`, `LIST_TERM_INVALID`, `LIST_NO_CHANGE`, `CENSUS_LIST_SIZE`, `CENSUS_LIST_INVALID`, `FORBIDDEN_FEATURE`, `BIN_REQUIRED`, `SIBLING_METHOD_NOT_FOUND`, `SIBLING_METHOD_ALREADY_APPROVED` (2.4.0), `SIBLING_METHOD_NOT_APPROVED`, `TEST_SET_NAME_TAKEN`, `TEST_SET_EMPTY`, `TEST_SET_NOT_FOUND`, `TEST_SET_NOT_READY`, `TEST_SET_ALREADY_SEALED`, `TEST_SET_NOT_SEALABLE` (2.5.0), `DROP_LIST_NAME_TAKEN`, `DROP_LIST_NOT_FOUND`, `COHORT_NAME_TAKEN`, `COHORT_EMPTY`, `COHORT_NOT_FOUND` (2.8.0). Selection warnings: `PRICING_V3_MISSING`. `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` also apply to an activation, a census list and a sibling method approval.

**`/report` warnings:** listed with levels in `reports.md`.

**`/check` exclusion reasons:** `NO_CUSTOM_NAMESERVERS`, `NO_AVAILABILITY_ACCESS`, `REGISTRAR_NOT_ALLOWED`, `ADAPTER_ERROR`, `NOT_AVAILABLE`, `PREMIUM`, `NOT_USD`, `MULTI_YEAR_MINIMUM`, `NO_FIRST_YEAR_PRICE`, `NO_RENEWAL_PRICE`. `PINNED_REGISTRAR_INELIGIBLE` may carry `exclusion_reason: NO_ADAPTER`.

**Registrar adapter codes** (in `/check` `error_code` and in `details.registrar_code`): the registrar's own code when it gives one (Porkbun e.g. `INSUFFICIENT_FUNDS`, `COST_MISMATCH`, `MONTHLY_SPEND_LIMIT_EXCEEDED`, `API_ACCESS_DISABLED`, `DOMAIN_NOT_FOUND`, `IDEMPOTENCY_KEY_IN_USE`, `IDEMPOTENCY_KEY_MISMATCH`; GoDaddy e.g. `ACCOUNT_NOT_ELIGIBLE`, `UNAUTHORIZED`, `RATE_LIMIT_EXCEEDED`, `GODADDY_HTTP_<status>`, `GODADDY_OPERATION_FAILED`), or one of the adapter's own: `REGISTRAR_TIMEOUT`, `REGISTRAR_NETWORK`, `REGISTRAR_HTTP_5XX`, `REGISTRAR_BAD_RESPONSE`, `UNKNOWN_REGISTRAR_ERROR`, `ADAPTER_FAILED`, `MULTI_YEAR_TERM`, `NOT_SUPPORTED`, `INVALID_COST`, `INVALID_IDEMPOTENCY_KEY`, `AUTO_RENEW_UPDATE_FAILED`. Timeouts, network errors, 5xx, bad responses and `IDEMPOTENCY_KEY_IN_USE` are **ambiguous** (the registrar may have acted).
