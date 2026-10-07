# Architecture (v1)

A backend service: Postgres + an HTTP API, no frontend. Bots (Gavriel) call it over HTTPS with bearer tokens. It is the **only** place money actions happen and the source of truth for the portfolio and ledger. The interface is `docs/contract/` (every route, field and code); this file covers the internals.

## 1. Goal
Answer any portfolio or money question; buy a domain at the cheapest qualifying registrar only after Dvir's explicit approval; point it at a for-sale lander; produce marketplace bulk-upload files; record offers and sales. Server-enforced caps, every write audited.

## 2. Scope
- **Built (contract v1.0.0):** the 22 routes in `docs/contract/endpoints.md`.
- **Out of scope (v1):** a frontend; marketplace APIs (Afternic has no seller API; Sedo's needs account credentials); automatic delisting **at** the marketplaces (the `delist` event only flags the name for manual removal); sending email or chat; auctions and backorders; multi-year registrations; non-USD prices; TLDs other than .com (code is TLD-generic, tested on .com only).
- **Selection backend (selection v9.1, Dvir approved 6 Oct 2026):** specified in `selection.md` §4 and §8; delivered through **CR-001** (P1a/P1b, `docs/requests/CR-001-selection-checks.md` §11). Not built: see `gaps.md`.
- **Proposed v1.1 (not built until Dvir says so):** `POST /renew/{domain}` (the one allowed renewal: refuses when `renewals_used ≥ 1` with 409 `MAX_ONE_RENEWAL`, renews 1 year, books a `renewal` row, sets `renewals_used = 1`); LTO installment logging; the thin `dt` CLI (`cli.md`).

## 3. Components
```
Gavriel --HTTPS + Bearer--> [Render free web service: API] --> Neon Postgres (all state)
                                   |-- registrar adapters --> Porkbun (full), GoDaddy (management only)
                                   |-- RDAP (rdap.verisign.com), public DNS (a.gtld-servers.net)
Cloudflare Worker cron --POST /jobs/run--> API      daily job --git data API--> private data repo (backup)
```
- Stack: Node 22, TypeScript (strict), Fastify 5, zod v4, Kysely + pg, node-pg-migrate (plain SQL), native fetch, Vitest + MSW.
- Screening (`src/screening/*`): form, brand/typo, RDAP/census, SURBL, history (HIST-2), tier/DEMAND-2, quote/price, runs engine, tranches, replay. Outside sources are read only when their `sources.*` setting is true (terms log: `sources.md`). No LLM calls.
- Adapters implement one interface (§5). Porkbun is fully implemented; GoDaddy is management-only; others are enabled only when implemented, keyed **and** their contract tests pass (`../research/registrars.md`).
- Secrets (registrar keys, DB URL, backup PAT, job token) live **only** in server env vars (Render `sync: false`). Never returned, logged or committed.

## 4. Data model (Postgres)
Money = integer cents (USD). Timestamps = `timestamptz` (UTC). Calendar dates = Asia/Jerusalem days.

| Table | Key columns | Rules |
|---|---|---|
| `domains` | `id`, `domain` (unique, lowercase), `deal_id` (`D-NNN`), `registrar`, `status` (`pending_purchase`, `owned`, `listed`, `delisted`, `sold`, `dropped`), `buy_date`, `cost_cents`, `expiry_date`, `renewal_price_cents`, `renewals_used` (CHECK 0..1), `drop_date`, `category` (`geo`, `trend`, `b2b`, `collision`, `regulation`, `buzzword`, `other`; NOT NULL once owned), `listing_mode` (`bin`/`offer`/`hybrid`/NULL), `bin_cents`, `floor_cents`, `min_offer_cents` (CHECK ≥ 2000), `walkaway_cents` (private; CHECK walkaway ≤ floor ≤ bin), `price_grade`, `pricing_source` (`formula`/`approved_exception`), `pricing_settings_version`, `first_listed_at`, `pricing_hold` + reason, `plan_id`, `plan_audit_id`, `export_pending_since`, `listing_changed_at`, `lto_max_months`, `display_name`, `lander`, `lander_ns` (text[]), `lander_set_at`, `ns_verified_at`, `registrar_api` (`full`/`manage`/`none`), `sold_at`, `delisted_at` | At purchase `renewals_used = 0`, `drop_date = expiry + 1 year` (29 Feb → 28 Feb). `drop_date` is never pushed later. CHECK: `renewals_used = 1` OR `drop_date` NULL OR `drop_date = expiry + 1 year` OR `drop_date = expiry_date` (Gate F `drop-at-first-expiry`) |
| `ledger_entries` | `id`, `occurred_on`, `domain_id`, `deal_id`, `type` (`registration`, `renewal`, `fee`, `commission`, `sale`, `payout_fee`, `refund`, `tool`, `ai`, `adjustment`), `amount_cents` (signed; negative = out), `currency`, `counterparty`, `receipt_ref`, `note`, `audit_id` | **Append-only** (trigger). Corrections are reversing rows |
| `sales` | `id`, `domain_id`, `sale_ledger_id` (UNIQUE FK: the `sale` row), `venue`, `transaction_ref` (no `@`), `sale_price_cents`, `commission_cents`, `other_fees_cents`, `sold_at`, `offer_id`, `recorded_by`, `confirmed`, `approval_text`, `approval_at`, `evidence_source`, `evidence_ref`, `audit_id` | UNIQUE (`venue`, `transaction_ref`). CHECK `confirmed` or (ref + evidence). Immutable (no UPDATE/DELETE/TRUNCATE) |
| `registrar_presence` | `domain_id` (PK), `status` (`present`/`absent`), `first_absent_at` (kept while absent), `last_checked_at` | Upserted by the daily registrar check; feeds `DOMAIN_LEFT_ACCOUNT` |
| `listing_history` | `id`, `domain_id`, `at`, `source` (`buy`/`import`/`list`/`schedule`), category, grade, mode, prices incl. walk-away, `lto_max_months`, `lander`, `pricing_source`, settings version, `schedule_event_id`, `plan_audit_id`, `override`, `override_reason`, `approval_text`, `approval_at`, `audit_id` | **Append-only**. One row per accepted listing, price, category, hold or scheduled change |
| `pricing_settings` | `version` (PK), `effective_at`, geo grade prices and range, `geo_drops_enabled`, `geo_drops`, `floor_bps`, `floor_min_cents`, `walkaway_bps`, `walkaway_min_cents`, `hybrid_min_offer_cents`, `drops`, `final_push_days_before_drop`, `final_push_mode`, `delist_days_before_drop`, `headsup_days_before`, `comps_min` (CHECK ≥ 1), `comps_max`, `public_lto`, `approval_text`, `approval_at`, `note` | **Versioned, append-only.** v2 seeded. Written only by `npm run admin -- pricing-settings new`. v3 columns (`listing-strategy.md` §10.13) arrive with CR-001 P1a |
| `price_schedule` | `id`, `domain_id`, `plan_id`, `event` (`drop1_m6`, `drop2_m18`, `geo_drop_m12`, `final_push`, `delist`), `due_on`, prices, `settings_version`, `status`, `applied_at`, `listing_history_id`, `note` | Exact amounts at plan creation; unique (`domain_id`, `event`, `plan_id`) |
| `pricing_evidence` | `id`, `domain_id`, `comps` (jsonb), `rationale`, `legacy_no_comps_reason`, `audit_id` | One per buy/import; CHECK comps or legacy reason |
| `export_runs` | `export_id`, `marketplace`, `at` (snapshot, app clock), `domains` (text[]) | One per `GET /export/*.csv` |
| `export_uploads` | `id`, `venue`, `export_id`, `domains`, `uploaded_at`, `approval_text` (nullable), `note` (no `@`), `audit_id` | One per confirmed upload |
| `offers` | `id`, `domain_id`, `amount_cents`, `source`, `received_at`, `buyer_type`, `buyer_ref`, `external_ref`, price snapshot (`*_cents_at`), `listing_history_id`, `band`, `routing`, `outcome`, `outcome_at`, `outcome_note`, `outcome_approval_text`, `note`, `recorded_by`, `audit_id`, `created_at` | Facts immutable (trigger). UNIQUE (`source`, `external_ref`). No buyer emails or names |
| `quotes` | `id`, `check_id`, `domain`, `registrar`, `quoted_at`, `available`, `premium`, prices, `eligible`, `exclusion_reason`, `raw` (secrets stripped) | Every `/check` and `/buy` stores its comparison |
| `purchases` | `id`, `idempotency_key` (unique), `request_hash`, `domain`, `state` (`created`, `register_sent`, `succeeded`, `failed`, `unknown`), `dry_run`, `registrar`, `check_id`, `charged_cents`, `expected_cents` (counts toward the cap while open), `order_id`, `max_price_cents`, `approval_text`, `approval_at`, `request` (redacted), `response`, `audit_id` | One row per real `/buy`. A unique partial index allows one `created`/`register_sent`/`succeeded`/`unknown` row per domain |
| `receipts` | `id`, `purchase_id`, `registrar`, `order_id`, `raw` (billing identity redacted), `fetched_at` | Registration `receipt_ref` = `<registrar>:<order_id>` |
| `deals` | `id` (`D-NNN`), `domain`, `strategy`, `status_note`, `created_at` | Upserted when `/buy` passes `deal_id` |
| `selection_settings` | `version`, `label` (unique), `values` (jsonb), `created_by`, activation columns (`activated_at`, `activated_by`, `approval_text`, `approval_at`) | Immutable apart from activation; the active row is the latest activated. Activations are columns here (R4: nothing is lost by merging) |
| `selection_lists` | `name`, `version`, `items`, `frozen`, `approval_text` | Versioned lists (brand, bigco, events, signatures, census). Census lists frozen only with Dvir's approval |
| `screening_runs`, `screening_results` | run input, mode, settings version, status; one row per (run, name, check) with status, reason code, fields, evidence ids | Resumable; manual rows outrank machine rows |
| `screening_evidence` | `id`, `source`, `url`, `text`, `sha256`, `fetched_at` | Hash-addressed evidence (HIST-2 captures, manual URLs) |
| `manual_quotes` | `domain`, `registrar`, `renewal_cents`, `observed_at` | Kept apart from `quotes`: those rows are tied to a `/check` and carry registrar raw data |
| `rdap_lookups`, `reference_files` | cache of RDAP answers; downloaded reference files (popularity list, IANA bootstrap) | Caches, not in the backup export |
| `tranches`, `tranche_members` | name, size, `spend_cap`, `opened_under`, status, per-member lane and `est_cost` | Closed rows read-only by DB trigger |
| `labelled_names`, `holdout_suites`, `replay_runs` | append-only registry (`fit`/`dev`/`test`), pre-registered suite definitions (frozen with approval), replay reports | A failing holdout sticks per settings version |
| `audit_log` | `id` (`aud_…`), `at`, `token_id`, `scope` (`read`/`write`/`job`/`admin`), `method`, `path`, `idempotency_key`, `approval_text`, `approval_at`, `request` (redacted), `status_code`, `result_summary`, `client_ip` | **Append-only.** One row per authenticated POST, job run and admin command |
| `idempotency_keys` | `key` (PK), `request_hash`, `method`, `path`, `token_id`, `state`, `status_code`, `response_body`, `response_content_type`, `completed_at` | Never exported |
| `api_tokens` | `id`, `name`, `scope` (`read`/`write`), `token_sha256`, `created_at`, `revoked_at`, `last_used_at` | Plain token shown once by the admin command. Never exported |
| `settings` | `poc_cap_cents` (150000), `max_domains` (50), `approval_max_age_hours` (72), `lander_target` (`afternic`), `allowed_registrars` (`{porkbun}`; never cloudflare), `high_value_min_bin_cents` (250000), `sedo_hybrid_as` (`make_offer`) | One row. Changed only by an admin command or a migration, never the API |

## 5. Registrar adapter interface
```
quote(domain)                    -> {available, premium, first_year_cents, renewal_cents, privacy_cents_per_year, currency, raw}
accountState()                   -> {balance_cents|null, spend_limit_remaining_cents|null, auto_topup_enabled|null}
register(domain, {costCents, idempotencyKey, dryRun})   # privacy on; 1 year only; auto-renew set afterwards
                                 -> registered {order_id, charged_cents, balance_cents, raw} | dry_run {would_succeed, cost_cents}
findDomain(domain)               -> {expiry_date, whois_privacy, auto_renew, api_access, ns|null} | null
                                 # null only on a definite DOMAIN_NOT_FOUND; any other error throws
setNameservers(domain, ns[]) -> {pending?}  ; getNameservers(domain) -> set
setAutoRenew(domain, on)        ; getReceipt(order_id)
findRegistration(domain, since)  -> {order_id, charged_cents, expiry_date|null, invoice_date, raw} | null   # from invoices
capabilities                     -> {canRegister, canQuote, canManageNs, customNs, prepaid, freePrivacy, afternicFastTransfer, sandbox}
```
`registrar_api`: `full` = quote + register + manage (Porkbun); `manage` = NS/details only (GoDaddy PAT; accounts < 50 domains can't check availability or buy); `none` = manual (NS verified via public DNS).

**Porkbun** (`https://api.porkbun.com/api/json/v3`; headers `X-API-Key` / `X-Secret-API-Key`; verified 3 Oct 2026 in https://porkbun.com/llms/domain):

| Method | Endpoint |
|---|---|
| `quote` | `POST /domain/checkDomain/{d}` (`avail`, `price`, `regularPrice`, `premium`, `additional.renewal.price`) |
| `accountState` | `GET /account/balance` + `GET /account/apiSettings` (`settings.autoTopup`). The code never calls a top-up path (B-25) |
| `register` | `POST /domain/create/{d}`: `cost` (integer cents = the quote), `agreeToTerms:"yes"`, `whoisPrivacy:true`, optional `dryRun:true`, header `Idempotency-Key: dt-<purchase id>` |
| `findDomain` | `GET /domain/get/{d}` |
| `setNameservers` / `getNameservers` | `POST /domain/updateNs/{d}` / `getNs` (compare as a set) |
| `setAutoRenew` | `POST /domain/updateAutoRenew/{d}` |
| `getReceipt` / `findRegistration` | `GET /account/invoice/{orderId}` (redacted) / `GET /account/invoices?year=` (the SUCCESS registration line: `price_cents − discount_cents`, `expires`) |

Branch on the error `code`, never the message. A coded error on HTTP < 500 is **definite**, except `IDEMPOTENCY_KEY_IN_USE`. Timeouts, network errors, any 5xx, `IDEMPOTENCY_KEY_IN_USE` and unparseable responses are **ambiguous** (never retry a purchase with a new key). Conditions handled: `VERIFICATION_REQUIRED`, `INSUFFICIENT_FUNDS`, `MONTHLY_SPEND_LIMIT_EXCEEDED`, `ORDER_TOO_LARGE` (> $100), `COST_MISMATCH`, `DOMAIN_NOT_AVAILABLE`, premium names (not registrable via API), `API_ACCESS_DISABLED` (domain not opted in), `RATE_LIMIT_EXCEEDED` (+ `Retry-After`), `IDEMPOTENCY_KEY_MISMATCH` / `IDEMPOTENCY_KEY_IN_USE`.

**GoDaddy** (management only, PAT, v3): NS via `PUT /v3/domains/domain-names/{domain}/nameservers` → 202 + an operation polled up to 60 s (still running, untrackable, or a poll error → `pending` + `NS_PENDING`; FAILED → the operation's code, else `GODADDY_OPERATION_FAILED`). 403 `ACCOUNT_NOT_ELIGIBLE` → manual NS. No `register` implementation (IM-11).

## 6. Auth, scopes, audit (contract: `docs/contract/README.md`)
- Tokens: `dt_` + 32 random bytes (base64url), stored as SHA-256. READ = GET only; WRITE = everything except `/jobs/run`. Created/revoked only by `npm run admin -- token create|revoke|list` run against Neon (`.env.neon`). No API route touches tokens.
- **Bots only (Dvir, 6 Oct 2026):** without a valid credential → 401 (or 429) with **zero DB writes** (no audit or idempotency row; unknown routes and framework errors too). Public: `GET /health/ping` only.
- **Failed-auth limiter:** in memory per client IP (`trustProxy` exactly one hop: Render), > 20 failures in a rolling 10 min → 429 before any lookup. While blocked: a bot token verified in the last 10 min (cache of ≤ 100 hashes, consulted only for blocked IPs; a hit only permits the normal DB lookup, so revocation bites) and the correct job token still pass.
- **Job trigger:** `POST /jobs/run` accepts only `JOB_TRIGGER_TOKEN` (≥ 32 chars, constant-time compare, no DB); unset → 503 `JOBS_DISABLED`. Steps and schedule: `docs/contract/jobs.md`.
- **Per-token rate limit:** 60 GET / 10 POST per minute (in memory, one instance). Body limit 64 KB.
- **Audit:** every authenticated POST (success, refusal incl. 403, dry run, replay, error) → one `audit_log` row. A failed audit write turns the reply into 500 `AUDIT_WRITE_FAILED` (processed; retry with the same key).
- **Idempotency:** claimed in a preHandler after auth and scope; stored in `onSend`; released on 5xx; a stored 202 on `/buy` is re-run (the handler never re-registers).
- **Approvals:** `approval_ref` only for buy and sell decisions (Dvir, 5 Oct 2026, 20:07): `/buy` (and the future renewal), non-pre-approved offer `countered`/`accepted`, pricing exceptions (V5), overrides (V8). Everything else is bot-only. The server records Dvir's words but can't verify a human said them (trust boundary, §9).

## 7. Errors and conventions
Envelope, cross-cutting codes, money and time conventions: `docs/contract/README.md`. No LLM calls anywhere: 0 tokens at runtime.

## 8. Hosting ($0; Dvir, 5 Oct 2026)
- **Render free web service** (`render.yaml`, Blueprint; sleeps when idle, ~50 s cold start). Health check `/health/ping` (no DB, so it never wakes Neon). Deploy in its own free workspace (750 instance-hours per workspace; no keep-warm ping).
- **Neon free Postgres**, **direct** connection (production refuses a `-pooler` host: the per-domain lock is a session advisory lock), TLS `sslmode=verify-full` (`DATABASE_SSL=true`). No paid PITR: recovery = the nightly export + the restore drill (`backup.md`).
- **Cloudflare Worker cron** (`jobs-trigger/`) calls `POST /jobs/run`: one cron `5 0 * * *` (daily-only since 2.1.0, CR-005 Amendment A): `daily` at 00:05 UTC, which runs the former hourly `tick` steps (reconciler, NS verifier, screening resume) first and then the daily steps. `tick` stays callable by hand. The service runs no timers; locally `npm run job -- tick|daily` runs the same `JobRunner` (backup skipped with a warning when unconfigured; exit 1 if a step failed, 2 on bad args; audited with scope `job`, method `CLI`).
- **Outbound IPs:** Render free uses shared regional ranges; Porkbun's IP allowlist is skipped. Namecheap needs fixed IPv4s (paid), so it stays out.
- Setup steps: `docs/DEPLOYMENT.md`.

## 9. Risks and bounds
| Risk | Bound |
|---|---|
| A bot spends without real approval (prompt injection, bug) | Gavriel calls `/buy` only after Dvir's explicit chat yes, quoted verbatim. Server caps: $1,500 total, 50 domains, per-call `max_price`, approval ≤ 72 h naming the domain. Registrar limits: Porkbun's monthly API spend limit and a small prepaid credit. Every buy audited and visible in `/report`; the WRITE token revocable in seconds. **Residual:** the server can't prove the text came from Dvir |
| A false sale recorded automatically | `/sold` needs `transaction_ref` + evidence without approval; duplicates → `SALE_ALREADY_RECORDED`; unconfirmed sales listed (`SALE_UNCONFIRMED`); a sale moves no money and the registrar still holds the name. `DOMAIN_LEFT_ACCOUNT` catches a name gone without a sale |
| WRITE token leak | Rotate every 90 days; revoke on suspicion; the caps limit damage to ≤ $1,500 |
| Double purchase | Idempotency key, one open purchase per domain, per-domain advisory lock, registrar-side `Idempotency-Key`, a `findDomain` check before registering |
| Lost bookkeeping after a crash | `purchases.state = register_sent` + the reconciler, run by the daily job (`buy.md` §6) |
| Data loss | Nightly export to the private data repo + the restore drill before G4 (`backup.md`) |
| The price job cuts a price wrongly or twice | Rows computed and shown on the buy card before approval; applies only `planned` rows with exact amounts; idempotent (unique per event); re-validates V5/V6; never calls a registrar or marketplace; every change a `listing_history` row; the live price changes only when a bot uploads the export |
