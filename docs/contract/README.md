# domain-trading API contract

**Version 2.0.2** (7 Oct 2026). This folder is the interface between **DOM** (the vendor that owns and runs the software) and its customer, **Dvir**, whose chief of staff **Gavriel** is the only API user. It describes the API exactly as built. What isn't written here isn't promised.

| File | What |
|---|---|
| `README.md` | This page: base URL, auth, idempotency, errors, conventions, guarantees |
| `endpoints.md` | Every route: method, path, token, request, response, error codes |
| `jobs.md` | The scheduled jobs (`POST /jobs/run`: `tick`, `daily`) |
| `reports.md` | `GET /report` fields and warnings (with levels) |
| `selection.md` | Selection and screening checks: statuses, codes, shapes (v1.1.0) |
| `formats.md` | The Afternic CSV, the Sedo file, the ledger CSV, and other exported shapes |
| `CHANGELOG.md` | Contract versions |

**Versioning (semver).** A MAJOR change breaks a caller: a route, field or code removed or renamed, a type or meaning changed, a rule tightened. A MINOR change adds something optional: a route, a response field, a warning, an error code on a new path. A PATCH fixes the docs or fixes behaviour back to what this contract already says. Every change is listed in `CHANGELOG.md` and announced in a release note (`docs/releases/`). Callers must ignore unknown response fields.

