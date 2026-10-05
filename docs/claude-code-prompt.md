# Paste-ready prompt for Claude Code

Paste everything between the lines into Claude Code, opened at the root of the `domain-trading` repo, after the handoff files have been committed.

---
You're building the **domain-trading API**: a backend service with Postgres and an HTTP API, no frontend. Before writing any code, read `CLAUDE.md`, then `docs/specs/00-architecture.md`, then `docs/specs/test-plan.md`. The specs in `docs/specs/` are the contract, and every test ID they list (CK-*, B-*, L-*, E-*, S-*, R-*, BK-*, AU-*, CAP-*, ID-*, DR-*, AL-*, RN-*, LS-*, LG-*, LH-*, LX-*, PR-*) has to exist as a real test with that ID in its name.

Hard rules (details are in CLAUDE.md):
- Store money as integer cents. Every POST requires an `Idempotency-Key` and writes an audit row.
- `ledger_entries` and `audit_log` are append-only, enforced by DB triggers.
- Enforce the caps on the server: $1,500 POC cap, 50 domains, `max_price`, approval validity. A global lock must prevent parallel buys from going over the cap.
- Max one renewal: compare first year + one renewal; `renewals_used` is CHECK 0..1; `drop_date = expiry + 1y`; register for 1 year only.
- Never call a registrar's top-up endpoints. Never use Cloudflare Registrar. Never register premium names.
- Registrar keys come only from env vars. Never put a real key in code, fixtures or logs. Use fake values in tests.
- Unit and API tests make **no network calls** (block sockets). Contract tests are opt-in markers.
- **Never run a live (non-sandbox) Porkbun `domain/create` call.** The first live buy is made by Gavriel through the deployed API, only after Dvir has approved it in chat (Dvir never calls the API; 5 Oct 2026, 20:07).
- Don't add a frontend, token-creation or settings endpoints (including `pricing_settings`), or any LLM calls.
- Pricing numbers (65%, 48%, $750, the $500 walk-away floor, $100 min offer, −20%, months 6/18, geo month 12, 90/7 days, $499/$399) come **only** from the versioned `pricing_settings` table, never from constants in logic. Integer cents; the PR-* vectors are the contract.

Work in phases. **At the end of each phase, stop.** Show me the test output (counts plus any failures), list the spec items you couldn't meet or found ambiguous, and wait for me to say "continue".

**Phase 1: foundation.**
- Project skeleton (Fastify, Kysely, node-pg-migrate, Vitest, docker-compose with Postgres 16).
- All tables from 00-architecture §4, with the CHECK constraints, unique partial index and append-only triggers.
- Bearer auth with READ/WRITE scopes, plus `npm run admin -- token create|revoke|list` and `npm run admin -- doctor`.
- Idempotency middleware, the audit row on every POST, the error format, rate limits and `/health`.
- Tests: AU-*, ID-1/ID-3, AL-*, RN-3.

**Phase 2: prices.**
- The registrar adapter base, a fake adapter for tests, and the Porkbun adapter (mapping in 00-architecture §5; code paths for every listed error code).
- RDAP client, selection logic and `GET /check`, with quote storage and the 60 s cache.
- Tests: CK-1 to CK-11, CK-13, RN-1, B-10 (selection part).

**Phase 3: buy.**
- `POST /buy` exactly as in `docs/specs/buy.md`: check order, `dry_run`, locks, purchase states, retries with the same registrar idempotency key, single-transaction bookkeeping, post-buy steps as warnings, and the reconciler at startup and every 10 min.
- Tests: B-1 to B-25, CAP-*, ID-2/ID-4, DR-*, RN-2, RN-6.

**Phase 4: listing strategy, list, exports, sold, reports.**
- Listing strategy exactly as `docs/specs/listing-strategy.md`:
  - `category` and geo `price_grade` on domains;
  - modes `bin` (geo) / `hybrid` (all others) / `offer` (override only);
  - validation V1–V12;
  - `approval_ref` only for buy and sell decisions: pricing exceptions, overrides, `/buy`, non-pre-approved offer counters/accepts; every other `/list`, hold, upload confirmation and `/sold` call is bot-only (Dvir, 5 Oct 2026, 20:07);
  - the append-only `listing_history`.
  - `/buy` validates `proposed_listing`, `pricing_evidence` (2–3 comps) and `expected_settings_version` **before** any registrar call.
