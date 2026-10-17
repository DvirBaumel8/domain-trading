# Reports (contract v5.13.0)

Every money figure is a SQL sum over the ledger; nothing is estimated. Money fields are pairs (`x_cents` + `x`). Times use the Asia/Jerusalem offset.

## `GET /report`
READ. **Query (strict):** `format` = `json` (default) | `md`. Anything else → 400 `VALIDATION_ERROR`.
- `md` returns `text/markdown`: a compact chat digest (spend, sales and ROI, domains, upcoming, warnings by level). It **never** contains the walk-away. Its layout isn't part of the contract.
- `json` returns:

| Field | Content |
|---|---|
| `generated_at` | ISO time |
| `spend` | (5.0.0, G-86: was `budget`; the `poc_cap` and `remaining` pairs are gone, the service holds no budget.) `spent` (pair) = −Σ ledger `registration` + `renewal` + `fee` rows (a plain accounting figure; nothing checks it). `committed_forward: {total (pair), complete: bool, missing: [domain]}` = one renewal for each live name with `renewals_used = 0`, except a name with `drop_date` = `expiry_date` (drop at first expiry: no renewal is planned, 2.1.0) (`missing` = names without a known renewal price). `domains: {count, max}` (owned + listed + delisted + pending purchases, vs 40) |
| `sales` | `count`, `gross`, `commission`, `fees` (sale-side fees: `/sold` fee and adjustment rows and `payout_fee`), `net` (pairs) |
| `profit` | pair: `net − costs`. Costs = `registration`, `renewal`, `refund` (lowers costs), `tool`, `ai`, and `fee`/`adjustment` rows not written by `/sold` |
| `roi`, `roi_pct` | `profit / costs`: a number with 2 decimals, and a whole percent; both `null` while costs are 0 |
| `lines` | (5.8.0, CR-059) Two rows, Line 1 (hand registration) then Line 2 (S8 aftermarket): `{line: 1|2, name, names (active names), max_names (30 and 10: `max_domains - s8_reserved_slots`, `s8_reserved_slots`), spend: {spent (pair)}, sales: {count, gross (pair)}, pnl (pair), committed_forward: {total (pair), complete, missing: [domain]}}`. Every figure is a sum over the ledger rows of the line's names: `spent` = −Σ `registration` + `renewal` + `fee`, `gross` = Σ `sale`, `pnl` = Σ of every ledger row of the line (sales in; commissions, fees, registrations, renewals out). Ledger rows with no name (tool, ai) belong to no line, so the two `pnl` figures need not add up to `profit`. `committed_forward` follows the same rule as `spend.committed_forward` |
| `per_domain` | One row per domain (pending purchases excluded), see below |
| `upcoming_90d` | Events within 90 days, see below |
| `offers_by_strategy` | `[{category, strategy, names_listed, names_with_offers, offers_90d, offers_per_listed_name_per_month (2 decimals), median_offer_pct_of_bin, max_offer_pct_of_bin, band_shares: {<band>: share}}]` (`names_listed`, `names_with_offers` and `offers_90d` count currently listed names; `median_offer_pct_of_bin`, `max_offer_pct_of_bin` and `band_shares` cover all offers ever logged for the category; `strategy` is the service's strategy label for the category, `S2`..`S7`) |
| `tranches` | `[<tranche view without members>]`, newest first: open and closed tranches with `counts`, spend cap, `committed` and (closed) `close_report`; shape in `endpoints.md` §Tranches |
| `applied_7d` | Price events applied in the last 7 days: `[{domain, event, applied_at, old: {bin_cents, bin, floor_cents, floor, walkaway_cents, walkaway}, new: {…}, export_pending: bool}]` |
| `warnings` | `[{code, level: "error"|"warn"|"info", domain?, message, details}]`, sorted error → warn → info, then by code and domain |

### `per_domain` row
`domain`, `line` (1 or 2, 5.8.0) and `lane` (`null` or `"S8"`), `status` (`owned`, `listed`, `delisted`, `sold`, `dropped`), `registrar`, `registrar_api` (`full`, `manage`, `none`), `category`, `price_grade`, `listing_mode` (`bin`/`hybrid`/`offer`/null), `bin`, `floor` (pairs), `walkaway_cents` + `walkaway` (`"$960 (private)"`), `min_offer` (pair), `pricing_source`, `pricing_settings_version`, `offers: {count_30d, highest_30d, count_90d, highest_90d, count_all, highest_all, highest_all_pct_of_bin, last_offer_at, open_for_dvir}` (highest = `{cents, display}` or null; periods in IDT days; keys always present), `next_price_event: null | {event, due_on, bin_cents, bin, floor_cents, floor, walkaway_cents, walkaway}`, `pricing_hold`, `export_pending_since`, `cost` (pair: registration + renewal rows), `renewal_price` (pair), `renewals_used` (0 or 1), `expiry_date`, `drop_date`, `lander`, `ns_verified: bool`, `days_held` (stops at the sale or drop date), `sold_at`, `delisted_at`.

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
| `PURCHASE_UNRESOLVED` | warn | (3.9.0) A real purchase has been `register_sent` or `unknown` for more than 30 minutes. The reconciler books it when the registrar shows the name and an invoice, but it never fails it (registrar lag can look like absence). Check the registrar account, then ask DOM to run the admin `resolve-purchase` command (an `unknown` purchase raises `PURCHASE_UNKNOWN` as well) | `purchase_id`, `state`, `age_minutes`, `created_at` |
| `ENDING_REGISTERED` | warn | (5.7.0, CR-058) Another ending (.net, .co, .org, .io or .ai) of an owned name was registered after our baseline check (`newly_registered`) or its registry creation date changed (`re_registered`). One warning per event for 30 days. The registrant is a lead; nothing is sent | `owned_domain`, `host` (e.g. `name.net`), `created`, `registrar`, `kind`, `detected_at` |
| `DB_SIZE_HIGH` | warn | (3.9.0) The database is over 70% of Neon's free storage (1 GB since 5.13.0; 0.5 GB before); the free plan stops accepting writes at the limit. Tell DOM | `size_bytes`, `limit_bytes`, `percent`, `warn_percent` |
| `PRICE_EVENT_FAILED` | error | A scheduled price event failed (the domain is unchanged) | `events[] {event, due_on, note}` |
| `EXPIRED_NOT_RENEWED` | error | A live name with `renewals_used = 0` is past its expiry (it is not auto-dropped: grace period) | `expiry_date` |
| `RENEWAL_DROP_SUGGESTED` | warn | (4.0.0, CR-045 item 1) A name with `renewals_used` 0 and a later `drop_date` is within `renewal.drop_check_days` (60) of its first expiry and shows none of: a logged offer, an inquiry or lead (`POST /portfolio/{domain}/stats`), a rise of lookalikes in use since the screening before the buy, measured search demand (4.2.0: the latest keyword upload shows at least `demand.keep_min_searches` average monthly searches for the name; `details.signals.keyword_searches` has the number); or its renewal maths ratio (BIN x (1 - commission) x STRe / renewal price) is under `buy.renewal_math_min`. Drop it instead of renewing | `expiry`, `days_to_expiry`, `signals {offers, inquiries, lookalike_rise, lookalikes_at_buy, lookalikes_now, search_band_above_unmeasured}`, `renewal` (pair), `renewal_math?` |
| `SELL_BEFORE_DROP` | warn | (4.0.0, CR-045 follow-up) The same condition (also for a name that drops at its first expiry, which needs no renewal decision): list it for a small wholesale exit about 30 days before expiry. The flag lists nothing and prices nothing; a wholesale price is a pricing exception (`POST /list` with an override and Dvir's `approval_ref` naming the domain and the price) | `expiry`, `list_by` (expiry - 30 days), `venues[]` (Afternic wholesale BIN, SellerHub, a NamePros thread by hand), `drop_suggested?` |
| `HORIZON_DUE` | warn; **error once past** | (4.0.0, CR-045 item 2) A `trend` or `regulation` name is within `renewal.horizon_due_days` (30) of its `sell_or_drop_by` date (buy date + 12 months) | `horizon`, `sell_or_drop_by`, `days_left` |
| `DELIST_NEEDED` | error | (4.0.0, CR-049 item 4) A name sold in the last 30 days is still to be removed at `afternic` and/or `sedo` (cleared per venue by `POST /listings/{domain}/venue` with `delisted: true`), or SellerHub reported a sale of a name not yet recorded as sold (`reason: sellerhub_sold_report`: record the sale too). SellerHub itself is delisted by the service | `venues[]`, `reason` (`sold`, `sellerhub_sold_report`), `sold_at?`, `seen_at?` |
| `LANDER_PRICE_MISMATCH` | warn | (4.0.0, CR-049 item 3) The Buy Now amount the lander page shows is not the plan's BIN | `checked_at`, `shown` (pair), `expected` (pair) |
| `LANDER_OFFER_MISSING` | info | (4.0.0) The plan has a make-offer option (hybrid or offer) but the lander page shows none | `checked_at` |
| `DAILY_JOB_MISSED` | warn | (5.1.0) No `daily` job run with trigger `scheduled` started in the last 26 hours (the cron did not fire; a manual or CLI daily does not count). Not raised when no job run exists at all (fresh install) | `last_scheduled_at` (ISO or null), `hours_since` (null when none) |
| `JOB_MISSED` | error | (3.1.0, CR-016) Today's scheduled slot (00:05 UTC) passed more than 30 minutes ago and no daily run was created at or after it (once any daily run exists) | `slot`, `last_run_at` |
| `JOB_RUN_INCOMPLETE` | error | (3.1.0) A daily run has been queued or running for more than 2 hours | `run_id`, `started_at`, `open_steps[]` |
| `JOB_OVERDUE` | error | No `daily` job run has finished in the last 26 hours (2.1.0); a run started by hand counts; a never-run service is overdue | `job` (`daily`), `last_run_at` (null if never), `expected_every` (`24h`) |
| `REGISTRY_MISMATCH` | error | The daily registry check (`portfolioCheck`, 2.3.0) found the name not registered, at another registrar, with another expiry date, or on hold / pending delete / in redemption | `checked_at`, `differences[] {field, ours, registry}` |
| `OWNED_NAME_BLOCKLISTED` | error | The weekly blocklist check found the name on SURBL or Google Web Risk (2.3.0) | `checked_at`, `sources[]` |
| `DOMAIN_LEFT_ACCOUNT` | error | The daily registrar check found the name gone and no sale is recorded (status unchanged) | `registrar`, `first_absent_at`, `last_checked_at` |
| `LANDER_AWAITING_MARKETPLACE` | info | (3.7.0, CR-033 G-8) An `afternic`-lander name whose Afternic export was never confirmed uploaded; Afternic serves no page for it yet. `LANDER_DOWN` counts only from the first confirmed upload | `domain` |
| `AUTO_RENEW_ON` | error | (3.7.0, CR-033 G-6) The registrar reports auto-renew on (founder rules: auto-renew stays off) | `domain`, `checked_at` |
| `REGISTRAR_DRIFT` | warn | (3.7.0) The registrar's privacy is off, or its nameservers differ from the lander's | `domain`, `drift: [privacy_off, nameservers]`, `checked_at` |
| `LANDER_DOWN` | warn; **error from the 2nd day running** | The daily web check of a listed name with verified lander nameservers did not get the lander's answer (2.3.0; 4.0.0: https, and a TLS failure counts, `reason: tls_error`) | `checked_at`, `since`, `status_code`, `reason` |
| `EXPORT_PENDING` | warn; **error after 7 days** | A listed name changed since the last confirmed Afternic upload | `days_pending`, `export_pending_since` |
| `MANUAL_DELIST` | warn | A sold, delisted or dropped name must be removed by hand at a marketplace | `status`, `venues[]` |
| `POST_BUY_INCOMPLETE` | warn | (3.9.0: was "no stored comps") A name bought with `POST /buy` has no screening pack on file. Comps are optional since pricing v3 and no longer matter here. Never raised for an imported name (`import-domain` makes no purchase) | `purchase_id` |
| `LANDER_PENDING` | info | The name was listed with `lander: "none"` and no lander has been chosen yet (2.1.0); no nameserver action is pending in the service | `lander` (null) |
| `NS_UNVERIFIED` | warn | Public DNS doesn't show the lander nameservers yet | `lander`, `lander_ns` |
| `DROP_FEED_STALE` | info (3.3.0; `warn` by setting) | (2.8.0) Drop lists exist, but the newest `list_date` is more than `intake.drop_feed_stale_days` (3.3.0: default 7; was 2) days before today. At `info` (the default, `intake.drop_feed_stale_level`) it counts toward no warning total | `newest_list`, `newest_list_date` |
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
