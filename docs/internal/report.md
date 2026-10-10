# Reads: /report, /portfolio, /ledger, /deals, /audit, /health (READ); import-domain; lifecycle

Gavriel and Gizbar (the CFO bot) answer any question from the DB alone. **The `/report` fields and the full warnings list are in the contract (`docs/contract/reports.md`), which wins over this file;** this file keeps DOM's internal rules and test IDs. **Every figure traces back to ledger rows; nothing is estimated.** Fields, warnings and levels: `docs/contract/reports.md`; other reads: `docs/contract/endpoints.md`.

## Rules
- Money = flat pairs (`x_cents` + `x`); times returned with the Asia/Jerusalem offset (spec sync 4d-2, Dvir, 5 Oct 2026, 22:02).
- `spent` is the `/buy` cap figure. Sale fees (`/sold` fee and adjustment rows sharing a sale's audit id, plus `payout_fee`) count on the sale side, not as costs; a refund lowers costs. `roi` = profit / costs, 2 decimals, `roi_pct` whole %; both null when costs are 0. `committed_forward` counts **at most one renewal** per name with `renewals_used = 0` (not sold, dropped or pending); a missing renewal price marks it incomplete.
- `?format=md` is a chat digest that **never contains the walk-away**; any other format → 400.
- `/portfolio?status=` takes `owned`, `listed`, `delisted`, `sold`, `dropped`; `pending_purchase` or anything else → 400. `/portfolio/{domain}` adds ledger rows, purchases, the latest quotes, `listing_history`, the schedule, the sale, offers and an `export` block per venue (`pending`, `last_confirmed_upload_at`, `last_uploaded {bin, floor, min_offer}` as uploaded, **never the walk-away**) for the weekly lander check.
- `/ledger` JSON `{count, rows}` with signed amounts; CSV header `date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note` (same as the CFO's `cfo-ledger.md`). `/deals/{id}` lists approvals (audit rows with approval text citing the deal or its domain); unknown → 404 `DEAL_NOT_FOUND`. `/audit?since=&limit=` (1–500, default 100). `/health` needs any bot token and shows no business data.
- `/report/pricing-review`: default window the last 90 IDT days; stage = the last **applied** M6/M12/M18/final event, else M0; `ratio` 2 decimals; `held_domains_now` is a snapshot; `insufficient_data` under 3 sales (`listing-strategy.md` §10.9).
- No registrar-balance warning in v1 (no balance is stored).
- **Not built (CR-001 P2, `gaps.md`):** `upcoming_90d` FT-1 confirmation due (`ft_eligible_on + 7`; today `fast_transfer` = buy date + 60) and warning `DISTRIBUTION_INCOMPLETE`; the renewal decision `GET /renewal/decision/{domain}` (RENEW/DROP with the Ratio, ARA = the **live** `/check/quote` renewal at the current registrar, never a fixed $11.08, plus transfer to the cheapest FT-capable registrar; renew by expiry − 31 to keep Fast Transfer; `selection.md` §1.4, C17). `POST_BUY_INCOMPLETE` means "a `/buy` purchase with no screening pack on file" (since 3.9.0; imports are exempt).

## Import of hand-bought domains (`npm run admin -- import-domain`; admin only, not an API route)
D-001 (promptinjectionaudit.com) was bought by hand at GoDaddy: registered **2026-10-04** (RDAP 13:16Z), **$13.73** (42 ILS @ 0.3269), no order number.
```
npm run admin -- import-domain --domain promptinjectionaudit.com --registrar godaddy --buy-date 2026-10-04 --cost 13.73 --cost-note "42 ILS @0.3269" --order none --deal D-001 --category trend --listing-mode hybrid --bin 1488 --floor 967 --walkaway 950 --pricing-exception "Dvir approved 2026-10-06 00:32 IDT" --legacy-no-comps "bought before the comps rule; card found no comps" --approval-text "<Dvir's 00:32 words>" --approval-at 2026-10-06T00:32:00+03:00 --manual --expiry 2027-10-04 [--renewal-price <GoDaddy rate, auto-renew off>] [--dry-run]
```
then `drop-at-first-expiry` (`drop_date` 2027-10-04; `listing-strategy.md` §8). The 5 Oct form (1995 / 1295 / 950, approval text "Approve the prices, but wait for the software to list it" at 2026-10-05T00:39:00+03:00) followed by a `POST /list` replan is the alternative. Dvir's exact 00:32 words must be copied from his chat.
- The listing is validated with the same rules (V1–V12) and calculator, written to `listing_history` with `source=import`; `first_listed_at` = the import date when a listing is included. Same rows as a `/buy` success (registration ledger row, `renewals_used = 0`, `drop_date = expiry + 1 year`, category, listing, admin audit row). The caps count it.
- **Registrar data:** with an API (Porkbun keys, or `GODADDY_PAT` with `domains.domain:read` + `domains.nameserver:update`) `findDomain` reads expiry, privacy, auto-renew and NS; `registrar_api` = `full` (Porkbun) or `manage` (GoDaddy). `--manual` (no key, or GoDaddy 403 `ACCOUNT_NOT_ELIGIBLE`): `--expiry` (and optionally `--renewal-price`) from the dashboard, `registrar_api = none`, NS changed by hand and verified by DNS. A missing renewal price is allowed for imports only (`RENEWAL_PRICE_UNKNOWN`, `committed_forward` incomplete).
- **Flags:** `--registrar` ∈ `porkbun`, `godaddy`, `other` (`other` needs `--manual`); `--order` default `none`, no `@` (422 `NO_PII`); `--approval-text`/`--approval-at` together, needed only for an exception or override and always validated; `--comps-file` (`{comps, rationale}` or a bare array; since 3.9.0 optional when `pricing_settings` `comps_min` is 0) or `--legacy-no-comps "<reason>"` (only for buy dates before 2026-10-05, else 422 `COMPS_REQUIRED`; not both). Whether a hand-bought name will need a screening pack is open for Dvir.
- **Refusals (no rows):** `REGISTRATION_TERM_INVALID` (expiry later than buy date + 1 year + 7 days), `DROP_DATE_PASSED` (a listing with `drop_date` not in the future), `ADAPTER_NOT_ENABLED`, `ACCOUNT_NOT_ELIGIBLE`, `REGISTRAR_ERROR`, `EXPIRY_UNKNOWN`, `NOT_IN_ACCOUNT` (GoDaddy: suggests `--manual`), `ALREADY_IN_PORTFOLIO`, `CATEGORY_REQUIRED` or a guard code.
- **Warnings (never block):** `AUTO_RENEW_ON`, `PRIVACY_OFF`, `AUTO_RENEW_UNCONFIRMED` (always for `--manual` and GoDaddy: check auto-renew is OFF, renewals there bill the card outside the cap; since 2.2.0 also a standing `/report` info warning for every live GoDaddy or `registrar_api: none` name, CR-006 F-2), `EXPIRY_MISMATCH` (the registrar's date is used), `EXPIRY_IN_PAST`, `LEGACY_NO_COMPS`, `API_ACCESS_DISABLED`, `RENEWAL_PRICE_UNKNOWN`, `POC_CAP_EXCEEDED_BY_IMPORT` / `DOMAIN_CAP_EXCEEDED_BY_IMPORT` (an import is never refused for the caps; `/buy` is refused until under them).
- **GoDaddy limits (verified 3 Oct 2026):** ≥ 1 active domain → the Domains API for management (20,000 calls/month); availability needs ≥ 50 domains or ≥ $20/month spend (https://www.godaddy.com/help/how-do-i-access-domain-related-apis-42424), so GoDaddy is never a `/check` source. v3 needs a PAT. Exact v3 paths for details and auto-renew: UNVERIFIED. Fast Transfer: GoDaddy names are opted in automatically at the end of the 60-day lock (Help 27761). GoDaddy's discounted renewal needs auto-renew ON, so the one renewal costs the standard rate.

## Daily registrar check (`DOMAIN_LEFT_ACCOUNT`; Dvir, 5 Oct 2026, 19:47)
Part of `daily` after the price and drop jobs; by hand `npm run job -- registrar-check [--dry-run]`. For every `owned`/`listed`/`delisted` name with `registrar_api` `full` or `manage`: `findDomain`. Each result upserts `registrar_presence` (`first_absent_at` kept while absent, cleared when present). A definite `null` and no `sales` row → `/report` `DOMAIN_LEFT_ACCOUNT`; the status is **not** changed and no sale is invented. Errors or timeouts → no warning (retry next day); `none` names are skipped. Read-only; audit scope `job`.

## Warnings added in 3.9.0
- `PURCHASE_UNRESOLVED` (warn): a `register_sent`/`unknown` purchase open longer than 30 min (`PURCHASE_UNRESOLVED_MINUTES`); the reconciler never fails one, the admin `resolve-purchase` command closes it.
- `DB_SIZE_HIGH` (warn): the database is over 70% (`DB_SIZE_WARN_PERCENT`) of Neon free's 0.5 GiB (`NEON_FREE_STORAGE_BYTES`); constants in `src/modules/reporting/report/warnings.ts`.
- `POST_BUY_INCOMPLETE` now means a `/buy` purchase with no screening pack on file (imports are exempt; it no longer checks comps).

## Status lifecycle
`pending_purchase → owned → listed → sold` (also `owned → sold`, `delisted → sold`), `listed → delisted → dropped` (delist at `drop_date − 7`), or `→ dropped`. A name becomes `dropped` only when the drop job finds `today > drop_date` (status `owned`/`listed`/`delisted`; planned rows → `cancelled`). An expired, unrenewed name is **not** auto-dropped (grace period): `EXPIRED_NOT_RENEWED` instead. `renewals_used` never exceeds 1.

## Tests
| ID | Case | Pass |
|---|---|---|
| R-1 | Ledger: buys $11.08 + $9.99, one sale $1,995 with $299.25 commission | spent $21.07; remaining $1,478.93; net sales $1,695.75; profit $1,674.68; ROI 7948% |
| R-2 | Traceability | Every money figure = an independent SQL sum over `ledger_entries` |
| R-3 | `committed_forward` | Only `renewals_used=0` counts; `renewals_used=1` adds $0 |
| R-4 | Expiring in 45 days, `renewals_used=0` | "first renewal decision", stage 60 |
| R-5 | Expiring in 25 days, `renewals_used=1` | "final expiry", stage 30, no renew option |
| R-6 | Fast Transfer date | `buy_date + 60` shown |
| R-7 | NS ≠ lander | Warning |
| R-8 | Scopes | READ 200; WRITE 200; none 401; revoked 401 |
| R-9 | `?format=md` | Valid digest, `$` amounts, no walk-away anywhere; `?format=xml` → 400 |
| R-10 | Time zone | `sold_at` stored UTC, returned `+03:00` / `+02:00` as applies |
| R-11 | `/health` | 401 without a token, 200 with READ; no data fields |
| R-12 | `/ledger?format=csv` | Header = the `cfo-ledger.md` header |
| R-13 | Warning fixtures (unknown purchase; failed event; expired unrenewed; buy without comps; purchase without receipt; hold 31 days; listed without BIN; sold name still at Sedo; no Afternic upload for 8 days with changes; live name past `drop_date`) | `PURCHASE_UNKNOWN`, `PRICE_EVENT_FAILED`, `EXPIRED_NOT_RENEWED` (error); `POST_BUY_INCOMPLETE`, `RECEIPT_MISSING`, `HOLD_STALE`, `BIN_MISSING`, `MANUAL_DELIST` (venues `[sedo]`), `EXPORT_STALE`, `PAST_DROP_DATE` (warn); sorted error → warn → info. With CR-001 P2: `DISTRIBUTION_INCOMPLETE` (8 days past `ft_eligible_on`) and the screening-pack meaning of `POST_BUY_INCOMPLETE` |
| R-14 | Money shape | Pairs everywhere; `roi` 2 decimals + `roi_pct`; a refund lowers costs; a `/sold` fee is a sale fee; `committed_forward.complete` false with the name in `missing` |
| R-15 | `/portfolio?status=pending_purchase`; `/ledger` JSON; `/audit?limit=0` / `501`; `/deals/D-999`; `/portfolio/{d}` after an upload | 400 / `{count, rows}` signed / 400 / 404 `DEAL_NOT_FOUND` / `export.afternic.last_uploaded` = uploaded values, no walk-away |
| IM-1 | Import with a mock registrar | Rows shaped like a `/buy` success; `/report` spend includes it |
| IM-2 | Import twice | Second refused, no new rows |
| IM-3 | Not in the account | Refused |
| IM-4 | Live (G3): import D-001 | `/portfolio/promptinjectionaudit.com`: registrar `godaddy`, cost $13.73, expiry 2027-10-04, trend hybrid **1488 / 967 / 950 (private) / min 100**, `approved_exception`, `drop_date` 2027-10-04 after `drop-at-first-expiry` with its schedule rows; ledger total $13.73 *(with the 5 Oct values instead: 1995 / 1295 / 950, `drop_date` 2028-10-04, the 4 PR-11 rows anchored on the import date)* |
| IM-5 | `--registrar godaddy` with a mock PAT | `registrar_api=manage`; expiry and NS from the mock |
| IM-6 | GoDaddy 403 `ACCOUNT_NOT_ELIGIBLE` | Refused with "use --manual with --expiry"; no rows |
| IM-7 | `--manual` without `--expiry` | Refused |
| IM-8 | `--manual` with expiry, no renewal price | Imported; `none`; `RENEWAL_PRICE_UNKNOWN`; `drop_date` = expiry + 1 y |
| IM-9 | No `--category` / a listing breaking a guard | Refused (`CATEGORY_REQUIRED` / the guard code) |
| IM-10 | Counts toward the caps | `/report` includes it; a `/buy` over the remaining cap refused |
| IM-11 | GoDaddy never registers | Static: no `register` in the GoDaddy adapter; `/check` excludes it `NO_AVAILABILITY_ACCESS` |
| IM-12 | Auto-renew on + privacy off; GoDaddy; `--manual` | `AUTO_RENEW_ON` + `PRIVACY_OFF` / `AUTO_RENEW_UNCONFIRMED` / `AUTO_RENEW_UNCONFIRMED`; all imported |
| IM-13 | `--expiry` ≠ registrar's; an expiry in the past (no listing) | `EXPIRY_MISMATCH` (registrar's stored) / `EXPIRY_IN_PAST`; imported |
| IM-14 | Expiry > buy + 1 y + 7 d; a listing with `drop_date` ≤ today | 422 `REGISTRATION_TERM_INVALID` / `DROP_DATE_PASSED`; no rows |
| IM-15 | `--registrar namecheap`; `--order a@b`; `--legacy-no-comps` with buy date 2026-10-05; an exception without `--approval-text`; a formula listing without it | exit 2 / 422 `NO_PII` / 422 `COMPS_REQUIRED` (v2; imported once comps are optional) / refused / imported |
| IM-16 | Adapter disabled; registrar error; no expiry; not in the account (GoDaddy) | `ADAPTER_NOT_ENABLED` / `REGISTRAR_ERROR` / `EXPIRY_UNKNOWN` / `NOT_IN_ACCOUNT` + `--manual` hint; no rows |
| IM-17 | Import over $1,500 or 50 | Imported + `POC_CAP_EXCEEDED_BY_IMPORT` / `DOMAIN_CAP_EXCEEDED_BY_IMPORT`; a later `/buy` refused |
