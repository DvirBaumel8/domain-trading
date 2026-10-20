# Books in DOM: ledger costs, forward-cost plans, books.csv (CR-070, v5.25.0)

DOM is the one place for the portfolio, the ledger and the planned costs; Sales (the bot that owns the ledger) writes non-money cost rows and the forward plan here, and reads the private books file to diff against. Migration `1765700000000_v5-25-0.sql`. Contract: `endpoints.md` §Costs, `formats.md` §Books CSV.

## Files
- `src/modules/reporting/books.ts`: `postCosts`, `parseForwardBody`, `putForwardCosts`, `forwardCostHistory`, `forwardCosts`, `booksRows`, `DERIVED_FIELDS`. Routes in `reporting/api/books.ts` (`registerBooks`, called from `src/app.ts`).
- The committed-renewal rule is shared with `/report`: `unrenewedLiveNames` and `dropsAtFirstExpiry` in `reporting/report/money.ts` (`spend.committed_forward` uses the same two).

## Rules
1. `POST /ledger/costs` writes only `tool`, `ai`, `adjustment` rows (the baseline CHECK on `ledger_entries.type` already allows them; no schema change). Amounts are signed cents (cost negative). One bad row rejects the call (422 `VALIDATION_ERROR`, nothing stored). `dry_run` answers 200 and stores nothing. A correction is a reversing row; the ledger stays append-only. Classified `allowed` in `BOTS_ROUTES`: it records costs, it never spends.
2. The forward plan is stored as versions: `forward_cost_plans` (one header per PUT: domain, version, line_count, token name, audit id) and `forward_cost_lines` (the lines of that version). Both are append-only (triggers). The newest version of a domain is its plan; earlier versions are history (`GET /portfolio/{domain}/forward-costs`). `[]` is a version with no lines (clears the plan). The PUT locks the domain row, so two concurrent PUTs get consecutive versions. Both tables are in the backup (`TABLE_FILES`, `ORDER`).
3. **Derived numbers are computed, never typed.** `DERIVED_FIELDS` (floor, walk-away, min offer, bin, renewal due, renewal cost, forward total, dates, totals, with or without `_cents` / `_usd`) is checked first, at the top level and in every line, so the answer is `DERIVED_FIELD` and not a generic unknown-key 422. The plan has no budget comparison (G-86).
4. `GET /costs/forward`: planned lines (current version per domain, by month) plus renewals computed from `domains.renewal_price_cents` for live names with `renewals_used` 0, in the month of `expiry_date`. A name with `drop_date = expiry_date` renews at 0 (`counted: false`). Unknown price: `renewal` null, warning `RENEWAL_PRICE_UNKNOWN`, `incomplete: true` on the month and the totals; never summed as 0.
5. `GET /books.csv` is a view of `GET /portfolio` (`portfolioRows`) filtered to owned, listed and delisted, plus `display_name`, `buy_date`, `renewal_price_source` from `domains` and `listed_venues` / `observed_venues` (v5.27.0, CR-076, from `portfolioRows`): `listed_venues` = the latest `ours_confirmed` `venue_listings` row per venue (not delisted); `observed_venues` = venues whose latest row (any provenance) is `observed_public`; `unknown` rows count in neither. Text cells go through `csvSafeText`. The walk-away is in this file and in `/portfolio` only; the `/export/*` files never carry it (BK525-12). CR-070 R-4 was declined: the walk-away stays 48% of BIN to the nearest $5 (BK525-4).

## Tests (`tests/modules/reporting/books.test.ts`)
| ID | What |
|---|---|
| BK525-1 | AT-1 dry_run 200 stores nothing; real 201 and `GET /ledger?type=ai` shows the row; audited |
| BK525-2 | AT-2 registration, renewal, sale, commission, refund, fee, payout_fee and bad rows are 422, nothing stored |
| BK525-3 | AT-3 derived field is 422 `DERIVED_FIELD` (top level and in a line); unknown domain 404; other unknown key is `VALIDATION_ERROR` |
| BK525-4 | AT-4 BIN 148800 gives walk-away 71500 and floor 96700, BIN 90000 gives 50000; portfolio and books.csv agree |
| BK525-5 | AT-5 a name dropping at first expiry counts 0; planned lines with their basis |
| BK525-6 | AT-6 unknown renewal price: null, `RENEWAL_PRICE_UNKNOWN`, `incomplete: true`; default range; bad range 400 |
| BK525-7 | AT-7 books.csv header, one row per live name, values equal `GET /portfolio` |
| BK525-8 | READ token 403 on both writes; bots and WRITE can; books.csv needs a token |
| BK525-9 | a reversing row corrects; the ledger refuses UPDATE and DELETE |
| BK525-10 | PUT replaces the set, keeps the old version in history, `[]` clears; tables append-only |
| BK525-11 | books.csv formula guard |
| BK525-12 | `/export/afternic.csv` and `/export/sedo.csv` carry no walk-away |
| BK525-13 | line validation (month, USD string, text bounds) stores nothing |

## Listing provenance (CR-076, v5.27.0)
Migration `1765900000000_v5-27-0.sql` adds `provenance` (`ours_confirmed` | `observed_public` | `unknown`, NOT NULL, default `unknown`) and `seen_price_cents`, `seen_url`, `seen_at` (required for `observed_public`, CHECK) to `venue_listings`. **Append-only is kept:** `ADD COLUMN ... DEFAULT` marks old rows `unknown` without an UPDATE (no trigger disabled); the R-4 seed is new appended rows (latest row per domain and venue decides), each guarded by `WHERE EXISTS` on the domain, "latest row is not already the same" and (ours) "latest row is not a removal". No Sedo row is appended for the two names (an appended row would look like a live hand listing); their old Sedo rows read `unknown`.
- Routes (`listing/api/venue.ts`): `POST /listings/{domain}/venue` takes `provenance` (`ours_confirmed` default, or `unknown`; bots stay refused, money route); `POST /listings/{domain}/observed` (bots, `allowed`) stores `observed_public` only and touches nothing else; `POST /portfolio/{domain}/display-name` (bots, `allowed`) sets `domains.display_name` (same letters only) and flags a `listed` name with `changedColumns` because the name is in the export rows.
- Readers that ignore a sighting: `exportBlock` (`report/portfolio.ts`), the `/sold` checklist (`selling/sold.ts`), `DELIST_NEEDED` (`report/lifecycle.ts`).
- Tests `tests/modules/listing/provenance.test.ts`: PV527-1 (AT-1 seed and books/portfolio), PV527-2 (AT-2 sighting changes nothing), PV527-3 (AT-3 `provenance` key is 422), PV527-4 (AT-4 bots 403 `SCOPE_FORBIDDEN`, WRITE default and `unknown`), PV527-5 (AT-5 display name), PV527-6 (seed no-op on missing domains, idempotent re-run), PV527-7 (old rows `unknown`, append-only, delisting beats the seed), PV527-8 (export block ignores a sighting). `ID527-1` in `tests/modules/http/idempotency.test.ts` (PUT without the key names the PUT). B520-8 (route guard) covers the two new routes.
