# domain-trading

A backend service (HTTP API + Postgres, no frontend) for a small domain-trading proof of concept: at most 10 .com names, a $500 cap, and each name held at most 2 years. Dvir's bot Gavriel calls it over HTTPS with READ/WRITE bearer tokens. Every purchase requires Dvir's explicit approval in chat.

- **Start here:** `CLAUDE.md` (rules, conventions, build order), then `docs/specs/00-architecture.md`.
- **Build:** paste `docs/claude-code-prompt.md` into Claude Code.
- **Tests and gates:** `docs/specs/test-plan.md`.
- **Hosting:** `render.yaml` (a sketch; the price is unverified and Dvir must approve the spend). Env vars: `.env.example`.
- **Research behind the choices:** `docs/research/`.

**Status (3 Oct 2026):** specs only, no code yet. Bots never commit code here.
