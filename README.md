# domain-trading

A backend service (HTTP API + Postgres, no frontend) for a small domain-trading proof of concept: at most 10 .com names, a $500 cap, and each name held at most 2 years. Dvir's bot Gavriel calls it over HTTPS with READ/WRITE bearer tokens. Every purchase requires Dvir's explicit approval in chat.

- **Start here:** `CLAUDE.md` (rules, conventions, build order), then `docs/specs/00-architecture.md`.
- **Build:** paste `docs/claude-code-prompt.md` into Claude Code.
- **Tests and gates:** `docs/specs/test-plan.md`.
- **Hosting:** `render.yaml` (a sketch; the price is unverified and Dvir must approve the spend). Env vars: `.env.example`.
- **Research behind the choices:** `docs/research/`.

**Status (5 Oct 2026):** steps 1 (foundation) and 2 (registrar adapters + `GET /check`) built. Next: step 3 (`/buy`).

## Run locally
1. `npm install`
2. `npm run db:up` (Postgres 16 in docker on port 5433; creates `domain_trading` and `domain_trading_test`)
3. `cp .env.example .env` (fake/blank keys are fine for local work)
4. `npm run migrate up`
5. `npm run admin -- token create --scope write --name dvir-local` (the token is printed once)
6. `npm run dev`, then `curl localhost:3000/health`

Tests: `npm test` (unit + API; needs the docker Postgres from run step 2 above to be running). Network is blocked in tests.
