# POST /buy (WRITE)

Registers a domain at the cheapest qualifying registrar (first year + one renewal), **only** after Dvir's explicit chat approval, which Gavriel passes verbatim in `approval_ref`. Caps are enforced on the server; nothing is bought twice; ledger, portfolio, receipt and audit rows are written. Request and response shapes: `docs/contract/endpoints.md`.

## Checks, in order (any failure stops the call; nothing before check 6 contacts a registrar)
| # | Check | Error |
|---|---|---|
| 1 | WRITE scope | 403 `SCOPE_FORBIDDEN` |
| 2 | `Idempotency-Key`; a key already in `purchases` replays that outcome (a succeeded purchase always as 201, rebuilt from the rows if needed); another domain with the key → 409 | 400 `IDEMPOTENCY_KEY_REQUIRED` / 409 `IDEMPOTENCY_KEY_MISMATCH` |
| 3 | `approval_ref.text` non-empty and **names the domain** on label boundaries (case-insensitive; `ba.com`, `x.com.au`, `www.x.com`, `x.company` don't name `x.com`); `approved_at` has an offset, ≤ 60 s in the future, ≤ `approval_max_age_hours` (72) old | 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED` |
| 3b | `proposed_listing.mode` valid first; `category` valid (geo: `price_grade`; a grade on non-geo refused); `proposed_listing`, if given, passes `listing-strategy.md` V1–V8 with `phase=buy` (geo BIN = grade price) **and equals the server-computed plan** (an exception or override uses this call's `approval_ref`; `pricing_exception`, its reason and `walkaway` go inside `proposed_listing`); `pricing_evidence` passes V11; `expected_settings_version` matches (V12) | 422 `MODE_INVALID` / `CATEGORY_REQUIRED` / `GEO_GRADE_REQUIRED` / `GRADE_NOT_GEO` / the listing code / `PRICING_FORMULA_MISMATCH` / `COMPS_REQUIRED` / `COMPS_INVALID`; 409 `SETTINGS_VERSION_CHANGED` |
| 3c | **Not built (CR-001 P1b; selection v9.1 SCREEN-1, SEL7-1):** `screening_pack {id}` present (else **400** `SCREENING_PACK_REQUIRED`) naming a complete pack for this domain, validated ≤ 72 h before, every hard gate passing: non-geo DEMAND-1 (census `pattern_id@version`, `in_use_share ≥ 0.25`, retailstats start/end count ≥ 1 with `cache_date`), LEAD-1, RATIO-1 at BIN and floor, EV-1, LANDER-1 (pack BIN = `proposed_listing.bin`, on the price list), `registrar_ft_capable`, WEB-RISK-1 / HIST-1 / SURBL-1 / TM-1. Comps then become optional | 400 `SCREENING_PACK_REQUIRED` / 422 `SCREENING_PACK_INVALID` (`details.failed_gates`); v3 listing codes `BIN_NOT_IN_PRICE_LIST` / `LANDER_EXCEPTION_REQUIRED` |
| 4 | Not in `domains` as `pending_purchase`/`owned`/`listed`/`delisted`, and no open purchase; `sold`/`dropped` → 409 `ALREADY_IN_PORTFOLIO` | 409 `ALREADY_OWNED_OR_PENDING` |
| 5 | Domain cap: `owned` + `listed` + `delisted` + `pending_purchase` < `max_domains` (40 since 4.0.0), and Line 1 (names with `domains.lane` NULL) < `max_domains - s8_reserved_slots` (30 since 5.8.0, CR-059: 10 slots are reserved for the S8 import lane) | 409 `DOMAIN_CAP_REACHED` |
| 6 | Live re-check (the `/check` logic, no cache, doesn't write the cache): `availability = available` and an eligible winner (or the pinned registrar, no fallback) | 409 `NOT_AVAILABLE` / `NO_ELIGIBLE_REGISTRAR` / `PINNED_REGISTRAR_INELIGIBLE` |
| 7 | Price caps: keep eligible quotes with `first_year ≤ max_price` (and `two_year ≤ max_two_year_price`), then the lowest `two_year` | 409 `PRICE_ABOVE_MAX` (cheapest quote in `details`) |
| 8 | *(removed in 5.0.0, G-86: the service tracks no money budget; Gavriel owns it and checks spend before Dvir approves.)* | none |
| 9 | Registrar account: state readable, auto top-up off, balance ≥ cost and spend-limit remaining ≥ cost where known. **No top-up is ever attempted** | 409 `REGISTRAR_STATE_UNKNOWN` / `REGISTRAR_AUTO_TOPUP_ON` / `REGISTRAR_FUNDS` (shortfall, or `reason: MONTHLY_SPEND_LIMIT`) |
| 10 | Registrar dry run with the exact `cost` (Porkbun `dryRun:true`): must answer as a dry run that would succeed. `COST_MISMATCH` → re-quote once, re-check every cap (incl. 9), retry. An ambiguous answer → record an `unknown` purchase + `pending_purchase` row (so the caps count it) | 409 `REGISTRAR_DRY_RUN_FAILED` (`registrar_code`) / `REGISTRAR_DRY_RUN_AMBIGUOUS` |

`dry_run: true` stops after check 10: 200 with the winner, costs, cap headroom, the registrar dry-run result and the proposed plan with its full schedule (anchor today IDT, drop date + 24 months, as `GET /pricing/preview` with no domain: PR-17). Only the audit row and the quotes are written.

## Purchase (`dry_run: false`)
1. Reservation in one transaction: per-domain advisory lock (`hashtext(domain)`, shared with `/list`), the global settings lock, re-checks 4/5/8, insert `purchases` (`created`) and `domains` (`pending_purchase`).
2. `findDomain`: already in our account (a crashed earlier run, or bought by hand) → book **only** from the registrar's invoice (`findRegistration`; none yet → 202) with warning `FOUND_IN_ACCOUNT`; never buy again.
3. Persist `register_sent` **before** the call (guarded: if the reconciler abandoned it meanwhile → 409 `PURCHASE_ABANDONED`), then `register` with registrar key `dt-<purchase id>`, privacy on, 1 year.
4. Result: success → bookkeeping. Definite failure (a coded error, nothing charged) → `failed`, pending row removed, 409 `REGISTRAR_REJECTED` (`registrar_code`; a `COST_MISMATCH` here is definite). Ambiguous → retry the **same** request and key up to 3 times (2 s, 5 s, 10 s; Porkbun replays within 24 h); a definite error after an ambiguous attempt is resolved by lookup, not trusted; then `findDomain`: present → book from the invoice; otherwise `unknown` → **202** `PURCHASE_STATE_UNKNOWN` (never released in-call: a late registration must still be booked; the reconciler never fails it: it stays open, `/report` shows `PURCHASE_UNRESOLVED` after 30 min, and the admin `resolve-purchase` command closes it, §6).
5. **Bookkeeping, one transaction:** ledger `registration` −charged (`counterparty` = registrar, `receipt_ref` = `<registrar>:<order_id>`, note `1yr; privacy on; check <check_id>; approval <audit_id>`); `domains` → `owned` with registrar, `buy_date` (IDT), cost, expiry (from `findDomain`, else the invoice, else buy date + 1 year with `EXPIRY_ESTIMATED`), renewal price (from the quote), `renewals_used = 0`, `drop_date = expiry + 1 year`, category, `registrar_api`; receipt (billing identity redacted) if available; `purchases.succeeded`; `deals` upsert. A charge above `max_price` adds `CHARGE_ABOVE_MAX`.
6. **Post-buy (outside the money transaction; a failure is a warning, never an undo):** store comps (`EVIDENCE_SAVE_FAILED`); `findDomain` privacy check (`PRIVACY_OFF`: Porkbun can't turn it on by API, Dvir fixes it in the dashboard; `PRIVACY_UNKNOWN`); `setAutoRenew(false)` + verify (`AUTO_RENEW_FAILED`, `AUTO_RENEW_NOT_CONFIRMED`); with `auto_list`: lander NS via the registrar, set → read back → compare as sets (`LANDER_CUSTOM`, `LANDER_MISMATCH`, `LANDER_FAILED`, `NS_PENDING`, `API_ACCESS_DISABLED` with the "Opt In All Domains" hint), then under the per-domain lock the listing (mode, computed prices, min offer, `listing_history` `source=buy`, `first_listed_at`, `price_schedule` rows, status `listed`, `plan_audit_id` = this call's audit id; `LISTING_SAVE_FAILED`) even if NS failed. Public-DNS verification is `/list`'s and the daily job's. Totals failing → `TOTALS_UNAVAILABLE`; anything else → `POST_BUY_FAILED`.
7. **FT-1 (not built; CR-001 P2, CAP-22):** a distribution check due `ft_eligible_on + 7 days` (`ft_eligible_on` = the date the name becomes Fast Transfer eligible: after any registrar lock, e.g. GoDaddy 60 days, and Afternic's ≥ 60-day rule; default `buy_date + 60`; Dvir, 6 Oct 2026, 01:01). `POST /distribution/confirm` (`ft_optin_at`, `afternic_listed_at`, `bin`) must confirm the opt-in and an Afternic listing at the same BIN by then, else the daily job flags `distribution_incomplete` (`/report` `DISTRIBUTION_INCOMPLETE`; a mismatched BIN → 422 `DISTRIBUTION_BIN_MISMATCH`). The winner must also come from an FT-capable adapter (Porkbun: yes, KB 163); others excluded as `NOT_FT_CAPABLE` (name proposed).

Other v9.1 points (with CR-001): `proposed_listing.bin` follows `pricing_settings` v3 once it exists; the stored renewal price stays the live quote, while the renewal decision uses the live `/check/quote` at that time (`GET /renewal/decision/{domain}`); S7 names only from zone diff + RDAP 404 ×2 or names Dvir pastes. **Retired:** the S7 auction `max_bid` / `MAX_BID_EXCEEDED` (no auctions, founder rule 5).

## Never
Call a top-up endpoint; register for more than 1 year; buy premium or aftermarket names; fall back when a registrar is pinned; retry a definite failure, or any purchase, with a new idempotency key.

## Reconciler (§6; a step of the `daily` job since 2.1.0, also `npm run job -- tick`)
For every `purchases.state` in (`register_sent`, `unknown`) older than 2 min: `findDomain` at that registrar; present → finish the bookkeeping (from the invoice), `succeeded`; absent → the purchase **stays open** (registrar lag can look like absence; no RDAP check; Dvir, 10 Oct 2026): `/report` shows `PURCHASE_UNRESOLVED` once it is older than 30 min, and the admin `resolve-purchase` command closes it (the only way an open purchase is failed). On booking, the reconciler turns auto-renew off (a failure is only logged; `/report` `AUTO_RENEW_ON` covers it) and sets `drop_date = expiry` when the stored request has `drop_policy` `at_first_expiry`; `/buy` sets `drop_date` inside `bookPurchase`'s transaction too (`DROP_POLICY_FAILED` is gone). Also fails `created` purchases older than 10 min (never sent; pending row deleted), every transition guarded by the selected state; fetches missing receipts; never registers; never runs post-buy steps (`/report` flags them: `POST_BUY_INCOMPLETE`, `RECEIPT_MISSING`). Reconciler-booked purchases get no comps or plan (they remain in `purchases.request`).

## Max one renewal
Comparison = first year + exactly one renewal. At purchase `renewals_used = 0`, `drop_date = expiry + 1 year`. The proposed `/renew` (v1.1) refuses `renewals_used ≥ 1` (409 `MAX_ONE_RENEWAL`).

## Tests
| ID | Case | Pass |
|---|---|---|
| B-1 | READ token | 403, audit row, no registrar call |
| B-2 | No `Idempotency-Key` | 400 |
| B-3 | Same key + body twice | Stored response with `Idempotent-Replayed: true`; exactly 1 `register` call |
| B-4 | Same key, different body | 409 `IDEMPOTENCY_KEY_MISMATCH` |
| B-5 | New key, same domain after a success | 409 `ALREADY_OWNED_OR_PENDING`, 0 registrar calls |
| B-6 | 10 parallel buys, same domain | Exactly 1 `register`; 9 refusals |
| B-7 | Approval missing the domain / 73 h old / in the future | 422 each |
| B-8 | `max_price` 10.00 vs best 11.08 | 409 `PRICE_ABOVE_MAX`, details $11.08 |
| B-9 | `max_two_year_price` below the best 2-yr | 409 |
| B-10 | Caps before the min: A $11.60 / $20.00 2-yr, B $11.08 / $22.16, `max_price` 11.50 | B chosen |
| B-11 | G-86: spent $1,495.00, quote $11.08 | 201 (no money cap in the service) |
| B-12 | Two parallel $11.08 buys of different domains | Both succeed (G-86) |
| B-13 | 50 owned | 409 `DOMAIN_CAP_REACHED` |
| B-14 | RDAP 200 / adapter not available | 409 `NOT_AVAILABLE`, 0 register calls |
| B-15 | Pinned registrar ineligible | 409 `PINNED_REGISTRAR_INELIGIBLE`, no fallback |
| B-16 | `dry_run:true`, valid | 200 `dry_run:true`, registrar dry run called, 0 ledger/domain/succeeded-purchase rows |
| B-17 | `INSUFFICIENT_FUNDS` on the dry run | 409 `REGISTRAR_FUNDS` with the shortfall; no top-up |
| B-18 | `COST_MISMATCH` | Re-quote once; within caps proceed with the new cost, else 409 |
| B-19 | `register` timeout, then the replay succeeds | One charge, bookkeeping done, 201 |
| B-20 | Killed after `register_sent` | Next reconciler run completes the rows; exactly 1 registration row |
| B-21 | Successful buy rows | 1 ledger row (−1108, `porkbun:<order>`), domain with `renewals_used=0`, `drop_date=expiry+1y`, receipt, audit, purchase `succeeded` |
| B-22 | 29 Feb expiry | `drop_date` 28 Feb next year |
| B-23 | `UPDATE ledger_entries` | Raises |
| B-24 | Post-buy privacy 0 / NS fails | Still 201; warnings list the manual fix |
| B-25 | Never top up | Static: no reference to `/account/topup*` |
| B-26 | Sandbox E2E (G2, `pk1_sb_`) | Full buy of a random free .com; rows correct; same-key replay |
| B-27 | Live acceptance (G4): the first deal bought through the API | After Dvir's chat approval: one charge ≤ `max_price`; privacy on, auto-renew off at Porkbun; rows correct; `/report` spend +charge, count +1, `drop_date` set; NS = lander within 5 min |
| B-28 | v2 fixture: hybrid `proposed_listing` {bin 1995} + 2 comps + `expected_settings_version: 2` | Stored 1995 / 1295 / 960 (min 100); `pricing_evidence`; `first_listed_at`; 4 schedule rows as PR-12; `plan_audit_id` = this audit id |
| B-29 | **v3 (CR-001):** hybrid 1488, valid screening pack, no comps, version 3 | 1488 / 967 / 715 (min 100); schedule PR3-3; FT-1 check due `ft_eligible_on` + 7 days |
| B-30 | **Spec-only (no test with this ID; shipped as 409 `SCREENING_PACK_REQUIRED` with `details.reason`, see `gaps.md` G-3; covered by `tests/modules/selection/screening-packs.test.ts`, `tests/modules/buying/buy-v2.test.ts`).** **CR-001:** no pack / pack for another domain / DEMAND-1 failed / pack BIN 1488 vs listing 1088 | 400 `SCREENING_PACK_REQUIRED` / 422 `SCREENING_PACK_INVALID` ×3; 0 registrar calls (SEL7-1) |
| B-31 | **Spec-only (no test with this ID; the codes are tested in the listing and buy tests).** **v3:** hybrid 1495 / 1988 without LANDER-1 | 422 `BIN_NOT_IN_PRICE_LIST` / `LANDER_EXCEPTION_REQUIRED`, 0 registrar calls (SEL9-3) |
| B-32 | **FT-1 (CR-001 P2):** buy 2026-10-04 (eligible 2026-12-03); job on 10-12, 12-10, 12-11 without confirm; then a confirm with another BIN | No flag on 10-12 or 12-10; on 12-11 `DISTRIBUTION_INCOMPLETE` + flag (SEL9-6); mismatch → 422 `DISTRIBUTION_BIN_MISMATCH` |

## S8 import lane (v5.8.0, CR-059; Dvir 14-15 Oct 2026)
`POST /portfolio/import` (route `ops/api/portfolio-import.ts`, logic `importDomain` with `lane: 'S8'`) books an existing .com Dvir bought on a registrar website. Rules, all enforced in code: approval_ref validated as at `/buy` (rule 1); `source` closeout|fixed|auction; NameJet, SnapNames, DropCatch refused as source or registrar; price_paid <= `settings.s8_max_price_cents` ($50) and S8 names < `settings.s8_reserved_slots` (10) and total < `max_domains` (rule 2, migration only; no money total, G-86); BIN (v5.9.0, CR-060) = `bin_override` (named in `approval_ref.text`, exact dollar amount, else 422 `APPROVAL_INVALID`) or `s8LadderBin` from `settings.s8_bin_ladder` by name length (<= 8 $4,888, 9-12 $3,488, 13+ $2,488); S8 BINs are exempt from the price list and the LANDER-1 exception check everywhere (rule 4 exception by Dvir, CR-060; `gaps.md` G-105); floor = `floor_override` (named, <= BIN) or the formula (65%, whole dollar); `comps_value` is evidence only; expiry window buy_date + 2y + 30d; no M6/M18 drops (final push and delist stay); a geo name takes the grade price and refuses overrides. (v5.8.0 used the price-list rung from comps; replaced.) Books `domains.lane = 'S8'`, one `registration` ledger row, `pricing_evidence`, the plan and its schedule, the deal row when `deal_id` is given. Tests (`tests/modules/buying/s8-import.test.ts`):

| ID | Case |
|---|---|
| S8-1 | missing, wrong-domain, expired or future approval_ref refused; lane other than S8 refused; nothing written |
| S8-2 | source not closeout/fixed/auction refused; NameJet/SnapNames/DropCatch refused as source or registrar |
| S8-3 | $250.01 is `S8_PRICE_CAP`, $250.00 accepted (cap $250 since 5.36.0, was $50); the cap is not settable through the API |
| S8-4 | the import books lane S8, ledger row, evidence, hybrid plan; BIN from the S8 ladder (v5.9.0); comps optional; geo grade price; manual registrar needs expiry |
| S8-5 | 30 Line 1 names close `/buy` (`DOMAIN_CAP_REACHED`, dry run `would_be_blocked`), S8 import still allowed; 10 S8 names give `S8_SLOTS_FULL` (dry run `would_be_blocked`) |
| S8-6 | total cap 40 holds for an S8 import |
| S8-7 | `/report` `lines` and `per_domain[].line` |
| S8-8 | idempotent replay, dry run writes nothing, owned name and READ token refused |
| S8-9 | a registrar adapter that reports no expiry: 422 `EXPIRY_UNKNOWN` |
| S8-10 | pricing settings without a price list: 409 `PRICING_SETTINGS_NO_PRICE_LIST` |
| S8-11 | (v5.9.0, CR-060) dry run with `bin_override` 348800 and `floor_override` 226700 named in the approval: echoed, `would_be_blocked` null; real import stores them |
| S8-12 | no `approval_ref`: 422 `APPROVAL_INVALID` |
| S8-13 | override price not named (or only inside a larger number): 422 `APPROVAL_INVALID` with `details.override`; amount forms `$3488`, `$3,488.00`; floor above BIN refused |
| S8-14 | no override: ladder by length (8, 9, 10, 12, 13 characters), floor 65% whole dollar, ladder in the settings row |
| S8-15 | expiry buy+2y+30d accepted, one day later `REGISTRATION_TERM_INVALID` |
| S8-16, S8-16b | no M6/M18 rows; final push + delist stay; `POST /jobs/preview` does not fail an off-list S8 BIN |
| S8-17 | CR-059 guards stand (`S8_PRICE_CAP`, `BACKORDER_SOURCE_REFUSED`) |
| S8-18 | geo S8 keeps the grade price, refuses overrides |
| S8-19 | `POST /list` replan keeps an off-list S8 BIN; a Line 1 name still gets `BIN_NOT_IN_PRICE_LIST` |
