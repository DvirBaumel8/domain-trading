# domain-trading

A backend service (HTTP API + Postgres, no frontend) for a small domain-trading proof of concept: at most 50 .com names, a $1,500 cap (both confirmed by Dvir on 5 Oct 2026, 01:04 IDT), and each name held at most 2 years. Dvir's bot Gavriel calls it over HTTPS with READ/WRITE bearer tokens. Every purchase requires Dvir's explicit approval in chat.

- **Start here:** `CLAUDE.md` (rules, conventions, build order), then `docs/specs/00-architecture.md`.
- **Build:** paste `docs/claude-code-prompt.md` into Claude Code.
- **Tests and gates:** `docs/specs/test-plan.md`.
- **Hosting:** free: Render free + Neon + a Cloudflare Worker for the scheduled jobs ($0). Setup: `docs/DEPLOYMENT.md`; blueprint: `render.yaml`. Env vars: `.env.example`.
- **Research behind the choices:** `docs/research/`.

**Status (6 Oct 2026):** steps 1-5 built; step 6 code ready (free hosting, jobs trigger, backup). Waiting for Dvir's setup (`docs/DEPLOYMENT.md`) and then G3.

## Run locally
1. `npm install`
2. `npm run db:up` (Postgres 16 in docker on port 5433; creates `domain_trading` and `domain_trading_test`)
3. `cp .env.example .env` (fake/blank keys are fine for local work)
4. `npm run migrate up`
5. `npm run admin -- token create --scope write --name dvir-local` (the token is printed once)
6. `npm run dev` runs in `JOBS_MODE=internal`: the jobs run at startup and on timers (the backup is skipped without a token). Check `curl localhost:3000/health/ping` and `curl localhost:3000/health`.

Tests: `npm test` (unit + API; needs the docker Postgres from run step 2 above to be running). Network is blocked in tests.
