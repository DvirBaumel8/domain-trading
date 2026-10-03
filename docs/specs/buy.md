# POST /buy  (WRITE)

**Goal:** register a domain at the cheapest qualifying registrar (first year + one renewal), **only** after Dvir's explicit chat approval. The server enforces caps, never double-buys, and records everything (ledger, portfolio, receipt, audit) in the DB.

**Who calls it:** Gavriel, **only** after Dvir has explicitly approved the purchase in chat. Gavriel puts Dvir's verbatim words and their timestamp in `approval_ref`. Dvir can also call it himself, e.g. with curl.

## Request
Header: `Idempotency-Key: <uuid>` (required).
```json
{ "domain": "promptinjectionaudit.com",
  "max_price": 11.50,                 // USD cap on the FIRST-YEAR charge (required)
  "max_two_year_price": 23.00,        // optional cap on first year + one renewal
  "approval_ref": { "text": "yes buy promptinjectionaudit.com up to $11.50", "approved_at": "2026-10-04T09:10:00+03:00" },
  "deal_id": "D-001",                 // optional
  "registrar": null,                  // optional: pin one registrar (Dvir named it); no fallback then
  "dry_run": false,                   // default false
  "auto_list": true }                 // default true: point NS at the lander right after purchase (see list.md)
```

## Server-side checks, in order (any failure stops the call: no registrar call, audit row written)

| # | Check | Error |
|---|---|---|
| 1 | Token scope is WRITE | 403 `SCOPE_FORBIDDEN` |
| 2 | `Idempotency-Key` present. If seen before: same body → replay the stored response; different body → 409 | 400 `IDEMPOTENCY_KEY_REQUIRED` / 409 `IDEMPOTENCY_KEY_MISMATCH` |
| 3 | `approval_ref.text` is non-empty, **contains the domain name** (case-insensitive), and `approved_at` is not in the future and is ≤ `approval_max_age_hours` (default 72) old | 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` |
| 4 | The domain isn't already in `domains` with status `pending_purchase`/`owned`/`listed`, and no open purchase exists for it | 409 `ALREADY_OWNED_OR_PENDING` |
| 5 | **Domain cap:** count of `owned` + `listed` + `pending_purchase` < `max_domains` (10) | 409 `DOMAIN_CAP_REACHED` |
| 6 | **Live re-check:** run the `/check` logic now, with no cache. `availability` must be `available`, and a winner (or the pinned registrar) must be eligible | 409 `NOT_AVAILABLE` / `NO_ELIGIBLE_REGISTRAR` / `PINNED_REGISTRAR_INELIGIBLE` |
| 7 | **Price caps:** among eligible quotes, keep only those with `first_year ≤ max_price` (and `two_year ≤ max_two_year_price` if given), then choose the lowest `two_year` | 409 `PRICE_ABOVE_MAX` (with the cheapest quote in `details`) |
| 8 | **POC cap:** `spent + first_year ≤ poc_cap_cents` ($500). `spent` = −Σ amounts of `registration`, `renewal`, `fee` rows. Computed **under a global lock** (`SELECT … FOR UPDATE` on `settings`), so parallel buys can't overshoot | 409 `POC_CAP_EXCEEDED` (with spent, remaining) |
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
     - absent and RDAP 404 → `failed`;
     - otherwise `state=unknown`, return **202** `PURCHASE_STATE_UNKNOWN`. The reconciler resolves it (§6).
6. **Bookkeeping, in ONE DB transaction:**
   - `ledger_entries`: `registration`, `-charged_cents`, `counterparty=<registrar>`, `receipt_ref=<registrar>:<order_id>`, note `"1yr; privacy on; check <check_id>; approval <audit_id>"`.
   - `domains`: `status=owned`, `registrar`, `buy_date`, `cost_cents`, `expiry_date` (from the registrar), `renewal_price_cents` (from the quote), **`renewals_used=0`**, **`drop_date = expiry_date + 1 year`** (a 29 Feb expiry gives 28 Feb the next year).
   - `receipts`: the invoice JSON, if available now; otherwise the reconciler fetches it later. Billing address redacted.
   - `purchases.state=succeeded`.
   - `deals` upsert, if `deal_id` was given.
7. **Post-buy steps** (outside the money transaction; each result goes in the response; a failure here never undoes the purchase):
   1. `find_domain`: confirm `whois_privacy=1`. If it's 0, add a warning: Porkbun has no privacy-on endpoint after registration, so Dvir fixes it in the dashboard.
   2. `set_auto_renew(false)`, then verify.
   3. If `auto_list`: run the `/list` logic with the configured lander (see `list.md`).
      - If `API_ACCESS_DISABLED`, add a warning telling Dvir to turn on "Opt In All Domains" at porkbun.com/account/api, then call `/list` again.

## Response (201)
```json
{ "domain":"promptinjectionaudit.com", "registrar":"porkbun", "order_id":"12345678",
  "charged":"$11.08", "renewal":"$11.08", "two_year":"$22.16", "expiry_date":"2027-10-04", "drop_date":"2028-10-04",
  "renewals_used":0, "poc_spent_after":"$11.08", "poc_remaining":"$488.92", "domains_owned":1,
  "post_buy":{"privacy":"on","auto_renew":"off","lander":"afternic ns set"}, "warnings":[], "audit_id":"aud_…" }
