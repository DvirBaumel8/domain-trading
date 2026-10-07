# Reports (contract v2.11.0)

Every money figure is a SQL sum over the ledger; nothing is estimated. Money fields are pairs (`x_cents` + `x`). Times use the Asia/Jerusalem offset.

## `GET /report`
READ. **Query (strict):** `format` = `json` (default) | `md`. Anything else → 400 `VALIDATION_ERROR`.
- `md` returns `text/markdown`: a compact chat digest (budget, sales and ROI, domains, upcoming, warnings by level). It **never** contains the walk-away. Its layout isn't part of the contract.
- `json` returns:

| Field | Content |
|---|---|
| `generated_at` | ISO time |
| `budget` | `poc_cap`, `spent`, `remaining` (pairs). `spent` = −Σ ledger `registration` + `renewal` + `fee` rows (the figure `/buy` checks against the cap). `committed_forward: {total (pair), complete: bool, missing: [domain]}` = one renewal for each live name with `renewals_used = 0`, except a name with `drop_date` = `expiry_date` (drop at first expiry: no renewal is planned, 2.1.0) (`missing` = names without a known renewal price). `domains: {count, max}` (owned + listed + delisted + pending purchases, vs 50) |
| `sales` | `count`, `gross`, `commission`, `fees` (sale-side fees: `/sold` fee and adjustment rows and `payout_fee`), `net` (pairs) |
| `profit` | pair: `net − costs`. Costs = `registration`, `renewal`, `refund` (lowers costs), `tool`, `ai`, and `fee`/`adjustment` rows not written by `/sold` |
| `roi`, `roi_pct` | `profit / costs`: a number with 2 decimals, and a whole percent; both `null` while costs are 0 |
| `per_domain` | One row per domain (pending purchases excluded), see below |
| `upcoming_90d` | Events within 90 days, see below |
| `offers_by_strategy` | `[{category, strategy, names_listed, names_with_offers, offers_90d, offers_per_listed_name_per_month (2 decimals), median_offer_pct_of_bin, max_offer_pct_of_bin, band_shares: {<band>: share}}]` (`names_listed`, `names_with_offers` and `offers_90d` count currently listed names; `median_offer_pct_of_bin`, `max_offer_pct_of_bin` and `band_shares` cover all offers ever logged for the category; `strategy` is the service's strategy label for the category, `S2`..`S7`) |
| `tranches` | `[<tranche view without members>]`, newest first: open and closed tranches with `counts`, spend cap, `committed` and (closed) `close_report`; shape in `endpoints.md` §Tranches |
| `applied_7d` | Price events applied in the last 7 days: `[{domain, event, applied_at, old: {bin_cents, bin, floor_cents, floor, walkaway_cents, walkaway}, new: {…}, export_pending: bool}]` |
| `warnings` | `[{code, level: "error"|"warn"|"info", domain?, message, details}]`, sorted error → warn → info, then by code and domain |

### `per_domain` row
`domain`, `status` (`owned`, `listed`, `delisted`, `sold`, `dropped`), `registrar`, `registrar_api` (`full`, `manage`, `none`), `category`, `price_grade`, `listing_mode` (`bin`/`hybrid`/`offer`/null), `bin`, `floor` (pairs), `walkaway_cents` + `walkaway` (`"$960 (private)"`), `min_offer` (pair), `pricing_source`, `pricing_settings_version`, `offers: {count_30d, highest_30d, count_90d, highest_90d, count_all, highest_all, highest_all_pct_of_bin, last_offer_at, open_for_dvir}` (highest = `{cents, display}` or null; periods in IDT days; keys always present), `next_price_event: null | {event, due_on, bin_cents, bin, floor_cents, floor, walkaway_cents, walkaway}`, `pricing_hold`, `export_pending_since`, `cost` (pair: registration + renewal rows), `renewal_price` (pair), `renewals_used` (0 or 1), `expiry_date`, `drop_date`, `lander`, `ns_verified: bool`, `days_held` (stops at the sale or drop date), `sold_at`, `delisted_at`.

### `upcoming_90d` item
`{domain, kind, date, stage?, headsup?, event?, values?, note}`, sorted by date. Kinds:
- `first_renewal`: expiry within 60 days with `renewals_used = 0`; `stage` 60 / 30 / 7. Dvir decides once; the service doesn't renew in v1.
- `final_expiry`: expiry within 60 days with the renewal used, or a name set to drop at its first expiry; `stage` 60 / 30; no renew option.
- `fast_transfer`: buy date + 60 days (the Afternic Fast Transfer opt-in date).
- `drop_date`: the registration lapses (unless it's the same date as a `final_expiry` item).
- `price_event`: a planned `price_schedule` row with its exact `values` (flat pairs: `bin_cents`, `bin`, `floor_cents`, `floor`, `walkaway_cents`, `walkaway`); `headsup: true` within 7 days (the settings' `headsup_days_before`). Information only: pre-approved by the buy. Overdue events aren't listed (they show as warnings).

### Warnings

| Code | Level | When | `details` |
|---|---|---|---|
| `PURCHASE_UNKNOWN` | error | A purchase is in the `unknown` state | `purchase_id` |
| `PRICE_EVENT_FAILED` | error | A scheduled price event failed (the domain is unchanged) | `events[] {event, due_on, note}` |
| `EXPIRED_NOT_RENEWED` | error | A live name with `renewals_used = 0` is past its expiry (it is not auto-dropped: grace period) | `expiry_date` |
| `JOB_OVERDUE` | error | No `daily` job run has finished in the last 26 hours (2.1.0); a run started by hand counts; a never-run service is overdue | `job` (`daily`), `last_run_at` (null if never), `expected_every` (`24h`) |
| `REGISTRY_MISMATCH` | error | The daily registry check (`portfolioCheck`, 2.3.0) found the name not registered, at another registrar, with another expiry date, or on hold / pending delete / in redemption | `checked_at`, `differences[] {field, ours, registry}` |
| `OWNED_NAME_BLOCKLISTED` | error | The weekly blocklist check found the name on SURBL or Google Web Risk (2.3.0) | `checked_at`, `sources[]` |
| `DOMAIN_LEFT_ACCOUNT` | error | The daily registrar check found the name gone and no sale is recorded (status unchanged) | `registrar`, `first_absent_at`, `last_checked_at` |
| `LANDER_DOWN` | warn; **error from the 2nd day running** | The daily web check of a listed name with verified lander nameservers did not get the lander's answer (2.3.0) | `checked_at`, `since`, `status_code`, `reason` |
| `EXPORT_PENDING` | warn; **error after 7 days** | A listed name changed since the last confirmed Afternic upload | `days_pending`, `export_pending_since` |
| `MANUAL_DELIST` | warn | A sold, delisted or dropped name must be removed by hand at a marketplace | `status`, `venues[]` |
| `POST_BUY_INCOMPLETE` | warn | A bought name has no stored pricing evidence (comps). Never raised for a name imported with `legacy_no_comps` (2.1.0: its evidence row records the legacy reason) | `purchase_id` |
| `LANDER_PENDING` | info | The name was listed with `lander: "none"` and no lander has been chosen yet (2.1.0); no nameserver action is pending in the service | `lander` (null) |
| `NS_UNVERIFIED` | warn | Public DNS doesn't show the lander nameservers yet | `lander`, `lander_ns` |
| `DROP_FEED_STALE` | warn | (2.8.0) Drop lists exist, but the newest `list_date` is more than 2 days before today | `newest_list`, `newest_list_date` |
| `REVIEW_OVERDUE` | warn | (2.10.0) Review feedback exists, but none was recorded in the last 36 hours | `last_feedback_at` |
| `EXPORT_STALE` | warn | No confirmed Afternic upload in 7 days while listings changed | `pending[]` |
| `HOLD_STALE` | warn | A pricing hold has been on for more than 30 days | `reason`, `since` |
| `PAST_DROP_DATE` | warn | A live name is past its `drop_date` | `drop_date` |
| `RECEIPT_MISSING` | warn | A completed purchase has no registrar receipt | `purchase_id` |
| `RENEWAL_PRICE_UNKNOWN` | warn | No renewal price on record (`committed_forward` is incomplete). Not raised for a name with `drop_date` = `expiry_date` (drop at first expiry, 2.1.0: no renewal is planned) | — |
| `BIN_MISSING` | warn | Listed in `bin`/`hybrid` without a BIN | — |
| `CATEGORY_MISSING` | warn | Listed without a category (defensive; the DB prevents it) | — |
| `OFFER_NEEDS_DVIR` | warn | A Dvir-routed offer is still `open`/`countered` 48 h after it was recorded | `offer_id`, `amount`, `source`, `outcome`, `logged_at` |
| `SALE_UNCONFIRMED` | info | A sale recorded from evidence, without Dvir's approval | `venue`, `transaction_ref`, `evidence_source`, `evidence_ref`, `recorded_by`, `sold_at` |
| `PRICING_EXCEPTION` | info | A name priced by an approved exception | `settings_version`, `stored`, `formula` |
| `FLOOR_AUTO_ACCEPT` | info | Afternic auto-accepts any offer at or above the floor | `floor`, `bin` |
| `AUTO_RENEW_UNCONFIRMED` | info | A live (owned, listed or delisted) name at a registrar whose auto-renew setting the service can't read: GoDaddy, or any name with `registrar_api: none` (imported `--manual`). Raised on every report (2.2.0, CR-006); check auto-renew is OFF in the registrar's dashboard, since a renewal there is billed outside the cap. A confirmation by Dvir is recorded in the import note and audit row, not here | `registrar`, `registrar_api` |

## `GET /report/pricing-review`
READ. For the quarterly pricing review.
- **Query (strict):** `from`, `to` (`YYYY-MM-DD`; default: the last 90 IDT days ending today). Errors → 400 `VALIDATION_ERROR`.
- **200:**
  ```
  { from, to,
    sales: [{ domain, venue, gross (pair), bin_at_sale (pair), ratio: gross/BIN (2 decimals) | null,
              stage: "M0"|"M6"|"M12"|"M18"|"final", days_listed, at_floor: bool, sold_at }],
    offers: { count, by_band: {<band>: n}, median_pct_of_bin },
    skipped_events: int, held_domains_now: int (a snapshot, not the window),
    settings_versions_in_use: [int], insufficient_data: bool (fewer than 3 sales) }
  ```

## Other reads
`GET /portfolio`, `/portfolio/{domain}`, `/ledger`, `/deals/{id}`, `/audit` and `/report/offers` are in `endpoints.md`.
