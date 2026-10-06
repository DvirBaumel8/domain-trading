# domain-trading

A backend service (HTTP API + Postgres, no frontend) for a small domain-trading proof of concept: at most 50 .com names, a $1,500 cap, each name held at most 2 years. Built, owned and run by **DOM** (the vendor); the only API user is Dvir's bot **Gavriel**, with READ/WRITE bearer tokens. Every purchase requires Dvir's explicit approval in chat.

- **API contract (the interface):** `docs/contract/` (v1.0.0; changes in `docs/contract/CHANGELOG.md`).
- **DOM's manual:** `CLAUDE.md` (founder rules, conventions, workflow). Internal rules and test IDs: `docs/internal/` (gaps vs the code: `docs/internal/gaps.md`).
- **Requests and releases:** `docs/requests/` (CR/BUG templates), `docs/releases/` (release notes).
- **Hosting ($0):** Render free + Neon + a Cloudflare Worker for the scheduled jobs. Setup: `docs/DEPLOYMENT.md`; operations: `docs/runbook.md`; env vars: `.env.example`.

**Status (6 Oct 2026):** contract v1.0.0 built and tested; not deployed yet (waiting for Dvir's one-time hosting setup, `docs/DEPLOYMENT.md`). Next: CR-001 P1a (selection checks, pricing settings v3).

## Run locally
1. `npm install`
2. `npm run db:up` (Postgres 16 in docker on port 5433; creates `domain_trading` and `domain_trading_test`)
3. `cp .env.example .env` (fake/blank keys are fine for local work)
4. `npm run migrate up`
5. `npm run admin -- token create --scope write --name dvir-local` (printed once)
6. `npm run dev` serves the API only; nothing runs on timers. Run scheduled work with `npm run job -- tick` or `npm run job -- daily` (the same runner as `POST /jobs/run`). Check `curl localhost:3000/health/ping` and `curl -H "Authorization: Bearer $TOKEN" localhost:3000/health` (every route except `/health/ping` needs a token).

Tests: `npx vitest run && npx tsc --noEmit && npm run build` (unit + API + the contract-doc check; needs the docker Postgres from step 2). Network is blocked in tests.
