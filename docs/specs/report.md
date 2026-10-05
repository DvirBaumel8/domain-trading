# Read endpoints: /report, /portfolio, /ledger, /deals, /audit  (READ)

**Goal:** Gavriel (and Gizbar, the CFO bot) can answer any question Dvir asks from the database alone. Every figure **traces back to ledger rows**; nothing is estimated.

Every money field is a **flat pair**: `<key>_cents` (integer) plus `<key>` (display string), e.g. `spent_cents: 2107, spent: "$21.07"` (spec sync 4d-2, Dvir, 5 Oct 2026, 22:02). Times are stored in UTC and returned with the `Asia/Jerusalem` offset.

## GET /report  (`?format=json|md`, default json)
`md` is a **compact chat digest** for Gavriel to paste; it **never contains the walk-away**. Any other `format` value → 400 `VALIDATION_ERROR`.

| Section | Content |
|---|---|
| `budget` | `poc_cap`; **`spent`** = the `/buy` cap figure (−Σ all `registration`, `renewal` and `fee` rows); `remaining`; **`committed_forward`** `{total, complete, missing}` (renewal price for domains with `renewals_used=0` not yet sold or dropped, **at most one renewal each**; `complete` false and `missing` = the domains without a renewal price); `domains` count vs `max_domains` 50 |
| `sales` | count; gross; commission; **sale fees** (`fee`/`adjustment` rows written by `/sold`, plus `payout_fee`); net |
| `profit` | `net_sales − costs`. **Costs** = `registration`, `renewal`, `refund` (lowers costs), `tool`, `ai`, and `fee`/`adjustment` rows **not** from a sale (all domains, sold or not). Sale fees count on the sale side, not as costs |
| `roi` | `profit / costs` as a ratio with 2 decimals, plus **`roi_pct`** (whole %); both `null` if costs are 0 |
| `per_domain` | domain, status, registrar, `registrar_api`, **category, grade, listing mode, BIN, floor, walk-away (private), min offer, pricing source + settings version, **offers (`count_30d`, `highest_30d`, `count_90d`, `highest_90d`, `count_all`, `highest_all`, `highest_all_pct_of_bin`, `last_offer_at`, `open_for_dvir`)**, next price event (date + values), hold, export pending since**, cost, renewal price, `renewals_used`, expiry, `drop_date`, lander, NS verified, `days_held` (stops at the sale or drop date) |
| `upcoming_90d` | For each domain, the events within 90 days: **first renewal decision** (expiry, where `renewals_used=0`; alert stages 60/30/7; since 6 Oct 2026 the decision is `GET /renewal/decision/{domain}` = RENEW/DROP, Ratio with ARA = the **live** `/check/quote` renewal at the current registrar (never a fixed $11.08) plus the transfer-to-cheapest-FT-capable option, `selection.md` §1.4/C17; renew by expiry − 31 to keep Fast Transfer); **final expiry** (where `renewals_used=1`, **or a Gate F name** with `drop_date = expiry_date`: "won't be renewed again; the final push price is already scheduled at `drop_date − 90`; consider an outreach push (Gate C)"; stages 60/30); **FT-1 confirmation due** (`buy_date+7`, selection v9.1) and **Fast Transfer eligibility date** (`buy_date+60`, where `buy_date` is the registry creation date); `drop_date`; **price events** from `price_schedule` (`drop1_m6`, `drop2_m18`, `final_push`, `delist`) with exact values (**overdue** events are left out; they surface as warnings). Events due within `headsup_days_before` (7) are flagged `headsup: true`; Gavriel relays them to Dvir as information (no approval needed) |
| `offers_by_strategy` | One row per category/strategy: `names_listed`, `names_with_offers`, `offers_90d`, `offers_per_listed_name_per_month`, `median_offer_pct_of_bin`, `max_offer_pct_of_bin`, share per band (`listing-strategy.md` §10.11). The demand signal for the quarterly review |
| `payouts_pending` | Sold domains whose `payouts` row has `received_on` null: domain, venue, amount, fee, method, `sold_at`, `days_pending` (IDT days since `sold_at`). Payouts add **no** ledger money, so `sales`, `profit` and `roi` are unchanged (R-1, R-2) |
| `applied_7d` | Price events the job applied in the last 7 days, with old → new values and whether the export is still pending upload |
| `warnings` | Each `{code, level, domain?, message, details}`, sorted error → warn → info (spec sync 4d-2, Dvir, 5 Oct 2026, 22:02). **error:** `PURCHASE_UNKNOWN` (a purchase in `unknown` state); `PRICE_EVENT_FAILED`; `EXPIRED_NOT_RENEWED`; `DOMAIN_LEFT_ACCOUNT` (daily registrar check below). **warn:** `MANUAL_DELIST` (remove the listing at Afternic or Sedo; one per domain, with its venues); `POST_BUY_INCOMPLETE` (a buy without a plan, or, since 6 Oct 2026, without a stored screening pack; comps no longer count, selection v9.1); **`DISTRIBUTION_INCOMPLETE`** (6 Oct 2026, FT-1: no `POST /distribution/confirm` with Afternic Fast Transfer opt-in + Afternic listing at the same BIN within 7 days of the buy; `buy.md` 7.4); `NS_UNVERIFIED`; `EXPORT_STALE` (no confirmed Afternic upload in 7 days while listings changed); `HOLD_STALE` (a `pricing_hold` over 30 days); `PAYOUT_OVERDUE` (a pending payout over 30 days); `PAST_DROP_DATE` (a live name past `drop_date`); `RECEIPT_MISSING`; `RENEWAL_PRICE_UNKNOWN`; `BIN_MISSING`; `CATEGORY_MISSING` (listed without a category); `OFFER_NEEDS_DVIR` (a `dvir`-routed offer open or countered > 48 h **since it was recorded**; skips sold or dropped names). **`EXPORT_PENDING`**: listed names only; warn, **error after 7×24 h**. **info:** `SALE_UNCONFIRMED` (each `sales` row with `confirmed = false`: domain, venue, `transaction_ref`, evidence, `recorded_by`, `sold_at`); `PRICING_EXCEPTION`; `FLOOR_AUTO_ACCEPT`. The registrar-balance warning is **not in v1** (no balance is stored) |