- **Pricing (§10):**
  - the versioned, append-only `pricing_settings` table (seed **v2**: v1 is superseded) and `npm run admin -- pricing-settings new|show`;
  - the calculator (formula, rounding, minimums);
  - `GET /pricing/preview`;
  - `price_schedule` rows created on the first listing;
  - holds, `replan` and regeneration;
  - the daily price job (idempotent; no outbound calls);
  - `export_pending_since`, `?changed_only=true`, `POST /export/{venue}/uploaded`;
  - `/report` price events + `EXPORT_PENDING`;
  - `GET /report/pricing-review`.
- **Offers log (§10.11; Dvir, 5 Oct 01:03):** hybrid min offer = `hybrid_min_offer` ($100), never the walk-away (which is never exported); the `offers` + `offer_imports` tables; `POST /offers`, `POST /offers/import` (CSV, all-or-nothing, `dry_run`), `POST /offers/{id}/outcome`, `GET /offers`, `GET /report/offers`, and the per-domain and per-strategy offer aggregates in `/report`.
- `POST /list/{domain}` (including `dry_run`, the manual-NS path for `registrar_api=none`, and public-DNS NS verification), `GET /export/afternic.csv` (header byte-exact; cells per mode, §6), `GET /export/sedo.csv` (template-driven, 501 without the template), `POST /sold/{domain}`, `/report` (json + md), `/portfolio`, `/ledger` (+csv), `/deals/{id}`, `/audit`, the `npm run admin -- import-domain` command for manual buys (Porkbun, and GoDaddy via PAT or `--manual`; D-001 is at GoDaddy), and the daily job that marks domains dropped.
- Tests: LS-1 to LS-20, LG-1 to LG-21, LH-1 to LH-5, LX-1 to LX-7 (incl. LX-3b), **PR-1 to PR-44**, **OF-1 to OF-20**, B-28, L-1 to L-9, L-11 to L-15, E-1 to E-8, E-10 to E-13, S-1 to S-8, R-1 to R-12, IM-1 to IM-3, IM-5 to IM-11, RN-4/RN-5, AU-8 (secret-leak grep over all responses and logs).
- Phase 4 is now the largest phase. If it runs long, split it: **4a** = listing strategy + pricing calculator + preview + schedule + job (LS/LG/LH/PR); **4b** = `/list`, exports, `/sold`, reports, import, and the offers log (OF). Stop and report after 4a.

**Phase 5: contract tests (Gate G2).**
- Porkbun contract tests against Porkbun's mock server, plus the sandbox end-to-end B-26 (skipped when `PORKBUN_SANDBOX_*` is unset).
- Re-check every endpoint and field against https://porkbun.com/llms/domain, and report any difference from 00-architecture §5.

**Phase 6: deploy prep (Gate G3 is run by me).**
- Finalise `render.yaml` and the README deploy steps.
- Write `docs/runbook.md`: create tokens, set env secrets, the G3 live checklist (import D-001 with `npm run admin -- import-domain` using the exact command in `report.md` §Import, IM-4; CK-12; `/buy` with `dry_run:true` on a free test .com; confirm balance and invoices are unchanged), and the restore drill (BK-3/BK-5).
- Do **not** deploy yourself.

**Phase 7 (optional): backup cron, plus the thin CLI (`docs/specs/cli.md`, tests CLI-1 to CLI-4) if I ask for it.**
- `src/jobs/export-backup.ts` and `src/jobs/import-backup.ts`.
- Tests: BK-1 to BK-4.

At the end of every phase, give me:
- test counts;
- the spec IDs covered;
- open questions;
- anything I need to do by hand (keys, Porkbun "Opt In All Domains", spend limit, Sedo template).
---
