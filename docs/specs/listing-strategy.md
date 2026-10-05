# Listing and pricing strategy (categories, modes, guards, pricing calculator, marketplace mapping)

**Decision (Dvir, 3 Oct 2026, 19:17 IDT):** the way a name is listed depends on its **category**. Geo names are strict Buy It Now with no negotiation. Trend, B2B and similar names are high-value holds.

**Decision (Dvir, 5 Oct 2026, 00:46 IDT): pricing process ADOPTED.** It replaces every earlier pricing rule in this file.
1. **Evidence:** the scout proposes the BIN on every buy card with **2–3 real comparable sales**. A card with no comps is rejected. *(Replaced 6 Oct 2026: demand proof, not comps; see "Selection v9.1" below.)*
2. **Geo:** prices are fixed at **$499 (strong) / $399 (weaker)**. Mode `bin` only, with no offers and no negotiation.
3. **Trend, B2B and every other non-geo category:**
   - Mode `hybrid`. **Floor (Afternic auto-accept) = 65% of BIN, never below $750.** **Walk-away = 48% of BIN.**
   - **Marketplace minimum offer = $100** on every non-geo listing (Dvir, 5 Oct 2026, 01:03 IDT, decision #2). The **walk-away is a private threshold**: it is never exported, never shown on a lander and never told to a buyer.
   - Offers ≥ floor: Afternic auto-accepts. Offers from walk-away up to the floor go to Dvir. Offers from $100 up to the walk-away are **declined automatically** (Sochen's standard template, or no action where the marketplace closes them itself), but **every offer is logged** in the `offers` table as a demand signal (§10.11).
   - Lease-to-own is off on public listings.
4. **Scheduled price drops:** −20% at month 6 and −20% at month 18, with floor and walk-away recalculated *(v1/v2 plans; v3 steps down the allowed price list, §10.13)*. Final push 90 days before `drop_date`; delist 7 days before. **Dvir gets a heads-up only.** His yes on the buy card covers the whole schedule.
5. **One approval:** Dvir approves the buy and the full sell plan (BIN, floor, walk-away, drop schedule) **once**, on the buy card. He is asked again only for mid-range offers and email negotiations (Sochen drafts the reply).
6. **Quarterly review:** Gizbar compares sale prices with BIN, Gavriel proposes % changes, Dvir approves. Percentages and geo prices live in a **versioned settings table**, so changing them needs no code.

**Decisions v2 (Dvir, 5 Oct 2026, 09:17 IDT; `pricing_settings` version 2).** They replace the v1 numbers wherever this file differs:
1. **Walk-away floor:** the private walk-away is never below **$500**, including after price drops, and never above the floor: `walkaway = min(floor, max(48% of BIN, $500))`.
2. **Geo drops:** at most **one** drop, **$499 → $399 at month 12**. A $399 geo name never drops. There is no $299 step and no geo final push. *(Replaced 6 Oct 2026, 01:01: Dvir confirmed a $399 geo name **may** drop to $299; the geo ladder is 499 → 399 → 299, §10.13.)*
3. **Sedo:** every Sedo listing is **Make Offer** (never fixed price). Non-geo: minimum $100, BIN shown as a non-binding price expectation. This resolves the old `SEDO_NO_FLOOR` item.
4. **Drop clock:** months count from the **first listing date** (decided; unchanged).
- **Calculator fixes from the dry run:** (a) the settings version label must change whenever any output rule changes, so these rules are **v2**; (b) the hybrid final push follows `system/operating-model.md` §3a ("BIN drops to the floor"): new BIN = the floor rounded **up** to a price ending in 95 (never below the floor, never above the current BIN, min $795). Floor and walk-away stay as they are, so the walk-away stays ≥ $500. The earlier v1 rule rounded to the nearest x95 and set floor = BIN, which gave a flat $795 and pushed the BIN below the floor.

**Selection v9.1 (Dvir approved, 6 Oct 2026; `selection.md`): `pricing_settings` version 3 for new plans.** Where v9.1 contradicts the rules above, v9.1 wins for every **new** plan. Existing plans keep their version (§10.1). **D-001 is repriced separately** (Dvir, 6 Oct 2026, 00:32: 1488 / 967 / 950, drop at the first renewal date 2027-10-04; §8). Changes (detail and vectors in §10.13 and `test-plan.md` PR3-*):
1. **Comps → demand proof.** Comps are no longer required on any buy or import (`COMPS-1` replaced by `DEMAND-1`: frozen sibling census `pattern_id@version` with `in_use_share ≥ 0.25` plus a NameBio retailstats keyword start/end count ≥ 1, carried in the `screening_pack`). `/buy` instead requires a `screening_pack` (400 `SCREENING_PACK_REQUIRED` if missing, SEL7-1; `buy.md` check 3c). V11 becomes "comps optional, shape-checked if sent"; `COMPS_REQUIRED` and `LEGACY_NO_COMPS` are retired.
2. **Allowed BIN price list** {$299, $399, $499, $788, $1,088, $1,488, $1,988, $2,488} replaces "non-geo BIN ends in 95" and the $795 minimum. Non-geo: default **$1,488**, minimum $788; **$1,988 / $2,488 only with the LANDER-1 exception** (≥30 A/B leads and retailstats end count ≥20, evidenced in the screening pack). Bands $800–$999 and $1,950–$1,999 and x95/x99 endings are forbidden for non-geo (all implied by the list). No price A/B tests.
3. **Floor** = 65% of BIN rounded to the **whole dollar** (not $5), never below $750: $1,488 → **$967**. Walk-away rule unchanged (max(48%, $500) ≤ floor, nearest $5).
4. **Drops step down the list, not −20%:** non-geo one rung at M6 and one at M18 (2488 → 1988 → 1488 → 1088 → 788; from $1,488: $1,088 then $788, SEL9-9). Floor and walk-away are **recomputed** from the new BIN (not scaled). Geo: one rung at M12 (499 → 399 **and 399 → 299**), which reverses v2 decision 2 (**confirmed by Dvir, 6 Oct 2026, 01:01**: a $399 name may drop to $299).
5. **Final push** stays at `drop_date − 90`, but must land on the list: BIN = the lowest list price ≥ the floor (proposed `bin_to_lowest_listed_ge_floor`; v9.1 doesn't define the final push).
6. **Geo grade prices stay $499 / $399** (D2 still open in v9.1; it suggests revisiting $788/$299 after ≥60 E1).

**Exception (Dvir, 5 Oct 2026, 00:39 IDT):** D-001 is recorded with its **approved values**: BIN $1,995, floor $1,295, walk-away $950 (§8). Its marketplace min offer is $100 like every non-geo name.

**Offers log (Dvir, 5 Oct 2026, 01:03 IDT):** Afternic has no seller API, so Gavriel records every offer from marketplace emails or dashboards with `POST /offers` (WRITE). (Removed 6 Oct 2026 (Dvir): the CSV import `POST /offers/import` and the `offer_imports` table.) `/report` shows offer counts and the highest offer per domain and period, plus per-strategy aggregates. These are the demand signal for the quarterly review (§10.11).

**Dvir's CLI wording maps to the API.** He wrote the rules as CLI commands (`dt list <domain> --bin 299`); the system is an HTTP API, so these become the body of `POST /list/{domain}` (§4). An optional thin CLI keeps the flags (`cli.md`). **The server computes every derived price** (floor, walk-away, min offer, the drop schedule) from BIN + category + `pricing_settings` (§10). Bots never do the arithmetic by hand.

## 1. Categories (stored per domain, set at buy or import)

| `category` | From strategy | Mode (required) | Prices |
|---|---|---|---|
| `geo` | S2 | `bin` | Fixed by **`price_grade`**: `strong` → `geo_bin_strong` ($499); `weaker` → `geo_bin_weaker` ($399). Floor = min offer = walk-away = BIN. Strong only: one drop to $399 at month 12 |
| `trend` | S3 | `hybrid` | BIN from the buy card (comps); floor and walk-away computed (§10) |
| `b2b` | S3/S4 B2B service names | `hybrid` | Same |
| `collision` | S4 | `hybrid` | Same |
| `regulation` | S6 | `hybrid` | Same |
| `buzzword` | S5 | `hybrid` (was `offer` before 5 Oct) | Same |
| `other` | e.g. S7 drops | `hybrid` | Same, plus a warning that asks for a real category |

- **Required:** `/buy` and `import-domain` refuse to proceed without a category (422 `CATEGORY_REQUIRED`). Geo also needs `price_grade` (422 `GEO_GRADE_REQUIRED`).
- **Other modes need an override:** `offer`, or a plain `bin` on a non-geo name, is allowed only with an override plus `approval_ref` (V7, V8).
- **Changing the category later:** goes through `POST /list` with `category`; no `approval_ref` is needed within the rules (Dvir, 5 Oct 2026, 20:07: bot autonomy). Moving a non-geo name to `geo` counts as an **override** (needs `approval_ref`), because otherwise the guard could be dodged by relabelling.

## 2. Modes

| Mode | Meaning | Price fields | Negotiation |
|---|---|---|---|
| `bin` | Strict Buy It Now (geo) | `bin` from the geo grade. Floor, min offer and walk-away are stored **= BIN**. No lease-to-own | **None.** Offers below the BIN are ignored; none can close without Dvir |
| `hybrid` | BIN + make offer (all non-geo) | Client sends `bin`. The server computes `floor` and `walkaway` (§10), and sets `min_offer` = `hybrid_min_offer` ($100, a setting). Rule: **$20 ≤ `min_offer` ≤ `walkaway` ≤ `floor` ≤ `bin`**. The walk-away is private (never exported) | Offers ≥ floor are pre-approved (Afternic closes them automatically). Offers from walk-away up to the floor → Dvir (Gate D). Offers from $100 up to the walk-away → declined automatically and logged (§10.11) |
| `offer` | Make-offer only, no BIN | **Override only** (V7). `min_offer` ≥ $20; `floor` optional | Every offer → Dvir (Gate D) |

**Lease-to-own** is off on every public listing (`pricing_settings.public_lto = false`). The `lto_max_months` field still exists. Setting it needs an override plus `approval_ref`, a hybrid listing, 2–60 months, a BIN of $495–$5M (an Afternic rule), and a lease that ends before `drop_date`. When a buyer asks, a lease of up to 12 months is offered privately through the Afternic Custom Checkout Link instead (`system/selling-playbook.md` §5).

## 3. How Afternic and Sedo support each mode (researched 3 Oct 2026; unchanged)

| # | Fact | Source | Status |
|---|---|---|---|
| A1 | The Afternic **Buy Now** price is binding and optional ("leave zero or blank if not set"). It is required for the **Buy It Now lander**, for the Custom Lander's Buy Now option, and for lease-to-own | Afternic bulk template v3 (`templates/`), field text | Verified |
| A2 | The Afternic **Floor** is binding: "If a broker negotiates a price at or above the floor price, our team will complete the sale ... We will not reach out to you before accepting." **So a floor pre-approves every sale at or above it** | Template; https://www.godaddy.com/help/what-is-list-for-sale-27761 | Verified |
| A3 | The Afternic **Min Offer** is "the lowest amount anyone can submit" and is not binding. It must be ≥ $20; the default is $20 (GoDaddy List for Sale sets it to 65% of the BIN) | Template; GoDaddy help 27761; https://blog.afternic.com/whats-new-august-24/ | Verified |
| A4 | **Make-offer only on Afternic:** with no BIN, the marketplace shows Make Offer, and the Custom Lander can show a Make Offer form (added Aug 2024). The **Request Price** lander also exists | https://blog.afternic.com/whats-new-august-24/ ; namepros thread with an Afternic staff reply (link in `../research/marketplaces.md`) | Verified (blog); forum is third-party |
| A5 | **No BIN means less reach:** Afternic says removing the BIN "may affect the exposure" on its Distribution Network. The Premium (Fast Transfer) Network requires a BIN under $100k. A broker who gets a price request will ask the seller for a BIN and a floor | Afternic staff reply (namepros); template Fast Transfer note; https://blog.afternic.com/whats-new-june-2024/ | Verified (Afternic's own words, posted on a forum) |
| A6 | The Custom Lander has switches for Buy Now, Lease to Own and Make Offer (CSV columns `Show … Option`). They apply **only** when Sale Lander = Custom Lander | Template | Verified |
| A7 | **Can make-offer be fully switched off for a BIN listing across GoDaddy and partner sites?** No documented switch. Buyers can still reach a broker. Our guard is **floor = min offer = BIN**, so nothing below the BIN can close or be submitted. Whether Afternic accepts min offer = BIN | — | **UNVERIFIED.** Check at the first geo upload (test LX-9) |
| A8 | **Afternic has no public seller API** for listings. GoDaddy's Aftermarket API only "remove[s] listings and add[s] expiry listings". Afternic listings are set by **bulk CSV** or the dashboard | https://www.godaddy.com/help/how-do-i-access-domain-related-apis-42424 ; `../research/marketplaces.md` | Verified |
| S1 | **Sedo Buy Now (fixed price)** is binding: the seller must sell to the first buyer at that price. **A minimum offer isn't possible with a fixed price.** Per Sedo's terms, "when available, buyers ... may still submit a binding offer ... below the Buy Now price, which Seller can either accept or ignore" | https://faq-us.sedo.com/app/answers/detail/a_id/748 ; https://sedo.com/services/s_priceoption3.php3?language=e ; https://sedo.com/us/about-us/policies-gmbh/agb-fuer-den-service-marktplatz/ | Verified |
| S2 | **Sedo Make Offer:** a listing with no fixed price defaults to Make Offer. Any price shown is a non-binding "price expectation". A **minimum offer** makes Sedo auto-reject offers below it | Same sources | Verified |
| S3 | Sedo has **no floor** (no broker auto-accept) | Same sources (no such field exists) | Verified by absence; low risk |
| S4 | **SedoMLS** distributes **Buy Now** listings to partner registrars, so a Make Offer listing doesn't get MLS reach | `../research/marketplaces.md` M5 | Verified |
| S5 | Sedo's **API** `DomainInsert`/`DomainEdit` has exactly the mode fields: `forsale`, `price`, `minprice`, `fixedprice` (0/1) and `currency` (1 = USD). But it needs the account **username and password** plus a partner ID and signkey, so it is **not used in v1** (bots hold no credentials) | https://api.sedo.com/apidocs/v1/Basic/functions/sedoapi_DomainInsert.html | Verified |
| S6 | Sedo's **bulk uploader** documents Domain, Selling Option, For Sale, Price, Minimum Price, Currency and Action Type. The **exact header strings and values aren't public** | `export-csv.md` | Partly verified (values UNVERIFIED) |

## 4. API body (`POST /list/{domain}`) and Dvir's CLI wording

| Dvir's wording (`dt list …`) | `POST /list/{domain}` body |
|---|---|
| `dt list austinroofrepair.com --bin 499` (geo, strong) | `{"mode":"bin","bin":499}` (a manual change; at buy time the BIN comes from `price_grade`) |
| `dt list promptinjectionaudit.com --bin 1995 --offer` | `{"mode":"hybrid","bin":1995}`. The server computes floor $1,295 and the private walk-away $960, and sets min offer $100 |
| `… --floor 1295 --walkaway 950 --exception "Dvir approved 00:39"` | `{"mode":"hybrid","bin":1995,"floor":1295,"walkaway":950,"pricing_exception":true,"pricing_exception_reason":"…"}` (+ `approval_ref`, required) |
| `dt list x.com --offer --min-offer 500 --override --reason "…"` | `{"mode":"offer","min_offer":500,"override":true,"override_reason":"…"}` (+ `approval_ref`) |
| `… --hold` / `… --unhold` | `{"pricing_hold":true,"pricing_hold_reason":"…"}` / `{"pricing_hold":false}` (reason required; no `approval_ref`; pauses the drop schedule, §10.4) |
| `… --lto 12 --override --reason "…"` (hybrid only) | `"lto_max_months":12` (public LTO is off by default) |
| `… --category trend` | `"category":"trend"` (no `approval_ref` unless it relabels a name to `geo`, an override) |
| `… --dry-run` | `"dry_run":true` (validates; previews the export rows **and the full drop schedule**; no changes) |

- The API **requires `mode`** when any price is sent. The CLI works it out from the flags: `--bin` alone means `bin`, and `--bin --offer` means `hybrid`. `--offer` alone means `offer`, which needs an override.
- In `hybrid` the client **never sends `min_offer`**. The server sets it to `min(hybrid_min_offer, walkaway)` = $100 under settings v2.

All prices are whole USD. **Bot autonomy (Dvir, 5 Oct 2026, 20:07):** `approval_ref` (Dvir's words, relayed by Gavriel) is **required only for buy and sell decisions**: a **pricing exception** (V5) and an **override** (V8), plus `/buy` and non-pre-approved offer counters/accepts (§10.11). Mode, price, category and grade changes within the rules, holds/unholds (reason still required), `replan` and NS re-points need **no** approval; the calling token is recorded in `audit_log`, and every rule still applies. An `approval_ref` sent anyway is validated and stored (V10).

## 5. Server validation and guards (in this order; the first failure → 422, plus an audit row)

| # | Rule | Error code |
|---|---|---|
| V1 | `mode` ∈ {bin, offer, hybrid} | `MODE_INVALID` |
| V2 | The domain has a category. Geo also has `price_grade` ∈ {strong, weaker} | `CATEGORY_REQUIRED` / `GEO_GRADE_REQUIRED` |
| V3 | **bin:** `bin` present. `floor`, `min_offer` and `walkaway` are empty or equal to `bin` (the server stores them = `bin`). No lease-to-own | `BIN_REQUIRED` / `BIN_MODE_NO_NEGOTIATION` / `LTO_NOT_ALLOWED` |
| V4 | **offer** (override only, V7): no `bin`; `min_offer` ≥ 20; `floor`, if given, ≥ `min_offer`; no lease-to-own | `OFFER_MODE_HAS_BIN` / `MIN_OFFER_REQUIRED` / `MIN_OFFER_TOO_LOW` / `FLOOR_BELOW_MIN_OFFER` / `LTO_NOT_ALLOWED` |
| V5 | **hybrid:** see the hybrid rules below the table | `HYBRID_FIELDS_REQUIRED` / `BIN_NOT_NICE` / `BIN_BELOW_FLOOR_MIN` / **v3:** `BIN_NOT_IN_PRICE_LIST` / `LANDER_EXCEPTION_REQUIRED` / `PRICING_FORMULA_MISMATCH` / `HYBRID_PRICES_INVALID` / `FLOOR_BELOW_MIN` / `WALKAWAY_BELOW_MIN` / `MIN_OFFER_FIXED` / `LTO_NOT_ALLOWED` / `LTO_INVALID` |
| V6 | **Geo:** the mode must be `bin`. At buy/import, `bin` = the grade price (`geo_bin_strong` or `geo_bin_weaker`). On any later manual change, `geo_bin_min` ≤ `bin` ≤ `geo_bin_max` ($299–$499) | `GEO_MODE_NOT_ALLOWED` / `GEO_BIN_NOT_GRADE_PRICE` / `GEO_BIN_OUT_OF_RANGE` |
| V7 | **Non-geo:** see the non-geo rules below the table | `MODE_NOT_ALLOWED_FOR_CATEGORY` / `HIGH_VALUE_LOW_BIN` |
| V8 | **Override:** V6, V7 and the LTO switch may be passed only with `override: true`, a non-empty `override_reason` **and** a valid `approval_ref` that names the domain and is ≤72 h old. V1–V5 (except LTO), V11 and V12 can **never** be overridden | `OVERRIDE_NEEDS_APPROVAL` |
| V9 | Category change: allowed without `approval_ref` within the rules. A non-geo → `geo` change needs `override` (hence `approval_ref`, V8) | `OVERRIDE_NEEDS_APPROVAL` |
| V10 | A **manual** change needs **no** approval unless it's an **exception** (V5) or an **override** (V8) (Dvir, 5 Oct 2026, 20:07: bot autonomy). If an `approval_ref` is sent anyway, it is validated (an invalid one → its code) and stored in the `listing_history` row; otherwise `approval_text`/`approval_at` are null. Scheduled job changes (`source=schedule`, §10.5) carry `plan_audit_id` | `APPROVAL_REQUIRED` (exception without approval) / the `approval_ref` codes |
| V11 | **Comps:** optional since 6 Oct 2026 (selection v9.1; demand proof lives in the `screening_pack`, `buy.md` 3c). If sent, shape-checked: see the comps rules below the table | `COMPS_INVALID` *(`COMPS_REQUIRED` retired 6 Oct)* |
| V12 | **Settings version:** if the request carries `expected_settings_version` (the version the buy card's preview used), it must equal the current `pricing_settings` version | 409 `SETTINGS_VERSION_CHANGED` (re-run the preview, re-ask Dvir) |

**Hybrid rules (V5):**
- `bin` is required. It must be a whole-dollar price **ending in 95** and at least `hybrid_bin_min` ($795, §10.3). *(v2.)*
- **v3 (6 Oct 2026, §10.13):** `bin` must be in `allowed_bins_cents` and ≥ `nongeo_bin_min` ($788), else 422 `BIN_NOT_IN_PRICE_LIST` (replaces `BIN_NOT_NICE` / `BIN_BELOW_FLOOR_MIN` under v3). $1,988 / $2,488 need the LANDER-1 exception evidence in the screening pack, else 422 `LANDER_EXCEPTION_REQUIRED`. A pricing exception may change floor/walk-away but **never** waives the price list.
- `floor` and `walkaway` are optional:
  - **Omitted:** the server computes them (§10.3).
  - **Sent:** they must equal the computed values, **unless** `pricing_exception: true` comes with a reason and `approval_ref`. An exception is stored as `pricing_source = approved_exception`. An exception may also waive the "ends in 95" rule.
- Even with an exception: `walkaway_min` ($500) ≤ `walkaway` ≤ `floor` ≤ `bin`, and `floor` ≥ `floor_min` ($750). A walk-away below $500 → 422 `WALKAWAY_BELOW_MIN` (v2; can't be overridden).
- `min_offer` must be absent or equal to the server value `min(hybrid_min_offer, walkaway)`; otherwise 422 `MIN_OFFER_FIXED`. It can't be overridden; changing it means a new `pricing_settings` version.
- Lease-to-own needs an override (V8), 2–60 months, a BIN of $495–$5M, and the lease must end before `drop_date`.

**Non-geo rules (V7):**
- The mode must be `hybrid`.
- `offer` mode, or a plain `bin`, is allowed only with an override (V8).
- Under an override, a plain `bin` below `high_value_min_bin` ($2,500) is also reported (`HIGH_VALUE_LOW_BIN`). The same override covers it.

**Comps rules (V11; optional since 6 Oct 2026, selection v9.1):**
- `pricing_evidence` may be omitted. If sent, `comps` has 0 to `comps_max` (3) entries (`comps_min` is 0 in v3; was 2).
- Each entry has `domain`, `price_usd` > 0, `sold_on` (not in the future), `venue`, and a `source_url` (https).
- The server checks the shape only. **Shomer checks that the comps are real sales.**
- An import may use `legacy_no_comps` with a reason, only for names bought before 5 Oct 2026 (D-001). *(Since 6 Oct no longer needed: accepted and stored, no effect.)*

**Warnings** (200 with `warnings[]`):
- `FLOOR_AUTO_ACCEPT`: "Afternic will close any deal ≥ floor without asking you" (any floor below the BIN).
- `FLOOR_RAISED_TO_MIN`: 65% of the BIN was below $750, so the floor was raised to $750.
- `PRICING_EXCEPTION`: the stored floor or walk-away differs from the formula. Both values are shown.
- `LEGACY_NO_COMPS`: D-001 only. *(Retired 6 Oct 2026 with the comps requirement; not emitted for new calls.)*
- *(Retired in v2: `WALKAWAY_BELOW_500`. The walk-away can no longer go below $500; an exception below $500 is refused with 422 `WALKAWAY_BELOW_MIN`.)*
- `NO_BIN_LESS_EXPOSURE`: offer mode (A5). No Premium or Fast Transfer reach.
- `BIN_OVER_FAST_TRANSFER_MAX`: BIN ≥ $100,000.
- *(Resolved in v2: `SEDO_NO_FLOOR`. Sedo listings are Make Offer with a minimum, so it is no longer emitted. It returns only if an admin sets `sedo_hybrid_as = buy_now`.)*
- `CATEGORY_OTHER`.
- *(Removed 5 Oct: `HYBRID_BIN_BELOW_HIGH_VALUE_MIN`. Hybrid is now the rule for every non-geo name.)*

**Every accepted change** appends one row to `listing_history` (append-only). The row holds:
- mode, prices (`bin`, `floor`, `walkaway`, `min_offer`), category and grade (the walk-away is stored here and in `domains`, but never exported);
- `pricing_source` (`formula`/`approved_exception`) and `pricing_settings_version`;
- override, reason, approval text and time;
- `audit_id`, `source` (`buy`/`import`/`list`/`schedule`) and `schedule_event_id` (for `source=schedule`).

**Settings** (admin command or migration only, never the API):
- **`settings`** (caps; unversioned): `high_value_min_bin_cents` 250000 and `sedo_hybrid_as` (**`make_offer` default since v2**, Dvir 5 Oct 09:17; `buy_now` only by admin change).
- **`pricing_settings`** (**versioned, append-only**, §10.1): the geo prices and range, the floor/walk-away percentages and minimums, `hybrid_min_offer`, the drop schedule, final push/delist offsets, comps limits and `public_lto`. *(`geo_bin_min/max` moved here from `settings` on 5 Oct; `high_value_categories` and `high_value_guard_modes` are retired, since every non-geo category is hybrid.)*

## 6. Mode → export columns

**Afternic** (`/export/afternic.csv`; header exactly as `export-csv.md`):

| Mode | Buy Now Price | Floor Price | Min Offer | Lease to Own | Max Lease Period | Sale Lander | Show Buy Now | Show LTO | Show Make Offer | Hidden |
|---|---|---|---|---|---|---|---|---|---|---|
| `bin` (geo) | BIN | BIN | BIN | N | (blank) | `Buy It Now` | Y | N | N | N |
| `hybrid` | BIN | floor | **min_offer ($100; never the walk-away)** | N (Y only with an LTO override) | months or (blank) | `Custom Lander` | Y | N (Y with LTO) | Y | N |
| `offer` (override only) | `0` (not set, A1) | floor or (blank) | min_offer | N | (blank) | `Custom Lander` | N | N | Y | N |

- **Mode-switch caveat (UNVERIFIED):** on an Afternic **Update** upload, it isn't documented whether a blank cell clears the old value or keeps it. That's why offer mode writes `0` for the BIN (the template says "zero or blank" = not set). After any mode change, Dvir checks the listing in the Afternic dashboard (LX-8).
- **Scheduled drops change rows:** the next export is still the full file; `X-Pending-Changes` and `/report` count the rows changed since the last confirmed upload (§10.7, `export-csv.md`). Drops never change the $100 min offer.
- **The walk-away is never written to any export**, to the preview's `afternic_row`, or to any lander or buyer-facing text (OF-14).

**Sedo** (`/export/sedo.csv`; the strings come from Dvir's template map):

| Mode | Selling Option | Price | Minimum Price | For Sale | Currency |
|---|---|---|---|---|---|
| `bin` (geo) | Make Offer | BIN as a non-binding price expectation | **BIN** (no negotiation: nothing below the BIN can be submitted) | yes | USD |
| `hybrid` (`sedo_hybrid_as = make_offer`, **default**) | Make Offer | BIN as a non-binding price expectation | **min_offer ($100)** | yes | USD |
| `hybrid` (`sedo_hybrid_as = buy_now`, admin only) | Buy Now / fixed | BIN | (blank / 0) | yes | USD |
| `offer` | Make Offer | (blank / 0) | min_offer | yes | USD |

**Sedo and the offer rules:**
- **Decided (v2, Dvir 5 Oct 09:17):** Sedo is Make Offer for every mode, so Afternic holds the only binding price (no double sale). Only Make Offer supports a minimum offer (S1/S2), so Sedo now enforces the $100 minimum (geo: min = BIN).
- Offers that Sedo forwards are logged with `POST /offers`. Those below the walk-away are declined automatically (§10.8), so no Gate D is needed.
- *Interpretation:* the decision named the $100 minimum; for geo names the Sedo minimum is the BIN, to keep the geo no-negotiation rule.

## 7. Buy-time approval of the full sell plan (one approval)
1. **The scout proposes the BIN with 2–3 real comparable sales** (domain, price, date, venue, URL). *(Replaced 6 Oct 2026 by selection v9.1: the backend builds the `screening_pack` (demand proof, lead gate, EV, Ratio, BIN from the price list; `selection.md` §1–§4). Comps are optional context.)*
   - Geo: the scout picks the grade (`strong` → $499, `weaker` → $399) and still cites comps.
   - Non-geo: the BIN must end in 95 *(v2; v3: a price-list value, default $1,488)*.
   - No comps → Shomer REJECTs the card (`COMPS-1`, `system/operating-model.md` §7.1), and the server would refuse it anyway (V11). *(Retired 6 Oct: no screening pack → refused, `buy.md` 3c.)*
2. **Gavriel calls `GET /pricing/preview`** with the BIN, category and grade (§10.6). He pastes the returned `sell_plan_line` (with its `settings_version`) into the card's **"Sell plan (computed)"** row.
   - Before the API exists, the reference calculator `system/tools/pricing_calc.py` (on Gavriel's box, outside this repo) gives the same numbers.
3. **Dvir approves the buy and the full sell plan in one message.** That covers the BIN, floor, walk-away, the drop schedule, the final push and the delist. **There is no further price approval for this name**, except:
   - offers between walk-away and floor;
   - every email negotiation;
   - (offers below the walk-away need nothing from Dvir: they are declined automatically and logged.)
   - a pricing exception or an override (Dvir's words; other changes within the rules are bot-only, (Dvir, 5 Oct 2026, 20:07: bot autonomy)).
4. **Gavriel sends `/buy`** with the following fields. The server **re-computes the plan and validates it before buying**. A buy whose plan breaks a rule, or doesn't match the card's numbers, is refused **before any money is spent**.
   - `category` (and `price_grade` for geo);
   - `proposed_listing` `{mode, bin, floor, walkaway}` with the card's numbers;
   - `pricing_evidence` (optional since 6 Oct);
   - `screening_pack` (required since 6 Oct, `buy.md` 3c);
   - `expected_settings_version`.
5. **On a successful listing** (`auto_list`), the server stores the plan and creates the `price_schedule` rows (§10.4). The anchor is the date of the first accepted listing (decided: Dvir, 5 Oct 09:17).

## 8. D-001 (current state, 5 Oct 2026; **repriced 6 Oct 2026, 00:32**)

**Reprice (Dvir, 6 Oct 2026, 00:32 IDT; replaces the 5 Oct plan below):**
- BIN **$1,488**, floor **$967** (= the v3 formula), walk-away **$950** (private; **approved exception**, the v3 formula gives $715), marketplace min offer **$100**, lease-to-own off. `pricing_source = approved_exception`.
- **Drop at the first renewal date, 2027-10-04, unless a real inquiry or offer arrives** (Gate F: `npm run admin -- drop-at-first-expiry`, so `drop_date` = 2027-10-04 → final push 2027-07-06, delist 2027-09-27).
- Bands: $100–$949 declined automatically and logged; $950–$966 → Dvir; ≥ $967 Afternic auto-accepts.
- Afternic row: `PromptInjectionAudit.com,1488,967,100,N,,Custom Lander,Y,N,Y,N`.
- **Gavriel applies it via the API once live:** import at G3 with these values (or import, then `POST /list` `replan:true` with `pricing_exception`, reason and `approval_ref` = Dvir's 00:32 words), then `drop-at-first-expiry` with the same approval. Test PR3-9.
- **Open for Dvir:** (a) whether scheduled drops apply before 2027-10-04. Under v3 the M6 row would be 1088 / 750 / 520 (the exception isn't carried, §10.13) and the final push 788; under v2 it would be off-list 1195 / 775 / 760 and a final push to 795. So plan it under v3 or with drops off. (b) No command exists to undo `drop-at-first-expiry` (move `drop_date` back to expiry + 1 year) if a real inquiry or offer arrives.

*The 5 Oct record (kept for history; test fixtures still use these values):*
- **Domain:** `promptinjectionaudit.com` is **OWNED**.
  - Registered by hand at **GoDaddy** on **2026-10-04** (RDAP creation 13:16Z = 16:16 IDT). An earlier note said 3 Oct; that was the order attempt.
  - Cost **$13.73** (42 ILS at 0.3269 USD/ILS; no order number). Expires 2027-10-04. `drop_date` 2028-10-04.
- **Approved plan** (Dvir, 5 Oct 00:39 IDT: "Approve the prices, but wait for the software to list it"):
  - Category `trend`, mode `hybrid`. BIN **$1,995**.
  - Floor **$1,295**. That equals the formula.
  - Walk-away **$950** (private threshold). The formula gives $960; Dvir approved $950, so it is stored as `pricing_exception` (warning `PRICING_EXCEPTION`).
  - **Marketplace min offer $100** (decision #2, 01:03). Offers $100–$949 are declined automatically and logged; $950–$1,294 go to Dvir; ≥ $1,295 Afternic auto-accepts. **Lease-to-own off.**
- **Comps:** none were found on its card, so the import uses `legacy_no_comps` (warning `LEGACY_NO_COMPS`).
- **Afternic CSV row:** `PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N`.
- **Drop schedule** (computed from the approved values; "L" = the first listing date, still unknown):

| Event | When | BIN / floor / walk-away |
|---|---|---|
| M6 | L + 6 months | $1,595 / $1,035 / $760 (min offer stays $100 throughout) |
| M18 | L + 18 months (any L before 2027-01-06 keeps M18 before the final push) | $1,295 / $830 / $610 |
| Final push | **2028-07-06** | $895 / $830 / $610 |
| Delist | **2028-09-27** | — |

- **Expected warnings:** `FLOOR_AUTO_ACCEPT`, `PRICING_EXCEPTION`, `LEGACY_NO_COMPS`. Expected errors: none.
- **Listing waits for the API service** (Dvir's decision, 00:39). Until then the name sits on GoDaddy's default nameservers, and HTTPS fails (checked 4 Oct, 21:38 IDT); that is the accepted consequence of his decision.
- GoDaddy specifics are in `report.md` §Import and `../research/registrars.md`.

## 9. Tests (pass/fail; G0 unit + G1 API). The pricing calculator tests (PR-*) are in `test-plan.md`

**Mode validation (LS)**

| ID | Input | Pass | Fail |
|---|---|---|---|
| LS-1 | `mode:"auction"` | 422 `MODE_INVALID` | Accepted |
| LS-2 | bin mode, no `bin` | 422 `BIN_REQUIRED` | Accepted |
| LS-3 | geo bin 399 + floor 350 | 422 `BIN_MODE_NO_NEGOTIATION` | Accepted |
| LS-4 | geo bin 399, floor/min_offer omitted | 200; stored floor = min_offer = walkaway = 399 | Other values |
| LS-5 | bin mode + `lto_max_months` | 422 `LTO_NOT_ALLOWED` | Accepted |
| LS-6 | offer (with override) + bin 2000 | 422 `OFFER_MODE_HAS_BIN` | Accepted |
| LS-7 | offer (with override), no min_offer / min_offer 10 | 422 `MIN_OFFER_REQUIRED` / `MIN_OFFER_TOO_LOW` | Accepted |
| LS-8 | offer (with override), min_offer 500, floor 400 | 422 `FLOOR_BELOW_MIN_OFFER` | Accepted |
| LS-9 | offer (with override), min_offer 500 | 200 + `NO_BIN_LESS_EXPOSURE` | No warning |
| LS-10 | hybrid without `bin` | 422 `HYBRID_FIELDS_REQUIRED` | Accepted |
| LS-11 | hybrid bin 1995 + exception floor 2100 / exception walkaway 1000 with floor 950 | 422 `HYBRID_PRICES_INVALID` (both) | Accepted |
| LS-12 | hybrid 1995 + LTO 12 without override / with override → ok; LTO 61, or a lease ending on or after `drop_date` (*corrected 5 Oct: under v2 a hybrid BIN below $795 is `BIN_BELOW_FLOOR_MIN`, so the old "bin 495 / 395" cases can't occur*) | 422 `LTO_NOT_ALLOWED` / 200 / 422 `LTO_INVALID` | Other |
| LS-13 | hybrid bin 4995, nothing else | 200; floor 3245, walkaway 2400, min_offer 100; `FLOOR_AUTO_ACCEPT` | Other values, or no warning |
| LS-14 | Contradiction: `mode:"bin"` with `"offer":true`-style extra fields | 422 (strict schema: unknown or contradictory fields are rejected) | Silently ignored |
| LS-15 | hybrid bin 1995 + `min_offer` 800 / `min_offer` 960 / `min_offer` 100 | 422 `MIN_OFFER_FIXED` / 422 `MIN_OFFER_FIXED` / 200 | Accepted, or 100 refused |
| LS-16 | hybrid bin 1990 / bin 695 | 422 `BIN_NOT_NICE` / `BIN_BELOW_FLOOR_MIN` | Accepted |
| LS-16b | **v3** (6 Oct 2026, §10.13): hybrid bin 1495 / 995 / 1999 / 699 / 1488 / 788 / 1988 without and with LANDER-1 exception evidence | 422 `BIN_NOT_IN_PRICE_LIST` ×4; 200; 200; 422 `LANDER_EXCEPTION_REQUIRED` / 200 | Any off-list price accepted |
| LS-17 | hybrid bin 1995 + floor 1200 (no exception) | 422 `PRICING_FORMULA_MISMATCH` (details show computed 1295/960) | Accepted |
| LS-18 | hybrid bin 1995 + floor 1295 + walkaway 950 + exception + approval_ref | 200; `pricing_source=approved_exception`; `PRICING_EXCEPTION` warning with formula 960 | Rejected |
| LS-19 | Exception with floor 700 | 422 `FLOOR_BELOW_MIN` | Accepted |
| LS-20 | hybrid bin 1995 + exception floor 1295 + walkaway 450 + approval_ref (+ override) | 422 `WALKAWAY_BELOW_MIN` | Accepted |

**Guards (LG)**

| ID | Input | Pass | Fail |
|---|---|---|---|
| LG-1 | geo manual change, bin 299 / 499 (both edges) + approval_ref (manual range only; the schedule never sets 299) | 200 | Rejected |
| LG-2 | geo manual change, bin 298 / 500 | 422 `GEO_BIN_OUT_OF_RANGE` | Accepted |
| LG-3 | geo, offer or hybrid | 422 `GEO_MODE_NOT_ALLOWED` | Accepted |
| LG-4 | geo bin 650, `override:true` + reason + valid approval_ref | 200; `listing_history.override = true` with reason and approval | Rejected, or override not recorded |
| LG-5 | geo bin 650, override but no approval_ref / approval 73 h old / approval names another domain | 422 `OVERRIDE_NEEDS_APPROVAL` | Accepted |
| LG-6 | trend, bin mode, bin 999, no override | 422 `MODE_NOT_ALLOWED_FOR_CATEGORY` | Accepted |
| LG-7 | trend, bin mode, bin 2500, no override (**changed 5 Oct**: was 200) | 422 `MODE_NOT_ALLOWED_FOR_CATEGORY` | Accepted |
| LG-8 | trend, bin 999 with override + approval | 200, recorded, `HIGH_VALUE_LOW_BIN` in the override record | Rejected |
| LG-9 | D-001 import: hybrid 1995 / exception floor 1295, walkaway 950, `legacy_no_comps` | 200 + `FLOOR_AUTO_ACCEPT` + `PRICING_EXCEPTION` + `LEGACY_NO_COMPS` | Rejected, or warnings missing |
| LG-10 | trend hybrid bin 1995, no floor/walkaway sent (**replaces** the retired `high_value_guard_modes` test) | 200; stored 1995 / 1295 / 960; `pricing_source=formula`; settings version recorded | Other values |
| LG-11 | Relabel trick: change category trend→geo without override | 422 `OVERRIDE_NEEDS_APPROVAL` | Accepted |
| LG-12 | Settings via the API (`floor_bps`, `geo_bin_max` in the body) | Ignored or 422; the settings are unchanged | Changed |
| LG-13 | Manual price change (within the rules) without `approval_ref` | 200; `listing_history.approval_text` null | 422 |
| LG-14 | NS-only re-point without `approval_ref` | 200 | Rejected |
| LG-15 | Overrides can't bypass V1–V5 (e.g. hybrid exception with floor > bin + override) | 422 `HYBRID_PRICES_INVALID` | Accepted |
| LG-16 | `/buy` with `proposed_listing` that breaks V5–V7, V11 or V12, or doesn't match the computed plan | 422/409 **before** any registrar call (mock shows 0 `register` calls) | Domain bought |
| LG-17 | `/buy` without `category` | 422 `CATEGORY_REQUIRED`, 0 registrar calls | Bought |
| LG-18 | `/buy` geo without `price_grade` | 422 `GEO_GRADE_REQUIRED`, 0 registrar calls | Bought |
| LG-19 | `/buy` geo `strong` with bin 399 | 422 `GEO_BIN_NOT_GRADE_PRICE` | Bought |
| LG-20 | *(Changed 6 Oct 2026, selection v9.1: comps optional.)* `/buy` with no comps / 1 comp / 4 comps / a comp without `source_url` / `sold_on` in the future | no comps and 1 comp accepted (if the screening pack passes); 422 `COMPS_INVALID` ×3, 0 registrar calls | `COMPS_REQUIRED` still emitted, or an invalid comp accepted |
| LG-21 | `/buy` with `expected_settings_version` = current − 1 | 409 `SETTINGS_VERSION_CHANGED`, 0 registrar calls | Bought |

**History and audit (LH)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| LH-1 | 3 accepted changes (hybrid → raise BIN → hold) | 3 `listing_history` rows, in order, each with `audit_id`; `/portfolio/{d}` shows them | Missing or out of order |
| LH-2 | Rejected change | 0 history rows, 1 audit row | A history row |
| LH-3 | `UPDATE`/`DELETE` on `listing_history` | DB error | Succeeds |
| LH-4 | `dry_run:true` | 0 history rows; response previews the Afternic and Sedo rows **and the schedule** | Rows written |
| LH-5 | Scheduled drop applied (PR-20) | One row with `source=schedule`, `schedule_event_id`, `plan_audit_id`, no new approval text | Missing fields |

**Export columns per mode (LX)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| LX-1 | geo bin, BIN 399 | Afternic row = `…,399,399,399,N,,Buy It Now,Y,N,N,N` | Any cell differs |
| LX-2 | offer mode (override), min 500, no floor | `…,0,,500,N,,Custom Lander,N,N,Y,N` | Differs |
| LX-3 | hybrid 1995, formula | `…,1995,1295,100,N,,Custom Lander,Y,N,Y,N` | Differs (e.g. 960 in Min Offer) |
| LX-3b | D-001 (exception 1295/950) | `PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N`; `950` appears nowhere in the file | Differs |
| LX-4 | hybrid + LTO 24 (override), BIN 4995 | `Lease to Own=Y`, `Max Lease Period=24`, `Show LTO=Y` | Differs |
| LX-5 | Sedo, test template, each mode | offer → make offer + min; hybrid (default `make_offer`) → make offer + price + **min = 100** (never the walk-away); geo → make offer + price + min = BIN; hybrid with admin `buy_now` → fixed + BIN + no min | Differs |
| LX-6 | Min Offer < 20 ever exported | Never (DB CHECK + V4/V5) | Exported |
| LX-7 | Mode switch hybrid → offer, then export | BIN cell is `0`, not blank | Blank |
| LX-8 | **Live (G5):** first upload per mode | Afternic dashboard shows the expected BIN / floor / min offer / lander for that mode within 48 h (Dvir's screenshot) | Differs → fix the mapping; record the finding in `../research/marketplaces.md` |
| LX-9 | **Live (G5), first geo name:** Min Offer = BIN accepted by Afternic | Accepted, with no offer form on the lander | Rejected → fallback min offer = 0.9 × BIN, documented; re-run LX-1 with the new rule |

## 10. Pricing calculator, drop schedule and settings (adopted 5 Oct 2026, 00:46 IDT)

The **server** computes every derived price from three inputs: **BIN + category (+ geo grade) + the current `pricing_settings` version**. Bots and Dvir never type a floor, walk-away or drop price by hand, except for an approved exception (V5). All math is in **integer cents**; no floats anywhere.

### 10.1 `pricing_settings` (versioned, append-only)

*The v3 fields and values (selection v9.1, 6 Oct 2026) are in §10.13. The table below is v2.*

| Field | v2 value | Meaning |
|---|---|---|
| `version` | **2** (v1 = 00:46 rules, superseded) | Integer, increments by 1. Rows are never updated or deleted (DB trigger) |
| `effective_at`, `created_at`, `approval_text`, `approval_at`, `note` | 2026-10-05 09:17 IDT, "v2: $500 walk-away floor, one geo drop, Sedo make-offer, final push to floor" (v1: 00:46, "pricing process adopted") | Who approved the version and when |
| `geo_bin_strong_cents` / `geo_bin_weaker_cents` | 49900 / 39900 | Geo price per grade |
| `geo_bin_min_cents` / `geo_bin_max_cents` | 29900 / 49900 | The range for a **manual** geo change (V6). The schedule never uses it |
| `geo_drops_enabled` / `geo_drops` | true / `[{"after_months":12,"from_cents":49900,"to_cents":39900}]` | Geo: at most one drop, $499 → $399 at month 12; a $399 name never drops (decided v2) |
| `floor_bps` / `floor_min_cents` | 6500 / 75000 | Floor = 65% of BIN, never below $750 |
| `walkaway_bps` / `walkaway_min_cents` | 4800 / **50000** | Walk-away = max(48% of BIN, $500), never above the floor (private threshold; v2) |
| `hybrid_min_offer_cents` | 10000 | **Marketplace minimum offer on every non-geo listing = $100** (Dvir, 5 Oct 2026, 01:03 IDT). Must be ≥ $20 (Afternic's minimum). Never derived from the walk-away |
| `drops` | `[{"after_months":6,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]` | Scheduled drops |
| `final_push_days_before_drop` / `final_push_mode` | 90 / `bin_to_floor_ceil95` | Hybrid final push (§10.4). Geo has none |
| `delist_days_before_drop` | 7 | Delist |
| `headsup_days_before` | 7 | How far ahead `/report` lists an event for Gavriel's heads-up |
| `comps_min` / `comps_max` | 2 / 3 | V11 |
| `public_lto` | false | Public lease-to-own off |

- **The current version** is the highest `version` with `effective_at` ≤ now. It is created only by `npm run admin -- pricing-settings new --from-current --set floor_bps=6000 … --approval-text "<Dvir's words>" --approval-at <ISO>`, never by the API.
- **Every plan stores the version it was computed with** (`domains.pricing_settings_version`, `price_schedule.settings_version`, `listing_history.pricing_settings_version`).
- **A new version applies to new plans only.** Existing names keep their approved plan; Dvir approved those exact numbers. Re-pricing an existing name with the new version is a manual `POST /list` with `"replan":true` (bot-only, no `approval_ref` unless it carries an exception or override; (Dvir, 5 Oct 2026, 20:07: bot autonomy)).

### 10.2 Rounding to nice prices (decided)

*v2 rules. v3 (§10.13): BINs come from the price list (no rounding); floor = whole dollar; walk-away still `round5`.*

| What | Rule | Why | Examples |
|---|---|---|---|
| Non-geo **BIN** (public) | Must end in **95** at listing (V5). Computed BINs (drops, final push) go to the **nearest whole-dollar price ending in 95; ties go down** | Matches D-001's $1,995 and the common x95 retail pattern; ties down so a drop is never smaller than a tie would make it | $1,596.00 → $1,595 · $1,276.00 → $1,295 · $1,545.00 (tie) → $1,495 · $956.00 → $995 |
| Geo **BIN** (public) | The grade prices ($499/$399). The only scheduled geo change is $499 → $399 (no rounding needed). `nice99` is kept for manual-change validation only | One geo step only (v2) | $499 → $399 |
| **Floor** and **walk-away** (not shown as list prices) | **Nearest $5, ties up** | Close to the exact %, so "65%" and "48%" stay honest; ties up is the conservative side for Dvir | 65% × $1,995 = $1,296.75 → **$1,295** · 48% × $1,995 = $957.60 → **$960** · $828.00 → $830 · $957.50 → $960 |

- Percentages are applied in cents as `(c × bps + 5000) div 10000` (half-up to the cent) **before** the nice-price rounding.
- Cent formulas (normative):
  - `round5(c) = ((c + 250) div 500) × 500`
  - `nice95(c)`: let `n = c + 500`. Choose `lo = (n div 10000) × 10000` or `hi = lo + 10000`, whichever is closer to `n` (ties → `lo`). Return that minus 500.
  - `nice99` is the same with 100 in place of 500.
  - `ceil95(c)`: the smallest whole-dollar price ending in 95 that is ≥ `c` (final push, v2).

### 10.3 The formula and its minimums

**Non-geo (hybrid):**
- `floor = min(BIN, max(round5(BIN × floor_bps), floor_min))`
- `walkaway = min(floor, max(round5(BIN × walkaway_bps), walkaway_min))` with `walkaway_min` = $500 (v2). Since the floor is always ≥ $750, the walk-away is always ≥ $500
- `min_offer = min(hybrid_min_offer, walkaway)` = **$100** under v2 (the walk-away is always ≥ $500, so the min offer is simply $100)
- `hybrid_bin_min` = the smallest price ending in 95 that is ≥ `floor_min` = **$795**. It is derived, not a setting, so it always stays consistent with `floor_min`.

**When the $750 floor minimum can't be met:**

| Case | Behaviour |
|---|---|
| 65% of BIN < $750 but BIN ≥ $795 (BIN $795–$1,155) | Floor is **raised to $750**; warning `FLOOR_RAISED_TO_MIN`. Floor ≤ BIN still holds |
| BIN < $795 at listing or buy | **Refused**: 422 `BIN_BELOW_FLOOR_MIN`. It can't be overridden. A non-geo name worth under $795 isn't a fit for the POC (`>$500` goal); propose a different BIN or don't buy |
| A scheduled drop would take the BIN below $795 | The BIN **clamps at $795**. If it is already $795, the drop is **skipped** (status `skipped_at_minimum`), and **floor and walk-away stay unchanged** too (a drop never lowers floor or walk-away when the BIN can't drop) |
| A settings change makes `floor_min` > some existing BIN | Existing plans keep their version (§10.1), so nothing changes until a re-plan |

**Geo (bin):** BIN = the grade price; floor = min offer = walk-away = BIN. There are no offers (the $100 min offer is for non-geo listings only).

**Worked examples (settings v2; these are test vectors PR-1–PR-8 and PR-40):**

| Input | Floor | Walk-away (private) | Min offer (exported) |
|---|---|---|---|
| hybrid $1,995 | $1,295 | $960 | $100 |
| hybrid $2,495 | $1,620 | $1,200 | $100 |
| hybrid $4,995 | $3,245 | $2,400 | $100 |
| hybrid $1,195 | $775 | $575 | $100 |
| hybrid $795 | $750 (raised) | **$500** (raised to the minimum) | $100 |
| hybrid $995 | $750 (raised) | **$500** (48% = $480) | $100 |
| hybrid $1,495 | $970 | $720 | $100 |
| geo strong | $499 | $499 | $499 |
| geo weaker | $399 | $399 | $399 |

### 10.4 Drop schedule (pre-approved on the buy card; Dvir gets heads-ups only)

*v2 plans. v3 plans step down the price list instead (§10.13). The D-001 example below is its 5 Oct plan, superseded by the 6 Oct 00:32 reprice (§8).*

| Event | Due on | What changes |
|---|---|---|
| `drop1_m6` | **anchor + 6 months** | BIN × (1 − 20%) → nice price; floor × (1 − 20%) → round5, ≥ $750 and ≤ BIN; walk-away × (1 − 20%) → round5, then max with $500, ≤ floor; min offer unchanged ($100). **Geo: no M6/M18 events** |
| `geo_drop_m12` | **anchor + 12 months** | **Geo strong only:** $499 → $399 (floor = walk-away = min offer = BIN). A $399 name gets no row. This is the only geo price change the schedule ever makes |
| `drop2_m18` | **anchor + 18 months** | The same, applied to the values after M6 |
| `final_push` | **`drop_date` − 90 days** | **Hybrid only** (`bin_to_floor_ceil95`, v2): BIN = min(BIN, max(ceil95(floor), $795)); floor and walk-away unchanged. `skipped_no_change` if the BIN is already there. **Geo: none** (no $299). Also: Sochen drafts one E1 batch to prospects never contacted (**sending still needs Gate C**) |
| `delist` | **`drop_date` − 7 days** | Status → `delisted`. The domain goes into `X-Manual-Delist` on both exports, and `/report` shows "remove at Afternic, Sedo, DA" for Dvir. Nameservers are left alone |

**Rules for the schedule:**
- **Anchor** = the IDT date of the domain's first accepted listing (the first `listing_history` row with a mode). "+N months" keeps the day of the month, or the last day of a shorter month.
- **Values are scaled from the current approved values**, not recomputed from the formula. So an approved exception (D-001's walk-away $950) carries through the schedule proportionally. For formula-based plans both methods give the same numbers within rounding.
- **All rows are computed when the plan is created** (status `planned`, with exact amounts and dates), so the buy card and the heads-up show real numbers.
- An M-event due on or after the final push date is created as `superseded_by_final_push`.
- A drop that can't lower the BIN is `skipped_at_minimum`, as is a final push that changes nothing (`skipped_no_change`).
- **Regenerate the schedule when:**
  - **A manual price change is approved** (`POST /list`): future unapplied rows → `superseded`, and new rows are computed from the new values with the same anchor dates.
  - **`drop_date` changes** (Gate F says drop at first expiry): `final_push` and `delist` move, and M-rows at or after the new final push are superseded.
  - **The domain is sold, delisted or dropped:** all open rows → `cancelled`.
- **Hold:** `pricing_hold = true` (Dvir's words via `POST /list`, e.g. while a negotiation is open) keeps due rows `planned`.
  - When the hold is lifted, the next job run applies **only the latest due event**; earlier due ones become `superseded`, because the latest one already holds the cumulative values.
  - `delist` is never held: `drop_date` is fixed by the max-one-renewal rule.

**Example: D-001** (approved 1995 / 1295 / 950; `drop_date` 2028-10-04; if first listed on 2026-10-12):

| Event | Date | Values |
|---|---|---|
| M6 | 2027-04-12 | $1,595 / $1,035 / $760 |
| M18 | 2028-04-12 | $1,295 / $830 / $610 |
| Final push | 2028-07-06 | $895 / $830 / $610 |
| Delist | 2028-09-27 | — |

### 10.5 Scheduled job `src/jobs/price-schedule.ts`
- **When it runs:** once a day as the first step of the `daily` job (`POST /jobs/run`, 00:05 UTC, triggered by the Cloudflare Worker cron; `00-architecture.md` §6), before the drop job, registrar check and backup export. No extra service, so no extra cost (local dev: `npm run job -- daily`). It can also be run by hand: `npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]`.
- **For each `price_schedule` row with status `planned` and `due_on ≤ today` (IDT)**, in one transaction per domain, under the per-domain advisory lock:
  - **Skip** if the domain isn't `listed`, or if `pricing_hold` is set.
  - **Otherwise:**
    - update the domain's `bin`/`floor`/`walkaway` to the row's values (`min_offer` stays at the plan's value, $100 for hybrid; geo min offer = the new BIN);
    - append `listing_history` (`source=schedule`, `schedule_event_id`, `plan_audit_id`, `pricing_settings_version`);
    - set the row to `applied` with `applied_at` and the `listing_history_id`;
    - set `domains.export_pending_since` (if empty);
    - write an `audit_log` row (scope `job`).
  - For `delist`: status → `delisted`; add to the manual-delist list.
- **Idempotent:** unique `(domain_id, event, plan_id)`. A second run on the same day changes nothing (PR-22).
- **The job never:**
  - calls a registrar or a marketplace;
  - changes nameservers;
  - sends anything;
  - applies a row whose values break V5/V6 (it marks it `failed`, adds a `/report` warning, and changes nothing).
- **The marketplaces only change when a bot uploads the export file** on the marketplace website (§10.7; (Dvir, 5 Oct 2026, 20:07: bot autonomy)).

### 10.6 `GET /pricing/preview` (READ)
- **Query:** `category` (required), `bin` (USD; required unless geo), `grade` (geo), optional `floor` + `walkaway` (to preview an exception), `listed_on` (date; default today), `drop_date` (default today + 2 years), `domain` (optional; then `drop_date` is taken from the DB).
- **Errors:** the same codes as V2/V5/V6 (`BIN_NOT_NICE`, `BIN_BELOW_FLOOR_MIN`, `GEO_GRADE_REQUIRED`, …). 200 with `warnings[]` otherwise. **No side effects** (not even an audit row; it's a GET).
- **Response:**
```json
{ "settings_version": 2, "category": "trend", "mode": "hybrid", "pricing_source": "formula",
  "bin_cents": 199500, "floor_cents": 129500, "walkaway_cents": 96000, "min_offer_cents": 10000,
  "display": {"bin":"$1,995","floor":"$1,295","walkaway":"$960 (private)","min_offer":"$100"},
  "net_at_15pct": {"bin":"$1,695.75","floor":"$1,100.75","walkaway":"$816.00"},
  "schedule": [
    {"event":"drop1_m6","due_on":"2027-04-12","bin":"$1,595","floor":"$1,035","walkaway":"$770","status":"planned"},
    {"event":"drop2_m18","due_on":"2028-04-12","bin":"$1,295","floor":"$830","walkaway":"$615","status":"planned"},
    {"event":"final_push","due_on":"2028-07-06","bin":"$895","floor":"$830","walkaway":"$615","status":"planned"},
    {"event":"delist","due_on":"2028-09-27","status":"planned"} ],
  "afternic_row": "PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N",
  "sell_plan_line": "hybrid · BIN $1,995 · floor (auto-accept) $1,295 · walk-away (private) $960 · min offer $100 · LTO off · M6 2027-04-12 $1,595/$1,035/$770 · M18 2028-04-12 $1,295/$830/$615 · final push 2028-07-06 $895/$830/$615 · delist 2028-09-27 · settings v2",
  "warnings": ["FLOOR_AUTO_ACCEPT"] }
```
  (The example uses `listed_on=2026-10-12`, `drop_date=2028-10-04`, and the formula walk-away. D-001's real plan uses its approved $950.)
- **The same computation** runs inside `/buy`, `/list` (incl. `dry_run`) and `import-domain`, so the preview, the card and the stored plan can't drift (PR-17).

### 10.7 Export flags for the weekly upload
- **`GET /export/afternic.csv`** (and `sedo.csv`) gains these:
  - **Always the full current file.** `changed_only` is removed (a query parameter of any kind is a 422 `VALIDATION_ERROR`); Afternic's upload is always a full-file Update.
  - **Headers:** `X-Export-Id`, `X-Pending-Changes: <n>` and `X-Manual-Delist`. `X-Manual-Delist` also lists `delisted` domains.
  - **Pending** = listed names with `listing_changed_at` after the snapshot time of the venue's newest confirmed upload (all listed names while none was confirmed). **Manual delist** = sold/delisted/dropped names first listed at or before that snapshot whose status changed after it.
- **`POST /export/{venue}/uploaded`** `{"export_id":"…","uploaded_at":"…","note":"…"}` (WRITE; the bot calls it after it uploaded the file; `approval_ref` optional, `export-csv.md`). It records `export_uploads` (which moves the venue's pending boundary to that file's snapshot time) and clears `export_pending_since` for the file's domains unchanged since the snapshot.
- **`/report` warnings:**
  - `EXPORT_PENDING` lists every domain whose live marketplace price is now stale, with days pending. It becomes an error-level warning after 7 days.
  - The weekly lander check compares the page with the **last uploaded** values, so a drop that's waiting for upload shows as "pending upload", not as a broken lander.

### 10.8 Who decides each offer (marketplaces enforce the $100 min offer; the server classifies every logged offer; Gavriel routes)

| Offer (hybrid) | Afternic | Sedo / DomainAgents | Email thread (outbound) |
|---|---|---|---|
| ≥ BIN | Sells (BIN is binding) | Accept: pre-approved by the buy card | **Dvir** (Sochen drafts; he sends) |
| floor ≤ offer < BIN | Afternic brokers close it automatically (A2) | Accept: pre-approved | **Dvir** |
| walk-away ≤ offer < floor | Reaches Dvir as an offer | **Dvir decides (Gate D)**; Sochen drafts the counter | **Dvir** |
| $100 ≤ offer < walk-away | Reaches the seller dashboard. **Declined automatically:** Dvir clicks Decline (or lets Afternic expire it, if it does so itself); no counter, no Gate D | **Declined automatically:** Sochen's standard decline template (no number other than the public BIN), or no action if the venue closes it itself | Sochen's standard decline template; Dvir sends it (pre-approved text, no Gate D) |
| < $100 | Blocked by Afternic's min offer | Make Offer: blocked by Sedo's minimum. Buy Now listing: declined like the row above | Same as the row above |
| **Geo**, any offer < BIN | Not possible (min offer = BIN) | Declined | One line: "The price is $X, fixed" |

**Every offer in every row is logged** with `POST /offers` (§10.11), including the declined ones and geo ones. The server classifies it against the prices in force when it was received and returns the routing above.

Offer counts and amounts feed the quarterly review from the `offers` table (§10.11). It replaces the earlier `inquiries` proposal (`system/selling-playbook.md` §7 S3); the per-deal `offers.md` files stay as narrative only.

### 10.9 Quarterly pricing review (settings change without code)
1. **When:** the first Monday of January, April, July and October. The first review is **4 Jan 2027**; the April review merges with the POC review (3 Apr 2027).
2. **Gizbar** reads `GET /report/pricing-review?from=&to=` (READ). It returns:
   - for every sale: the sale price ÷ the BIN at the time of sale, the venue, the event stage (M0/M6/M18/final), days listed, and whether the sale happened at the floor (auto-accept);
   - for every offer logged (the `offers` table, §10.11): the offer ÷ BIN at the time, its band, source and buyer type, and offers per listed name per month by category;
   - the count of skipped and held events.
   - Gizbar marks the result **"insufficient data"** when there are fewer than 3 sales in the window.
3. **Gavriel** proposes % changes as scored options (e.g. `floor_bps` 6500 → 6000 if most sales land at the floor within 30 days; `drops[0].after_months` 6 → 4 if no name gets an offer before M6; `walkaway_bps` 4800 → 4000 if many logged offers land just below the walk-away).
4. **Dvir approves in chat.** Dvir (or Claude Code with him) runs `npm run admin -- pricing-settings new …` with his verbatim words. That creates version N+1. No code changes, and existing plans keep their version (§10.1).

### 10.10 Data model (detail in `00-architecture.md` §4)
- **`domains` adds:** `walkaway_cents`, `price_grade`, `pricing_source`, `pricing_settings_version`, `first_listed_at`, `pricing_hold`, `pricing_hold_reason`, `plan_id`, `plan_audit_id`, `export_pending_since`. `status` adds `delisted`.
- **New tables:**
  - `pricing_settings` (versioned, append-only);
  - `price_schedule` (`id`, `domain_id`, `plan_id`, `event`, `due_on`, `bin_cents`, `floor_cents`, `walkaway_cents`, `settings_version`, `status` ∈ planned/applied/skipped_at_minimum/skipped_no_change/skipped_disabled/superseded/superseded_by_final_push/cancelled/failed, `applied_at`, `listing_history_id`, `note`);
  - `pricing_evidence` (`domain_id`, `comps` jsonb, `rationale`, `legacy_no_comps_reason`, `audit_id`);
  - `export_uploads` (`id`, `venue`, `export_id`, `domains[]`, `uploaded_at`, `approval_text` (nullable), `note`, `audit_id`);
  - `offers` (§10.11).
- **The reference implementation** used to generate the test vectors is `system/tools/pricing_calc.py` on Gavriel's box (not in this repo; bots don't add code here). The PR tests in `test-plan.md` are the contract.

### 10.11 Offers log: `POST /offers`, `/report` demand signal (Dvir, 5 Oct 2026, 01:03 IDT, decision #2)
**Why:** Afternic has no seller API, and offers below the walk-away never reach a decision. Without a log they'd be lost, but they are the best demand signal for the quarterly review.

**Table `offers`** (one row per offer received; amounts in integer cents):

| Column | Rule |
|---|---|
| `id`, `domain_id` | `domain_id` must be an owned domain (any status from `owned` on) |
| `amount_cents` | Integer > 0 (USD). A non-USD offer is converted by the recorder; the original goes in `note` |
| `source` | `afternic` / `godaddy` / `sedo` / `domainagents` / `email_inbound` / `outbound_reply` / `other` |
| `received_at` | timestamptz from the marketplace email or dashboard. Not more than 5 minutes in the future |
| `buyer_type` | `end_user` / `investor` / `broker` / `unknown` (default `unknown`) |
| `buyer_ref` | Optional opaque label (e.g. the marketplace's buyer ID). **No email addresses or names**: values containing `@` are refused (`NO_PII`) |
| `external_ref` | Optional marketplace offer ID or email Message-ID. Unique per `source` (dedupe key) |
| `bin_cents_at`, `floor_cents_at`, `walkaway_cents_at`, `min_offer_cents_at`, `listing_history_id` | Snapshot of the prices in force at `received_at` (from `listing_history`; the latest row ≤ `received_at`) |
| `band` (server) | `below_min` (< min offer) / `below_walkaway` (min offer ≤ x < walk-away) / `mid_range` (walk-away ≤ x < floor) / `at_or_above_floor` (floor ≤ x < BIN) / `at_or_above_bin`. Geo: `geo_below_bin` / `at_or_above_bin` |
| `routing` (server) | `auto_decline` (below_min, below_walkaway, geo_below_bin) / `dvir` (mid_range; and every `email_inbound` or `outbound_reply` offer ≥ walk-away) / `auto_accept` (≥ floor on afternic/godaddy) / `accept_preapproved` (≥ floor on other venues) |
| `outcome`, `outcome_at`, `outcome_note`, `outcome_approval_text` | `declined_auto` (set at record time for `auto_decline`) / `open` (all others) → `declined` / `countered` / `accepted` / `expired` / `withdrawn` / `sold` |
| `recorded_by`, `audit_id`, `created_at` | Who recorded it (from the token's agent name) |

- **Immutable facts:** a DB trigger refuses updates to `domain_id`, `amount_cents`, `source`, `received_at`, the snapshot and `band`. Only the outcome fields change, each change through the API with an `audit_log` row.
- **No side effects:** recording an offer never calls a marketplace or registrar, never sends anything, and never changes a price. It may set `pricing_hold` only if the request asks for it (reason required; no `approval_ref`, as with `POST /list`; (Dvir, 5 Oct 2026, 20:07: bot autonomy)).

**`POST /offers`** (WRITE; Gavriel, from a marketplace email or dashboard):
```json
{"domain":"promptinjectionaudit.com","amount_usd":"450.00","source":"afternic",
 "received_at":"2026-12-01T09:12:00+02:00","buyer_type":"unknown","external_ref":"AFN-OFFER-123"}
```
- **201** with the stored row, plus `band`, `routing` and `next_step` (plain text, e.g. "Below the walk-away: decline in the Afternic dashboard; no Gate D" or "Mid-range: Sochen drafts; needs Dvir's Gate D line").
- **Duplicate** (`source` + `external_ref` exists, or, without `external_ref`, the same domain + amount + source + `received_at`): **200** with the existing row and `"duplicate": true`; nothing is written.
- **Errors:** 404 `DOMAIN_NOT_FOUND`; 422 `AMOUNT_INVALID`, `SOURCE_INVALID`, `BUYER_TYPE_INVALID`, `RECEIVED_AT_IN_FUTURE`, `NO_PII`; 403 with a READ token.
- **Warnings:** `OFFER_ON_UNLISTED` (domain not `listed` at `received_at`; stored with band against the plan's prices, or `unpriced` if there are none); `OFFER_AT_OR_ABOVE_FLOOR` ("Afternic may already have closed this; check the dashboard").

**`POST /offers/{id}/outcome`** (WRITE) `{"outcome":"countered","note":"…","approval_ref":{…}}`:
- `countered` or `accepted` on any offer that isn't pre-approved (routing not `auto_accept`/`accept_preapproved`, i.e. `dvir`: mid-range, or any email offer ≥ walk-away) **needs `approval_ref`** with Dvir's words (a sell decision, Gate D); otherwise 422 `APPROVAL_REQUIRED`.
- `declined` on an `auto_decline` offer needs none. `sold` must match a `POST /sold` for the same domain.

**CSV import:** Removed 6 Oct 2026 (Dvir): `POST /offers/import`, the `offer_imports` table and `offers.import_id`. Gavriel records offers one at a time with `POST /offers`.

**`GET /offers?domain=&from=&to=&band=&source=`** (READ): the rows, newest first.

**`/report` additions (READ):**
- **Per domain** (`per_domain[].offers`): `count_30d`, `highest_30d`, `count_90d`, `highest_90d`, `count_all`, `highest_all`, `highest_all_pct_of_bin` (vs the BIN in force when it was received), `last_offer_at`, `open_for_dvir` (mid-range offers still `open`). Periods are counted back from now in IDT days; empty periods give 0 and `null` (not missing keys).
- **Per strategy** (`offers_by_strategy[]`, one row per category with its strategy label, e.g. `trend` = S3): `names_listed`, `names_with_offers`, `offers_90d`, `offers_per_listed_name_per_month` (90 days, 2 decimals), `median_offer_pct_of_bin` and `max_offer_pct_of_bin` (all time), and the share of offers per band.
- **`GET /report/offers?from=&to=&group_by=domain|category|source|month`** (READ): the same aggregates for any window. `/report/pricing-review` (§10.9) uses it.
- **Warning** `OFFER_NEEDS_DVIR`: a mid-range or email offer has been `open` for more than 48 h.

**Tests:** OF-1 to OF-20 in `test-plan.md`.

### 10.12 Implementation decisions (Dvir, 5 Oct 2026, steps 4b-1 and 4b-2; confirmed "Confirm all")
- **Settings:** only version 2 is seeded (no v1 plan was ever computed). Each settings version's cross-field rules are enforced on load and by the admin command: ≤ 2 drops in ascending months < 24; ≤ 1 geo drop, from the strong to the weaker grade price *(v2; v3 allows one geo rung per plan from either grade, §10.13)*; `hybrid_min_offer` ≤ `walkaway_min`. `--from-current` is optional; at least one `--set` is required; a version that changes nothing is refused. `drops`/`geo_drops` use snake_case keys (`after_months`, `pct_bps`, `from_cents`, `to_cents`).
- **Exceptions:** a request with `pricing_exception: true` is always stored as `approved_exception` (even if the values equal the formula); `PRICING_EXCEPTION` is warned when they differ or the BIN doesn't end in 95. It needs `pricing_exception_reason` (`EXCEPTION_REASON_REQUIRED`) and a valid approval (`APPROVAL_REQUIRED`).
- **Codes added:** `WALKAWAY_NOT_ALLOWED` (walk-away or exception in offer mode; in bin mode a walk-away ≠ BIN is `BIN_MODE_NO_NEGOTIATION`), `LISTING_PRICE_INVALID` (not a positive whole-dollar amount), `GRADE_NOT_GEO`, `HOLD_REASON_REQUIRED`, `REPLAN_NOTHING_LISTED`, 503 `DOMAIN_BUSY`, 503 `REGISTRAR_UNAVAILABLE`, 500 `PRICING_SETTINGS_MISSING`. Lease-to-own always needs an override (V8), whatever `public_lto` says.
- **Override plans** (non-geo plain `bin`, `offer`, a geo BIN off the grade price, or geo `hybrid`) get only a `delist` row: no drops and no final push.
- **Geo M12** due on or after the delist date is created as `superseded_by_final_push` (status name reused; geo has no final push).
- **A delisted domain** still counts toward the domain cap until it is sold or dropped.
- **Preview:** `afternic_row` uses the given domain's validated `display_name` (else the domain; `example.com` with no domain). The response adds `grade`. Prices display as whole dollars (`$1,995`); `net_at_15pct` keeps cents. The `sell_plan_line` shows skipped events as `M6 skipped (minimum)` / `(no change)` / `(disabled)`, omits superseded ones, prints `LTO <n> mo` when set, and starts `bin (geo strong) · BIN $499 · no offers` for geo. Query errors (unknown parameter, bad date, non-decimal amount, `drop_date` not after `listed_on`) → 400 `VALIDATION_ERROR`; rule errors stay 422; an unknown `domain` → 404 `DOMAIN_NOT_FOUND`; with `domain`, sending `drop_date` too → 400.

### 10.13 `pricing_settings` v3: selection v9.1 price list and step-down drops (Dvir approved v9.1, 6 Oct 2026)

**Applies to new plans only** (§10.1). v2 plans keep their numbers and schedules. **D-001** is repriced by Dvir's 6 Oct 00:32 decision (§8), applied by Gavriel via the API once live. The admin command creates v3 with Dvir's v9.1 approval as `approval_text`; until then v2 stays current. Rules v9.1 states are marked **[v9.1]**; rules it leaves open and this spec proposes are marked **[proposed]** and need Dvir's OK at the build gate.

| Field (new or changed) | v3 value | Meaning |
|---|---|---|
| `allowed_bins_cents` | `[29900,39900,49900,78800,108800,148800,198800,248800]` | **[v9.1]** Every listed or scheduled BIN must be in this list (geo and non-geo). Implies the forbidden bands $800–$999 / $1,950–$1,999 and no x95/x99 non-geo endings |
| `nongeo_bin_min_cents` / `nongeo_default_bin_cents` | 78800 / 148800 | **[v9.1]** Non-geo uses list values ≥ $788; default $1,488. Replaces the derived `hybrid_bin_min` ($795) |
| `lander_exception_bins_cents` | `[198800,248800]` | **[v9.1]** Need LANDER-1 exception evidence (≥30 A/B leads ∧ retailstats end count ≥20) in the screening pack |
| `floor_bps` / `floor_min_cents` / `floor_rounding` | 6500 / 75000 / `dollar` | **[v9.1]** Floor = 65% of BIN, half-up to the whole dollar ($1,488 → $967), never below $750, never above BIN |
| `walkaway_bps` / `walkaway_min_cents` | 4800 / 50000 | Unchanged (v2 rule, `round5`) |
| `hybrid_min_offer_cents` | 10000 | Unchanged |
| `drop_mode` / `drops` | `ladder` / `[{"after_months":6,"steps":1},{"after_months":18,"steps":1}]` | **[v9.1]** ladder; the months are kept from v2 **[proposed]**. Replaces `pct_bps` 2000 |
| `geo_drops` | `[{"after_months":12,"steps":1}]` | **[v9.1; confirmed by Dvir 6 Oct 2026, 01:01]** geo ladder 499 → 399 → 299, one rung at M12 as written here (a $399 name drops to $299 at M12). Replaces v2 decision 2 ("a $399 name never drops") |
| `final_push_mode` | `bin_to_lowest_listed_ge_floor` | **[proposed]** BIN = the lowest list value ≥ floor and ≤ current BIN; floor and walk-away unchanged. Replaces `bin_to_floor_ceil95` (which can give off-list prices such as $995). Geo: none |
| `comps_min` / `comps_max` | 0 / 3 | **[v9.1]** comps optional (V11) |
| `geo_bin_min_cents` / `geo_bin_max_cents` | 29900 / 49900 | A manual geo change must also be in the list ($299 / $399 / $499) |

**Calculation (integer cents):**
- `round_dollar(c) = ((c + 50) div 100) × 100`; `floor = min(BIN, max(round_dollar((BIN × 6500 + 5000) div 10000), 75000))`; `walkaway = min(floor, max(round5((BIN × 4800 + 5000) div 10000), 50000))`.
- **Ladder step:** the next lower value in `allowed_bins_cents` within the name's lane (non-geo ≥ $788; geo ≤ $499). At the bottom of the lane the event is `skipped_at_minimum` (values unchanged).
- **After each step, floor and walk-away are recomputed from the new BIN** **[v9.1]** (not scaled as in v2 §10.4). For an approved-exception plan this means the exception does not carry through drops **[proposed; v9.1 is silent]**.
- Schedule events, anchor, holds, regeneration, delist and the job (§10.4–§10.5) are unchanged.

**Vectors (v3; also `test-plan.md` PR3-*):**

| BIN | Floor | Walk-away | M6 | M18 | Final push |
|---|---|---|---|---|---|
| $2,488 (exception) | $1,617 | $1,195 | 1988/1292/955 | 1488/967/715 | 1088/967/715 |
| $1,988 (exception) | $1,292 | $955 | 1488/967/715 | 1088/750/520 | 788/750/520 |
| **$1,488 (default)** | **$967** | $715 | **1088**/750/520 | **788**/750/500 | `skipped_no_change` |
| $1,088 | $750 (raised) | $520 | 788/750/500 | `skipped_at_minimum` | `skipped_no_change` |
| $788 | $750 (raised) | $500 | `skipped_at_minimum` | `skipped_at_minimum` | `skipped_no_change` |
| geo $499 / $399 | = BIN | = BIN | — | — | none; M12: 499 → 399 / 399 → 299 |

**Validation codes (v3; names proposed):** `BIN_NOT_IN_PRICE_LIST` (422), `LANDER_EXCEPTION_REQUIRED` (422). `BIN_NOT_NICE` and `BIN_BELOW_FLOOR_MIN` remain for v2 plans only.

