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
| GET | `/health` | none | here §7 |
| GET | `/check?domain=` | READ | `check.md` |
| POST | `/buy` | WRITE | `buy.md` |
| POST | `/list/{domain}` | WRITE | `list.md` + `listing-strategy.md` (modes bin/offer/hybrid, guards) |
| GET | `/export/afternic.csv`, `/export/sedo.csv` | READ | `export-csv.md` |
| POST | `/sold/{domain}` | WRITE | `sold.md` |
| GET | `/report` | READ | `report.md` |
| GET | `/portfolio`, `/portfolio/{domain}`, `/ledger`, `/deals/{id}`, `/audit` | READ | `report.md` |

Backups are covered in `backup.md`.

**Out of scope (v1):**
- a frontend;
- marketplace APIs (Afternic has no public seller API; Sedo's needs account credentials);
- automatic delisting;
- email or chat sending (Gavriel talks to Dvir; the service never contacts anyone);
- auctions and backorders;
- multi-year registrations;
- non-USD prices;
- TLDs other than .com (the code is TLD-generic, but v1 is tested on .com only).

**Proposed v1.1 (not built until Dvir says so):**
- `POST /renew/{domain}`: the one allowed renewal, with `renewals_used` enforcement;
- a payout update on a sold domain;
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
| `domains` (portfolio) | `id`, `domain` (unique, lowercase), `deal_id` (nullable, `D-NNN`), `registrar`, `status` (`pending_purchase`, `owned`, `listed`, `sold`, `dropped`), `buy_date`, `cost_cents`, `expiry_date` (= next renewal date), `renewal_price_cents`, **`renewals_used` (0 or 1; CHECK 0..1)**, **`drop_date`**, **`category`** (`geo`, `trend`, `b2b`, `collision`, `regulation`, `buzzword`, `other`; NOT NULL once owned), **`listing_mode`** (`bin`, `offer`, `hybrid`, or NULL = not listed), `bin_cents`, `floor_cents`, `min_offer_cents` (CHECK ≥ 2000 when set), `lto_max_months`, `display_name` (CamelCase), `lander`, `lander_ns` (text[]), `lander_set_at`, `ns_verified_at`, **`registrar_api`** (`full`, `manage`, `none`), `sold_at`, timestamps | **Max-one-renewal rule:** at purchase, `renewals_used = 0` and `drop_date = expiry_date + 1 year`. `drop_date` is never pushed later |
| `ledger_entries` | `id`, `occurred_on`, `domain_id`, `deal_id`, `type` (`registration`, `renewal`, `fee`, `commission`, `sale`, `payout_fee`, `refund`, `tool`, `ai`, `adjustment`), `amount_cents` (signed: negative = money out), `currency`, `counterparty`, `receipt_ref`, `note`, `audit_id` | **Append-only:** a DB trigger rejects UPDATE and DELETE. Corrections are reversing rows |
| `listing_history` | `id`, `domain_id`, `at`, `source` (`buy`, `import`, `list`), `category`, `mode`, `bin_cents`, `floor_cents`, `min_offer_cents`, `lto_max_months`, `lander`, `override`, `override_reason`, `approval_text`, `approval_at`, `audit_id` | **Append-only** (trigger). One row per accepted listing, mode, price or category change (`listing-strategy.md` §5) |
| `quotes` | `id`, `check_id`, `domain`, `registrar`, `quoted_at`, `available`, `premium`, `first_year_cents`, `renewal_cents`, `privacy_cents_per_year`, `two_year_cents`, `eligible`, `exclusion_reason`, `raw` (jsonb, secrets stripped) | Every `/check` and `/buy` stores its full comparison |
| `purchases` | `id`, `idempotency_key` (unique), `request_hash`, `domain`, `state` (`created`, `register_sent`, `succeeded`, `failed`, `unknown`), `dry_run`, `registrar`, `check_id`, `charged_cents`, `order_id`, `max_price_cents`, `approval_text`, `approval_at`, `response` (jsonb), timestamps | One row per `/buy` call. A unique partial index allows one `created`/`register_sent`/`succeeded`/`unknown` row per domain (`unknown` added by Dvir, 4 Oct 2026: an unknown purchase may have charged) |
| `receipts` | `id`, `purchase_id`, `registrar`, `order_id`, `raw` (jsonb, billing address redacted), `fetched_at` | The `ledger_entries.receipt_ref` of a registration = `<registrar>:<order_id>` |
| `deals` | `id` (`D-NNN`), `domain`, `strategy`, `status_note`, `created_at` | Created or updated when `/buy` passes `deal_id` |
| `audit_log` | `id`, `at`, `token_id`, `scope`, `method`, `path`, `idempotency_key`, `approval_text`, `approval_at`, `request` (jsonb, redacted), `status_code`, `result_summary`, `client_ip` | **Every** POST, including dry runs and refusals. Append-only (trigger) |
| `api_tokens` | `id`, `name`, `scope` (`read`, `write`), `token_sha256`, `created_at`, `revoked_at`, `last_used_at` | Plain tokens are shown once, when created by the admin command |
| `settings` | `poc_cap_cents` (default 50000), `max_domains` (10), `approval_max_age_hours` (72), `lander_target` (`afternic`), `allowed_registrars`, `geo_bin_min_cents` (29900), `geo_bin_max_cents` (49900), `high_value_categories`, `high_value_min_bin_cents` (250000), `high_value_guard_modes` (`["bin"]`), `sedo_hybrid_as` (`buy_now`) | Changed only by Dvir's admin command or a migration, never via the API |

## 5. Registrar adapter interface
```
quote(domain)                     -> Quote{available, premium, first_year_cents, renewal_cents,
                                           privacy_cents_per_year, currency, raw}
account_state()                   -> {balance_cents|None, spend_limit_remaining_cents|None,
                                      auto_topup_enabled|None}
register(domain, quote, idem_key, dry_run, privacy=True, auto_renew=False)
                                  -> {order_id, charged_cents, expiry_date, raw} | DryRun{would_succeed,...}
find_domain(domain)               -> {in_account, expiry_date, whois_privacy, auto_renew, api_access, ns} | None
set_nameservers(domain, ns[])     ; get_nameservers(domain) -> set
set_auto_renew(domain, on)        ; get_receipt(order_id) -> raw
capabilities                      -> {can_register, can_quote, can_manage_ns, custom_ns, prepaid, free_privacy,
                                      afternic_fast_transfer, sandbox}
# registrar_api on a domain: full = Porkbun-style (quote+register+manage); manage = GoDaddy PAT
# (NS/details only, no register/quote for accounts <50 domains); none = manual (NS verified via public DNS)
```
Porkbun mapping, all verified in the official docs (snapshot in `system/specs/evidence/porkbun-docs-2026-10-03/` on Gavriel's box; live at https://porkbun.com/llms/domain):

| Method | Porkbun endpoint |
|---|---|
| `quote` | `POST /domain/checkDomain/{d}` (`avail`, `price`, `regularPrice`, `premium`, `additional.renewal.price`) |
| `account_state` | `GET /account/balance` + `GET /account/apiSettings` + `GET /account/autoTopup` |
| `register` | `POST /domain/create/{d}` with `cost` (integer cents, must equal the quote), `agreeToTerms:"yes"`, `whoisPrivacy:true`, optional `dryRun:true`, and the `Idempotency-Key` header |
| `find_domain` | `GET /domain/get/{d}` |
| `set_nameservers` / `get_nameservers` | `POST /domain/updateNs/{d}` / `getNs` (compare as a **set**) |
| `set_auto_renew` | `POST /domain/updateAutoRenew/{d}` |
| `get_receipt` | `GET /account/invoices` + `/account/invoice/{orderId}` |

Base URL: `https://api.porkbun.com/api/json/v3`; auth headers `X-API-Key` / `X-Secret-API-Key`. Branch on the error `code`, never on `message`.

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
- Tokens are created and revoked by Dvir's admin command (`npm run admin -- token create --scope read --name gavriel-read`), run in the Render shell or locally against the DB. **No API endpoint creates tokens.** The same admin tool imports domains bought by hand (`import-domain`, see `report.md` §Import; D-001 was bought this way).
- **Every POST** (success, refusal, dry run, error) writes one `audit_log` row: token id and scope, approval text and timestamp, idempotency key, and the redacted request and result.
- `Idempotency-Key` header is **required on every POST** (400 if missing).
  - Same key and same body: the stored response is replayed (header `Idempotent-Replayed: true`).
  - Same key, different body: **409** `IDEMPOTENCY_KEY_MISMATCH`.
- `approval_ref` = `{ "text": "<Dvir's verbatim chat words>", "approved_at": "<ISO 8601>" }`. It is **required on `/buy`** and **required on `/sold`** (Dvir's word that it sold); on `/list` it is optional. Gavriel may only call a WRITE endpoint after Dvir's explicit approval in chat; the server records it but can't verify a human said it. That is a trust boundary; see §9 risks.
- Rate limit per token: 60 requests/min (GET), 10/min (POST). Over the limit: **429**.

## 7. Errors and conventions
- JSON errors: `{ "error": { "code": "POC_CAP_EXCEEDED", "message": "...", "details": {...} } }`. Codes are stable; messages are not.
- `GET /health` (no auth) returns `{status, db: ok|down, version, adapters: [{name, enabled}]}`. It never reveals secrets or key prefixes.
- Responses show money both in cents and as a display string (`"$11.08"`).
- Times: stored in UTC; `/report` also renders IDT (`Asia/Jerusalem`).
- No LLM calls anywhere in the service. **0 tokens at runtime.**

## 8. Hosting (Render)
- **Web service** (Docker or native Node), plus **Render Postgres on a paid instance type**:
  - Free Postgres expires after 30 days and has **no** backups or PITR.
  - Paid instances get PITR: **3 days on Hobby, 7 days on Pro+**.
  - Logical backups are kept 7 days. Source: https://render.com/docs/postgresql-backups.md
- Optional **cron job** for the nightly export to GitHub (`backup.md`).
- Sketch: `render.yaml` in the repo root (Blueprint spec: https://render.com/docs/blueprint-spec.md).
- **Monthly cost is UNKNOWN to me:** check https://render.com/pricing. It conflicts with the current $0 tools cap in `cfo-ledger.md`, so **Dvir must approve the hosting spend.**
- **Outbound IPs:** Render egress uses shared regional CIDR ranges, unless you buy a **Dedicated IP set** (3 static IPv4s) (https://render.com/docs/dedicated-ips).
  - Porkbun's key IP allowlist accepts CIDR, so shared ranges work.
  - Namecheap needs specific whitelisted IPv4s, which means a Dedicated IP set.

## 9. Risks and how v1 bounds them

| Risk | Bound |
|---|---|
| A bot spends without real approval (prompt injection, a bug) | Gavriel's rules (call `/buy` only after Dvir's explicit chat yes; quote it verbatim). Server caps: **$500 POC total, 10 domains, per-call `max_price`, approval ≤ 72 h old, approval text must contain the domain**. Registrar-side limits: Porkbun's monthly API spend limit and a small prepaid credit, set by Dvir. Full audit log. **Residual:** the server can't prove the approval text came from Dvir. Mitigations: an audit row for every buy, Dvir sees every buy in `/report`, and the WRITE token can be revoked in seconds |
| WRITE token leak | Rotate every 90 days. Revoke immediately on suspicion. The caps above limit the damage to ≤ $500 total |
| Double purchase | Idempotency key, a unique purchase per domain, a per-domain advisory lock, a registrar-side `Idempotency-Key`, and a `find_domain` check before registering |
| Lost bookkeeping after a crash | `purchases.state = register_sent` + the reconciler (`buy.md` §6) |
| Data loss | Render PITR + the nightly export to git (`backup.md`) |
