# POST /buy  (WRITE)

**Goal:** register a domain at the cheapest qualifying registrar (first year + one renewal), **only** after Dvir's explicit chat approval. The server enforces caps, never double-buys, and records everything (ledger, portfolio, receipt, audit) in the DB.

**Who calls it:** Gavriel, **only** after Dvir has explicitly approved the purchase in chat. Gavriel puts Dvir's verbatim words and their timestamp in `approval_ref`. (Dvir never calls the API himself; 5 Oct 2026, 20:07.)

## Request
Header: `Idempotency-Key: <uuid>` (required).
```json
{ "domain": "examplecityroofing.com",      // illustrative geo name, not checked
  "max_price": 11.50,                 // USD cap on the FIRST-YEAR charge (required)
  "max_two_year_price": 23.00,        // optional cap on first year + one renewal
  "approval_ref": { "text": "APPROVE D-002 BUY examplecityroofing.com 1yr max $11.50, sell plan as on card (bin $399, settings v3)", "approved_at": "2026-10-06T09:10:00+03:00" },
  "deal_id": "D-002",                 // optional
  "category": "geo",                  // REQUIRED: geo|trend|b2b|collision|regulation|buzzword|other (listing-strategy.md §1)
  "price_grade": "weaker",            // REQUIRED for geo: strong ($499) | weaker ($399), from pricing_settings
  "proposed_listing": {"mode":"bin","bin":399},   // the buy card's numbers; non-geo (settings v3): {"mode":"hybrid","bin":1488,"floor":967,"walkaway":715}
                                                  // the server RE-COMPUTES the plan (listing-strategy.md §10) and refuses a mismatch BEFORE buying
  "screening_pack": {"id":"sp_…"},               // REQUIRED since 6 Oct 2026 (selection v9.1, SEL7-1): the id POST /screening_pack returned; check 3c
  "pricing_evidence": {"comps":[                  // OPTIONAL since 6 Oct 2026 (was REQUIRED 2–3 comps, V11); shape-checked if sent; never invent comps
      {"domain":"<comp1>.com","price_usd":0,"sold_on":"YYYY-MM-DD","venue":"<venue>","source_url":"https://…"},
      {"domain":"<comp2>.com","price_usd":0,"sold_on":"YYYY-MM-DD","venue":"<venue>","source_url":"https://…"}],
    "rationale":"one line"},
  "expected_settings_version": 3,                 // the version GET /pricing/preview used on the card (V12); 3 once the v9.1 settings exist (listing-strategy.md §10.13)
  "override": false, "override_reason": null,      // only if proposed_listing needs a guard override (same approval_ref)
  "registrar": null,                  // optional: pin one registrar (Dvir named it); no fallback then
  "dry_run": false,                   // default false
  "auto_list": true }                 // default true: point NS at the lander right after purchase (see list.md)
```

## Server-side checks, in order (any failure stops the call: no registrar call, audit row written)

