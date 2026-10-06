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
| GET | `/selection/settings`, `/selection/lists/{name}` | READ | Selection (`selection.md`) |
| POST | `/selection/settings`, `/selection/settings/{label}/activate`, `/selection/lists/{name}`, `/selection/evaluate` | WRITE | Selection (`selection.md`) |
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

- **Checks, in order (any failure stops the call; no registrar call before check 6):** approval (`APPROVAL_INVALID` / `APPROVAL_EXPIRED`) → `proposed_listing.mode` (`MODE_INVALID`) → category (`CATEGORY_REQUIRED`) → grade (`GEO_GRADE_REQUIRED` / `GRADE_NOT_GEO`) → the listing rules for `proposed_listing` (the `/list` listing codes, plus `PRICING_FORMULA_MISMATCH`; a geo BIN must equal the grade price; under `pricing_settings` v3 also `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED`) → comps (`COMPS_REQUIRED` / `COMPS_INVALID`) → settings version (409 `SETTINGS_VERSION_CHANGED`) → not owned (409 `ALREADY_OWNED_OR_PENDING` / `ALREADY_IN_PORTFOLIO`) → domain cap (409 `DOMAIN_CAP_REACHED`) → live re-check, no cache (409 `NOT_AVAILABLE` / `NO_ELIGIBLE_REGISTRAR` / `PINNED_REGISTRAR_INELIGIBLE`) → price caps, then the cheapest two-year (409 `PRICE_ABOVE_MAX`, `details.cheapest`) → POC cap $1,500 including open purchases (409 `POC_CAP_EXCEEDED`, `details` `cap_cents`, `spent_cents`, `spent`, `pending_cents`, `remaining_cents`, `remaining`, `cost_cents`) → registrar account (409 `REGISTRAR_STATE_UNKNOWN` / `REGISTRAR_AUTO_TOPUP_ON` / `REGISTRAR_FUNDS`) → the registrar's own dry run with the exact cost (409 `REGISTRAR_DRY_RUN_FAILED` with `details.registrar_code`; a price change re-quotes once and re-checks the caps; an ambiguous answer → 409 `REGISTRAR_DRY_RUN_AMBIGUOUS`).
- **`dry_run: true`** stops after the checks. **200:**
  ```
  { dry_run: true, domain, check_id, registrar, first_year/renewal/two_year (money pairs),
    poc_spent (pair), poc_remaining_after (pair), domains_owned: int (owned + listed + delisted + pending purchases),
    registrar_dry_run: { would_succeed: true, cost, cost_cents },
    proposed_listing: null | <plan view, with the schedule anchored today and drop date +24 months>,
    settings_version: int, warnings: [string] }
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
The selection settings, the word lists and the pure tier + money evaluation. Shapes, defaults and meanings of every setting are in `selection.md`. **Settings drafts and list edits are WRITE and take effect only as a draft or a new list version; activating a settings version and freezing a census list need Dvir's `approval_ref`** (text only: it need not name a domain). `pricing_settings` is **not** reachable here: it changes only through DOM's admin command.

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
- **Errors:** 422 `SETTINGS_KEY_UNKNOWN` (`details.path`) · 422 `SETTINGS_KEY_LOCKED` (the priors `tier.p_passive`, `lead.p_lead` and `priors_v91` can't be changed by a draft, whether by a leaf path or by replacing a parent; only a migration changes them; `details.path`) · 422 `SETTINGS_INVALID` (the resulting document breaks a rule: `details.issues[] {path, message}`; see `selection.md` §Validation) · 422 `SETTINGS_NO_CHANGE` (identical to the active version; a copy of a version that is not active is allowed, which is how an older version is brought back) · 409 `SETTINGS_LABEL_TAKEN` · 404 `SETTINGS_NOT_FOUND` (`based_on`) · 422 `VALIDATION_ERROR`.

### `POST /selection/settings/{label}/activate`
WRITE. Makes a draft the active version, for runs started afterwards (a run keeps the version it started with).
- **Body (strict):** `{approval_ref}`, required (Dvir's words, valid as in README §Conventions, without the domain-name rule).
- **200:** `{active: label, activated_at: ISO}`.
- **Rules:** a version can be activated **once**; to bring an older version back, draft a new one based on it. Clearing the buy hold (the active version has `buy_hold: true`, the target `false`) also needs the holdout report to pass (every `holdout.required_suites` suite); until the holdout report exists the hold can never be cleared. The activation and the check run in one transaction, after the previous activation row is locked.
- **Errors:** 422 `APPROVAL_REQUIRED` · 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` · 404 `SETTINGS_NOT_FOUND` · 409 `SETTINGS_ALREADY_ACTIVE` · 409 `SETTINGS_ALREADY_ACTIVATED` (activated before, then replaced) · 409 `HOLDOUT_NOT_PASSED` (`details.suites`).