## Base URL
`https://<service>.onrender.com` (expected: `https://domain-trading-api.onrender.com`; the release note gives the real one once it's deployed). HTTPS only. The service sleeps when idle and needs **up to ~60 s** for a cold start, so use request timeouts of at least 60 s and retry an idempotent call once (same `Idempotency-Key`).

## Who may call
**Bots only.** Every request needs a credential, except `GET /health/ping`.

| Credential | Header | May call |
|---|---|---|
| **READ** bot token | `Authorization: Bearer <token>` | Every `GET` |
| **WRITE** bot token | same | Every route except `POST /jobs/run` |
| **Job token** (`JOB_TRIGGER_TOKEN`, held by the Cloudflare Worker cron) | same | `POST /jobs/run` only |

- DOM creates and revokes bot tokens with an admin command. No API route creates, lists or reveals a token.
- **Refused requests:** a missing, malformed, unknown or revoked token → **401** `UNAUTHORIZED`. A READ token on a POST → **403** `SCOPE_FORBIDDEN`. A READ or WRITE token on `/jobs/run`, or the job token anywhere else → 401. An unknown **GET** route → 401 without a valid token, 404 `NOT_FOUND` with one. An unknown **POST** (or other mutating) route runs the same checks as a real one: a READ token → 403 `SCOPE_FORBIDDEN`, a WRITE token without `Idempotency-Key` → 400 `IDEMPOTENCY_KEY_REQUIRED`, and only with a key → 404 `NOT_FOUND` (audited, and the key is claimed). `POST /jobs/run` with no job token configured answers 503 `JOBS_DISABLED` before the auth check, even without a token.
- **An unauthenticated request writes nothing** to the database: no audit row, no idempotency row. This covers refusals, unknown routes and framework errors (bad URL encoding and the like; answered with `INVALID_REQUEST`).
- **Failed-auth limiter:** 20 or more failed authentications from one client IP (the 21st request is refused) within a rolling 10 minutes → **429** `RATE_LIMITED` with `Retry-After` (seconds) and `details.retry_after_seconds`, before any token lookup. While an IP is blocked, a bot token verified in the last 10 minutes and the correct job token still get through (a revoked token never does).
- **Rate limits per token:** 60 GET and 10 POST per minute (sliding window; the job token has its own). Over the limit → **429** `RATE_LIMITED` with `Retry-After`. A 429 never claims an `Idempotency-Key`.
- `HEAD` is answered for every `GET` route, with the same auth. On `/export/afternic.csv` and `/export/sedo.csv` a HEAD runs the GET handler: it writes an `export_runs` row and returns an `X-Export-Id`.

## Idempotency (every POST)
- `Idempotency-Key: <1–255 visible ASCII characters>` is **required** on every POST. Missing or malformed → **400** `IDEMPOTENCY_KEY_REQUIRED`.
- **Same key, same method, path and body** (canonical JSON): the stored response is replayed with the header `Idempotent-Replayed: true`. The side effects happen once.
- **Same key, different request** → **409** `IDEMPOTENCY_KEY_MISMATCH`. **Same key while the first call is still running** → **409** `IDEMPOTENCY_KEY_IN_USE`.
- A 5xx response releases the key, so a retry with the same key runs again. Exception: `AUDIT_WRITE_FAILED` (500) means the request **was processed** but not audited. Retry with the same key to get the stored result.
- `POST /buy` only: a stored **202** (purchase state unknown) is re-evaluated on retry with the same key, never replayed blindly. Never retry a purchase with a **new** key.
- Keys are global, not per token. Use a fresh UUID per intended action.

## Audit
Every authenticated POST writes exactly one `audit_log` row: success, refusal (including 403 and 4xx validation errors), dry run, replay (`replayed:` summary) and error. The row holds the token id and scope, method, path, idempotency key, the `approval_ref` text and time if sent, the redacted request, the status code and a result summary. `GET /audit` reads them. Audit rows are append-only.

## Errors
```json
{ "error": { "code": "POC_CAP_EXCEEDED", "message": "…", "details": { } } }
```
- **Branch on `code`, never on `message`.** Codes are stable within a MAJOR version; messages may change at any time. `details` is always an object (may be empty).
- Cross-cutting codes: `UNAUTHORIZED` 401 · `SCOPE_FORBIDDEN` 403 · `RATE_LIMITED` 429 · `IDEMPOTENCY_KEY_REQUIRED` 400 · `IDEMPOTENCY_KEY_MISMATCH` / `IDEMPOTENCY_KEY_IN_USE` 409 · `VALIDATION_ERROR` **422** for a request body (strict schemas: an unknown field is a 422, except inside `pricing_evidence`, whose problems are `COMPS_INVALID`; with `details.issues[] {path, message}`), **400** for most query-string errors (exceptions are listed per route) · `INVALID_BODY` 400/413/415 (unparseable JSON, body over 64 KB, wrong content type) · `INVALID_REQUEST` 4xx (malformed URL and other framework rejections) · `DOMAIN_INVALID` 422 (not a second-level name like `name.com`) · `TLD_NOT_SUPPORTED` 422 (only `.com` in v1) · `NOT_FOUND` 404 (unknown route) · `INTERNAL` 500 · `AUDIT_WRITE_FAILED` 500.
- Route-specific codes are listed per route in `endpoints.md`. The code index at the end of `endpoints.md` lists every code the service emits.

## Conventions
- **Money:** integer **cents, USD**. Every money field is a pair: `<key>_cents` (integer) plus `<key>` (display string such as `"$11.08"`). Display strings for listing prices differ by place. The plan view (`/list`, `/buy`, `/pricing/preview`, including its `schedule` entries) uses whole dollars (`"$1,995"`). `/report`, `/portfolio`, `next_price_event`, upcoming `values`, `applied_7d`, an offer `snapshot` and listing history use the standard money format (`"$1,995.00"`). The walk-away display is whole dollars with `(private)` everywhere except the plan-view `schedule` entries (no suffix there). **Request** amounts are USD numbers or strings as stated per route (for example `max_price: 11.5`, `amount_usd: "450.00"`), with at most 2 decimals.
- **Time:** responses carry ISO 8601 with an offset; most use the Asia/Jerusalem offset (`+03:00` IDT / `+02:00` IST); exceptions are UTC `...Z` strings: `uploaded_at` on `/export/{venue}/uploaded` and `started_at` / `finished_at` on `/jobs/run`. Request times must carry an offset (`Z` or `±hh:mm`). Calendar days (`YYYY-MM-DD`, such as `expiry_date` or a `from`/`to` filter) are Asia/Jerusalem days.
- **Domains:** lowercased, a trailing dot dropped; v1 accepts only second-level `.com` names. `display_name` is the same name with different ASCII capitalisation (for marketplaces).
- **`approval_ref`** = `{ "text": "<Dvir's verbatim words>", "approved_at": "<ISO 8601 with offset>" }`. Valid when `text` is non-empty, `approved_at` has an offset, is not more than 60 s in the future and not older than 72 h, and (except on `/export/{venue}/uploaded`) the text **names the domain** on label boundaries (`ba.com`, `x.com.au` and `www.x.com` don't name `x.com`). An invalid one → 422 `APPROVAL_INVALID` or `APPROVAL_EXPIRED`. It is **required only for buy and sell decisions**: `POST /buy`, an offer `countered`/`accepted` outcome that isn't pre-approved, a pricing exception and an override on `/list` or `/buy`. It is also required (the text must name the settings label, or the list name or target sld, instead of a domain) to **activate a selection settings version** (`POST /selection/settings/{label}/activate`) and to **freeze a census list** (`POST /selection/lists/{name}` for `bt1_<sld>` and `s6_regime_audit`). Elsewhere it is validated and stored only where a route says so (`POST /offers` with `pricing_hold: true`; an outcome that needs it); otherwise it is ignored, and only the audit row keeps the text.

## Guarantees
1. **Caps are server-side and can't be changed through the API:** total spend ≤ **$1,500** (POC cap), at most **50** domains (owned + listed + delisted + pending purchases), and the per-call `max_price` / `max_two_year_price` on `/buy`. Only DOM's admin command or a migration changes the caps, and only on Dvir's word.
2. **No purchase without Dvir's approval:** `/buy` refuses without a valid `approval_ref` naming the domain. The server can't prove that a human wrote the text; that trust boundary is accepted. A real purchase happens only when Dvir has approved that domain in chat.
3. **`dry_run` for all testing.** `POST /buy` and `POST /list/{domain}` accept `"dry_run": true`: every check runs (including the live registrar quote and the registrar's own dry run on `/buy`) and the response shows what would happen, but nothing is bought, changed or booked. Only the audit row (and, on `/buy`, the stored quotes) is written. One exception: if the registrar answers a `/buy` dry run ambiguously (it may have registered), the service records an `unknown` purchase so the caps count it, and answers 409 `REGISTRAR_DRY_RUN_AMBIGUOUS`. Gavriel tests with `dry_run: true` only.
4. **No top-up:** the service never calls a registrar top-up endpoint. A registrar with auto top-up on is refused (`REGISTRAR_AUTO_TOPUP_ON`). The prepaid credit is a second spending limit.
5. **1-year registrations only, at most one renewal,** compared on first year + one renewal. Never premium or aftermarket names, never Cloudflare Registrar.
6. **Append-only records:** the ledger, the audit log, listing history, pricing settings and sales facts can't be updated or deleted (database triggers). Corrections are new reversing rows.
7. **No outbound contact:** the service never sends email or chat, never contacts buyers, never calls a marketplace. Scheduled price changes reach a marketplace only when a bot uploads the export file.
8. **The private walk-away is never written to an export file** (Afternic, Sedo, the preview's `afternic_row`). Read endpoints show it to the bots, marked `(private)`. `GET /report?format=md` leaves it out.
9. **No secrets in responses or logs:** registrar keys live only in server environment variables. No route returns a key, a key prefix or an account balance.
10. **No LLM calls** inside the service.
11. **Buy hold (v1.1.0):** while a screened name's latest screening run has `buy_hold` on (or is a backtest or no longer the active settings version), a real `/buy` of it is refused (409 `BUY_HOLD`). A name never screened is not held.
12. **Hosting costs $0:** Render free web service, Neon free Postgres and a Cloudflare Worker cron.

**Known limits:**
- Export pending and manual-delist flags (`X-Pending-Changes`, `X-Manual-Delist`, `EXPORT_PENDING`, `MANUAL_DELIST`) assume Gavriel calls the API **sequentially**. A `/list` change that races a concurrent export may be counted as already exported. They also compare timestamps taken from the app clock.
- **Screening and the screening pack are in (v1.1.0, v1.2.0); the rest of CR-001 is not.** Since 2.0.0 a real `/buy` **requires** a complete, current pack of the name's latest run and an active membership of the open tranche (409 `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP`; `endpoints.md`); a dry run reports what would block in `would_be_blocked`. Lead verification (CAP-14/15/16) was cut on 6 Oct 2026 and is not built. `/buy` still requires 2-3 comps and refuses `screening_pack` (422). Web Risk and US trademark results are **manual records** (`POST /screening/runs/{id}/manual`). NameBio and the Internet Archive are switched off; `history` is `MANUAL_REQUIRED` until Gavriel records a manual history result per name (`selection.md`). `GET /check` and `/buy` need at least one enabled registrar adapter (Porkbun) to show `available`.
