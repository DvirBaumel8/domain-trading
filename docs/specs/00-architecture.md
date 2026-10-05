# domain-trading API: architecture (v1)

**Decision (Dvir, 3 Oct 2026, 18:58 IDT):** this is a **backend service with a Postgres database and an HTTP API, with no frontend**.
- Bots (Gavriel) call it over HTTPS with bearer tokens.
- Dvir builds it himself with Claude Code in `DvirBaumel8/domain-trading`. Bots never add code to the repo.
- The service is the **only** place money actions happen (buy, renew) and the **source of truth** for the portfolio and ledger.

## 1. Goal
Answer any portfolio or money question on request. Buy a domain at the cheapest qualifying registrar, but only after Dvir's explicit approval. Point the domain at a for-sale lander, produce marketplace bulk-upload files, and record sales. All of it happens under server-enforced caps, with every write in an audit log.

## 2. Scope
**In scope (v1):** these endpoints:

| Method | Path | Scope | Spec |
|---|---|---|---|
| GET | `/health` | none | here §7 (checks the DB) |
| GET | `/health/ping` | none | here §7 (no DB; liveness) |
| POST | `/jobs/run` | job token | here §6 (`{"job":"tick"\|"daily"}`; the Cloudflare Worker cron) |
| GET | `/check?domain=` | READ | `check.md` |
| POST | `/buy` | WRITE | `buy.md` |
| POST | `/list/{domain}` | WRITE | `list.md` + `listing-strategy.md` (modes, guards, computed prices, holds) |
| GET | `/pricing/preview?category=&bin=&grade=&listed_on=&drop_date=` | READ | `listing-strategy.md` §10.6 (floor, walk-away, drop schedule from BIN + category + `pricing_settings`) |
| GET | `/export/afternic.csv`, `/export/sedo.csv` (`?changed_only=true`) | READ | `export-csv.md` |
| POST | `/export/{venue}/uploaded` | WRITE | `export-csv.md` (records the bot's upload on the marketplace site; clears the pending flags) |
| POST | `/sold/{domain}` | WRITE | `sold.md` |
| POST | `/offers`, `/offers/{id}/outcome` | WRITE | `listing-strategy.md` §10.11 (Gavriel records offers from marketplace emails/dashboards; Afternic has no API). Removed 6 Oct 2026 (Dvir): `POST /payouts/{id}/received` and `POST /offers/import`. |
| GET | `/offers`, `/report/offers` | READ | `listing-strategy.md` §10.11, `report.md` |
| GET | `/report`, `/report/pricing-review` | READ | `report.md` |
| GET | `/portfolio`, `/portfolio/{domain}`, `/ledger`, `/deals/{id}`, `/audit` | READ | `report.md` |

Backups are covered in `backup.md`.

**Out of scope (v1):**
- a frontend;
- marketplace APIs (Afternic has no public seller API; Sedo's needs account credentials);
- automatic delisting **at the marketplaces** (the scheduled `delist` event only flags the domain for Dvir's manual removal; `listing-strategy.md` §10.4);
- email or chat sending (Gavriel talks to Dvir; the service never contacts anyone);
- auctions and backorders;
- multi-year registrations;
- non-USD prices;
- TLDs other than .com (the code is TLD-generic, but v1 is tested on .com only).

**Selection backend (selection v9.1, Dvir approved 6 Oct 2026; built after step 6; `selection.md` §4 and §8):** `POST /check/batch` (RDAP), `POST /check/history` (CDX, SURBL, Web Risk; blocking), `POST /check/tm`, `GET /check/quote`, `GET /tokenize`, `GET /census/siblings` + `POST /census/run` (frozen lists only), `GET /comps/keyword` (nightly NameBio CSV cache), `GET /exttaken`, `POST /leads/build` + `/leads/verify`, `POST /score`, `POST /screening_pack` (required by `/buy`, `buy.md` 3c), `POST /distribution/confirm` (FT-1), `GET /renewal/decision/{domain}` (live ARA), `GET /patterns/{id}/health`, `POST /labels`, `GET /signals/keywords`, `GET /market/geo`, `GET /regimes`, `GET /s7/candidates`. Its tables (screening packs, census runs, NameBio cache, leads, labels, distribution checks) are designed in that build; they are not in §4 yet. *(Replaces the 5 Oct phase-later `GET /check/batch`; the S7 auction `max_bid` is retired: v9.1 S7-ONLY, no auctions.)*

**Proposed v1.1 (not built until Dvir says so):**
- `POST /renew/{domain}`: the one allowed renewal, with `renewals_used` enforcement;
- LTO installment logging;
- a thin CLI wrapper (`dt`) over the API.

## 3. Components
```
Gavriel (box) --HTTPS + Bearer--> [Render web service: API]
                                        |-- Postgres (Render) : all state
                                        |-- Registrar adapters --> Porkbun / Dynadot / Name.com ... APIs
                                        |-- RDAP (rdap.verisign.com) : independent availability check
                                        `-- (optional cron) nightly export --> GitHub repo (data backup)
```
- **Language and stack:** language-agnostic spec. Chosen stack (4 Oct 2026): TypeScript on Node 22, Fastify, zod, Kysely + pg, node-pg-migrate, native fetch, Vitest + MSW.
- **Registrar adapters:** each implements one interface (§5). v1 ships **Porkbun fully** (documented, verified 3 Oct 2026). Others are enabled only when their keys are set **and** their contract tests pass (`docs/research/registrars.md`).
- **Secrets:** registrar keys, the DB URL and the GitHub backup token live **only** in server environment variables (Render secret env, `sync: false`). They are never returned by any endpoint, never logged, and never in the repo.

## 4. Data model (Postgres)
All money is stored as **integer cents (USD)**. All timestamps are `timestamptz` (UTC in the DB); API responses carry ISO 8601 with offset. Reports show IDT.

| Table | Key columns | Rules |
|---|---|---|
| `domains` (portfolio) | `id`, `domain` (unique, lowercase), `deal_id` (nullable, `D-NNN`), `registrar`, `status` (`pending_purchase`, `owned`, `listed`, `delisted`, `sold`, `dropped`), `buy_date`, `cost_cents`, `expiry_date` (= next renewal date), `renewal_price_cents`, **`renewals_used` (0 or 1; CHECK 0..1)**, **`drop_date`**, **`category`** (`geo`, `trend`, `b2b`, `collision`, `regulation`, `buzzword`, `other`; NOT NULL once owned), **`listing_mode`** (`bin`, `offer`, `hybrid`, or NULL = not listed), `bin_cents`, `floor_cents`, `min_offer_cents` (CHECK ≥ 2000 when set), **`walkaway_cents`** (private walk-away, computed by `listing-strategy.md` §10.3; geo/plain bin: = BIN; offer: NULL; CHECK `walkaway ≤ floor ≤ bin`), **`price_grade`** (`strong`/`weaker`, geo only), **`pricing_source`** (`formula`/`approved_exception`), **`pricing_settings_version`**, **`first_listed_at`** (schedule anchor), **`pricing_hold`** + `pricing_hold_reason`, `plan_id`, `plan_audit_id`, **`export_pending_since`**, `lto_max_months`, `display_name` (CamelCase), `lander`, `lander_ns` (text[]), `lander_set_at`, `ns_verified_at`, **`registrar_api`** (`full`, `manage`, `none`), `sold_at`, timestamps | **Max-one-renewal rule:** at purchase, `renewals_used = 0` and `drop_date = expiry_date + 1 year`. `drop_date` is never pushed later. **DB CHECK** (relaxed 5 Oct 2026): `renewals_used = 1` OR `drop_date` IS NULL OR `drop_date = expiry_date + 1 year` OR **`drop_date = expiry_date`** (Gate F "drop at first expiry", set only by `npm run admin -- drop-at-first-expiry`, `cli.md`) |
| `ledger_entries` | `id`, `occurred_on`, `domain_id`, `deal_id`, `type` (`registration`, `renewal`, `fee`, `commission`, `sale`, `payout_fee`, `refund`, `tool`, `ai`, `adjustment`), `amount_cents` (signed: negative = money out), `currency`, `counterparty`, `receipt_ref`, `note`, `audit_id` | **Append-only:** a DB trigger rejects UPDATE and DELETE. Corrections are reversing rows |
| `sales` | `id`, `domain_id`, `sale_ledger_id` (UNIQUE, FK `ledger_entries`: the `sale` row), `venue`, `transaction_ref` (no `@`), `sale_price_cents`, `commission_cents`, `other_fees_cents`, `sold_at`, `offer_id` (nullable FK), **`recorded_by`** (token name), **`confirmed`** (bool: `approval_ref` given), `approval_text`, `approval_at`, **`evidence_source`** (`afternic_email`, `sedo_email`, `afternic_dashboard`, `sedo_dashboard`, `escrow`, `other`), **`evidence_ref`** (Message-ID or dashboard ref), `audit_id`, `created_at` | Written by `POST /sold` (`sold.md`; system-triggered, Dvir 5 Oct 2026 19:47). **UNIQUE (`venue`, `transaction_ref`)** → 409 `SALE_ALREADY_RECORDED`. CHECK: `confirmed` or (`transaction_ref` and `evidence_source` and `evidence_ref` not null). Facts immutable (trigger, like `payouts`); no DELETE or TRUNCATE. The money stays in `ledger_entries` |
| *(removed)* | | Removed 6 Oct 2026 (Dvir): the `payouts` and `offer_imports` tables, and `offers.import_id` (migration `1760800000000_drop-payouts-offer-imports`) |
| `registrar_presence` | `domain_id` (PK, FK `domains`), `status` (`present`, `absent`), `first_absent_at` (set iff absent; kept while absent), `last_checked_at` | Upserted by the daily registrar check (`report.md` §Daily registrar check; after the price and drop jobs; `npm run job -- registrar-check`). Feeds `DOMAIN_LEFT_ACCOUNT` |
| `listing_history` | `id`, `domain_id`, `at`, `source` (`buy`, `import`, `list`, **`schedule`**), `category`, `price_grade`, `mode`, `bin_cents`, `floor_cents`, `walkaway_cents`, `min_offer_cents`, `lto_max_months`, `lander`, `pricing_source`, `pricing_settings_version`, `schedule_event_id`, `plan_audit_id`, `override`, `override_reason`, `approval_text`, `approval_at`, `audit_id` | **Append-only** (trigger). One row per accepted listing, mode, price, category, hold or **scheduled** change (`listing-strategy.md` §5, §10.5) |
| `pricing_settings` | `version` (PK), `effective_at`, geo grade prices + range, `geo_drops_enabled`, `geo_drops` (jsonb), `floor_bps`, `floor_min_cents`, `walkaway_bps`, `walkaway_min_cents`, `hybrid_min_offer_cents` (10000), `drops` (jsonb), `final_push_days_before_drop`, `final_push_mode`, `delist_days_before_drop`, `headsup_days_before`, `comps_min`, `comps_max`, `public_lto`, **v3 (6 Oct 2026, `listing-strategy.md` §10.13):** `allowed_bins_cents` (int[]), `nongeo_bin_min_cents`, `nongeo_default_bin_cents`, `lander_exception_bins_cents` (int[]), `floor_rounding` (`round5`\|`dollar`), `drop_mode` (`pct`\|`ladder`; `drops`/`geo_drops` may carry `steps`), `approval_text`, `approval_at`, `note` | **Versioned, append-only** (trigger). v1 = Dvir's adopted rules (5 Oct 2026, 00:46 IDT). Written only by `npm run admin -- pricing-settings new` (`listing-strategy.md` §10.1) |
| `price_schedule` | `id`, `domain_id`, `plan_id`, `event` (`drop1_m6`, `drop2_m18`, `geo_drop_m12`, `final_push`, `delist`), `due_on`, `bin_cents`, `floor_cents`, `walkaway_cents`, `settings_version`, `status`, `applied_at`, `listing_history_id`, `note` | Rows created with exact amounts when a plan is created; applied by the daily job (`listing-strategy.md` §10.5). Unique `(domain_id, event, plan_id)` |
| `pricing_evidence` | `id`, `domain_id`, `comps` (jsonb: 0–3 × {domain, price_usd, sold_on, venue, source_url}; optional since 6 Oct 2026, was 2–3), `rationale`, `legacy_no_comps_reason`, `audit_id` | One row per buy/import (V11) |
| `export_uploads` | `id`, `venue`, `export_id`, `domains` (text[]), `uploaded_at`, `approval_text` (**nullable** since 5 Oct 2026, 20:07; non-empty if set), `note` (nullable, no `@`), `audit_id` | Written by `POST /export/{venue}/uploaded` |
| `offers` | `id`, `domain_id`, `amount_cents`, `source`, `received_at`, `buyer_type`, `buyer_ref`, `external_ref`, `bin_cents_at`, `floor_cents_at`, `walkaway_cents_at`, `min_offer_cents_at`, `listing_history_id`, `band`, `routing`, `outcome`, `outcome_at`, `outcome_note`, `outcome_approval_text`, `recorded_by`, `import_id`, `audit_id`, `created_at` | Facts immutable (trigger); only outcome fields change, via the API. UNIQUE (`source`, `external_ref`). No buyer emails or names (`NO_PII`). `listing-strategy.md` §10.11 |
| `quotes` | `id`, `check_id`, `domain`, `registrar`, `quoted_at`, `available`, `premium`, `first_year_cents`, `renewal_cents`, `privacy_cents_per_year`, `two_year_cents`, `eligible`, `exclusion_reason`, `raw` (jsonb, secrets stripped) | Every `/check` and `/buy` stores its full comparison |
| `purchases` | `id`, `idempotency_key` (unique), `request_hash`, `domain`, `state` (`created`, `register_sent`, `succeeded`, `failed`, `unknown`), `dry_run`, `registrar`, `check_id`, `charged_cents`, `expected_cents` (counts toward the cap while open), `order_id`, `max_price_cents`, `approval_text`, `approval_at`, `request` (jsonb, redacted), `response` (jsonb), `audit_id`, timestamps | One row per `/buy` call. A unique partial index allows one `created`/`register_sent`/`succeeded`/`unknown` row per domain (`unknown` added by Dvir, 4 Oct 2026: an unknown purchase may have charged) |
| `receipts` | `id`, `purchase_id`, `registrar`, `order_id`, `raw` (jsonb, billing address redacted), `fetched_at` | The `ledger_entries.receipt_ref` of a registration = `<registrar>:<order_id>` |
| `deals` | `id` (`D-NNN`), `domain`, `strategy`, `status_note`, `created_at` | Created or updated when `/buy` passes `deal_id` |
| `audit_log` | `id`, `at`, `token_id`, `scope`, `method`, `path`, `idempotency_key`, `approval_text`, `approval_at`, `request` (jsonb, redacted), `status_code`, `result_summary`, `client_ip` | **Every** POST, including dry runs and refusals. Append-only (trigger) |
| `api_tokens` | `id`, `name`, `scope` (`read`, `write`), `token_sha256`, `created_at`, `revoked_at`, `last_used_at` | Plain tokens are shown once, when created by the admin command |
| `settings` | `poc_cap_cents` (default 150000; raised from 50000 on 5 Oct 2026), `max_domains` (50; raised from 10), `approval_max_age_hours` (72), `lander_target` (`afternic`), `allowed_registrars`, `high_value_min_bin_cents` (250000), `sedo_hybrid_as` (`buy_now`). *(5 Oct 2026: `geo_bin_min/max` moved to `pricing_settings`; `high_value_categories` and `high_value_guard_modes` retired, since every non-geo category is hybrid)* | Changed only by Dvir's admin command or a migration, never via the API |

## 5. Registrar adapter interface
```
quote(domain)                     -> Quote{available, premium, first_year_cents, renewal_cents,
                                           privacy_cents_per_year, currency, raw}
account_state()                   -> {balance_cents|None, spend_limit_remaining_cents|None,
                                      auto_topup_enabled|None}
register(domain, cost_cents, idem_key, dry_run)   # privacy always on; 1-year only; no auto-renew field (set after)
                                  -> {order_id, charged_cents, balance_cents, raw} | DryRun{would_succeed,...}
                                  # expiry_date is read afterwards with find_domain (Porkbun's create returns none)
find_domain(domain)               -> {expiry_date, whois_privacy, auto_renew, api_access, ns|None} | None
                                  # None = definitely not in our account (only a definite DOMAIN_NOT_FOUND); any other error throws
set_nameservers(domain, ns[])     ; get_nameservers(domain) -> set
set_auto_renew(domain, on)        ; get_receipt(order_id) -> raw (billing identity redacted)
find_registration(domain, since)  -> {order_id, charged_cents, expiry_date|None, invoice_date, raw} | None   # from the registrar's invoices
capabilities                      -> {can_register, can_quote, can_manage_ns, custom_ns, prepaid, free_privacy,
                                      afternic_fast_transfer, sandbox}
# registrar_api on a domain: full = Porkbun-style (quote+register+manage); manage = GoDaddy PAT
# (NS/details only, no register/quote for accounts <50 domains); none = manual (NS verified via public DNS)
```
Porkbun mapping, all verified in the official docs (snapshot in `system/specs/evidence/porkbun-docs-2026-10-03/` on Gavriel's box; live at https://porkbun.com/llms/domain):

| Method | Porkbun endpoint |
|---|---|
| `quote` | `POST /domain/checkDomain/{d}` (`avail`, `price`, `regularPrice`, `premium`, `additional.renewal.price`) |
| `account_state` | `GET /account/balance` + `GET /account/apiSettings` (its `settings.autoTopup` gives `auto_topup_enabled`; Dvir, 5 Oct 2026: the code never calls any top-up path, B-25) |
| `register` | `POST /domain/create/{d}` with `cost` (integer cents, must equal the quote), `agreeToTerms:"yes"`, `whoisPrivacy:true`, optional `dryRun:true`, and the `Idempotency-Key` header |
| `find_domain` | `GET /domain/get/{d}` |
| `set_nameservers` / `get_nameservers` | `POST /domain/updateNs/{d}` / `getNs` (compare as a **set**) |
| `set_auto_renew` | `POST /domain/updateAutoRenew/{d}` |
| `get_receipt` | `GET /account/invoice/{orderId}` (redacted) |
| `find_registration` | `GET /account/invoices?year=` + `/account/invoice/{orderId}` (the domain's SUCCESS registration line: `price_cents − discount_cents`, `expires`) |

Base URL: `https://api.porkbun.com/api/json/v3`; auth headers `X-API-Key` / `X-Secret-API-Key`. Branch on the error `code`, never on `message`. A coded error on HTTP < 500 is a **definite** failure, except `IDEMPOTENCY_KEY_IN_USE`. Timeouts, network errors, any 5xx (coded or not), `IDEMPOTENCY_KEY_IN_USE` and unparseable responses are **ambiguous** (the registrar may have acted; never retry a purchase with a new key).

Porkbun conditions the code must handle:
- `VERIFICATION_REQUIRED`;
- `INSUFFICIENT_FUNDS`;
- `MONTHLY_SPEND_LIMIT_EXCEEDED`;
- `ORDER_TOO_LARGE` (over $100);
- `COST_MISMATCH`;
- `DOMAIN_NOT_AVAILABLE`;
- premium names are not registrable via the API;
- `API_ACCESS_DISABLED` (the domain isn't opted in);
- `RATE_LIMIT_EXCEEDED` with `Retry-After`;
- `IDEMPOTENCY_KEY_MISMATCH` / `IDEMPOTENCY_KEY_IN_USE`.

## 6. Auth, scopes, audit
- `Authorization: Bearer <token>`. Tokens are random, at least 32 bytes, and stored as SHA-256.
- **READ** tokens may call GET only. **WRITE** tokens may call everything.
- Wrong or absent token: **401**. A READ token on a POST: **403** `SCOPE_FORBIDDEN`. A revoked token: 401.
- Tokens are created and revoked by Dvir's admin command (`npm run admin -- token create --scope read --name gavriel-read`), run locally against the Neon DB (`.env.neon`; `docs/DEPLOYMENT.md`). **No API endpoint creates tokens.** The same admin tool imports domains bought by hand (`import-domain`, see `report.md` §Import; D-001 was bought this way).
- **Job trigger (step 6 free hosting, Dvir, 5 Oct 2026):** `POST /jobs/run {"job":"tick"|"daily"}` accepts **only** the dedicated `JOB_TRIGGER_TOKEN` bearer (≥ 32 chars, an env secret held by the Cloudflare Worker). READ and WRITE tokens are refused there (401), and the job token works nowhere else. Not configured → 503 `JOBS_DISABLED`. Idempotent (the Worker sends `Idempotency-Key: <job>-<scheduled time>`; an overlapping run of the same job reports `skipped`) and audited with scope `job`.
  - **`tick`** (hourly): the reconciler (`buy.md` §6), then the NS verifier if it last ran ≥ 24 h ago.
  - **`daily`** (00:05 UTC): price job → drop job → registrar check → backup export (`backup.md`). Each step is isolated; the response lists every step's result.
- **Every POST** (success, refusal, dry run, error) writes one `audit_log` row: token id and scope, approval text and timestamp, idempotency key, and the redacted request and result.
- `Idempotency-Key` header is **required on every POST** (400 if missing).
  - Same key and same body: the stored response is replayed (header `Idempotent-Replayed: true`).
  - Same key, different body: **409** `IDEMPOTENCY_KEY_MISMATCH`.
- `approval_ref` = `{ "text": "<Dvir's verbatim chat words>", "approved_at": "<ISO 8601>" }`. It is required **only for buy and sell decisions** (Dvir, 5 Oct 2026, 20:07): (1) **buy**: `POST /buy` and the future one-renewal; (2) **sell decisions**: `POST /offers/{id}/outcome` `countered`/`accepted` on an offer that isn't pre-approved (routing not `auto_accept`/`accept_preapproved`), a pricing exception (V5) and an override (V8: geo off the grade price or range, a non-geo plain `bin`/`offer`, LTO, relabelling to `geo`). Sent anywhere else, it is validated and stored.
- **Bot permissions (Dvir, 5 Oct 2026, 20:07; extends 19:47):** **approval only for buy and sell decisions (the list above).** Dvir talks only to Gavriel; Gavriel calls every endpoint (Dvir never calls the API). Everything else is bot-only, with no `approval_ref`: `/list` price, mode, category and grade changes within the rules; holds/unholds (reason required) and `replan`; lander/NS; `POST /offers` (including a hold); `POST /export/{venue}/uploaded`; `POST /sold` (system-triggered, with evidence). The calling token is recorded in `audit_log`, and every rule and cap still applies. For the approval-gated calls the server records Dvir's words but can't verify a human said them. That is a trust boundary; see §9 risks.
- Rate limit per token: 60 requests/min (GET), 10/min (POST). Over the limit: **429**.

## 7. Errors and conventions
- JSON errors: `{ "error": { "code": "POC_CAP_EXCEEDED", "message": "...", "details": {...} } }`. Codes are stable; messages are not.
- Cross-cutting codes (added by Dvir, 4 Oct 2026, step 1): `UNAUTHORIZED` 401; `SCOPE_FORBIDDEN` 403; `IDEMPOTENCY_KEY_REQUIRED` 400; `IDEMPOTENCY_KEY_MISMATCH` / `IDEMPOTENCY_KEY_IN_USE` 409; `RATE_LIMITED` 429 (with `Retry-After`); `VALIDATION_ERROR` 422 (body) or 400 (query/params schema); `DOMAIN_INVALID` 422 (not a valid second-level name, e.g. `www.example.com`; step 2); `INVALID_BODY` 400/413/415 (unparseable, too large, wrong media type); `INVALID_REQUEST` 4xx (malformed URL and other framework rejections); `NOT_FOUND` 404; `INTERNAL` 500; `AUDIT_WRITE_FAILED` 500 (processed but not audited: retry with the same `Idempotency-Key` to get the stored result).
- `GET /health` (no auth) returns `{status, db: ok|down, version, adapters: [{name, enabled}]}` (503 `degraded` when the DB is down). It never reveals secrets or key prefixes.
- `GET /health/ping` (no auth, **no DB access**) returns `{status: "ok"}`: a cheap liveness probe.
- Responses show money both in cents and as a display string (`"$11.08"`).
- Times: stored in UTC; `/report` also renders IDT (`Asia/Jerusalem`).
- No LLM calls anywhere in the service. **0 tokens at runtime.**

## 8. Hosting (free; step 6 free hosting, Dvir, 5 Oct 2026)
- **Render free web service** (Docker or native Node; it sleeps when idle). `render.yaml` in the repo root (Blueprint: https://render.com/docs/blueprint-spec.md); setup steps in `docs/DEPLOYMENT.md`.
- **Neon free Postgres**, over the **direct** (non-pooler) connection with **TLS `sslmode=verify-full`** (`DATABASE_SSL=true`). In production the server refuses a `-pooler` host, because the per-domain lock is a session advisory lock.
- **No paid PITR.** Recovery = the nightly export to the private data repo + the restore drill (`backup.md`; BK-5 before G4).
- **Cloudflare Worker cron** (`jobs-trigger/`) wakes the service and calls `POST /jobs/run` (§6): hourly `tick` (`0 * * * *`) and `daily` at **00:05 UTC** (`5 0 * * *`). Production runs with **`JOBS_MODE=external`** (no in-process timers). In-process timers (`JOBS_MODE=internal`: reconciler every 10 min, NS verifier every 24 h, daily at 00:30 UTC) are for **local dev only**.
- Monthly cost: **$0**.
- **Outbound IPs:** Render egress uses shared regional CIDR ranges (no Dedicated IP set on free). Porkbun's key IP allowlist accepts CIDR, so shared ranges work. Namecheap needs specific whitelisted IPv4s (a paid Dedicated IP set), so it stays out.

## 9. Risks and how v1 bounds them

| Risk | Bound |
|---|---|
| A bot spends without real approval (prompt injection, a bug) | Gavriel's rules (call `/buy` only after Dvir's explicit chat yes; quote it verbatim). Server caps: **$1,500 POC total, 50 domains, per-call `max_price`, approval ≤ 72 h old, approval text must contain the domain**. Registrar-side limits: Porkbun's monthly API spend limit and a small prepaid credit, set by Dvir. Full audit log. **Residual:** the server can't prove the approval text came from Dvir. Mitigations: an audit row for every buy, Dvir sees every buy in `/report`, and the WRITE token can be revoked in seconds |
| A false sale recorded automatically (spoofed notification, prompt injection) | `/sold` needs `transaction_ref` + evidence without approval; duplicates → `SALE_ALREADY_RECORDED`; unconfirmed sales are listed in `/report` (`SALE_UNCONFIRMED`); a recorded sale moves no money and the registrar still holds the name. The daily registrar check (`DOMAIN_LEFT_ACCOUNT`) catches the reverse: a name gone without a recorded sale |
| WRITE token leak | Rotate every 90 days. Revoke immediately on suspicion. The caps above limit the damage to ≤ $1,500 total |
| Double purchase | Idempotency key, a unique purchase per domain, a per-domain advisory lock, a registrar-side `Idempotency-Key`, and a `find_domain` check before registering |
| Lost bookkeeping after a crash | `purchases.state = register_sent` + the reconciler (`buy.md` §6) |
| Data loss | No PITR on the free tier: the nightly export to the private data repo + the restore drill before G4 (`backup.md`) |
| The scheduled price job cuts a price wrongly or twice | Rows are computed and shown on the buy card before Dvir approves; the job only applies `planned` rows with exact amounts, is idempotent (unique row per event), re-validates V5/V6 before applying, never calls a registrar or marketplace, and every change is a `listing_history` row. The live price only changes when Dvir uploads the export (`listing-strategy.md` §10) |
