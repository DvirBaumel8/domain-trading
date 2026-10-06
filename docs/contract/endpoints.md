# Endpoints (contract v1.0.0)

Derived from the route registrations in `src/app.ts` and the zod schemas in `src/api/*.ts`. A test (`tests/contract/contract-doc.test.ts`) fails if a registered route is missing here, or if a route here isn't registered.

**Notation:** `field: type` · `?` = optional · `| null` = may be `null` · "USD number" = a JSON number with at most 2 decimals · "money pair" = `x_cents` + `x` (README §Conventions). Every POST needs `Idempotency-Key` (README §Idempotency). Every body schema is **strict**: an unknown field → 422 `VALIDATION_ERROR` (exception: `pricing_evidence` on `/buy` is checked by the comps rules, so an extra key or a bad comp → 422 `COMPS_INVALID`). The cross-cutting errors (401, 403, 429, `IDEMPOTENCY_KEY_*`, `INVALID_BODY`, `INTERNAL`, `AUDIT_WRITE_FAILED`) apply everywhere and aren't repeated per route.

| Method | Path | Token | Section |
|---|---|---|---|
| GET | `/health/ping` | none | Health |
| GET | `/health` | READ/WRITE | Health |
| GET | `/check` | READ | Buying |
| POST | `/buy` | WRITE | Buying |
| GET | `/pricing/preview` | READ | Listing |
| POST | `/list/{domain}` | WRITE | Listing |
| GET | `/export/afternic.csv`, `/export/sedo.csv` | READ | Exports |
| POST | `/export/{venue}/uploaded` | WRITE | Exports |
| POST | `/offers`, `/offers/{id}/outcome` | WRITE | Offers |
| GET | `/offers`, `/report/offers` | READ | Offers |
| POST | `/sold/{domain}` | WRITE | Sales |
| GET | `/report`, `/report/pricing-review` | READ | Reports (`reports.md`) |
| GET | `/portfolio`, `/portfolio/{domain}`, `/ledger`, `/deals/{id}`, `/audit` | READ | Reads |
| GET | `/selection/settings`, `/selection/lists/{name}`, `/selection/namebio`, `/selection/replays/{id}`, `/selection/buy-hold`, `/selection/holdout-suites` | READ | Selection (`selection.md`) |
| POST | `/selection/settings`, `/selection/settings/{label}/activate`, `/selection/lists/{name}`, `/selection/evaluate`, `/selection/labelled-names`, `/selection/replays`, `/selection/holdout-suites` | WRITE | Selection (`selection.md`) |
| POST | `/jobs/run` | job token | Jobs (`jobs.md`) |

---

## Health

