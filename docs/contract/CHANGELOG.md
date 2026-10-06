# Contract changelog

Semver for the API contract (`README.md` §Versioning). Newest first. Each entry links to its release note in `docs/releases/`.

## 1.1.0 (unreleased)
MINOR (additive only). Built task by task; each task adds its bullets here.
- **Name form (CAP-01, incl. FORM-2 and G-FORM-1):** new `selection.md` with the form result and its reason codes `HAS_DIGIT`, `HAS_HYPHEN`, `UNKNOWN_TOKEN`, `GFORM1_WORDS`, `GFORM1_LENGTH`, `GEO_ATTR_MISSING`, `CITY_PLUS_LEGAL`, `AMBIGUOUS_SPLIT`. No route yet (the check runs inside the screening run, a later task).
- **Pricing v3 (CR-001 G-1/G-2; `pricing_settings` columns, no new route):** when the current settings version has a price list (created only by the admin command, never seeded), new plans use the list, ladder drops, a whole-dollar floor, a geo M12 rung down to $299 and a final push to the lowest list price at or above the floor. New 422 codes on `/list`, `/buy` and `/pricing/preview`: `BIN_NOT_IN_PRICE_LIST`, `LANDER_EXCEPTION_REQUIRED` (always refused until the screening pack exists). `settings_version` is 3 in those responses. An override never waives the list. v2 plans, their schedules and every v2 number are unchanged unless replanned (a replan uses the current version) (`BIN_NOT_NICE` and `BIN_BELOW_FLOOR_MIN` stay for v2).
- **Selection settings, lists and evaluation (CAP-00, CAP-24, CAP-18; new routes):** `GET` / `POST /selection/settings`, `POST /selection/settings/{label}/activate`, `GET` / `POST /selection/lists/{name}`, `POST /selection/evaluate` (all in `endpoints.md`; the settings document, list formats, tier DSL, money fields and codes in `selection.md`). Settings are versioned and immutable; a draft is WRITE, **an activation needs Dvir's `approval_ref`**, the priors are locked against drafts (`SETTINGS_KEY_LOCKED`) and clearing `buy_hold` is refused until the holdout passes (`HOLDOUT_NOT_PASSED`). A census list is frozen only with `approval_ref`. New codes: `SETTINGS_NOT_FOUND`, `SETTINGS_KEY_UNKNOWN`, `SETTINGS_KEY_LOCKED`, `SETTINGS_INVALID`, `SETTINGS_NO_CHANGE`, `SETTINGS_LABEL_TAKEN`, `SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `LIST_NOT_FOUND`, `LIST_NAME_INVALID`, `LIST_TERM_INVALID`, `LIST_NO_CHANGE`, `CENSUS_LIST_SIZE`, `CENSUS_LIST_INVALID`, `FORBIDDEN_FEATURE`, `BIN_REQUIRED`, and the 500s `SELECTION_SETTINGS_MISSING` / `SELECTION_SETTINGS_INVALID`; warning `PRICING_V3_MISSING`. `approval_ref` is now also required for those two actions (README §Conventions).
- **Name form (CAP-01) settings:** `form.short_token_flag_min` (default 2: a split with that many dictionary-only 2-letter tokens, such as `animal·it·os`, is `FLAG` `AMBIGUOUS_SPLIT`) and `form.city_word_allowlist` (a place name that is also a dictionary word counts as a city only if listed there or in the `city_extra` list).

## 1.0.1 (2026-10-06): documentation corrections
PATCH. The code is unchanged except one message string; the contract now describes it exactly. Release note: `docs/releases/v1.0.1.md`. From the accuracy review (21 corrections).

**Wrong (would mislead a client):**
- `GET /audit` `request` is a JSON object (or null), not a string.
- An unknown **POST** route answers 403 / 400 (`SCOPE_FORBIDDEN`, `IDEMPOTENCY_KEY_REQUIRED`) before 404; the same for `POST /export/dan/uploaded`. Only GET gets a plain 404.
- `/list`: an off-grade geo BIN needs `approval_ref` (422 `APPROVAL_REQUIRED`); "no approval for any change within the rules" was too broad.

**Incomplete and cosmetic:**
- Money display: whole dollars only in the plan view and preview; `$1,995.00` elsewhere; the plan-view schedule has no `_cents` and no `(private)` suffix.
- `/report` `next_price_event`, upcoming `values`, `applied_7d` are flat `*_cents` + display pairs.
- Offer routing: `unpriced` (non-email) goes to `dvir`. `approval_ref` elsewhere is ignored unless a route says it is validated.
- `POC_CAP_EXCEEDED` and `REGISTRAR_FUNDS` `details` keys listed exactly.
- `pricing_evidence` problems are `COMPS_INVALID`, not `VALIDATION_ERROR`.
- HEAD on the export routes writes an `export_runs` row.
- `offers_by_strategy` scopes (listed names vs all-time); `domains_owned` differs between dry run and 201.
- Failed-auth limiter: 20 or more failures. `POST /jobs/run` with no job token: 503 even unauthenticated.
- `NOT_LISTED` never appears in export warnings. `OFFER_NOT_FOUND` comes after body validation. UTC time-field exceptions. Job step `skipped` only when the summary says so.
- v1.0.0 release note: removed the stale "$500" clause.
- **Message text (the only code change):** the `/buy` 202 `message` now says the bookkeeping resolves on the next hourly reconciler run (it said "within 10 minutes"). Messages are not part of the contract.

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
- Pricing is **`pricing_settings` v2** (x95 BINs, −20% drops, a $399 geo name never drops, floor and walk-away to the nearest $5). The v3 price list, step-down drops and the geo $399 → $299 rung ship in 1.1.0 (see above); `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED` were not emitted in 1.0.0.
- Not built: the selection endpoints (`/check/batch`, `/check/history`, `/check/tm`, `/check/quote`, `/score`, `/screening_pack`, …), `POST /distribution/confirm` and the FT-1 warning `DISTRIBUTION_INCOMPLETE`, `GET /renewal/decision/{domain}`, `POST /renew/{domain}` and the `dt` CLI.
- `POST_BUY_INCOMPLETE` means "bought without stored comps", not "without a screening pack".
- `GET /check` ignores unknown query parameters; every other GET with a query schema is strict.
- Codes the specs didn't list are now documented: `SOLD_AT_IN_FUTURE`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `EXTERNAL_REF_CONFLICT`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OUTCOME_CHANGED_CONCURRENTLY`, `OFFER_SOLD_MISMATCH`, `SEDO_TEMPLATE_INVALID`, `DROP_DATE_UNKNOWN`, `LANDER_INVALID`, `NS_INVALID`, `COMMISSION_UNEXPECTED`, the `/buy` post-buy warnings and the export warnings.
