# Contract changelog

Semver for the API contract (`README.md` §Versioning). Newest first. Each entry links to its release note in `docs/releases/`.

## 1.0.0 (2026-10-06): initial contract
The first written contract: the API as built after the 6 Oct 2026 cleanup (DOM handover). Release note: `docs/releases/v1.0.0.md`.

**Changes from the 5 Oct API** (all in this release):
- `POST /sold/{domain}`: the fee for the payout is a top-level `payout_fee` (USD). The `payout {amount, method, received_on}` object is gone (sending it → 422 `VALIDATION_ERROR`), and so are the `payouts` table, `POST /payouts/{id}/received`, `PAYOUT_MISMATCH`, `PAYOUT_OVERDUE` and `/report` `payouts_pending`.
- `POST /offers/import` (offers CSV import) is gone. Record offers one at a time with `POST /offers`.
- **Bots only:** every route except `GET /health/ping` needs a valid token; `GET /health` now needs one too. Unauthenticated requests write nothing. A per-IP failed-auth limiter answers 429 `RATE_LIMITED` after 20 failures in 10 minutes.
- **Exports are always the full file.** `changed_only` is gone; **any** query parameter on `GET /export/*.csv` → 422 `VALIDATION_ERROR`.
- **Jobs** run only through `POST /jobs/run` (`tick` hourly, `daily` 00:05 UTC). A bad body → **422** `VALIDATION_ERROR`. The service has no in-process timers (`JOBS_MODE` is gone).

**Where the contract differs from the inherited specs** (the specs DOM inherited are now `docs/internal/`; the full list with decisions is `docs/internal/gaps.md`). The contract describes the code:
- `POST /buy` still **requires 2–3 comps** (`pricing_evidence`, `COMPS_REQUIRED`) and does **not** accept `screening_pack` (an unknown field → 422). Selection v9.1 says comps are optional and a screening pack is required; that ships with CR-001 P1b.
- Pricing is **`pricing_settings` v2** (x95 BINs, −20% drops, a $399 geo name never drops, floor and walk-away to the nearest $5). The v3 price list, step-down drops and the geo $399 → $299 rung ship with CR-001 P1a. `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED` aren't emitted yet.
- Not built: the selection endpoints (`/check/batch`, `/check/history`, `/check/tm`, `/check/quote`, `/score`, `/screening_pack`, …), `POST /distribution/confirm` and the FT-1 warning `DISTRIBUTION_INCOMPLETE`, `GET /renewal/decision/{domain}`, `POST /renew/{domain}` and the `dt` CLI.
- `POST_BUY_INCOMPLETE` means "bought without stored comps", not "without a screening pack".
- `GET /check` ignores unknown query parameters; every other GET with a query schema is strict.
- Codes the specs didn't list are now documented: `SOLD_AT_IN_FUTURE`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `EXTERNAL_REF_CONFLICT`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OUTCOME_CHANGED_CONCURRENTLY`, `OFFER_SOLD_MISMATCH`, `SEDO_TEMPLATE_INVALID`, `DROP_DATE_UNKNOWN`, `LANDER_INVALID`, `NS_INVALID`, `COMMISSION_UNEXPECTED`, the `/buy` post-buy warnings and the export warnings.