### `GET /health/ping`
The only public route. No auth, no DB access (Render's health check uses it).
- **200** `{"status":"ok"}`.

### `GET /health`
Any valid bot token (READ or WRITE).
- **200** `{status: "ok", db: "ok", version: string, adapters: [{name: string, enabled: boolean}]}`; **503** with `status: "degraded"`, `db: "down"` when the DB can't be reached.
- `version` is the service build version (`package.json`), not the contract version. No secret, key prefix or balance is ever shown.

---

## Buying

### `GET /check`
Availability and live prices from every enabled registrar, compared on **first year + exactly one renewal**.
- **Query:** `domain: string` (required). Other query parameters are ignored.
- **Behaviour:** normalises the name (lowercase, `.com` second-level only), asks RDAP (Verisign) and every enabled adapter in parallel (8 s timeout each), stores every quote under a new `check_id`, and caches the answer per domain for 60 s (a cached answer is replayed whole, same `check_id`). `two_year = first_year + renewal + 2 × paid privacy`. The winner is the lowest `two_year` among eligible quotes (tie-break: prepaid model, Afternic Fast Transfer, then adapter order). Any disagreement between RDAP and the adapters, or among adapters → `availability: "unknown"` and no winner.
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
  | `dry_run` | bool? | default `false` |
  | `auto_list` | bool? | default `true`: after the buy, point NS at the lander and store the listing |

- **Checks, in order (any failure stops the call; no registrar call before check 6):** approval (`APPROVAL_INVALID` / `APPROVAL_EXPIRED`) → `proposed_listing.mode` (`MODE_INVALID`) → category (`CATEGORY_REQUIRED`) → grade (`GEO_GRADE_REQUIRED` / `GRADE_NOT_GEO`) → the listing rules for `proposed_listing` (the `/list` listing codes, plus `PRICING_FORMULA_MISMATCH`; a geo BIN must equal the grade price; under `pricing_settings` v3 also `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED`) → comps (`COMPS_REQUIRED` / `COMPS_INVALID`) → settings version (409 `SETTINGS_VERSION_CHANGED`) → **buy hold** (409 `BUY_HOLD`, real buys only, see below) → not owned (409 `ALREADY_OWNED_OR_PENDING` / `ALREADY_IN_PORTFOLIO`) → domain cap (409 `DOMAIN_CAP_REACHED`) → live re-check, no cache (409 `NOT_AVAILABLE` / `NO_ELIGIBLE_REGISTRAR` / `PINNED_REGISTRAR_INELIGIBLE`) → price caps, then the cheapest two-year (409 `PRICE_ABOVE_MAX`, `details.cheapest`) → POC cap $1,500 including open purchases (409 `POC_CAP_EXCEEDED`, `details` `cap_cents`, `spent_cents`, `spent`, `pending_cents`, `remaining_cents`, `remaining`, `cost_cents`) → registrar account (409 `REGISTRAR_STATE_UNKNOWN` / `REGISTRAR_AUTO_TOPUP_ON` / `REGISTRAR_FUNDS`) → the registrar's own dry run with the exact cost (409 `REGISTRAR_DRY_RUN_FAILED` with `details.registrar_code`; a price change re-quotes once and re-checks the caps; an ambiguous answer → 409 `REGISTRAR_DRY_RUN_AMBIGUOUS`).
- **Buy hold (v1.1.0, additive).** A domain that has a screening result is held (a run that lists the domain but has written no result for it yet counts too) when the settings version of the **latest** screening run that screened it has `buy_hold` on, is a backtest, or is no longer the active version (the same rule as `would_buy`). A real `/buy` of a held name → 409 `BUY_HOLD` (`details.settings_version`, `details.run_id`), before any registrar call. A domain that was **never screened** is not held: `/buy` behaves as in v1.0.x. A dry run is never refused; it adds `would_be_blocked: "BUY_HOLD"` to its 200. `/buy` does **not** require a tranche (`NO_TRANCHE` is planned for v2.0.0).
- **`dry_run: true`** stops after the checks. **200:**
  ```
  { dry_run: true, domain, check_id, registrar, first_year/renewal/two_year (money pairs),
    poc_spent (pair), poc_remaining_after (pair), domains_owned: int (owned + listed + delisted + pending purchases),
    registrar_dry_run: { would_succeed: true, cost, cost_cents },
    proposed_listing: null | <plan view, with the schedule anchored today and drop date +24 months>,
    settings_version: int, would_be_blocked?: "BUY_HOLD", warnings: [string] }
  ```
  Writes only the audit row and the quotes. The same key can't be reused for a real buy (different body → 409).
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
- **202 (state unknown):** `{status: "unknown", code: "PURCHASE_STATE_UNKNOWN", domain, purchase_id, audit_id, message}`. The registrar may have registered it; the hourly reconciler books or fails it. Retry only with the **same** key (re-evaluated, never re-registered).
- **409 after contacting the registrar:** `REGISTRAR_REJECTED` (`details.registrar`, `details.registrar_code`; nothing charged), `PURCHASE_ABANDONED`, and on a replay `PURCHASE_FAILED` (the reconciler found it was never registered).
- **Other errors:** 422 `VALIDATION_ERROR` (schema, or an amount that isn't a positive USD amount with ≤ 2 decimals) · 422 `DOMAIN_INVALID` / `TLD_NOT_SUPPORTED` · 409 `IDEMPOTENCY_KEY_MISMATCH` (the key was used for another domain) · 500 `PRICING_SETTINGS_MISSING`.

---

## Listing

**Pricing version (v2 or v3).** When the current `pricing_settings` version has a price list (**v3**, created only by the admin command), a **new** non-geo plan needs a BIN on the list and at or above the non-geo minimum (the x95 and minimum-BIN rules of v2 do not apply). Floor = 65% of the BIN to the whole dollar (never below $750); walk-away as in v2 (nearest $5, never below $500). Drops are one rung down the list (non-geo at M6 and M18, geo at M12 down to $299), with floor and walk-away recomputed from the new BIN (an exception does not carry through a drop); the final push is the lowest list price at or above the floor (none for geo). **An override never waives the price list** (an override relaxes mode guards only): under v3 every non-carried BIN in any mode, geo included, must be on the list. A plan keeps the settings version it was made under: its stored schedule and its manual changes follow that version, so v2 plans are unchanged unless replanned (a replan uses the current version). `settings_version` in every response says which applies.

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
  | `lander` | string? | `afternic` (default from settings) \| `sedo` \| `custom` (`dan` → `LANDER_RETIRED`) |
  | `ns` | string[] \| null | only with `custom`: 2–4 hostnames |
  | `display_name` | string \| null | same name, other ASCII capitalisation |
  | `dry_run` | bool? | validate and preview only |
  | `approval_ref` | `{text, approved_at}` \| null | required only for an exception, an override, or an off-grade geo BIN (422 `APPROVAL_REQUIRED`) |

  No price field means "nameservers/lander only". No `approval_ref` is needed for a change within the rules. A geo BIN that is within range but is neither the grade price nor the scheduled strong → weaker step is a sell decision: without a valid `approval_ref` → 422 `APPROVAL_REQUIRED`.
- **Behaviour:** validates (order: `MODE_INVALID`, field checks, the listing rules, then `approval_ref` if sent), sets the nameservers through the registrar (compared as a set), checks public DNS, saves the plan, appends `listing_history`, creates or regenerates the `price_schedule` rows (the first listing anchors the drop clock) and flags the export as pending. Runs under the per-domain lock shared with `/buy`.
- **200:**
  ```
  { domain, status, category, listing: null | <plan view>, pricing_hold: bool, lander, ns: [string],
    ns_status: "set"|"mismatch"|"unverified"|"manual"|"pending", manual_steps?: [string],
    ns_public: "match"|"pending"|"unknown", checklist: [string], warnings: [string] }
  ```
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
WRITE.
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
READ. One domain: the `per_domain` row plus
`ledger` (the `/ledger` JSON rows), `purchases: [{id, state, dry_run, registrar, cost (pair), created_at}]`, `quotes` (from the latest check: `{registrar, quoted_at, available, premium, first_year (pair), renewal (pair), eligible, exclusion_reason}`), `listing_history: [{id, at, source, category, mode, bin/floor (pairs), walkaway_cents, walkaway, min_offer (pair), price_grade, pricing_source, pricing_settings_version, override, override_reason, approval_text, approval_at}]` (newest first), `schedule: [{event, due_on, status, settings_version, bin/floor (pairs), walkaway_cents, walkaway, applied_at, note}]`, `sale: null | {venue, transaction_ref, sale_price/commission/other_fees (pairs), sold_at, evidence_source, evidence_ref, confirmed, recorded_by, offer_id}`, `export: {afternic, sedo}` (each `{pending: bool, last_confirmed_upload_at, last_uploaded: null | {bin, floor, min_offer (pairs)}}`; never the walk-away), `offers` (the latest 50: `{id, amount (pair), source, received_at, buyer_type, band, routing, outcome, note}`).
- **Errors:** 404 `DOMAIN_NOT_FOUND`.

### `GET /ledger`
READ. Ledger rows in date order.
- **Query (strict):** `type` (`registration`, `renewal`, `fee`, `commission`, `sale`, `payout_fee`, `refund`, `tool`, `ai`, `adjustment`), `domain`, `from`, `to` (`YYYY-MM-DD`, inclusive), `format` (`json` default, `csv`).
- **200 JSON:** `{count, rows: [{id, date, type, domain, deal_id, amount (pair, signed: negative = money out), amount_usd: "-11.08", counterparty, receipt_ref, note}]}`. **CSV:** `formats.md` §Ledger.
- **Errors:** 400 `VALIDATION_ERROR`.

### `GET /deals/{id}`
READ. `{id, domain, strategy, status_note, created_at, approvals: [{audit_id, at, method, path, approval_text, approval_at, status_code}]}` (audit rows with an approval that cite the deal or its domain).
- **Errors:** 404 `DEAL_NOT_FOUND`.

### `GET /audit`
READ. Newest first.
- **Query (strict):** `since` (ISO with offset), `limit` (1–500, default 100).
- **200:** `{rows: [{id, at, token_id, scope: "read"|"write"|"job"|"admin"|null, method, path, idempotency_key, approval_text, approval_at, request (the redacted request as a JSON object, or null; not a string), status_code, result_summary, client_ip}]}`. Job runs appear with scope `job` (`path` `/jobs/run`, or `job tick|daily` for a CLI run).
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
- **Errors:** 422 `SETTINGS_KEY_UNKNOWN` (`details.path`) · 422 `SETTINGS_KEY_LOCKED` (the priors `tier.p_passive`, `lead.p_lead` and `priors_v91` can't be changed by a draft, whether by a leaf path or by replacing a parent; only a migration changes them; `holdout` is locked too; the check also compares with the active version; `details.path`) · 422 `SETTINGS_INVALID` (the resulting document breaks a rule: `details.issues[] {path, message}`; see `selection.md` §Validation) · 422 `SETTINGS_NO_CHANGE` (identical to the active version; a copy of a version that is not active is allowed, which is how an older version is brought back) · 409 `SETTINGS_LABEL_TAKEN` · 404 `SETTINGS_NOT_FOUND` (`based_on`) · 422 `VALIDATION_ERROR`.

### `POST /selection/settings/{label}/activate`
WRITE. Makes a draft the active version, for runs started afterwards (a run keeps the version it started with).
- **Body (strict):** `{approval_ref}`, required (Dvir's words, valid as in README §Conventions; the text must **name the settings `label`** on label boundaries, else 422 `APPROVAL_INVALID`).
- **200:** `{active: label, activated_at: ISO}`.
- **Rules:** a version can be activated **once**; to bring an older version back, draft a new one based on it. Clearing the buy hold (the active version has `buy_hold: true`, the target `false`) also needs every `holdout.required_suites` suite to have passed as a **holdout-mode** replay on that target version (`POST /selection/replays`; `GET /selection/buy-hold?settings=<label>` shows the state), judged by the active version's `holdout` settings; DOM never clears the hold without the `approval_ref` as well. The activation and the check run in one transaction, after the previous activation row is locked.
- **Errors:** 422 `APPROVAL_REQUIRED` · 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 404 `SETTINGS_NOT_FOUND` · 409 `SETTINGS_ALREADY_ACTIVE` · 409 `SETTINGS_ALREADY_ACTIVATED` (activated before, then replaced) · 409 `HOLDOUT_NOT_PASSED` (`details.suites`).

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
- **Body (strict):** `lane` (`S2` geo, `S3`, `S4`, `S6`, `S7`), `features: {registered_share?: 0..1 | null, prior_history?: 0|1|null, alt_tld_before_n?: int | null, n_words?: int | null, sld_chars?: int | null, is_geo?: 0|1 (default: lane is S2), gform1_pass?: 0|1|null, short?: 0|1|null}` (an omitted or null feature is **unknown**), `leads_ab` (int ≥ 0), `bin_usd?`, `price_grade?` (`strong`|`weaker`, geo), `first_year_usd?`, `renewal_usd?`, `lander_ns?` (`afternic` default | `other`), `retail_start?`, `retail_end?` (NameBio counts), `form?: {geo_band_raw?, sld_len, word_count, short, syllables?}`, `domain?` (only for the syllable count), `risk_flag?`, `intent_raw?`, `timing_raw?` (0..10), `parked_only?`, `settings?` (a label: evaluate against that version instead of the active one). USD fields are positive numbers with at most 2 decimals.
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
- **Errors:** 422 `ROWS_INVALID` (`details.rows: [{index, domain, message}]`; nothing is recorded) · 422 `VALIDATION_ERROR` (neither or both of `rows` and `csv`, or not 1 to 200 rows).

### `POST /selection/replays`
WRITE. **CAP-21a replay** over the registered names. Every row goes through the same tier and DEMAND-2 code as live screening (`evaluateTier` with the chosen settings); nothing is a second implementation.
- **Body (strict):** `suite`, `mode` (`diagnostic` | `holdout`), `settings?` (a label; default the active version).
  - **`diagnostic`** also takes the filters `slices?`, `sources?`, `roles?`, `domains?` (AND) and `profit?`. `suite` is only a label. It refuses any selection that contains a `test` row: 422 `HOLDOUT_CONTAMINATED` ("Test rows are scored only by holdout replays").
  - **`holdout`** takes **only** `suite` and `settings` (any filter or `profit` → 422 `VALIDATION_ERROR`). `suite` must be one of `holdout.required_suites` with a frozen definition (`POST /selection/holdout-suites`, else 422 `SUITE_NOT_DEFINED`); the latest definition version selects the names and names the judged cell.
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
- **Body (strict):** `suite` (one of the active `holdout.required_suites`: `BT10-1`, `BT10-9`, `BT10-11`), `slices?`, `sources?` (at least one; they select every registered name in them, all of which must be `test`), `cell?` (`pooled` default, or `lane:expired` / `lane:fresh` / `lane:aged` / `lane:geo`: BT10-11 judges `lane:expired`), `approval_ref` (Dvir's words, which must **name the suite id**, validated as in README §Conventions).
- **Frozen at freeze time:** the selection is computed from the registry as it is now; the `test` names in it are stored as `member_count` and `member_hash` (sha256 of the sorted domain list, newline-joined). A holdout replay recomputes the selection and refuses on any difference.
- **201:** `{suite, version, slices, sources, member_hash, member_count, cell, created_at, created_by, approval_text}`.
- **Errors:** 409 `SUITE_ALREADY_SCORED` (the suite already has a holdout replay: no new definition version, `details.replay_id`) · 409 `SUITE_OVERLAP` (the selection shares a name with another required suite's latest definition; `details.other_suite`, `count`, `examples` up to 5) · 422 `SUITE_EMPTY` (no test names, or the judged cell has no sold or no dropped test name) · 422 `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 422 `SUITE_UNKNOWN` (`details.required_suites`) · 422 `VALIDATION_ERROR`.

### `GET /selection/holdout-suites`
READ. `{suites: [<201 shape>]}`, every version, oldest first.

### `GET /selection/replays/{id}`
READ. The stored replay: `{replay_id, suite, mode, settings_version, filter, report, leakage_rows, pass, created_at, created_by}`. 404 `REPLAY_NOT_FOUND`.

### `GET /selection/buy-hold`
READ. Query `settings?` (a label; default the active version). **200:** `{buy_hold (the active version's), settings_version (the version judged), target_buy_hold (that version's own buy_hold), required_suites: [{suite, replay_id | null, pass, sold_accept_rate, drop_reject_rate, n_sold, n_dropped, definition_version | null, failed_before, variants_scored}], clearable: bool}`. Per suite in the active version's `holdout.required_suites`, for that settings version: **a failing holdout replay sticks** (`failed_before: true`, `pass: false`; a re-run or a changed definition never erases it). Otherwise the suite passes when a holdout replay on its **latest definition version** passes (judged cell, the active version's `holdout` settings, 0 leaking rows). `replay_id` is the failing replay, else the passing one, else the latest, else null. `variants_scored`: how many settings versions have a holdout replay of the suite (the pre-registered variants). `clearable` is true only when `target_buy_hold` is false and every suite passes. It is a report: clearing `buy_hold` is an activation that also needs Dvir's `approval_ref`. 404 `SETTINGS_NOT_FOUND`.

### `POST /screening/runs`
WRITE. Starts a screening run (CAP-20) over 1 to 50 names and returns at once; the run is stored per (name, check) and continues in the background (and after a restart: see `jobs.md` `screeningResume`). Poll `GET /screening/runs/{id}`.
- **Body (strict):** `mode?` (`live` default | `full`), `settings?` (a settings label; default the active version), `tranche_id?` (an existing tranche, else 404 `TRANCHE_NOT_FOUND`; concentration counts its real geo members for the geo cap), `checks?` (a subset of check ids: each lane's gate list is cut to it, in settings order; a lane left with nothing → 422 `VALIDATION_ERROR`), `names` (1–50) each `{domain, lane (S2 geo | S3 | S4 | S6 | S7), city?, state?, trade?, price_grade? (strong|weaker), bin_usd?, leads_ab? (default 0), census_list?, as_of? (ISO with offset, full mode only), rank? (int)}`.
- **Modes:** `live` stops a name at its first FAIL or UNKNOWN; `full` runs every planned check regardless. `live` needs the **active** settings version; a `full` run may name any version, and a non-active one makes it a `backtest` (results labelled, never a buy card).
- **Order:** gate by gate in the settings' plan order, names in `rank` order (lower first; unranked after ranked, then submission order), so CONCENTRATION-1 sees the names ranked ahead.
- **Per-name problems never fail the request:** an unreadable or duplicate name gets one `form` result FAIL `INPUT_INVALID` (`fields.cause` and the start of `reason`: `DUPLICATE` the same name again, `NOT_COM`, `DOMAIN_INVALID`) and the final status `invalid`.
- **202:** `{run_id, status: "running", mode, backtest, settings_version, buy_hold, names_n, poll: "/screening/runs/<id>"}`.
- **Buy hold:** a run labelled `backtest` (a non-active settings version), or whose settings version is no longer the active one, never reports `buy_candidate`: a name that passes is `would_buy`.
- **Errors:** 422 `DRAFT_NOT_ALLOWED_LIVE` (`settings` is not the active version in a live run; `details.active`) · 404 `SETTINGS_NOT_FOUND` · 422 `AS_OF_LIVE_REFUSED` (`as_of` on a live run) · 422 `VALIDATION_ERROR` (size, lane, unknown check, unknown key). · 404 `TRANCHE_NOT_FOUND` (`tranche_id`).

### `GET /screening/runs/{id}`
READ. `?domain=` (one name), `?view=summary|full` (default `full`; `summary` leaves out `results`). **A READ poll may start background work:** a running run whose last row is older than 120 s (the service slept) continues now (it writes result rows in the background); the answer does not wait for it and is not affected by it.
- **200:** `{run_id, status: "running"|"done"|"partial", mode, backtest, settings_version, buy_hold, created_at, finished_at, progress: {checks_planned, checks_done}, names: [{domain, lane, final_status, first_fail: {check, gate, reason_code} | null, tier, short, flags: [check], pending_manual: [check], not_implemented: [check], verdicts: [{check, result_id, verdict, reason, decided_by, decided_at}] (1.2.0), source_lane: "expired_drop"|"fresh"|"unknown"|null, results?: [{check, gate, rule_ids, status, reason_code, reason, fields, data_as_of, checked_at, cached, source, settings_version, list_versions, duration_ms, upstream_calls, evidence: [id]}]}], funnel}`. `results` holds the latest result per check, in the order written. `tier` is the tier check's tier (null until that check exists); `short` is the form check's `short`; `source_lane` is the `history` check's inferred source lane (null until that check has a result). `verdicts` (1.2.0) lists the latest FLAG verdict of each result row that is **in force now** (a verdict on a superseded row is not shown); it never changes `final_status` or `flags`.
- Statuses, final statuses, the funnel and the reason codes: `selection.md` §Screening runs.
- **Errors:** 404 `RUN_NOT_FOUND` · 400 `VALIDATION_ERROR` (bad query).

### `POST /screening/runs/{id}/manual`
WRITE. Records a human result for a check no automated source answers: `web_risk` (Google Transparency Report, CAP-06), `tm_us` (USPTO wordmark search, CAP-08), `history` (HIST-2 and the prior-business guard, CAP-07; CR-002 Amendment B) or, since 1.2.0, `tm_eu` (EU and international trademark search, CAP-09). The server turns the record into a status by the settings' rules (below) and appends it; it supersedes the run's `MANUAL_REQUIRED` row for that name. The evidence URL is stored as an evidence row (`source: "manual"`, text = the JSON result).
- **Body (strict):** `domain` (a name of the run), `check` (`web_risk` | `tm_us` | `history` | `tm_eu`), `checked_at` (ISO with offset, not in the future and not older than the check's `freshness_hours` window; 168 h for `history`; `eu_tm.freshness_hours`, default 168, for `tm_eu`), `evidence_url` (an https URL; required for `web_risk`, `tm_us` and `tm_eu`, optional for `history`, whose links are in `result.evidence_urls`), `result`, `note?` (≤ 500 chars). `result` for `web_risk`: `{raw_status: int, threat_types?: [string]}`; for `tm_us`: `{phrases_queried: [string] (≥ 1), control_ok: bool, exact_or_core_live: [{mark, serial, owner, status}], generic_live: [{mark, serial, owner, status}], dead_n?: int, prior_name_live?: [{mark, serial, owner, status}]}`. When the run's `history` result found a prior business, `phrases_queried` must contain its phrase (`tm_us` `fields.prior_business_phrase`, compared uppercase without punctuation) or the record is UNKNOWN `PRIOR_NAME_NOT_QUERIED`; a non-empty `prior_name_live` is FAIL `TM_LIVE_MARK`. A `web_risk` "safe" record is PASS after a PASS or FLAG history, UNKNOWN `HISTORY_NOT_FINAL` (history unknown, not run, still MANUAL_REQUIRED or absent) or `HISTORY_NOT_CLEAN` (history FAIL).
- **`tm_eu` record (1.2.0, CAP-09).** `result`: `{phrases_queried: [string] (1-30, required: the phrases searched; compared uppercase without punctuation, as for `tm_us`), control_ok?: bool (false → UNKNOWN `CONTROL_FAILED`), checked_by: string, registers: ["euipo"|"wipo"|"ukipo"|"tmview"] (1-4), register_urls: [https URL] (1-10), result: "clear" | "hits", exact_or_core_live: [mark], generic_live: [mark]}` (strict), where `mark` is `{mark, number, owner, status, register: "euipo"|"wipo"|"ukipo"|"tmview"}`. `result: "clear"` with any mark listed, or `"hits"` with none, is 422 `VALIDATION_ERROR`. Status: any `exact_or_core_live` mark → FAIL `TM_LIVE_MARK`; only `generic_live` → FLAG `TM_GENERIC_HITS`; else PASS. The record is accepted for any name of the run, **even when `tm_eu` is not in its gate plan** (a screening pack reads it). Evidence and `recorded_by` as for the other manual checks.
- **`history` record (Amendment B).** `result`: `{result: "PASS" | "REJECT_HARMFUL" | "FLAG_PRIOR_BUSINESS", category?: "malware_phishing" | "spam" | "adult" | "scam" | "trademark_abuse" (required for, and only for, REJECT_HARMFUL), prior_business_name?: string (≤ 200), first_capture_year?: int, last_capture_year?: int, evidence_urls?: [string] (required when a capture year is given; each `https://web.archive.org/web/<timestamp>/<url>`; at least one for REJECT_HARMFUL and FLAG_PRIOR_BUSINESS), checked_by: string}` (strict). It is stored with the **field shape of the automated history result** (`hist2`, `hist2_fail_class`, `prior_history`, `prior_business_use` / `_name` / `_years`, `prior_business_guard`, `source_lane`, `com_prior_registration`, `evidence_urls`, `pre_cls`, plus `manual: true`, `checked_by`, `manual_result`, `first_capture_year`, `last_capture_year`), so the tier, `ext_dates`, `price`, `web_risk` and tranche admission read it like the automated one; `source` is `manual`, `recorded_by` is the calling token. Status: `PASS` → PASS; `REJECT_HARMFUL` → FAIL `HARMFUL_HISTORY` with `hist2_fail_class` = `category` (`pre_cls` `harmful`); `FLAG_PRIOR_BUSINESS` → FLAG `PRIOR_BUSINESS_FLAGGED` (a disclosed risk, shown on the card as the history flag with `prior_business_name`). **A1 guard:** when `prior_business_name` is given (any result) it runs through the `brand` and `bigco` lists of the run: a hit is FAIL `PRIOR_BUSINESS_BRAND_HIT` / `PRIOR_BUSINESS_BIGCO_HIT` (`hist2` stays as recorded), a missing list UNKNOWN `LIST_MISSING`; the manual `tm_us` record must then list that name's phrase in `phrases_queried` (UNKNOWN `PRIOR_NAME_NOT_QUERIED`). **Mapping:** `prior_history` is `1` when a capture year is given or the result is FLAG_PRIOR_BUSINESS, otherwise `null` (unknown, never `0`); `source_lane` is `expired_drop` and `com_prior_registration` `yes` when `prior_history` is 1, else `unknown`; `prior_business_use` is `yes` for a flag or a given name, else `unknown`. **Append-only, latest wins:** records add rows, earlier ones stay (the manual precedence of `beats`: a manual record outranks an auto or cached row, the highest id among manual rows wins). Recording a history result **re-reads this name's earlier manual `web_risk` and `tm_us` records against it** and appends a new row when the verdict changes (a TM record that lacks the prior name's phrase becomes UNKNOWN `PRIOR_NAME_NOT_QUERIED`; a Web Risk "safe" record waiting on history becomes PASS). The tier, `ext_dates` and `price` rows of a run are **not** recomputed: screen the name again (`POST /screening/runs`) and the new run reads the manual record from the cache for the history freshness window (168 h). **Automated `history` with `sources.wayback` false (permanent, Amendment B1)** answers MANUAL_REQUIRED `MANUAL_SOURCE` (`fields.lookup_name`, `results`, `archive_url`), so the name is `pending_manual` with `history` listed and cannot join a tranche (409 `MANUAL_REQUIRED`, below). The audit row of the POST holds who (token), when, and the request body with the evidence URLs.
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
The job token only (see `jobs.md`). Body `{"job": "tick" | "daily"}` (strict; anything else → 422 `VALIDATION_ERROR`). Needs `Idempotency-Key`. **200** `{job, skipped: bool, steps: {<step>: {ok, skipped?, error?, summary}}, started_at, finished_at}`. **503** `JOBS_DISABLED` when the job token isn't configured.

---

## Code index
Every code the service emits, by kind. Errors are `error.code`; warnings are strings in `warnings[]` (or `{code, level}` objects in `/report`, see `reports.md`).

**Cross-cutting errors:** `UNAUTHORIZED`, `SCOPE_FORBIDDEN`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_MISMATCH`, `IDEMPOTENCY_KEY_IN_USE`, `VALIDATION_ERROR`, `INVALID_BODY`, `INVALID_REQUEST`, `NOT_FOUND`, `INTERNAL`, `AUDIT_WRITE_FAILED`, `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED`, `JOBS_DISABLED`, `DOMAIN_BUSY`, `PRICING_SETTINGS_MISSING`.

**Buying errors:** `APPROVAL_INVALID`, `APPROVAL_EXPIRED`, `CATEGORY_REQUIRED`, `GEO_GRADE_REQUIRED`, `GRADE_NOT_GEO`, `COMPS_REQUIRED`, `COMPS_INVALID`, `SETTINGS_VERSION_CHANGED`, `BUY_HOLD`, `ALREADY_OWNED_OR_PENDING`, `ALREADY_IN_PORTFOLIO`, `DOMAIN_CAP_REACHED`, `NOT_AVAILABLE`, `NO_ELIGIBLE_REGISTRAR`, `PINNED_REGISTRAR_INELIGIBLE`, `PRICE_ABOVE_MAX`, `POC_CAP_EXCEEDED`, `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_FUNDS` (`details.reason` may be `MONTHLY_SPEND_LIMIT`; `details.shortfall_cents` + `details.shortfall` when known), `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_DRY_RUN_AMBIGUOUS`, `REGISTRAR_REJECTED`, `PURCHASE_ABANDONED`, `PURCHASE_FAILED`, `PURCHASE_STATE_UNKNOWN` (202 body `code`).

**Listing errors:** the listing rule codes under `POST /list/{domain}`, plus `NOT_IN_PORTFOLIO`, `API_ACCESS_DISABLED`, `REGISTRAR_UNAVAILABLE`, `LISTING_CHANGED_CONCURRENTLY`, `DOMAIN_NOT_FOUND`.

**Screening errors:** `DRAFT_NOT_ALLOWED_LIVE`, `AS_OF_LIVE_REFUSED`, `RUN_NOT_FOUND`, `NAME_NOT_IN_RUN`, `CHECK_NOT_MANUAL`, `EVIDENCE_NOT_FOUND`, `OBSERVED_AT_INVALID`, `CHECKED_AT_INVALID`, `VERDICT_RESULT_NOT_FLAG`, `VERDICT_RESULT_STALE`, `RESULT_NOT_FOUND`, `DECIDED_AT_INVALID` (1.2.0), `REGISTRAR_UNKNOWN` (and `REGISTRAR_NOT_ALLOWED`; and `SETTINGS_NOT_FOUND`, `VALIDATION_ERROR`). Result reason codes are in `selection.md` §Screening runs.

**Tranche errors:** `TRANCHE_NOT_FOUND` (404; also on a screening run), `TRANCHE_ALREADY_OPEN`, `TRANCHE_NAME_TAKEN`, `TRANCHE_CLOSED`, `TRANCHE_FULL`, `GEO_CAP`, `TRANCHE_SPEND_CAP`, `TRANCHE_BELOW_TARGET`, `MAIN_LANE_QUOTA`, `NOT_SCREENED_OK`, `MEMBER_NOT_FOUND` (and `NAME_NOT_IN_RUN`, `RUN_NOT_FOUND`, `DOMAIN_INVALID`, `VALIDATION_ERROR`).

**Export errors:** `SEDO_TEMPLATE_MISSING`, `SEDO_TEMPLATE_INVALID`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `UPLOADED_AT_INVALID`, `NO_PII`.

**Offer and sale errors:** `AMOUNT_INVALID`, `SOURCE_INVALID`, `BUYER_TYPE_INVALID`, `RECEIVED_AT_IN_FUTURE`, `HOLD_REASON_REQUIRED`, `EXTERNAL_REF_CONFLICT`, `OFFER_NOT_FOUND`, `APPROVAL_REQUIRED`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OFFER_SOLD_MISMATCH`, `OUTCOME_CHANGED_CONCURRENTLY`, `EVIDENCE_REQUIRED`, `SOLD_AT_IN_FUTURE`, `OFFER_MISMATCH`, `NOT_SELLABLE_STATE`, `SALE_ALREADY_RECORDED`, `DEAL_NOT_FOUND`.

**Response warnings (strings):** `/buy`: the post-buy list under `POST /buy` (incl. `RECONSTRUCTED`). Listing: `FLOOR_AUTO_ACCEPT`, `FLOOR_RAISED_TO_MIN`, `PRICING_EXCEPTION`, `NO_BIN_LESS_EXPOSURE`, `BIN_OVER_FAST_TRANSFER_MAX`, `HIGH_VALUE_LOW_BIN`, `CATEGORY_OTHER`, `NS_PENDING`, `NS_SET_AFTER_AMBIGUOUS`. Offers: `OFFER_ON_UNLISTED`, `OFFER_AT_OR_ABOVE_FLOOR`. Sales: `COMMISSION_UNEXPECTED`. Exports (`X-Export-Warnings`): `MIN_OFFER_BELOW_20`, `DISPLAY_NAME_IGNORED`, `AFTERNIC_ROUNDS_DOWN`, `SEDO_ROUNDS_DOWN`, `DOMAIN_NOT_ASCII`; skip reason `NOT_LISTED`.

**Selection errors:** `SETTINGS_NOT_FOUND`, `SETTINGS_KEY_UNKNOWN`, `SETTINGS_KEY_LOCKED`, `SETTINGS_INVALID`, `SETTINGS_NO_CHANGE`, `SETTINGS_LABEL_TAKEN`, `SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `ROWS_INVALID`, `REPLAY_EMPTY`, `HOLDOUT_CONTAMINATED`, `AS_OF_REQUIRED`, `REPLAY_INVALID_NO_GATES`, `SUITE_NOT_DEFINED`, `SUITE_UNKNOWN`, `SUITE_ALREADY_SCORED`, `SUITE_OVERLAP`, `SUITE_EMPTY`, `SUITE_MEMBERSHIP_CHANGED`, `LABELLED_NAME_CONFLICT`, `VARIANT_NOT_PREREGISTERED`, `PROFIT_REPORT_INCOMPLETE`, `REPLAY_NOT_FOUND`, `SELECTION_SETTINGS_MISSING` (500), `SELECTION_SETTINGS_INVALID` (500), `LIST_NOT_FOUND`, `LIST_NAME_INVALID`, `LIST_TERM_INVALID`, `LIST_NO_CHANGE`, `CENSUS_LIST_SIZE`, `CENSUS_LIST_INVALID`, `FORBIDDEN_FEATURE`, `BIN_REQUIRED`. Selection warnings: `PRICING_V3_MISSING`. `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` also apply to an activation and to a census list.

**`/report` warnings:** listed with levels in `reports.md`.

**`/check` exclusion reasons:** `NO_CUSTOM_NAMESERVERS`, `NO_AVAILABILITY_ACCESS`, `REGISTRAR_NOT_ALLOWED`, `ADAPTER_ERROR`, `NOT_AVAILABLE`, `PREMIUM`, `NOT_USD`, `MULTI_YEAR_MINIMUM`, `NO_FIRST_YEAR_PRICE`, `NO_RENEWAL_PRICE`. `PINNED_REGISTRAR_INELIGIBLE` may carry `exclusion_reason: NO_ADAPTER`.

**Registrar adapter codes** (in `/check` `error_code` and in `details.registrar_code`): the registrar's own code when it gives one (Porkbun e.g. `INSUFFICIENT_FUNDS`, `COST_MISMATCH`, `MONTHLY_SPEND_LIMIT_EXCEEDED`, `API_ACCESS_DISABLED`, `DOMAIN_NOT_FOUND`, `IDEMPOTENCY_KEY_IN_USE`, `IDEMPOTENCY_KEY_MISMATCH`; GoDaddy e.g. `ACCOUNT_NOT_ELIGIBLE`, `UNAUTHORIZED`, `RATE_LIMIT_EXCEEDED`, `GODADDY_HTTP_<status>`, `GODADDY_OPERATION_FAILED`), or one of the adapter's own: `REGISTRAR_TIMEOUT`, `REGISTRAR_NETWORK`, `REGISTRAR_HTTP_5XX`, `REGISTRAR_BAD_RESPONSE`, `UNKNOWN_REGISTRAR_ERROR`, `ADAPTER_FAILED`, `MULTI_YEAR_TERM`, `NOT_SUPPORTED`, `INVALID_COST`, `INVALID_IDEMPOTENCY_KEY`, `AUTO_RENEW_UPDATE_FAILED`. Timeouts, network errors, 5xx, bad responses and `IDEMPOTENCY_KEY_IN_USE` are **ambiguous** (the registrar may have acted).
