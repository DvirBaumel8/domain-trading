# Paste-ready prompt for Claude Code

Paste everything between the lines into Claude Code, opened at the root of the `domain-trading` repo, after the handoff files have been committed.

---
You're building the **domain-trading API**: a backend service with Postgres and an HTTP API, no frontend. Before writing any code, read `CLAUDE.md`, then `docs/specs/00-architecture.md`, then `docs/specs/test-plan.md`. The specs in `docs/specs/` are the contract, and every test ID they list (CK-*, B-*, L-*, E-*, S-*, R-*, BK-*, AU-*, CAP-*, ID-*, DR-*, AL-*, RN-*) has to exist as a real test with that ID in its name.

Hard rules (details are in CLAUDE.md):
- Store money as integer cents. Every POST requires an `Idempotency-Key` and writes an audit row.
- `ledger_entries` and `audit_log` are append-only, enforced by DB triggers.
- Enforce the caps on the server: $500 POC cap, 10 domains, `max_price`, approval validity. A global lock must prevent parallel buys from going over the cap.
- Max one renewal: compare first year + one renewal; `renewals_used` is CHECK 0..1; `drop_date = expiry + 1y`; register for 1 year only.
- Never call a registrar's top-up endpoints. Never use Cloudflare Registrar. Never register premium names.
- Registrar keys come only from env vars. Never put a real key in code, fixtures or logs. Use fake values in tests.
- Unit and API tests make **no network calls** (block sockets). Contract tests are opt-in markers.
- **Never run a live (non-sandbox) Porkbun `domain/create` call.** Only Dvir runs the first live buy, through the deployed API, after he has approved it in chat.
- Don't add a frontend, token-creation or settings endpoints, or any LLM calls.

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
- Listing strategy exactly as `docs/specs/listing-strategy.md`: `category` on domains, modes `bin`/`offer`/`hybrid`, validation V1–V10 with the geo [$299, $499] and high-value ($2,500) guards from `settings`, overrides only with `approval_ref`, and the append-only `listing_history`. `/buy` validates `proposed_listing` **before** any registrar call.
- `POST /list/{domain}` (including `dry_run`, the manual-NS path for `registrar_api=none`, and public-DNS NS verification), `GET /export/afternic.csv` (header byte-exact; cells per mode, §6), `GET /export/sedo.csv` (template-driven, 501 without the template), `POST /sold/{domain}`, `/report` (json + md), `/portfolio`, `/ledger` (+csv), `/deals/{id}`, `/audit`, the `npm run admin -- import-domain` command for manual buys (Porkbun, and GoDaddy via PAT or `--manual`; D-001 is at GoDaddy), and the daily job that marks domains dropped.
- Tests: LS-1 to LS-14, LG-1 to LG-17, LH-1 to LH-4, LX-1 to LX-7, L-1 to L-9, L-11 to L-13, E-1 to E-8, S-1 to S-8, R-1 to R-12, IM-1 to IM-3, IM-5 to IM-11, RN-4/RN-5, AU-8 (secret-leak grep over all responses and logs).

**Phase 5: contract tests (Gate G2).**
- Porkbun contract tests against Porkbun's mock server, plus the sandbox end-to-end B-26 (skipped when `PORKBUN_SANDBOX_*` is unset).
- Re-check every endpoint and field against https://porkbun.com/llms/domain, and report any difference from 00-architecture §5.

**Phase 6: deploy prep (Gate G3 is run by me).**
- Finalise `render.yaml` and the README deploy steps.
- Write `docs/runbook.md`: create tokens, set env secrets, the G3 live checklist (import D-001 with `npm run admin -- import-domain`, IM-4; CK-12; `/buy` with `dry_run:true` on a free test .com; confirm balance and invoices are unchanged), and the restore drill (BK-3/BK-5).
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
