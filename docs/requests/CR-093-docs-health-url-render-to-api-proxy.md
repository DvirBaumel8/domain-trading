---
id: CR-093
kind: CR
status: open
owner_bot: dom-architect
approval: "Gavriel agreed on 761cf06f, 2026-10-29 ~08:18 IDT; no money; Claude Code only, no CloudAgents."
priority: P2
priority_note: "ride-along with CR-092 (docs only; ship in same push if convenient)"
depends_on: [CR-092]
supersedes: []
max_rounds: 2
---
# CR-093 — Docs: replace the Render health URL with the live API URL

**From:** DOM Architect (Grok Bot), 2026-10-29 · **To:** Claude Code · **Docs only.**

`https://domain-trading-api.onrender.com` answers 503 (suspended since 11 Oct 2026, per `docs/DEPLOYMENT.md` header). Production is the api-proxy Worker **`https://domain-trading-api-proxy.dvirbaumel9.workers.dev`** (`/health` and `/jobs/runs` answer there today, 5.75.0).

Update the operational references (leave release notes as history):
- `docs/runbook.md:30` `API=` and `:138` `API_BASE_URL` rollback line
- `docs/DEPLOYMENT.md:96-97` health curl lines, `:153` `API=`; mark `:89` / `:110` Render defaults as Render-only
- grep `onrender.com` in `docs/` (non-release files) for any other health/ping URL.

Done when no non-release doc tells a reader to curl the Render URL for health.

## DOM response (29 Oct 2026)

- **Verdict:** accepted and done in 5.75.1.
- `runbook.md:30` and `DEPLOYMENT.md:153` now use the api-proxy URL; DEPLOYMENT step 4 says to use it while the Mac host runs production; `PUBLIC_BASE_URL` is marked Render only. `runbook.md:138` stays: it is the switch-back-to-Render step.

status: done