### `GET /selection/lists/{name}`
READ. Query (strict): `version?` (integer ≥ 1; default the newest).
- **200:** `{name, version, terms: [string], created_at, created_by}`.
- **Errors:** 404 `LIST_NOT_FOUND` (unknown name, no such version, or a list nobody has uploaded yet such as `brand`) · 400 `VALIDATION_ERROR`.

### `POST /selection/lists/{name}`
WRITE. Writes version n+1 of a list; older versions stay readable. Names: the fixed lists `dictionary_extra`, `city_extra`, `trade`, `regime`, `tech`, `generic_head`, `state`, `legal`, `brand`, `bigco`, `event`, `sig_harmful_strong`, `sig_harmful_weak`, `sig_parked`, `sig_forsale`; or a **census list** `bt1_<sld>` / `s6_regime_audit`.
- **Body (strict):** `replace?: [string]` **or** `add?: [string]` and `remove?: [string]`; `note?`; `approval_ref?` (required for a census list). At most 5000 terms (body limit 64 KB). Terms are lowercased and trimmed; duplicates collapse.
- **Term shapes:** word lists `^[a-z]{2,40}$`; `brand`, `bigco`, `event` also multi-word phrases of lowercase words separated by single spaces (stored with the spaces; matched without them, so `new balance` and `newbalance` are one term); signature lists `class:phrase` with class in `adult, pharma, gambling, malware, phishing, hacked_spam, scam` (`sig_harmful_*`), `parked` (`sig_parked`), `forsale` (`sig_forsale`).
- **Census lists:** replaced whole (`replace`), exactly `census.sibling_count` (default 20) distinct second-level `.com` names, normalised like every domain (case, trailing dot); stored sorted. The target name of `bt1_<sld>` is not its own sibling. Freezing needs `approval_ref` (Gavriel writes the list, Dvir approves it). Each frozen list is a version: `bt1_<sld>@v1`.
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

---

## Jobs

### `POST /jobs/run`
The job token only (see `jobs.md`). Body `{"job": "tick" | "daily"}` (strict; anything else → 422 `VALIDATION_ERROR`). Needs `Idempotency-Key`. **200** `{job, skipped: bool, steps: {<step>: {ok, skipped?, error?, summary}}, started_at, finished_at}`. **503** `JOBS_DISABLED` when the job token isn't configured.

---

## Code index
Every code the service emits, by kind. Errors are `error.code`; warnings are strings in `warnings[]` (or `{code, level}` objects in `/report`, see `reports.md`).

**Cross-cutting errors:** `UNAUTHORIZED`, `SCOPE_FORBIDDEN`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_MISMATCH`, `IDEMPOTENCY_KEY_IN_USE`, `VALIDATION_ERROR`, `INVALID_BODY`, `INVALID_REQUEST`, `NOT_FOUND`, `INTERNAL`, `AUDIT_WRITE_FAILED`, `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED`, `JOBS_DISABLED`, `DOMAIN_BUSY`, `PRICING_SETTINGS_MISSING`.

**Buying errors:** `APPROVAL_INVALID`, `APPROVAL_EXPIRED`, `CATEGORY_REQUIRED`, `GEO_GRADE_REQUIRED`, `GRADE_NOT_GEO`, `COMPS_REQUIRED`, `COMPS_INVALID`, `SETTINGS_VERSION_CHANGED`, `ALREADY_OWNED_OR_PENDING`, `ALREADY_IN_PORTFOLIO`, `DOMAIN_CAP_REACHED`, `NOT_AVAILABLE`, `NO_ELIGIBLE_REGISTRAR`, `PINNED_REGISTRAR_INELIGIBLE`, `PRICE_ABOVE_MAX`, `POC_CAP_EXCEEDED`, `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_FUNDS` (`details.reason` may be `MONTHLY_SPEND_LIMIT`; `details.shortfall_cents` + `details.shortfall` when known), `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_DRY_RUN_AMBIGUOUS`, `REGISTRAR_REJECTED`, `PURCHASE_ABANDONED`, `PURCHASE_FAILED`, `PURCHASE_STATE_UNKNOWN` (202 body `code`).

**Listing errors:** the listing rule codes under `POST /list/{domain}`, plus `NOT_IN_PORTFOLIO`, `API_ACCESS_DISABLED`, `REGISTRAR_UNAVAILABLE`, `LISTING_CHANGED_CONCURRENTLY`, `DOMAIN_NOT_FOUND`.

**Export errors:** `SEDO_TEMPLATE_MISSING`, `SEDO_TEMPLATE_INVALID`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `UPLOADED_AT_INVALID`, `NO_PII`.

**Offer and sale errors:** `AMOUNT_INVALID`, `SOURCE_INVALID`, `BUYER_TYPE_INVALID`, `RECEIVED_AT_IN_FUTURE`, `HOLD_REASON_REQUIRED`, `EXTERNAL_REF_CONFLICT`, `OFFER_NOT_FOUND`, `APPROVAL_REQUIRED`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OFFER_SOLD_MISMATCH`, `OUTCOME_CHANGED_CONCURRENTLY`, `EVIDENCE_REQUIRED`, `SOLD_AT_IN_FUTURE`, `OFFER_MISMATCH`, `NOT_SELLABLE_STATE`, `SALE_ALREADY_RECORDED`, `DEAL_NOT_FOUND`.

