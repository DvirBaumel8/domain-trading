> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-112 — Stateless cutover: Render target, pause Mac jobs, leave Neon idle
| Field | Value |
|---|---|
| CR id | CR-112 |
| Series | S8 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. 10:09 IST: autoDeploy stays ON; no new workspace and no suspending of the other services. |
| Priority | P0 (cutover switch-off and docs) |
| Depends on | CR-105, CR-107, CR-108, CR-111. Live data cutover also waits on CR-106 (blocked on dump copy). |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

Production must point at Render, not the Mac tunnel. Nightly `pg_dump` and the database backup export stop. Docs and deploy wiring match the stateless service. The Neon project is left idle and is never deleted. Mac launchd jobs are paused, not deleted.


## 2. Rules
- **R-1 (deploy target is Render): set `.github/deploy-target` to `render` (it is `mac` today). `API_BASE_URL` (GitHub repo variable and jobs-trigger) and the deploy-live health base point at the Render service (`https://domain-trading-api.onrender.com`, or the URL Render shows once the service is the production one). The Cloudflare quick tunnel, `tunnel-watch`, and the api-proxy path are retired from production; the Mac agents are paused, not deleted.**
- **R-2 (autoDeploy stays ON): do not turn auto-deploy off. Docs-only deploys are already stopped by CR-111's `buildFilter`; this CR must not revert that and must not set `autoDeployTrigger: off`.**
- **R-3 (stop database backups): remove or disable the nightly Mac `pg_dump` job (pause the launchd agent, do not delete the plist or the keep-folder dump). Remove the `backupExport` daily step that pushed a DB snapshot to `data-backup`. The FileStore in CR-105 is the backup. Do not delete `~/domain-trading-backups-keep/` or the Nov 12 dump.**
- **R-4 (docs): rewrite `docs/runbook.md`, `docs/DEPLOYMENT.md` and `docs/internal/00-architecture.md` (and any contract notes that still assume Neon or the tunnel) for a FileStore on Render Free, wake-before-act, and no database. Docs lint must pass.**
- **R-5 (Neon): the Neon project stays idle as a fallback and is never deleted. No upgrade, no spend, no connection from the new service.**
- **R-6 (no Mac dependency in prod): production start, health, daily light jobs and daily packs must not require the Mac. The Mac is for developing new things only.**
- **R-7: no spend. No new Render workspace. Do not suspend `pro-now`, `trader-backend` or `sapako-backend`.**

## 3. Acceptance criteria
- **AC-1 (DC-1): `render.yaml` and the GitHub workflows have no `DATABASE_URL`, no `migrate up`, and no production dependency on the tunnel or `TUNNEL_URL`. `autoDeployTrigger` is still `checksPass`.**
- **AC-2 (DC-2): `.github/deploy-target` is `render`. `deploy-live.yml` waits on the Render `/health/ping`, not the api-proxy. `API_BASE_URL` in the workflow docs and jobs-trigger default is the Render URL.**
- **AC-3 (DC-3): docs lint passes. runbook, DEPLOYMENT and 00-architecture describe FileStore + Render Free + wake-before-act, and they say the Neon project stays idle and is never deleted.**
- **AC-4: a repo search of the cutover docs and yaml shows the Mac launchd jobs described as paused, not deleted, and the Nov 12 keep-folder dump is not scheduled for deletion.**

## 4. Open questions for DOM
- Q1: should the api-proxy Worker be left in place but unused (recommended, zero cost, easy to ignore) or should its deploy workflow be paused too? Do not delete it in this CR.

<!-- DOM writes below this line -->