| # | Check | Error |
|---|---|---|
| 1 | Token scope is WRITE | 403 `SCOPE_FORBIDDEN` |
| 2 | `Idempotency-Key` present. If seen before: same body → replay the stored response; different body → 409 | 400 `IDEMPOTENCY_KEY_REQUIRED` / 409 `IDEMPOTENCY_KEY_MISMATCH` |
| 3 | `approval_ref.text` is non-empty, **names the domain** on label boundaries (case-insensitive; `ba.com`, `x.com.au`, `www.x.com` or `x.company` do not name `x.com`; Dvir, 5 Oct 2026), and `approved_at` is not in the future and is ≤ `approval_max_age_hours` (default 72) old | 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` |
| 3b | `category` present and valid (geo: `price_grade` too). `pricing_evidence`, if sent, passes V11 (optional since 6 Oct 2026). `expected_settings_version` matches (V12). If `proposed_listing` is given, it passes `listing-strategy.md` V1–V8 **and equals the server-computed plan** (§10.3; an approved exception or override uses this call's `approval_ref`) | 422 `CATEGORY_REQUIRED` / `GEO_GRADE_REQUIRED` / `COMPS_INVALID` / (v3) `BIN_NOT_IN_PRICE_LIST` / `LANDER_EXCEPTION_REQUIRED` / `PRICING_FORMULA_MISMATCH` / the listing error code; 409 `SETTINGS_VERSION_CHANGED` (**no registrar call**) |
| 3c | **Screening pack (selection v9.1, 6 Oct 2026; `selection.md` SCREEN-1, §4, SEL7-1):** `screening_pack` present, else **400**. It names a pack stored by `POST /screening_pack` for **this domain**, complete, validated ≤ `approval_max_age_hours` before the call, with every hard gate passing: for non-geo **DEMAND-1** (census `pattern_id@version`, `in_use_share ≥ 0.25`, retailstats start/end count ≥ 1 with `cache_date`), LEAD-1 (A/B tiers), RATIO-1 at BIN and floor, EV-1, LANDER-1 (`bin_in_allowed_set`, and the pack BIN = `proposed_listing.bin`), `registrar_ft_capable` (FT-1 eligibility), WEB-RISK-1 / HIST-1 / SURBL-1 / TM-1. Comps are **not** required | 400 `SCREENING_PACK_REQUIRED` / 422 `SCREENING_PACK_INVALID` (`details.failed_gates`) (**no registrar call**) |
| 4 | The domain isn't already in `domains` with status `pending_purchase`/`owned`/`listed`, and no open purchase exists for it | 409 `ALREADY_OWNED_OR_PENDING` |
| 5 | **Domain cap:** count of `owned` + `listed` + `pending_purchase` < `max_domains` (50) | 409 `DOMAIN_CAP_REACHED` |
| 6 | **Live re-check:** run the `/check` logic now, with no cache. `availability` must be `available`, and a winner (or the pinned registrar) must be eligible | 409 `NOT_AVAILABLE` / `NO_ELIGIBLE_REGISTRAR` / `PINNED_REGISTRAR_INELIGIBLE` |
| 7 | **Price caps:** among eligible quotes, keep only those with `first_year ≤ max_price` (and `two_year ≤ max_two_year_price` if given), then choose the lowest `two_year` | 409 `PRICE_ABOVE_MAX` (with the cheapest quote in `details`) |
| 8 | **POC cap:** `spent + pending + first_year ≤ poc_cap_cents` ($1,500). `spent` = −Σ amounts of `registration`, `renewal`, `fee` rows; `pending` = Σ `expected_cents` of purchases in `created`/`register_sent`/`unknown` (Dvir, 5 Oct 2026). Read in **one statement**, re-checked **under a global lock** (`SELECT … FOR UPDATE` on `settings`) in the reservation, so parallel buys can't overshoot | 409 `POC_CAP_EXCEEDED` (with spent, remaining) |
| 9 | Registrar account state: balance ≥ cost, where known; spend-limit remaining ≥ cost, where known | 409 `REGISTRAR_FUNDS` (with the shortfall). **No top-up is ever attempted** |
| 10 | Registrar dry run, where supported (Porkbun `dryRun:true` with the exact `cost`): `wouldSucceed` must be true | 409 `REGISTRAR_DRY_RUN_FAILED` (with the registrar's `code`) |

If `dry_run: true`, the call **stops here**. It returns 200 with everything that would happen (winner, costs, cap headroom, registrar dry-run result) and `"dry_run": true`. **Nothing is written except the audit row and the quotes.**

## Purchase (when `dry_run: false`)
1. Take a **per-domain advisory lock**.
2. Insert a `purchases` row (`state=created`) and a `domains` row (`status=pending_purchase`), in one transaction.
3. Call `adapter.find_domain(domain)`.
   - If the domain is already in our account (e.g. a crashed earlier run), skip to step 6 (bookkeeping) instead of buying again.
4. Set `state=register_sent`, then call `adapter.register(...)` with:
   - **registrar idempotency key** = `"dt-" + purchases.id`;
   - `privacy=true` and `auto_renew=false`;
   - **years = 1 only.**
5. Handle the result:
   - **Success:** continue.
   - **Definite failure** (an error `code`, nothing charged): set `state=failed` and delete the `pending_purchase` row (or mark it `failed`). Return 409 with the registrar code.
   - **Ambiguous** (timeout, 5xx, connection reset): retry the **same request with the same idempotency key** up to 3 times (2 s, 5 s, 10 s). Porkbun replays within 24 h. Then call `find_domain`:
     - present → success path;
     - absent and RDAP 404 → `unknown` (202) as well; the reconciler fails it after 30 min if it is still absent (Dvir, 5 Oct 2026: never release in-call after ambiguous attempts, so a late registration is still booked);
     - otherwise `state=unknown`, return **202** `PURCHASE_STATE_UNKNOWN`. The reconciler resolves it (§6).
6. **Bookkeeping, in ONE DB transaction:**
   - `ledger_entries`: `registration`, `-charged_cents`, `counterparty=<registrar>`, `receipt_ref=<registrar>:<order_id>`, note `"1yr; privacy on; check <check_id>; approval <audit_id>"`.
   - `domains`: `status=owned`, `registrar`, `buy_date`, `cost_cents`, `expiry_date` (from the registrar), `renewal_price_cents` (from the quote), **`renewals_used=0`**, **`drop_date = expiry_date + 1 year`**, `category`, `registrar_api` (from the adapter) (a 29 Feb expiry gives 28 Feb the next year).
   - `receipts`: the invoice JSON, if available now; otherwise the reconciler fetches it later. Billing address redacted.
   - `purchases.state=succeeded`.
   - `deals` upsert, if `deal_id` was given.
7. **Post-buy steps** (outside the money transaction; each result goes in the response; a failure here never undoes the purchase):
   1. `find_domain`: confirm `whois_privacy=1`. If it's 0, add a warning: Porkbun has no privacy-on endpoint after registration, so Dvir fixes it in the dashboard.
   2. `set_auto_renew(false)`, then verify.
   3. If `auto_list`: run the `/list` logic with the configured lander (see `list.md`). With `proposed_listing`, it also stores the mode and the computed prices (BIN, floor, private walk-away, min offer $100), stores `pricing_evidence`, appends a `listing_history` row (`source=buy`), sets `first_listed_at`, and **creates the `price_schedule` rows** (`listing-strategy.md` §10.4); the domain becomes `listed`. Dvir's buy approval is the plan approval (`plan_audit_id`).
      - If `API_ACCESS_DISABLED`, add a warning telling Dvir to turn on "Opt In All Domains" at porkbun.com/account/api, then call `/list` again.
   4. **FT-1 (selection v9.1, 6 Oct 2026):** open a distribution check due **`ft_eligible_on + 7 days`** (Dvir, 6 Oct 2026, 01:01: the 7 days start when the name becomes Fast Transfer eligible, not at the buy). `ft_eligible_on` = the date the name becomes Fast Transfer eligible: after any registrar lock (e.g. GoDaddy: 60 days after the buy) and after Afternic's ≥60-day rule (`system/post-acquisition.md` F3); default `buy_date + 60 days`, stored on the domain. Afternic Fast Transfer opt-in and the Afternic listing at the **same BIN** must be confirmed with `POST /distribution/confirm` (`ft_optin_at`, `afternic_listed_at`, `bin`; evidence pasted by a bot) by then. Otherwise the daily job flags the name `distribution_incomplete` (`/report` warning `DISTRIBUTION_INCOMPLETE`; counts as failed in pattern health, SEL9-6). The Afternic listing itself goes live right after the buy as before; FT-1 checks both the opt-in and the same-BIN listing once the name is eligible.

## Response (201)
```json
{ "domain":"examplecityroofing.com", "registrar":"porkbun", "order_id":"12345678",
  "charged":"$11.08", "renewal":"$11.08", "two_year":"$22.16", "expiry_date":"2027-10-04", "drop_date":"2028-10-04",
  "renewals_used":0, "poc_spent_after":"$11.08", "poc_remaining":"$1,488.92", "domains_owned":1,
  "post_buy":{"privacy":"on","auto_renew":"off","lander":"afternic ns set",
    "listing":{"mode":"bin","bin":399,"price_grade":"weaker","settings_version":2,
      "schedule":[{"event":"delist","due_on":"2028-09-27"}]}},
  "warnings":[], "audit_id":"aud_…" }