**Response warnings (strings):** `/buy`: the post-buy list under `POST /buy` (incl. `RECONSTRUCTED`). Listing: `FLOOR_AUTO_ACCEPT`, `FLOOR_RAISED_TO_MIN`, `PRICING_EXCEPTION`, `NO_BIN_LESS_EXPOSURE`, `BIN_OVER_FAST_TRANSFER_MAX`, `HIGH_VALUE_LOW_BIN`, `CATEGORY_OTHER`, `NS_PENDING`, `NS_SET_AFTER_AMBIGUOUS`. Offers: `OFFER_ON_UNLISTED`, `OFFER_AT_OR_ABOVE_FLOOR`. Sales: `COMMISSION_UNEXPECTED`. Exports (`X-Export-Warnings`): `MIN_OFFER_BELOW_20`, `DISPLAY_NAME_IGNORED`, `AFTERNIC_ROUNDS_DOWN`, `SEDO_ROUNDS_DOWN`, `DOMAIN_NOT_ASCII`; skip reason `NOT_LISTED`.

**Selection errors:** `SETTINGS_NOT_FOUND`, `SETTINGS_KEY_UNKNOWN`, `SETTINGS_KEY_LOCKED`, `SETTINGS_INVALID`, `SETTINGS_NO_CHANGE`, `SETTINGS_LABEL_TAKEN`, `SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `SELECTION_SETTINGS_MISSING` (500), `SELECTION_SETTINGS_INVALID` (500), `LIST_NOT_FOUND`, `LIST_NAME_INVALID`, `LIST_TERM_INVALID`, `LIST_NO_CHANGE`, `CENSUS_LIST_SIZE`, `CENSUS_LIST_INVALID`, `FORBIDDEN_FEATURE`, `BIN_REQUIRED`. Selection warnings: `PRICING_V3_MISSING`. `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` also apply to an activation and to a census list.

**`/report` warnings:** listed with levels in `reports.md`.

**`/check` exclusion reasons:** `NO_CUSTOM_NAMESERVERS`, `NO_AVAILABILITY_ACCESS`, `REGISTRAR_NOT_ALLOWED`, `ADAPTER_ERROR`, `NOT_AVAILABLE`, `PREMIUM`, `NOT_USD`, `MULTI_YEAR_MINIMUM`, `NO_FIRST_YEAR_PRICE`, `NO_RENEWAL_PRICE`. `PINNED_REGISTRAR_INELIGIBLE` may carry `exclusion_reason: NO_ADAPTER`.

**Registrar adapter codes** (in `/check` `error_code` and in `details.registrar_code`): the registrar's own code when it gives one (Porkbun e.g. `INSUFFICIENT_FUNDS`, `COST_MISMATCH`, `MONTHLY_SPEND_LIMIT_EXCEEDED`, `API_ACCESS_DISABLED`, `DOMAIN_NOT_FOUND`, `IDEMPOTENCY_KEY_IN_USE`, `IDEMPOTENCY_KEY_MISMATCH`; GoDaddy e.g. `ACCOUNT_NOT_ELIGIBLE`, `UNAUTHORIZED`, `RATE_LIMIT_EXCEEDED`, `GODADDY_HTTP_<status>`, `GODADDY_OPERATION_FAILED`), or one of the adapter's own: `REGISTRAR_TIMEOUT`, `REGISTRAR_NETWORK`, `REGISTRAR_HTTP_5XX`, `REGISTRAR_BAD_RESPONSE`, `UNKNOWN_REGISTRAR_ERROR`, `ADAPTER_FAILED`, `MULTI_YEAR_TERM`, `NOT_SUPPORTED`, `INVALID_COST`, `INVALID_IDEMPOTENCY_KEY`, `AUTO_RENEW_UPDATE_FAILED`. Timeouts, network errors, 5xx, bad responses and `IDEMPOTENCY_KEY_IN_USE` are **ambiguous** (the registrar may have acted).