## Other GETs

| Endpoint | Returns |
|---|---|
| `GET /portfolio?status=` | `{domains}` (same fields as `per_domain`). `status` ∈ `owned`, `listed`, `delisted`, `sold`, `dropped`; `pending_purchase` or anything else → 400 |
| `GET /portfolio/{domain}` | One domain, plus its ledger rows, purchases, quotes from the last check, lander status, **`listing_history`**, once sold its **`payout`** (`{amount, fee, method, received_on, status: received\|pending}` or null), and an **`export` block per venue** (`afternic`, `sedo`): `pending`, `last_confirmed_upload_at`, `last_uploaded {bin, floor, min_offer}` as uploaded (**never the walk-away**), for the weekly lander check |
| `GET /ledger?type=&domain=&from=&to=&format=json\|csv` | JSON: `{count, rows}` with `amount_usd` signed (negative = money out). CSV columns `date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note` (same as `cfo-ledger.md`) |
| `GET /deals/{id}` | Deal row: domain, stage, decision, approvals (audit rows whose `approval_ref` cites it). Unknown deal → 404 `DEAL_NOT_FOUND` |
| `GET /audit?since=&limit=` | `{rows}`; `limit` 1–500 (default 100), else 400. Audit rows (approval text included; request bodies redacted of nothing secret, since bodies never contain secrets) |
| `GET /health` | Shape in `00-architecture.md` §7; **no auth**, no business data |
| `GET /report/pricing-review?from=&to=` | For Gizbar's quarterly review (`listing-strategy.md` §10.9). Per sale: gross, BIN at the time of sale, `ratio = gross / BIN`, venue, schedule stage (the last **applied** `M6`, `M12`, `M18` or `final` event, else `M0`), days listed, `at_floor`. Default window: the **last 90 days** (IDT); `ratio` has 2 decimals; `held_domains_now` is a snapshot (holds now, not events in the window). Also: offers logged (when available), counts of skipped/held events, the settings versions in use, and `insufficient_data: true` with fewer than 3 sales |
| `GET /pricing/preview` | See `listing-strategy.md` §10.6 |
| `GET /offers?domain=&from=&to=&band=&source=` | Logged offers, newest first (`listing-strategy.md` §10.11) |
| `GET /report/offers?from=&to=&group_by=domain\|category\|source\|month` | Offer counts, highest offer, % of BIN and band shares for any window (OF-18, OF-19) |