```

## Decisions (Dvir, 5 Oct 2026, step 3)
- **Listing (3b, 7.3):** `proposed_listing` is validated with V1–V8 before any registrar call. Post-buy `auto_list` sets the lander NS via the registrar (set, read back, compare as sets) and stores the listing (`listing_history`, `source=buy`, `status=listed`) even if the NS step fails (warning). Public-DNS verification is `/list`'s job.
- **Check 9:** registrar auto top-up ON → 409 `REGISTRAR_AUTO_TOPUP_ON`; account state unreadable → 409 `REGISTRAR_STATE_UNKNOWN`.
- **Check 10:** `COST_MISMATCH` on the dry run → re-quote once, re-check every cap (incl. check 9), retry the dry run. On the real create it is a definite failure (409 `REGISTRAR_REJECTED`). An *ambiguous* dry-run answer (e.g. answered as a real registration) → 409 `REGISTRAR_DRY_RUN_AMBIGUOUS`, and an `unknown` purchase row is recorded so the cap counts it and the reconciler resolves it.
- **Approval:** `approved_at` must carry a timezone offset; ≤ 60 s of future clock skew is accepted.
- **Replay:** if `purchases` already holds the `Idempotency-Key`, its outcome is replayed (a succeeded purchase always as 201, rebuilt from the rows if needed); a different domain with the same key → 409 `IDEMPOTENCY_KEY_MISMATCH`. A stored 202 for `/buy` is re-evaluated on retry instead of replayed.
- **Found in account / ambiguous:** a domain found in the account is booked **only** from the registrar's invoice (`find_registration`); no invoice yet → 202 `PURCHASE_STATE_UNKNOWN`. A definite error after an earlier ambiguous attempt is resolved by lookup, not trusted.
- **Expiry:** from `find_domain`, else the invoice line, else `buy_date + 1 year` with warning `EXPIRY_ESTIMATED`. `buy_date` / ledger `occurred_on` use the Asia/Jerusalem date.
- **Portfolio:** a domain already in `domains` as `sold`/`dropped` → 409 `ALREADY_IN_PORTFOLIO`.
- **Reconciler:** also fails `created` purchases older than 10 min (never sent) and deletes their pending row; every fail is guarded by the selected state; it does not run post-buy steps (`/report` flags them).
- **Ambiguous dry run** also writes a `pending_purchase` domain row, so the 10-domain cap counts it.
- **New codes:** `REGISTRAR_REJECTED` (details.registrar_code), `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_DRY_RUN_AMBIGUOUS`, `ALREADY_IN_PORTFOLIO`, `PURCHASE_FAILED`, `PURCHASE_ABANDONED`, `LISTING_PRICE_INVALID`.

## Decisions (Dvir, 5 Oct 2026, step 4b-2; confirmed "Confirm all")
- **Exception fields at buy:** `pricing_exception`, `pricing_exception_reason` and `walkaway` go **inside** `proposed_listing`.
- **Check 3b order:** an invalid `proposed_listing.mode` → `MODE_INVALID` first; then category / `price_grade` (`GRADE_NOT_GEO` if a grade is sent for a non-geo name); then V1–V8 (`phase=buy`: a geo BIN must be the grade price); then V11 comps (optional since 6 Oct); then V12; then 3c (screening pack, 6 Oct). All before any registrar contact.
- **Comps (V11), when sent, are stored on every successful buy** (optional since 6 Oct 2026; the screening pack id is stored too) (not only with `auto_list`), as the first post-buy step; a failure is a warning (`EVIDENCE_SAVE_FAILED`) and never undoes the purchase. Comp prices may have cents; listing prices are whole dollars.
- **Post-buy listing** is saved under the per-domain lock after the money transactions commit. A failure is the warning `LISTING_SAVE_FAILED`. `post_buy.listing` uses the plan view (`*_cents` + display strings, walk-away marked "(private)", `pricing_source`, `settings_version`, `schedule`, `sell_plan_line`).
- **Dry run** returns `proposed_listing` with the full schedule computed as `GET /pricing/preview` does with no domain (anchor today IDT, drop date + 24 months), so the card, the preview and the stored plan match (PR-17).
- **Reconciler-booked purchases** (B-20, a 202 later booked) get no comps or plan, since the reconciler doesn't run post-buy; `/report` flags them (step 4d) and the comps and screening pack id remain in `purchases.request`.
- **B-28 clock:** the test runs at 2026-10-05 10:00Z (v2 takes effect 09:17 IDT that day); the dates follow the buy date.
- `PRICING_SETTINGS_MISSING` (500) if no `pricing_settings` version is in effect.

## Decisions (selection v9.1, Dvir approved 6 Oct 2026; `selection.md`)
- **Screening pack replaces comps** as the buy evidence (check 3c). Missing → 400 (SEL7-1); comps optional (V11).
- **FT-capable registrar only** (FT-1): at check 6 the winner must come from an adapter marked `ft_capable` (Porkbun: yes, KB 163; others only once verified). Others are excluded with `NOT_FT_CAPABLE` *(code name proposed)*.
- **FT-1 post-buy check** (step 7.4): confirmation ≤ 7 days **after `ft_eligible_on`** (amended 6 Oct 01:01) via `POST /distribution/confirm`, else `distribution_incomplete`.
- **Prices:** `proposed_listing.bin` follows `pricing_settings` v3 (price list, `listing-strategy.md` §10.13) once v3 exists; v2 plans are unchanged.
- **Renewal price** stored at buy is the live quote (unchanged); the renewal decision itself uses the live `/check/quote` renewal at that time (`GET /renewal/decision/{domain}`, `report.md`).
- **S7** names come only from zone diff + RDAP 404 ×2 or names Dvir pastes (`GET /s7/candidates`); no auctions.

## ~~Phase-later: auction max bid for S7~~ (retired 6 Oct 2026)
- **Retired:** selection v9.1 `S7-ONLY` says fully dropped names only (RDAP 404 ×2), **no auctions**, and founder rule 5 already forbids auctions. Kept below for history; don't build it.
- Buy cards for **S7 (expiring/auction names)** carry a **`max_bid`** field: **max bid = 10% of the card's proposed BIN** (e.g. BIN $1,995 → max bid $199.50, shown rounded down to whole dollars: $199). Dvir approves the max bid on the card (his yes names it). Bots never bid above it.
- Auctions stay out of scope for v1 (`00-architecture.md` §2), so the API doesn't place bids. When built: `/buy` (or a future `/bid`) refuses any amount > the approved `max_bid` with 422 `MAX_BID_EXCEEDED`, and the `max_bid` counts against the POC cap like a quote.

## Never
- Never call a registrar's top-up or auto-top-up endpoints.
- Never register for more than 1 year.
- Never buy premium or aftermarket names.
- Never fall back to another registrar when one is pinned.
- Never retry a definite failure with a new idempotency key inside the same call.

## Reconciler (§6)
Runs **hourly** in production (the `tick` job, `00-architecture.md` §6; every 10 min under local in-process timers). For every `purchases.state in (register_sent, unknown)` older than 2 min:
- Call `find_domain` at that registrar.
  - Present: finish the bookkeeping (step 6), then `state=succeeded`.
  - Absent, RDAP 404, and older than 30 min: `failed`.
- Also fetch missing receipts for `succeeded` purchases.
- It never registers anything.

## Max-one-renewal (affects buy and the proposed v1.1 `/renew`)
- The comparison uses first year + **exactly one** renewal.
- At purchase: `renewals_used=0` and `drop_date = expiry + 1 yr`.
- Proposed `/renew/{domain}` (v1.1): refuses when `renewals_used ≥ 1` (409 `MAX_ONE_RENEWAL`). Otherwise it renews 1 year, adds a `renewal` ledger row, and sets `renewals_used=1`.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| B-1 | READ token | 403, audit row written, no registrar call | Any other outcome |
| B-2 | No `Idempotency-Key` | 400 | Accepted |
| B-3 | Same key + same body, twice | The 2nd returns the stored response with `Idempotent-Replayed: true`; **exactly 1** registrar `register` call in the mock log | 2 calls |
| B-4 | Same key, different body | 409 `IDEMPOTENCY_KEY_MISMATCH` | Anything else |
| B-5 | Different key, same domain, after a success | 409 `ALREADY_OWNED_OR_PENDING`, 0 registrar calls | A purchase |
| B-6 | 10 parallel `/buy` calls for the same domain (different keys) | Exactly 1 `register` call; 9 refusals | ≥2 |
| B-7 | Approval text missing the domain / `approved_at` 73 h old / in the future | 422 for each | Accepted |
| B-8 | `max_price` 10.00 with best quote 11.08 | 409 `PRICE_ABOVE_MAX`, details show $11.08 | Bought |
| B-9 | `max_two_year_price` below the best 2-yr | 409 | Bought |
| B-10 | Cap filter before the min: A is $11.60 first year / $20.00 2-yr, B is $11.08 / $22.16, `max_price` 11.50 | B chosen | A, or a refusal |
| B-11 | POC: ledger spent $1,495.00, quote $11.08 | 409 `POC_CAP_EXCEEDED` (remaining $5.00) | Bought |
| B-12 | POC race: spent $1,480, two parallel buys of $11.08 for different domains | Exactly one succeeds | Both |
| B-13 | Domain cap: 50 owned | 409 `DOMAIN_CAP_REACHED` | Bought |
| B-14 | RDAP 200 / adapter "not available" | 409 `NOT_AVAILABLE`, 0 register calls | Any register call |
| B-15 | Pinned registrar ineligible | 409 `PINNED_REGISTRAR_INELIGIBLE`, no fallback | Falls back |
| B-16 | `dry_run:true`, all valid | 200, `dry_run:true`, registrar dry run called, **0 rows** in ledger/domains/purchases-succeeded; audit + quotes rows only | Any ledger/domain row |
| B-17 | Registrar `INSUFFICIENT_FUNDS` on the dry run | 409 `REGISTRAR_FUNDS` with the shortfall; no top-up call | Top-up attempted, or a 500 |
| B-18 | `COST_MISMATCH` (price changed between check and create) | Re-quote once; if still ≤ caps, proceed with the new cost; else 409 | Buys above the cap |
| B-19 | Timeout on `register`, then the replay returns success | Exactly one charge, bookkeeping done, 201 | Two charges, or no bookkeeping |
| B-20 | Process killed after `register_sent`, before bookkeeping | The next reconciler run (hourly in production) completes the rows; the ledger has exactly 1 registration row | 0 or 2 rows |
| B-21 | Successful buy: rows | 1 ledger row (−1108, `porkbun:<order>`); domain row with `renewals_used=0`, `drop_date=expiry+1y`; receipt; audit; purchase `succeeded` | Any missing or wrong |
| B-22 | 29 Feb expiry | `drop_date` = 28 Feb next year | Invalid date or error |
| B-23 | Ledger append-only | `UPDATE ledger_entries` raises | Succeeds |
| B-24 | Post-buy: privacy 0 / NS fails | Purchase still 201; warnings list the manual fix | 500, or rollback of the purchase |
| B-25 | Never top up | Static test: the code has no reference to `/account/topup*` endpoints | Reference found |
| B-26 | Sandbox E2E (gate G2, Porkbun `pk1_sb_` key) | Full buy of a random free .com in the sandbox; rows correct; a re-call with the same key replays | Any failure |
| B-27 | **Live acceptance (gate G4): the first deal bought through the API** (D-001 was bought by hand at GoDaddy, registered 4 Oct 2026, and is imported instead, see `report.md` §Import) | After Dvir's chat approval for that domain: one charge ≤ the approved `max_price`; Porkbun shows the domain with privacy on and auto-renew off; ledger/domain/receipt rows correct; `/report` spend rises by exactly the charge, domain count +1, `drop_date` set; NS = lander within 5 min | Any of these false |
| B-28 | *(v2 fixture settings; a valid screening pack added since 6 Oct)* Successful buy with a hybrid `proposed_listing` {bin 1995} + 2 comps + `expected_settings_version: 2` (corrected 5 Oct: the current version is 2; 1 would be refused by V12) | Domain stored 1995 / 1295 / 960 (min offer 100); `pricing_evidence` row; `first_listed_at` set; 4 `price_schedule` rows exactly as PR-12 (dates from the buy date); `plan_audit_id` = this call's audit id | Missing or different rows |
| B-29 | **v3 (6 Oct 2026):** hybrid {bin 1488}, valid screening pack, **no comps**, `expected_settings_version: 3` | Domain stored 1488 / 967 / 715 (min offer 100); schedule as PR3-3; FT-1 check due buy + 7 days | Refused for missing comps, or other values |
| B-30 | No `screening_pack` / pack for another domain / pack with DEMAND-1 failed / pack BIN 1488 vs `proposed_listing.bin` 1088 | 400 `SCREENING_PACK_REQUIRED` / 422 `SCREENING_PACK_INVALID` ×3; **0 registrar calls** (SEL7-1) | Any registrar call or purchase |
| B-31 | v3: hybrid bin 1495 / 1988 without LANDER-1 evidence | 422 `BIN_NOT_IN_PRICE_LIST` / `LANDER_EXCEPTION_REQUIRED`, 0 registrar calls (SEL9-3) | Bought |
| B-32 | FT-1 (amended 6 Oct 01:01): buy on 2026-10-04 (`ft_eligible_on` 2026-12-03); job on 2026-10-12, 2026-12-10 and 2026-12-11 without `/distribution/confirm`; then a confirm with a different BIN | No flag on 10-12 or 12-10; on 12-11 `DISTRIBUTION_INCOMPLETE` + `distribution_incomplete` flag (SEL9-6); the mismatched confirm → 422 `DISTRIBUTION_BIN_MISMATCH` | Not flagged, or mismatch accepted |

