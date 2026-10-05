# Read endpoints: /report, /portfolio, /ledger, /deals, /audit  (READ)

**Goal:** Gavriel (and Gizbar, the CFO bot) can answer any question Dvir asks from the database alone. Every figure **traces back to ledger rows**; nothing is estimated.

Every money field appears twice: in cents (`*_cents`) and as a display string ("$11.08"). Times are stored in UTC and returned with the `Asia/Jerusalem` offset.

## GET /report  (`?format=json|md`, default json)
`md` is ready for Gavriel to paste into chat.

| Section | Content |
|---|---|
| `budget` | `poc_cap` $1,500; `spent` (−Σ registration + renewal + fee); `remaining`; `committed_forward` (renewal price for domains with `renewals_used=0` that are not yet sold or dropped: **at most one renewal each**); `domains` count vs `max_domains` 50 |
| `sales` | count; gross; commission; fees; net |
| `profit` | `net_sales − total_costs` (all costs, sold or not) |
| `roi` | `profit / total_costs`, or `null` if costs are 0 |
| `per_domain` | domain, status, registrar, `registrar_api`, **category, grade, listing mode, BIN, floor, walk-away (private), min offer, pricing source + settings version, **offers (`count_30d`, `highest_30d`, `count_90d`, `highest_90d`, `count_all`, `highest_all`, `highest_all_pct_of_bin`, `last_offer_at`, `open_for_dvir`)**, next price event (date + values), hold, export pending since**, cost, renewal price, `renewals_used`, expiry, `drop_date`, lander, NS verified, days held |
| `upcoming_90d` | For each domain, the events within 90 days: **first renewal decision** (expiry, where `renewals_used=0`; alert stages 60/30/7); **final expiry** (where `renewals_used=1`: "won't be renewed again; the final push price is already scheduled at `drop_date − 90`; consider an outreach push (Gate C)"; stages 60/30); **Fast Transfer opt-in date** (`buy_date+60`, where `buy_date` is the registry creation date); `drop_date`; **price events** from `price_schedule` (`drop1_m6`, `drop2_m18`, `final_push`, `delist`) with exact values. Events due within `headsup_days_before` (7) are flagged `headsup: true`; Gavriel relays them to Dvir as information (no approval needed) |
| `offers_by_strategy` | One row per category/strategy: `names_listed`, `names_with_offers`, `offers_90d`, `offers_per_listed_name_per_month`, `median_offer_pct_of_bin`, `max_offer_pct_of_bin`, share per band (`listing-strategy.md` §10.11). The demand signal for the quarterly review |
| `payouts_pending` | Sold domains whose `payouts` row has `received_on` null: domain, venue, amount, fee, method, `sold_at`, `days_pending` (IDT days since `sold_at`). Payouts add **no** ledger money, so `sales`, `profit` and `roi` are unchanged (R-1, R-2) |
| `applied_7d` | Price events the job applied in the last 7 days, with old → new values and whether the export is still pending upload |
| `warnings` | `PAYOUT_OVERDUE` (a pending payout older than 30 days); NS not on the configured lander (public-DNS check); listed without a category; `RENEWAL_PRICE_UNKNOWN` (imports); a hybrid/offer listing with a floor below the BIN (`FLOOR_AUTO_ACCEPT` reminder); BIN missing; Afternic export older than 7 days while listings changed; purchases in `unknown` state; domains past `drop_date` still `owned` (→ mark as `dropped`); missing receipts; registrar balance below `$15` (if known); **`EXPORT_PENDING`** (marketplace price stale since a change; error level after 7 days); **`PRICE_EVENT_FAILED`**; a `pricing_hold` older than 30 days; `PRICING_EXCEPTION` (plan differs from the formula; informational); `OFFER_NEEDS_DVIR` (a mid-range or email offer open > 48 h) |

## Other GETs

| Endpoint | Returns |
|---|---|
| `GET /portfolio?status=` | Domains list (same fields as `per_domain`) |
| `GET /portfolio/{domain}` | One domain, plus its ledger rows, purchases, quotes from the last check, lander status, **`listing_history`** and, once sold, its **`payout`** (`{amount, fee, method, received_on, status: received\|pending}` or null) |
| `GET /ledger?type=&domain=&from=&to=&format=json\|csv` | Ledger rows; CSV columns `date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note` (same as `cfo-ledger.md`) |
| `GET /deals/{id}` | Deal row: domain, stage, decision, approvals (audit rows whose `approval_ref` cites it) |
| `GET /audit?since=&limit=` | Audit rows (approval text included; request bodies redacted of nothing secret, since bodies never contain secrets) |
| `GET /health` | Shape in `00-architecture.md` §7; **no auth**, no business data |
| `GET /report/pricing-review?from=&to=` | For Gizbar's quarterly review (`listing-strategy.md` §10.9). Per sale: gross, BIN at the time of sale, `ratio = gross / BIN`, venue, schedule stage (M0/M6/M18/final), days listed, `at_floor`. Also: offers logged (when available), counts of skipped/held events, the settings versions in use, and `insufficient_data: true` with fewer than 3 sales |
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
- The `--category` and listing flags follow `listing-strategy.md`. The listing is validated with the same rules (V1–V12, with `legacy_no_comps` for pre-5-Oct names) and the same calculator (§10). It is written to `listing_history` with `source=import`.
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
- It writes the same rows as a `/buy` success.
- It writes the same rows as a `/buy` success (ledger `registration` row, domain row with `renewals_used=0`, `drop_date = expiry + 1y`, `category`, the listing fields, and an audit row with scope `admin`). The POC cap and 10-domain cap count it.
- It refuses if the domain isn't in the registrar account, or is already in `domains`.
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
| IM-11 | GoDaddy adapter never registers | Static test: the GoDaddy adapter has no `register` implementation, and `/check` excludes GoDaddy with `NO_AVAILABILITY_ACCESS` | Can register |

## Status lifecycle
`pending_purchase → owned → listed → sold` (also `owned → sold` and `delisted → sold`), or `listed → delisted → dropped` (the scheduled delist at `drop_date − 7`), or `→ dropped`.
- A domain becomes `dropped` when a daily job finds `today > drop_date`, or when an `owned`/`listed` domain expires without renewal.
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
| R-9 | `?format=md` | Valid markdown table; amounts as `$` strings | Broken |
| R-10 | Timezone | `sold_at` stored in UTC, returned as `+03:00` (IDT) or `+02:00` (IST), whichever applies | Wrong offset |
| R-11 | `/health` | No auth, no data fields | Leaks data |
| R-12 | `/ledger?format=csv` | Header equals the `cfo-ledger.md` header | Differs |