## Import of domains bought by hand (admin command, not an API endpoint)
D-001 (promptinjectionaudit.com) was bought **by hand at GoDaddy** (not Porkbun), before the service existed.
- **Registered 2026-10-04** (RDAP creation 13:16Z = 16:16 IDT; the 3 Oct date in earlier notes was the first, failed order).
- **Cost $13.73** (paid 42 ILS at 0.3269 USD/ILS; Dvir's chat, 4 Oct 20:41 IDT). **No order number** was provided.
- Any manual buy enters the DB like this (D-001's values):
  - `npm run admin -- import-domain --domain promptinjectionaudit.com --registrar godaddy --buy-date 2026-10-04 --cost 13.73 --cost-note "42 ILS @0.3269" --order none --deal D-001 --category trend --listing-mode hybrid --bin 1995 --floor 1295 --walkaway 950 --pricing-exception "Dvir approved 2026-10-05 00:39 IDT" --legacy-no-comps "bought before the comps rule; card found no comps" --approval-text "Approve the prices, but wait for the software to list it" --approval-at 2026-10-05T00:39:00+03:00 --manual --expiry 2027-10-04`
  - `--renewal-price` is still unknown (`RENEWAL_PRICE_UNKNOWN`).
- The `--category` and listing flags follow `listing-strategy.md`. The listing is validated with the same rules (V1–V12; comps optional since 6 Oct 2026, so `legacy_no_comps` is no longer needed) and the same calculator (§10). It is written to `listing_history` with `source=import`.
- **The schedule anchor (`first_listed_at`) is set when the import includes a listing.** For D-001 that is the import date, because the name isn't listed anywhere yet.
- **Registrar data, two ways:**
  - **With a registrar API** (Porkbun keys, or a `GODADDY_PAT` with scopes `domains.domain:read` + `domains.nameserver:update`): it reads `expiry_date`, privacy, auto-renew and NS via `find_domain`, and sets `registrar_api = full` (Porkbun) or `manage` (GoDaddy: management only, no buying).
  - **`--manual`** (no key, or GoDaddy answers 403 `ACCOUNT_NOT_ELIGIBLE`): Dvir supplies `--expiry YYYY-MM-DD` and `--renewal-price <GoDaddy renewal price with auto-renew off>` from his dashboard. This sets `registrar_api = none`; NS changes are then manual (`list.md` step 4), and NS is verified by public DNS.
  - `renewal_price` may be left unknown for imports only. `/report` then shows `RENEWAL_PRICE_UNKNOWN`, and `committed_forward` is marked incomplete.
- **GoDaddy API access limits** (verified 3 Oct 2026):
  - Per GoDaddy Help (https://www.godaddy.com/help/how-do-i-access-domain-related-apis-42424): an account with **≥1 active domain** gets the Domains API, up to 20,000 calls/month. **Availability checks** need **≥50 domains** or an average spend of **≥$20/month**; a Discount Domain Club plan raises the limits.
  - Per the developer docs (https://developer.godaddy.com/en/docs/api-users/auth): management (list, DNS, privacy, renewals) needs ≥1 domain or a qualifying plan. Anything that costs money needs a billing method or a Good as Gold balance. An ineligible account gets **403 with a `code`** such as `ACCOUNT_NOT_ELIGIBLE`. v3 needs a **PAT**; the legacy `sso-key` doesn't work on v3.
  - So D-001 itself should make Dvir's account eligible for **NS management**: `PUT /v3/domains/domain-names/{domain}/nameservers` returns 202 plus an operation (https://developer.godaddy.com/en/docs/api-users/domains/manage/dns). GoDaddy **can't be a `/check` quote source** for this account (<50 domains), so in v1 GoDaddy is a **management-only** adapter.
  - The exact v3 paths for domain details and auto-renew weren't checked here: **UNVERIFIED**.
  - **Fallback:** Dvir changes the NS by hand in the GoDaddy dashboard, and the service verifies it via DNS.
- **GoDaddy cautions for D-001:**
  - GoDaddy bills renewals to the **card on file**, which the server's $1,500 cap can't block. Dvir must check that **auto-renew is OFF** for D-001 (the default isn't verified).
  - GoDaddy's discounted renewal applies only with auto-renew ON (`../research/registrars.md`). The one allowed renewal will cost GoDaddy's rate; Dvir enters it as `--renewal-price`.
  - WHOIS privacy status: Dvir checks it in the dashboard (UNVERIFIED whether privacy is free at GoDaddy).
  - Fast Transfer: GoDaddy is a Premium partner. Eligible listings are opted in automatically at the end of the 60-day lock (GoDaddy Help 27761).
- It writes the same rows as a `/buy` success (ledger `registration` row, domain row with `renewals_used=0`, `drop_date = expiry + 1y`, `category`, the listing fields, and an audit row with scope `admin`). The POC cap and 50-domain cap count it.
- It refuses if the domain isn't in the registrar account, or is already in `domains`.
- **Flags and codes** (spec sync, Dvir, 5 Oct 2026, 21:02; step 4d-1 code):
  - `--registrar` must be `porkbun`, `godaddy` or `other` (`other` needs `--manual`). `--order` defaults to `none` and must not contain `@` (422 `NO_PII`).
  - `--approval-text` / `--approval-at` (together) are needed **only** when the import carries a pricing exception or an override; if given, they are always validated.
  - `--comps-file` takes `{comps, rationale}` or a bare array of comps. `--legacy-no-comps "<reason>"` is allowed only for buy dates before 2026-10-05 (else 422 `COMPS_REQUIRED`); not together with `--comps-file`. *(Changed 6 Oct 2026, selection v9.1: comps are optional, so `COMPS_REQUIRED` is retired; both flags stay optional. Imports need no screening pack (hand buys outside `/buy`); whether a future hand-bought name must carry one is open for Dvir.)*
  - **Refusals:** `REGISTRATION_TERM_INVALID` (expiry later than buy date + 1 year + 7 days; founder rule 3); `DROP_DATE_PASSED` (the import carries a listing but `drop_date` is not in the future); `ADAPTER_NOT_ENABLED`; `ACCOUNT_NOT_ELIGIBLE`; `REGISTRAR_ERROR`; `EXPIRY_UNKNOWN`; `NOT_IN_ACCOUNT` (for GoDaddy the message suggests `--manual`); `ALREADY_IN_PORTFOLIO`. All suggest `--manual --expiry` where it applies.
  - **Warnings (never block):** `AUTO_RENEW_ON` (the registrar reports auto-renew on); `PRIVACY_OFF`; `AUTO_RENEW_UNCONFIRMED` (always for `--manual` and GoDaddy, and when the registrar doesn't report it: check auto-renew is OFF in the dashboard, since renewals there are billed outside the $1,500 cap); `EXPIRY_MISMATCH` (`--expiry` differs from the registrar's; the registrar's is used); `EXPIRY_IN_PAST`; `LEGACY_NO_COMPS`; and the cap warnings `POC_CAP_EXCEEDED_BY_IMPORT` / `DOMAIN_CAP_EXCEEDED_BY_IMPORT` (**an import is never refused for the caps**; `/buy` is refused until under them).
- Alternative bulk seed: `--from-csv ledger/portfolio.csv` (the pre-service portfolio file).

| ID | Case | Pass | Fail |
|---|---|---|---|
| IM-1 | Import with a mock registrar | Rows identical in shape to a `/buy` success; `/report` spend includes it | Missing rows |
| IM-2 | Import twice | Second refused, no new rows | Duplicate |
| IM-3 | Domain not in the account | Refused | Imported |
| IM-4 | Live (G3): import D-001 | `/portfolio/promptinjectionaudit.com` shows registrar `godaddy`, cost $13.73, expiry 2027-10-04, `drop_date` 2028-10-04, category `trend`, mode `hybrid` **1995 / floor 1295 / walk-away 950 (private) / min offer 100**, `pricing_source=approved_exception`, the 4 schedule rows (PR-11 values, anchored on the import date); ledger total = $13.73 | Any mismatch |
| IM-5 | `--registrar godaddy` with a mock PAT: `find_domain` OK | `registrar_api=manage`; expiry and NS read from the mock | Wrong value |
| IM-6 | GoDaddy mock returns 403 `ACCOUNT_NOT_ELIGIBLE` | Import refused with the hint "use --manual with --expiry"; no rows | Rows written, or a crash |
| IM-7 | `--manual` without `--expiry` | Refused | Imported |
| IM-8 | `--manual` with expiry, no renewal price | Imported; `registrar_api=none`; `/report` warns `RENEWAL_PRICE_UNKNOWN`; `drop_date` = expiry + 1 y | Missing warning |
| IM-9 | Import without `--category` / with a listing that breaks a guard | Refused (`CATEGORY_REQUIRED` / guard code) | Imported |
| IM-10 | Import counts toward the caps | After the import, `/report` spend and domain count include D-001; a `/buy` over the remaining cap is refused | Not counted |
| IM-12 | Registrar mock reports auto-renew on and privacy off; a GoDaddy import; a `--manual` import | `AUTO_RENEW_ON` + `PRIVACY_OFF` / `AUTO_RENEW_UNCONFIRMED` / `AUTO_RENEW_UNCONFIRMED`; all imported | Missing warning, or refused |
| IM-13 | `--expiry` ≠ the registrar's; an expiry in the past (no listing) | `EXPIRY_MISMATCH` (registrar's date stored) / `EXPIRY_IN_PAST`; imported | Missing warning |
| IM-14 | Expiry > buy date + 1 y + 7 d; a listing with `drop_date` ≤ today | 422 `REGISTRATION_TERM_INVALID` / 422 `DROP_DATE_PASSED`; no rows | Imported |
| IM-15 | `--registrar namecheap`; `--order a@b`; `--legacy-no-comps` with buy date 2026-10-05; an exception without `--approval-text`; a plain formula listing without it | exit 2 / 422 `NO_PII` / *(since 6 Oct: imported, comps optional; was 422 `COMPS_REQUIRED`)* / refused / imported | Other |
| IM-16 | Adapter disabled; registrar error; no expiry reported; not in the account (GoDaddy) | `ADAPTER_NOT_ENABLED` / `REGISTRAR_ERROR` / `EXPIRY_UNKNOWN` / `NOT_IN_ACCOUNT` with a `--manual` hint; no rows | Rows written |
| IM-17 | Import that takes spend over $1,500 or the count over 50 | Imported with `POC_CAP_EXCEEDED_BY_IMPORT` / `DOMAIN_CAP_EXCEEDED_BY_IMPORT`; a later `/buy` refused | Import refused, or no warning |
| IM-11 | GoDaddy adapter never registers | Static test: the GoDaddy adapter has no `register` implementation, and `/check` excludes GoDaddy with `NO_AVAILABILITY_ACCESS` | Can register |

## Daily registrar check (`DOMAIN_LEFT_ACCOUNT`; Dvir, 5 Oct 2026, 19:47)
- Runs daily **after the price and drop jobs** (the `daily` job, 00:05 UTC in production), and by hand with `npm run job -- registrar-check [--dry-run]`. Each result is upserted into **`registrar_presence`** (`present`/`absent`, `first_absent_at` kept while absent, cleared when present again; `00-architecture.md` §4) (spec sync 4d-2, Dvir, 5 Oct 2026, 22:02).
- Scope: for every domain with status `owned`, `listed` or `delisted` and `registrar_api` `full` or `manage`: `adapter.find_domain(domain)`.
- A definite `None` (not in our account; e.g. transferred out) and **no** `sales` row → `/report` warning `DOMAIN_LEFT_ACCOUNT` (domain, registrar, `first_absent_at`). The status is **not** changed and no sale is invented; Gavriel tells Dvir.
- Registrar errors or timeouts → no warning (retry next day); `registrar_api = none` names are skipped (no API to ask).
- Read-only: no registrar writes. Audit row scope `job`.

## Status lifecycle
`pending_purchase → owned → listed → sold` (also `owned → sold` and `delisted → sold`), or `listed → delisted → dropped` (the scheduled delist at `drop_date − 7`), or `→ dropped`.
- A domain becomes `dropped` only when the daily drop job (`npm run job -- drop`) finds `today > drop_date` (status `owned`, `listed` or `delisted`; planned schedule rows → `cancelled`).
- An `owned`/`listed` name that has **expired without renewal is not auto-dropped**, because the registrar's grace period applies. `/report` warns `EXPIRED_NOT_RENEWED` (error) instead.
- `renewals_used` is never above 1 (DB CHECK).

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| R-1 | Fixture ledger (2 buys of $11.08 + $9.99, 1 sale of $1,995 with $299.25 commission) | spent $21.07; remaining $1,478.93; net sales $1,695.75; profit $1,674.68; ROI 7948% (rounded to a whole %) | Any figure off by ≥ $0.01 |
| R-2 | Traceability | Every money figure in `/report` equals a SQL sum over `ledger_entries` (test recomputes it independently) | Mismatch |
| R-3 | `committed_forward` | Counts the renewal only for `renewals_used=0`; a domain with `renewals_used=1` adds $0 | Counts 2 renewals, or counts a used one |
| R-4 | Upcoming, first renewal | A domain expiring in 45 days with `renewals_used=0` → "first renewal decision", stage 60 | Missing or wrong stage |
| R-5 | Upcoming, final expiry | Expiring in 25 days with `renewals_used=1` → "final expiry", stage 30, recommends a price drop or outreach; **no renew option** | Offers renewal |
| R-6 | Fast Transfer date | `buy_date + 60` shown | Missing |
| R-7 | Warnings | A fixture with NS ≠ lander → warning | Silent |
| R-8 | Scopes | READ 200; WRITE 200 (WRITE ⊇ READ); none 401; revoked 401 | Other |
| R-9 | `?format=md` | Valid markdown digest; amounts as `$` strings; the walk-away value appears nowhere; `?format=xml` → 400 | Broken, leaks the walk-away, or 200 |
| R-13 | Warning fixtures: purchase `unknown`; a `failed` event; expiry passed without renewal; a buy without a screening pack (was: without `pricing_evidence`); a buy 8 days old without `/distribution/confirm`; a purchase without receipt; a hold 31 days old; a listed name without BIN; a sold name still listed at Sedo; no Afternic upload for 8 days with changes; a live name past `drop_date` | `PURCHASE_UNKNOWN`, `PRICE_EVENT_FAILED`, `EXPIRED_NOT_RENEWED` (error); `POST_BUY_INCOMPLETE`, `DISTRIBUTION_INCOMPLETE`, `RECEIPT_MISSING`, `HOLD_STALE`, `BIN_MISSING`, `MANUAL_DELIST` (venues `[sedo]`), `EXPORT_STALE`, `PAST_DROP_DATE` (warn); sorted error → warn → info | Missing, or wrong level |
| R-14 | Money shape | Every money field is a `*_cents` + display pair; `roi` 2 decimals + `roi_pct`; a refund row lowers costs; a `/sold` fee row counts as a sale fee, not a cost; `committed_forward.complete` false with the domain in `missing` when a renewal price is unknown | Other |
| R-15 | Read shapes: `/portfolio?status=pending_purchase`; `/ledger` JSON; `/audit?limit=0` / `501`; `/deals/D-999`; `/portfolio/{domain}` after an upload | 400 / `{count, rows}`, signed `amount_usd` / 400 / 404 `DEAL_NOT_FOUND` / `export.afternic.last_uploaded` = uploaded BIN/floor/min offer, no walk-away | Other |
| R-10 | Timezone | `sold_at` stored in UTC, returned as `+03:00` (IDT) or `+02:00` (IST), whichever applies | Wrong offset |
| R-11 | `/health` | No auth, no data fields | Leaks data |
| R-12 | `/ledger?format=csv` | Header equals the `cfo-ledger.md` header | Differs |