```

## Never
- Never call a registrar's top-up or auto-top-up endpoints.
- Never register for more than 1 year.
- Never buy premium or aftermarket names.
- Never fall back to another registrar when one is pinned.
- Never retry a definite failure with a new idempotency key inside the same call.

## Reconciler (§6)
Runs at startup and every 10 min. For every `purchases.state in (register_sent, unknown)` older than 2 min:
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
| B-11 | POC: ledger spent $495.00, quote $11.08 | 409 `POC_CAP_EXCEEDED` (remaining $5.00) | Bought |
| B-12 | POC race: spent $480, two parallel buys of $11.08 for different domains | Exactly one succeeds | Both |
| B-13 | Domain cap: 10 owned | 409 `DOMAIN_CAP_REACHED` | Bought |
| B-14 | RDAP 200 / adapter "not available" | 409 `NOT_AVAILABLE`, 0 register calls | Any register call |
| B-15 | Pinned registrar ineligible | 409 `PINNED_REGISTRAR_INELIGIBLE`, no fallback | Falls back |
| B-16 | `dry_run:true`, all valid | 200, `dry_run:true`, registrar dry run called, **0 rows** in ledger/domains/purchases-succeeded; audit + quotes rows only | Any ledger/domain row |
| B-17 | Registrar `INSUFFICIENT_FUNDS` on the dry run | 409 `REGISTRAR_FUNDS` with the shortfall; no top-up call | Top-up attempted, or a 500 |
| B-18 | `COST_MISMATCH` (price changed between check and create) | Re-quote once; if still ≤ caps, proceed with the new cost; else 409 | Buys above the cap |
| B-19 | Timeout on `register`, then the replay returns success | Exactly one charge, bookkeeping done, 201 | Two charges, or no bookkeeping |
| B-20 | Process killed after `register_sent`, before bookkeeping | The reconciler completes the rows within 10 min; the ledger has exactly 1 registration row | 0 or 2 rows |
| B-21 | Successful buy: rows | 1 ledger row (−1108, `porkbun:<order>`); domain row with `renewals_used=0`, `drop_date=expiry+1y`; receipt; audit; purchase `succeeded` | Any missing or wrong |
| B-22 | 29 Feb expiry | `drop_date` = 28 Feb next year | Invalid date or error |
| B-23 | Ledger append-only | `UPDATE ledger_entries` raises | Succeeds |
| B-24 | Post-buy: privacy 0 / NS fails | Purchase still 201; warnings list the manual fix | 500, or rollback of the purchase |
| B-25 | Never top up | Static test: the code has no reference to `/account/topup*` endpoints | Reference found |
| B-26 | Sandbox E2E (gate G2, Porkbun `pk1_sb_` key) | Full buy of a random free .com in the sandbox; rows correct; a re-call with the same key replays | Any failure |
| B-27 | **Live acceptance (gate G4): the first deal bought through the API** (D-001 was bought by hand on 3 Oct 2026 and is imported instead, see `report.md` §Import) | After Dvir's chat approval for that domain: one charge ≤ the approved `max_price`; Porkbun shows the domain with privacy on and auto-renew off; ledger/domain/receipt rows correct; `/report` spend rises by exactly the charge, domain count +1, `drop_date` set; NS = lander within 5 min | Any of these false |
