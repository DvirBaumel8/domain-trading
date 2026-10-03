# Read endpoints: /report, /portfolio, /ledger, /deals, /audit  (READ)

**Goal:** Gavriel (and Gizbar, the CFO bot) can answer any question Dvir asks from the database alone. Every figure **traces back to ledger rows**; nothing is estimated.

Every money field appears twice: in cents (`*_cents`) and as a display string ("$11.08"). Times are stored in UTC and returned with the `Asia/Jerusalem` offset.

## GET /report  (`?format=json|md`, default json)
`md` is ready for Gavriel to paste into chat.

| Section | Content |
|---|---|
| `budget` | `poc_cap` $500; `spent` (−Σ registration + renewal + fee); `remaining`; `committed_forward` (renewal price for domains with `renewals_used=0` that are not yet sold or dropped: **at most one renewal each**); `domains` count vs `max_domains` 10 |
| `sales` | count; gross; commission; fees; net |
| `profit` | `net_sales − total_costs` (all costs, sold or not) |
| `roi` | `profit / total_costs`, or `null` if costs are 0 |
| `per_domain` | domain, status, registrar, cost, renewal price, `renewals_used`, expiry, `drop_date`, BIN, lander, days held |
| `upcoming_90d` | For each domain, the events within 90 days: **first renewal decision** (expiry, where `renewals_used=0`; alert stages 60/30/7); **final expiry** (where `renewals_used=1`: "won't be renewed again; consider a last price drop or an outreach push"; stages 60/30); **Fast Transfer opt-in date** (`buy_date+60`); `drop_date` |
| `warnings` | NS not on the configured lander; BIN missing; Afternic export older than 7 days while listings changed; purchases in `unknown` state; domains past `drop_date` still `owned` (→ mark as `dropped`); missing receipts; registrar balance below `$15` (if known) |

## Other GETs

| Endpoint | Returns |
|---|---|
| `GET /portfolio?status=` | Domains list (same fields as `per_domain`) |
| `GET /portfolio/{domain}` | One domain, plus its ledger rows, purchases, quotes from the last check, and lander status |
| `GET /ledger?type=&domain=&from=&to=&format=json\|csv` | Ledger rows; CSV columns `date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note` (same as `cfo-ledger.md`) |
| `GET /deals/{id}` | Deal row: domain, stage, decision, approvals (audit rows whose `approval_ref` cites it) |
| `GET /audit?since=&limit=` | Audit rows (approval text included; request bodies redacted of nothing secret, since bodies never contain secrets) |
| `GET /health` | Shape in `00-architecture.md` §7; **no auth**, no business data |

## Import of domains bought by hand (admin command, not an API endpoint)
D-001 (promptinjectionaudit.com) was bought **by hand** at Porkbun on 3 Oct 2026, before the service existed. Any manual buy enters the DB like this:
- `python -m app.admin import-domain --domain promptinjectionaudit.com --registrar porkbun --buy-date 2026-10-03 --cost 11.08 --order <order no> --deal D-001 --approval-text "<Dvir's words>" --approval-at <ISO>`
- It reads `expiry_date`, privacy, auto-renew and NS from the registrar API (`find_domain`); `renewal_price` from a fresh quote.
- It writes the same rows as a `/buy` success (ledger `registration` row, domain row with `renewals_used=0` and `drop_date = expiry + 1y`, audit row with scope `admin`). The POC cap and 10-domain cap count it.
- It refuses if the domain isn't in the registrar account, or is already in `domains`.
- Alternative bulk seed: `--from-csv ledger/portfolio.csv` (the pre-service portfolio file).

| ID | Case | Pass | Fail |
|---|---|---|---|
| IM-1 | Import with a mock registrar | Rows identical in shape to a `/buy` success; `/report` spend includes it | Missing rows |
| IM-2 | Import twice | Second refused, no new rows | Duplicate |
| IM-3 | Domain not in the account | Refused | Imported |
| IM-4 | Live (G3): import D-001 | `/portfolio/promptinjectionaudit.com` shows the real cost, expiry, `drop_date`, NS; ledger total = the Porkbun invoice | Any mismatch |

## Status lifecycle
`pending_purchase → owned → listed → sold`, or `→ dropped`.
- A domain becomes `dropped` when a daily job finds `today > drop_date`, or when an `owned`/`listed` domain expires without renewal.
- `renewals_used` is never above 1 (DB CHECK).

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| R-1 | Fixture ledger (2 buys of $11.08 + $9.99, 1 sale of $1,995 with $299.25 commission) | spent $21.07; remaining $478.93; net sales $1,695.75; profit $1,674.68; ROI 7948% (rounded to a whole %) | Any figure off by ≥ $0.01 |
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
