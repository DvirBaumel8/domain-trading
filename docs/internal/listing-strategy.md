# Listing and pricing strategy

DOM-internal rules: categories, modes, guards, the calculator, the drop schedule, the offers log. API shapes: `docs/contract/`. **Built: pricing settings v2; v3 (§10.13) built in code, not yet created** (the admin command creates it with Dvir's approval).

**Process (Dvir, 5 Oct 2026, 00:46; v2 09:17; min offer and offers log 01:03):** geo = fixed-price `bin`, no negotiation; every other category = `hybrid` with a server-computed floor (65%, ≥ $750) and a **private** walk-away (max(48%, $500), ≤ floor) that is never exported, shown or told to a buyer; marketplace min offer $100; offers ≥ floor auto-accepted, walk-away..floor → Dvir (Gate D), below → declined automatically and **always logged** (§10.11); LTO off publicly. Scheduled drops (M6/M18 −20%, final push at `drop_date − 90`, delist at `drop_date − 7`; geo one drop $499 → $399 at M12) are pre-approved by the buy approval: Dvir gets heads-ups only. One approval on the buy card covers the whole sell plan. The quarterly review changes `pricing_settings` (a new version), never code.
- **Never hard-code** 65/48/20/750/500/100/499/399 or the price list in logic. The server computes every derived price.
- `approval_ref` is needed here only for a **pricing exception** (V5) or an **override** (V8). Everything else within the rules is bot-only (audited; every rule applies; Dvir, 5 Oct 2026, 20:07).

## 1. Categories
| `category` | Strategy | Mode | Prices |
|---|---|---|---|
| `geo` | S2 | `bin` | By `price_grade`: `strong` → `geo_bin_strong` ($499), `weaker` → `geo_bin_weaker` ($399). Floor = min offer = walk-away = BIN |
| `trend` | S3 | `hybrid` | BIN from the card; floor and walk-away computed (§10) |
| `b2b` | S3/S4 | `hybrid` | Same |
| `collision` | S4 | `hybrid` | Same |
| `regulation` | S6 | `hybrid` | Same |
| `buzzword` | S5 | `hybrid` | Same |
| `other` | e.g. S7 | `hybrid` | Same, plus warning `CATEGORY_OTHER` |
- `/buy` and `import-domain` refuse without a category (`CATEGORY_REQUIRED`); geo also needs `price_grade` (`GEO_GRADE_REQUIRED`).
- `offer`, or a plain `bin` on a non-geo name, needs an override plus `approval_ref` (V7, V8).
- A later category change goes through `POST /list` without approval, except non-geo → `geo`, which is an override (V9).

## 2. Modes
| Mode | Price fields | Negotiation |
|---|---|---|
| `bin` | `bin` (geo grade). Floor, min offer and walk-away stored = BIN. No LTO | None |
| `hybrid` | Client sends `bin`; server computes `floor`, `walkaway`, sets `min_offer = min(hybrid_min_offer, walkaway)`. **$20 ≤ min_offer ≤ walkaway ≤ floor ≤ bin** | ≥ floor pre-approved; walk-away..floor → Dvir; below → declined and logged |
| `offer` | Override only. `min_offer` ≥ $20, `floor` optional, no BIN | Every offer → Dvir |
- **LTO** (`lto_max_months`): override + `approval_ref`, hybrid only, 2–60 months, BIN $495–$5M (Afternic rule), lease ends before `drop_date`. Always needs the override whatever `public_lto` says. Buyers who ask get a private ≤12-month lease via the Afternic Custom Checkout Link.
- In hybrid the client never sends `min_offer`. All listing prices are whole USD (`LISTING_PRICE_INVALID` otherwise).

## 3. Marketplace facts (3 Oct 2026; sources in `../research/marketplaces.md`)
A1 Afternic Buy Now is binding, optional ("zero or blank" = not set), needed for the Buy It Now lander and LTO. A2 The floor is binding: brokers close any deal ≥ floor without asking. A3 Min Offer is non-binding, ≥ $20. A4 No BIN → Make Offer. A5 No BIN = less reach (Fast Transfer needs a BIN < $100k). A6 `Show … Option` applies only with Custom Lander. **A7 UNVERIFIED:** Afternic accepting min offer = BIN (LX-9). A8 No Afternic seller API. S1 Sedo Buy Now is binding, no minimum allowed. S2 Make Offer: non-binding price, a minimum auto-rejects. S3 No Sedo floor. S4 SedoMLS: Buy Now only. S5 Sedo API needs account credentials: unused. S6 Bulk header strings aren't public.

## 4. `POST /list` body
Dvir's `dt list … --bin/--offer/--hold/--replan/--lto/--override` wording maps to `POST /list/{domain}` fields as in `cli.md`. `mode` is required when any price is sent: `--bin` alone = `bin`, `--bin --offer` = `hybrid`, `--offer` alone = `offer` (override).

## 5. Validation (first failure → 422 + audit row)
| # | Rule | Code |
|---|---|---|
| V1 | `mode` ∈ {bin, offer, hybrid} | `MODE_INVALID` |
| V2 | Category set; geo has `price_grade` | `CATEGORY_REQUIRED` / `GEO_GRADE_REQUIRED` (`GRADE_NOT_GEO` for a grade on non-geo) |
| V3 | bin: `bin` present; floor/min_offer/walkaway empty or = bin; no LTO | `BIN_REQUIRED` / `BIN_MODE_NO_NEGOTIATION` / `LTO_NOT_ALLOWED` |
| V4 | offer: no bin; `min_offer` ≥ 20; floor ≥ min_offer; no walk-away or exception; no LTO | `OFFER_MODE_HAS_BIN` / `MIN_OFFER_REQUIRED` / `MIN_OFFER_TOO_LOW` / `FLOOR_BELOW_MIN_OFFER` / `WALKAWAY_NOT_ALLOWED` / `LTO_NOT_ALLOWED` |
| V5 | hybrid (below) | `HYBRID_FIELDS_REQUIRED` / `BIN_NOT_NICE` / `BIN_BELOW_FLOOR_MIN` / `PRICING_FORMULA_MISMATCH` / `HYBRID_PRICES_INVALID` / `FLOOR_BELOW_MIN` / `WALKAWAY_BELOW_MIN` / `MIN_OFFER_FIXED` / `EXCEPTION_REASON_REQUIRED` / `APPROVAL_REQUIRED` / `LTO_NOT_ALLOWED` / `LTO_INVALID`; v3 adds `BIN_NOT_IN_PRICE_LIST` / `LANDER_EXCEPTION_REQUIRED` |
| V6 | geo: mode `bin`; at buy/import BIN = grade price; a later manual change within `geo_bin_min`..`geo_bin_max` ($299–$499) | `GEO_MODE_NOT_ALLOWED` / `GEO_BIN_NOT_GRADE_PRICE` / `GEO_BIN_OUT_OF_RANGE` |
| V7 | non-geo: mode `hybrid`; `offer` or plain `bin` only by override; a plain bin below `high_value_min_bin` ($2,500) under override is reported | `MODE_NOT_ALLOWED_FOR_CATEGORY` / warning `HIGH_VALUE_LOW_BIN` |
| V8 | Override: V6, V7 and LTO pass only with `override: true`, a reason **and** a valid `approval_ref` naming the domain (≤ 72 h). V1–V5 (except LTO), V11, V12 are never overridable | `OVERRIDE_NEEDS_APPROVAL` |
| V9 | Category change: free within the rules; non-geo → geo is an override | `OVERRIDE_NEEDS_APPROVAL` |
| V10 | A manual change needs no approval unless it is an exception or override. An `approval_ref` sent anyway is validated (its code) and stored in `listing_history` | `APPROVAL_REQUIRED` / `APPROVAL_INVALID` / `APPROVAL_EXPIRED` |
| V11 | Comps (`pricing_evidence`): `comps_min`..`comps_max` entries (v2: 2–3), each `{domain, price_usd > 0, sold_on ≤ today, venue, source_url https}`; shape only (Shomer checks they are real) | `COMPS_REQUIRED` / `COMPS_INVALID` |
| V12 | `expected_settings_version`, if sent, = the current version | 409 `SETTINGS_VERSION_CHANGED` |

**Hybrid (V5):** `bin` required, whole dollars ending in 95, ≥ `hybrid_bin_min` ($795, derived: the smallest x95 ≥ `floor_min`). Floor and walk-away omitted → computed; sent → must equal the computed values unless `pricing_exception: true` + reason + `approval_ref` (stored as `pricing_source = approved_exception`; may also waive the x95 rule). Always: `walkaway_min` ($500) ≤ walkaway ≤ floor ≤ bin and floor ≥ `floor_min` ($750). `min_offer` absent or = `min(hybrid_min_offer, walkaway)`, never overridable.

**Warnings (200):** `FLOOR_AUTO_ACCEPT` (floor below BIN), `FLOOR_RAISED_TO_MIN`, `PRICING_EXCEPTION` (shows stored and formula values), `NO_BIN_LESS_EXPOSURE` (offer mode, A5), `BIN_OVER_FAST_TRANSFER_MAX` (BIN ≥ $100,000), `CATEGORY_OTHER`, `HIGH_VALUE_LOW_BIN`.
**Retired:** `WALKAWAY_BELOW_500` (v2: refused as `WALKAWAY_BELOW_MIN`), `SEDO_NO_FLOOR` (v2: Sedo is Make Offer; only returns if an admin sets `sedo_hybrid_as = buy_now`), `HYBRID_BIN_BELOW_HIGH_VALUE_MIN` (5 Oct), `LEGACY_NO_COMPS` (still printed by `import-domain --legacy-no-comps` for D-001).

**Every accepted change** appends one `listing_history` row (append-only): mode, prices (incl. the private walk-away), category, grade, `pricing_source`, settings version, override + reason, approval text/time, `audit_id`, `source` (`buy`/`import`/`list`/`schedule`) and `schedule_event_id`.

**Settings** (admin command or migration only, never the API): `settings` (caps, `high_value_min_bin_cents` 250000, `sedo_hybrid_as` default `make_offer`) and the versioned `pricing_settings` (§10.1).

## 6. Mode → export columns
Binding tables: `docs/contract/formats.md` (Afternic per mode; Sedo per mode). Notes:
- Offer mode writes BIN `0` (not blank), because an Afternic **Update** may keep an old value for a blank cell (UNVERIFIED); after any mode change the bot checks the Afternic dashboard (LX-8).
- Drops never change the $100 min offer. The walk-away appears in no export, no `afternic_row`, no lander or buyer-facing text (OF-14).
- Sedo: every mode is Make Offer (v2), so Afternic holds the only binding price. Geo minimum = BIN (no-negotiation rule); hybrid minimum = $100. Offers Sedo forwards are logged with `POST /offers`.

## 7. Buy-time approval
The scout proposes the BIN with 2–3 real comps (v2; v9.1 replaces them with the backend's `screening_pack`, CR-001 P1b). Gavriel pastes `GET /pricing/preview`'s `sell_plan_line` (with `settings_version`) into the card; Dvir approves buy + sell plan in one message; `/buy` sends `category` (+ grade), `proposed_listing` with the card's numbers, `pricing_evidence` and `expected_settings_version`; the server recomputes and refuses a mismatch **before any money is spent**. With `auto_list` the plan and schedule are stored, anchored on the first listing date.

## 8. D-001 (promptinjectionaudit.com)
- Bought by hand at GoDaddy, registered 2026-10-04, cost $13.73 (42 ILS), no order number, expiry 2027-10-04. Imported with `npm run admin -- import-domain` at G3 (`report.md` §Import).
- **Current plan (Dvir, 6 Oct 2026, 00:32):** trend, hybrid, BIN **$1,488**, floor **$967**, walk-away **$950** (approved exception; the v3 formula gives $715), min offer $100, LTO off. **Drop at the first renewal date 2027-10-04** unless a real inquiry or offer arrives (`drop-at-first-expiry` → final push 2027-07-06, delist 2027-09-27). Bands: $100–$949 declined and logged; $950–$966 → Dvir; ≥ $967 auto-accept. Afternic row `PromptInjectionAudit.com,1488,967,100,N,,Custom Lander,Y,N,Y,N` (PR3-9). Applied via import with these values, or import then `POST /list` `replan` with the exception and Dvir's 00:32 words, then `drop-at-first-expiry`.
- **Open for Dvir:** (a) scheduled drops before 2027-10-04: under v3 M6 would be 1088 / 750 / 520 and the final push 788; under v2 an off-list 1195 / 775 / 760 and 795. (b) No command undoes `drop-at-first-expiry`.
- **Test fixtures keep the 5 Oct plan:** 1995 / 1295 / 950 (exception; formula 960), min offer 100, listed 2026-10-12, drop 2028-10-04: schedule = PR-11, row = LX-3b; warnings `FLOOR_AUTO_ACCEPT`, `PRICING_EXCEPTION`, `LEGACY_NO_COMPS`.

## 9. Tests
LS-*, LG-*, LH-* and LX-* are in `test-plan.md` §Listing; the pricing tests PR-*/PR3-* and offers tests OF-* too.

## 10. Pricing calculator, schedule and settings
Inputs: BIN + category (+ geo grade) + the current `pricing_settings` version. Integer cents only. The same computation runs in `GET /pricing/preview`, `/buy` (incl. dry run), `/list` (incl. dry run) and `import-domain`, so they can't drift (PR-17).

### 10.1 `pricing_settings` (versioned, append-only; v2 is the only seeded version)
| Field | v2 | Meaning |
|---|---|---|
| `version`, `effective_at`, `approval_text`, `approval_at`, `note` | 2, 2026-10-05 09:17 IDT | Integer +1 per version; rows never updated (trigger) |
| `geo_bin_strong_cents` / `geo_bin_weaker_cents` | 49900 / 39900 | Geo grade prices |
| `geo_bin_min_cents` / `geo_bin_max_cents` | 29900 / 49900 | Manual geo change range (V6); never used by the schedule |
| `geo_drops_enabled` / `geo_drops` | true / `[{"after_months":12,"from_cents":49900,"to_cents":39900}]` | At most one geo drop |
| `floor_bps` / `floor_min_cents` | 6500 / 75000 | |
| `walkaway_bps` / `walkaway_min_cents` | 4800 / 50000 | Private walk-away |
| `hybrid_min_offer_cents` | 10000 | ≥ $20; never derived from the walk-away |
| `drops` | `[{"after_months":6,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]` | |
| `final_push_days_before_drop` / `final_push_mode` | 90 / `bin_to_floor_ceil95` | Hybrid only |
| `delist_days_before_drop` / `headsup_days_before` | 7 / 7 | |
| `comps_min` / `comps_max` | 2 / 3 | V11 |
| `public_lto` | false | |
- **Current version** = highest `version` with `effective_at` ≤ now; none → 500 `PRICING_SETTINGS_MISSING`. Created only by `npm run admin -- pricing-settings new [--from-current] --set k=v … --approval-text "<Dvir's words>" --approval-at <ISO>` (at least one `--set`; a no-op version is refused; snake_case jsonb keys `after_months`, `pct_bps`, `from_cents`, `to_cents`). Cross-field rules on load and in the command: ≤ 2 drops, ascending, < 24 months; ≤ 1 geo drop, strong → weaker grade price (v2); `hybrid_min_offer` ≤ `walkaway_min`.
- Every plan stores its version (`domains`, `price_schedule`, `listing_history`). A new version applies to **new plans only**; re-pricing an existing name is `POST /list` `replan:true`. The version must change whenever an output rule changes (PR-44).

### 10.2 Rounding (v2)
- Percentages in cents: `(c × bps + 5000) div 10000` (half-up), then:
- `round5(c) = ((c + 250) div 500) × 500`: floor and walk-away, nearest $5, ties up (65% × 1995 → 1295; 48% × 1995 → 960; 828 → 830; 957.50 → 960).
- `nice95(c)`: `n = c + 500`; `lo = (n div 10000) × 10000`, `hi = lo + 10000`; the closer to `n` (ties → `lo`), minus 500. Computed non-geo BINs (1596 → 1595; 1276 → 1295; 1545 tie → 1495; 956 → 995). `nice99` = same with 100: manual geo checks only.
- `ceil95(c)`: smallest whole-dollar price ending in 95 that is ≥ c (final push).

### 10.3 Formula and minimums
- Hybrid: `floor = min(BIN, max(round5(BIN × floor_bps), floor_min))`; `walkaway = min(floor, max(round5(BIN × walkaway_bps), walkaway_min))`; `min_offer = min(hybrid_min_offer, walkaway)` = $100.
- 65% of BIN < $750 with BIN ≥ $795 → floor raised to $750 + `FLOOR_RAISED_TO_MIN`. BIN < $795 at listing or buy → `BIN_BELOW_FLOOR_MIN` (not overridable). A drop that would take BIN below $795 clamps there; already $795 → `skipped_at_minimum`, floor and walk-away unchanged. A later `floor_min` change doesn't touch existing plans.
- Geo: BIN = grade price; floor = min offer = walk-away = BIN.
- Vectors (PR-1–PR-8, PR-40): 1995 → 1295/960/100 · 2495 → 1620/1200 · 4995 → 3245/2400 · 1195 → 775/575 · 795 → 750 (raised)/500 · 995 → 750/500 · 1495 → 970/720 · geo strong 499 · geo weaker 399.

### 10.4 Drop schedule (v2)
| Event | Due | Change |
|---|---|---|
| `drop1_m6` | anchor + 6 months | BIN × 0.8 → nice95; floor × 0.8 → round5, ≥ $750, ≤ BIN; walk-away × 0.8 → round5, ≥ $500, ≤ floor; min offer unchanged. Geo: none |
| `geo_drop_m12` | anchor + 12 months | Geo strong only: $499 → $399 (floor = walk-away = min offer = BIN). Weaker: no row |
| `drop2_m18` | anchor + 18 months | As M6, from the M6 values |
| `final_push` | `drop_date − 90` | Hybrid only: BIN = min(BIN, max(ceil95(floor), $795)); floor and walk-away unchanged; `skipped_no_change` if unchanged. Geo: none |
| `delist` | `drop_date − 7` | Status → `delisted`; in `X-Manual-Delist`; `/report` `MANUAL_DELIST`. NS untouched. Never held |
- **Anchor** = IDT date of the first accepted listing. "+N months" keeps the day or clamps to month end.
- Values **scale from the current approved values** (an exception carries through), all computed at plan creation with status `planned`. An M-event on or after the final push (or a geo M12 on or after the delist) → `superseded_by_final_push`. Override plans (non-geo plain bin, offer, geo off grade, geo hybrid) get only a `delist` row.
- **Regenerate:** an approved price, category, grade or replan change supersedes the `planned` rows and creates new ones with the same anchor (events already due aren't recreated, except `delist`, always kept); a `drop_date` change (Gate F) moves the final push and delist and supersedes M-rows at or after the new final push; sold/delisted/dropped → open rows `cancelled`. A hold change never regenerates.
- **Hold:** `pricing_hold = true` (reason required) keeps due rows `planned`; on release the next run applies only the latest due event (it has the cumulative values) and supersedes earlier ones.
- Statuses: `planned`, `applied`, `skipped_at_minimum`, `skipped_no_change`, `skipped_disabled`, `superseded`, `superseded_by_final_push`, `cancelled`, `failed`.

### 10.5 Price job (`src/jobs/price-schedule.ts`; first step of `daily`, `npm run job -- price-schedule [--dry-run] [--today D]`)
- For each `planned` row with `due_on ≤ today` (IDT), one transaction per domain under the per-domain lock: skip unless `listed` and not on hold (delist ignores the hold); else set the domain's prices to the row's values (hybrid min offer stays; geo min offer = new BIN), append `listing_history` (`source=schedule`, `schedule_event_id`, `plan_audit_id`, version), mark the row `applied` (+ `applied_at`, `listing_history_id`), set `export_pending_since` if empty, audit row scope `job`. `delist` → status `delisted`.
- Idempotent (unique `(domain_id, event, plan_id)`). Never calls a registrar or marketplace, changes NS or sends anything. A row whose values break V5/V6 → `failed` + `PRICE_EVENT_FAILED`, domain unchanged.

### 10.6 `GET /pricing/preview`
Shape: `docs/contract/endpoints.md`. Query errors → 400; rule errors → 422; unknown `domain` → 404; `domain` + `drop_date` → 400. `afternic_row` uses the validated `display_name` (else the domain, or `example.com`). `sell_plan_line` shows skipped events as `M6 skipped (minimum)` / `(no change)` / `(disabled)`, omits superseded ones, prints `LTO <n> mo`, and starts `bin (geo strong) · BIN $499 · no offers` for geo.

### 10.7 Export flags
Full file every time; the pending and manual-delist rules, the upload confirmation and `EXPORT_PENDING` are in `export-csv.md`. The weekly lander check compares the page with the **last uploaded** values (`/portfolio/{d}` export block).

### 10.8 Who decides each offer
| Offer (hybrid) | Afternic | Sedo / DomainAgents | Email thread |
|---|---|---|---|
| ≥ BIN | Sells (binding) | Accept (pre-approved) | Dvir (Sochen drafts) |
| floor ≤ x < BIN | Brokers close it (A2) | Accept (pre-approved) | Dvir |
| walk-away ≤ x < floor | Reaches Dvir | Dvir (Gate D) | Dvir |
| $100 ≤ x < walk-away | Declined automatically (no counter, no Gate D) | Declined (standard template) | Standard decline (pre-approved text) |
| < $100 | Blocked by min offer | Blocked by Sedo minimum | As above |
| Geo, any x < BIN | Impossible (min = BIN) | Declined | "The price is $X, fixed" |
Every offer in every row is logged with `POST /offers`; the server classifies it against the prices in force at receipt.

### 10.9 Quarterly review
First Monday of Jan/Apr/Jul/Oct (first 4 Jan 2027; April merges with the POC review, 3 Apr 2027). Gizbar reads `GET /report/pricing-review`; Gavriel proposes scored changes; Dvir approves in chat; DOM runs `pricing-settings new` with his words. Existing plans keep their version.

### 10.10 Data model
Columns and tables: `00-architecture.md` §4. The PR vectors were generated with `pricing_calc.py` (copy in `docs/requests/CR-001-reference/system/tools/`); the vectors are the contract.

### 10.11 Offers log (`POST /offers`, `/offers/{id}/outcome`, `GET /offers`, `/report` aggregates)
- **Row:** `domain_id` (any owned status), `amount_cents` > 0 (non-USD converted by the recorder; original in `note`), `source` (`afternic`/`godaddy`/`sedo`/`domainagents`/`email_inbound`/`outbound_reply`/`other`), `received_at` (≤ 5 min future), `buyer_type` (`end_user`/`investor`/`broker`/`unknown`), `buyer_ref` (opaque; no `@`: `NO_PII`), `external_ref` (unique per source; may be a Message-ID), a snapshot of the prices in force at `received_at` (latest `listing_history` row ≤ it) + `listing_history_id`, server `band` and `routing`, outcome fields, `recorded_by`, `audit_id`. Facts immutable (trigger); only outcome fields change, through the API.
- **Band:** `below_min` / `below_walkaway` / `mid_range` (walk-away ≤ x < floor) / `at_or_above_floor` / `at_or_above_bin`; geo `geo_below_bin` / `at_or_above_bin`; `unpriced` when there are no prices. Lower bounds inclusive.
- **Routing:** `auto_decline` (below_min, below_walkaway, geo_below_bin; outcome `declined_auto` at record time) / `dvir` (mid_range, and every `email_inbound`/`outbound_reply` offer ≥ walk-away) / `auto_accept` (≥ floor on afternic/godaddy) / `accept_preapproved` (≥ floor elsewhere). Others start `open`.
- **Record:** duplicate (source + external_ref, or domain + amount + source + time) → 200 `duplicate: true`, nothing written; an `external_ref` used on another domain → 409 `EXTERNAL_REF_CONFLICT`. Codes: 404 `DOMAIN_NOT_FOUND`; 422 `AMOUNT_INVALID`, `SOURCE_INVALID`, `BUYER_TYPE_INVALID`, `RECEIVED_AT_IN_FUTURE`, `NO_PII`; warnings `OFFER_ON_UNLISTED`, `OFFER_AT_OR_ABOVE_FLOOR`. Recording never calls anyone or changes a price; it may set a hold if asked (reason required, no approval).
- **Outcome:** `countered`/`accepted` on a non-pre-approved offer needs `approval_ref` (`APPROVAL_REQUIRED`); `declined` needs none; `sold` needs the domain sold (`OFFER_SOLD_MISMATCH`). Transitions and final states: `docs/contract/endpoints.md`.
- **`/report`:** per-domain offer counts and highest (30d/90d/all, IDT days, keys always present), `offers_by_strategy`, `GET /report/offers`, warning `OFFER_NEEDS_DVIR` (> 48 h since recorded): `docs/contract/reports.md`. No CSV import (removed 6 Oct 2026).

### 10.12 Implementation decisions (Dvir, 5 Oct 2026)
- A request with `pricing_exception: true` is always stored as `approved_exception`; `PRICING_EXCEPTION` is warned when the values differ from the formula or the BIN doesn't end in 95. It needs `pricing_exception_reason` (`EXCEPTION_REASON_REQUIRED`) and a valid approval (`APPROVAL_REQUIRED`).
- `WALKAWAY_NOT_ALLOWED`: walk-away or exception in offer mode (in bin mode a walk-away ≠ BIN is `BIN_MODE_NO_NEGOTIATION`). Also: `LISTING_PRICE_INVALID`, `GRADE_NOT_GEO`, `HOLD_REASON_REQUIRED`, `REPLAN_NOTHING_LISTED`, 503 `DOMAIN_BUSY`, 503 `REGISTRAR_UNAVAILABLE`, 500 `PRICING_SETTINGS_MISSING`.
- A delisted domain counts toward the domain cap until sold or dropped.

### 10.13 `pricing_settings` v3 (selection v9.1; Dvir approved 6 Oct 2026; **built** in CR-001 P1a Task 2; no v3 row exists until the admin command creates it)
New plans only; v2 plans keep their numbers (the price job and manual changes read the settings version the plan was made under). The admin command creates v3 with Dvir's approval text citing the 6 Oct 2026 decisions. **[v9.1]** = stated by v9.1; **[Dvir, 6 Oct 2026]** = decided by Dvir (the formerly proposed items; code names `BIN_NOT_IN_PRICE_LIST`, `LANDER_EXCEPTION_REQUIRED` built). Implementation notes: the v3 columns are `allowed_bins_cents`, `nongeo_bin_min_cents`, `nongeo_default_bin_cents`, `lander_exception_bins_cents`, `floor_rounding`, `drop_mode` (v2 = null/default); `comps_min` stays 2 (G-4 is P1b); in P1a `LANDER_EXCEPTION_REQUIRED` is always refused (no screening pack yet); a stored (carried) plan skips the list.
| Field | v3 | Meaning |
|---|---|---|
| `allowed_bins_cents` | `[29900,39900,49900,78800,108800,148800,198800,248800]` | **[v9.1]** Every listed or scheduled BIN is on the list (forbids $800–$999, $1,950–$1,999 and non-geo x95/x99) |
| `nongeo_bin_min_cents` / `nongeo_default_bin_cents` | 78800 / 148800 | **[v9.1]** Replaces the derived $795 |
| `lander_exception_bins_cents` | `[198800,248800]` | **[v9.1]** Need LANDER-1 evidence (≥ 30 A/B leads and retailstats end count ≥ 20) in the screening pack |
| `floor_bps` / `floor_min_cents` / `floor_rounding` | 6500 / 75000 / `dollar` | **[v9.1]** Floor to the whole dollar ($1,488 → $967) |
| `walkaway_bps` / `walkaway_min_cents`, `hybrid_min_offer_cents` | 4800 / 50000, 10000 | Unchanged (`round5`) |
| `drop_mode` / `drops` | `ladder` / `[{"after_months":6,"steps":1},{"after_months":18,"steps":1}]` | **[v9.1]** ladder; months **[Dvir, 6 Oct 2026]** |
| `geo_drops` | `[{"after_months":12,"steps":1}]` | **[v9.1; confirmed 6 Oct 01:01]** 499 → 399 → 299, one rung at M12 (a $399 name drops to $299) |
| `final_push_mode` | `bin_to_lowest_listed_ge_floor` | **[Dvir, 6 Oct 2026]** lowest list value ≥ floor and ≤ BIN; geo none |
| `comps_min` / `comps_max` | 0 / 3 | **[v9.1]** comps optional |
| `geo_bin_min_cents` / `geo_bin_max_cents` | 29900 / 49900 | Manual geo change must be on the list |
- `round_dollar(c) = ((c + 50) div 100) × 100`; floor = `min(BIN, max(round_dollar(pct(BIN, 6500)), 75000))`; walk-away as v2.
- Ladder step = next lower list value in the lane (non-geo ≥ $788; geo ≤ $499); at the bottom → `skipped_at_minimum`. After each step floor and walk-away are **recomputed** from the new BIN **[v9.1]**; an exception does not carry through **[Dvir, 6 Oct 2026]**.
- Hybrid V5 under v3: BIN on the list and ≥ $788 else `BIN_NOT_IN_PRICE_LIST` (replaces `BIN_NOT_NICE`/`BIN_BELOW_FLOOR_MIN`, which stay for v2 plans); $1,988/$2,488 without LANDER-1 → `LANDER_EXCEPTION_REQUIRED`. An exception or override never waives the list (every non-carried BIN in any mode, geo included, must be on it). Code names proposed.
- Vectors (PR3-*): 2488 → 1617/1195, M6 1988/1292/955, M18 1488/967/715, final 1088/967/715 · 1988 → 1292/955, M6 1488/967/715, M18 1088/750/520, final 788/750/520 · **1488 → 967/715, M6 1088/750/520, M18 788/750/500, final `skipped_no_change`** · 1088 → 750/520, M6 788/750/500, M18 `skipped_at_minimum` · 788 → 750/500, M6 and M18 `skipped_at_minimum` · geo 499/399: M12 → 399/299; no other rows but delist.
