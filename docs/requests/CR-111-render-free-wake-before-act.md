> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-111 — Render Free, wake-before-act, docs-only buildFilter
| Field | Value |
|---|---|
| CR id | CR-111 |
| Series | S7 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. 10:09 IST answers: keep autoDeploy ON; do not create a workspace and do not suspend pro-now, trader-backend or sapako-backend; minimise awake time. |
| Priority | P0 |
| Depends on | CR-105, CR-107 (API boots without a database) |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

DOM runs on Render Free in the existing shared workspace and is allowed to sleep. Callers must wake it and wait before they act. Database migrations must not run on start. Auto-deploy stays on, but a docs-only push must not redeploy the service.


## 2. Rules
- **R-1 (Render Free, autoDeploy stays ON): `render.yaml` keeps `plan: free` and `autoDeployTrigger: checksPass`. Do not turn auto-deploy off. Do not add a keep-warm ping.**
- **R-2 (docs-only pushes must not deploy): add a Blueprint `buildFilter` with `ignoredPaths: [docs/**]` (or equivalent; see https://docs.render.com/monorepo-support). Leave included `paths` unset so every non-docs change still deploys after CI. Do not use `autoDeployTrigger: off`. A change to `render.yaml` itself still deploys (Render always processes the Blueprint file).**
- **R-3 (no migrate, no DATABASE_URL): `startCommand` is `node dist/main.js` only — remove `npm run migrate up`. Drop the `DATABASE_URL` env var from `render.yaml`. `healthCheckPath` stays `/health/ping`.**
- **R-4 (wake-before-act, all callers): a shared `wakeAndWait()` (or the same logic inlined) is used by `.github/workflows/datasave.yml`, `.github/workflows/tick.yml`, `jobs-trigger/` (the Worker cron), and bot docs (`docs/bot-logic/` and the contract/runbook). Order: `GET /health/ping`; if the service is asleep, wake it and wait with backoff until it is ready, up to 180 s; then act. Per-call timeout 60 s, up to 3 retries. POSTs carry idempotency keys. If it is not ready in 180 s: fail loud, write nothing, leave no partial FileStore commit. Today's single ping with `--max-time 90 || true` (which then POSTs even when the ping failed) is not enough.**
- **R-5 (minimise awake time): no polling of DB-free endpoints (or any endpoint) that would keep the Free instance up. Wake only for a scheduled run or a real caller action. After the work finishes, let it sleep (Render spins a Free web service down after about 15 minutes idle). Do not add a keep-alive, a health loop, or a periodic `/health/ping` from bots.**
- **R-6 (shared 750 h, known risk): DOM stays in the shared Render workspace on Free. Do not create a new workspace. Do not suspend `pro-now`, `trader-backend` or `sapako-backend`. The shared 750 Free instance hours per workspace per month is a known risk to revisit later; this CR only reduces DOM's own awake time (R-5).**
- **R-7 (light daily jobs only): `POST /jobs/run` on the API runs only the light owned-state jobs (reconciler, nsVerifier, priceJob, listingSync, afternicSync, registrarCheck). The heavy market pull is CR-110. `dropJob` / drop-watch stay off (drops strategy closed, 2026-11-22).**
- **R-8 (workspace and secrets): moving Mac-only secrets into the Render dashboard waits until the Mac is on (Gavriel will say when). This CR can land the yaml, the wake helper and the tests without the secret values. Do not invent or print secrets.**

## 3. Acceptance criteria
- **AC-1 (WK-1): a simulated 60 s cold start → the caller waits, then succeeds, and the action runs once.**
- **AC-2 (WK-2): no ready answer within 180 s → the caller fails loud, and the FileStore is unchanged (no partial write).**
- **AC-3 (WK-3): a POST retried after a timeout, same Idempotency-Key → one row.**
- **AC-4: `render.yaml` has `autoDeployTrigger: checksPass` (not off), `startCommand` with no `migrate`, no `DATABASE_URL`, `healthCheckPath: /health/ping`, and `buildFilter.ignoredPaths` covering `docs/**`.**
- **AC-5: a commit whose changed files are all under `docs/` does not match the build filter (documented test or a recorded dry explanation against Render's filter rules). A commit that also changes a non-docs path still would deploy after CI.**
- **AC-6: datasave.yml, tick.yml, jobs-trigger and the bot docs all use the 180 s wake-and-wait and fail closed; none pings on a timer to keep the service awake. There is no keep-alive.**

## 4. Open questions for DOM
- Q1: none on auto-deploy or the workspace (Dvir answered both on 2026-11-23 10:09 IST). If `ignoredPaths: [docs/**]` is not accepted by the Blueprint schema as written, use the documented equivalent and note it in the DOM response.

<!-- DOM writes below this line -->

## Addendum 2026-11-23 10:23 IST (Render audit)
- R-add-1: Remove or disable the in-process self-ping keep-alive (docs/DEPLOYMENT.md, v5.13.0: pings itself when `RENDER` is set). On Render Free, DOM must be allowed to sleep after 15 min idle. AC-add-1: with no external calls for 20 min, the Render events/instances API shows the service scaled to 0 (sleeping).
- R-add-2: A failed startup must not crash-loop and burn free hours. With no DATABASE_URL (or an unreachable DB), the process starts and serves /health/ping 200 (CR-107/CR-111). AC-add-2: a deploy with no DB reaches `live` and does not log repeated `server_failed`.
- Context (read-only audit, Render API): on Nov 23 at 10:12 IST, the docs-only push 6be85a06 auto-deployed and `update_failed`; 2 instances crash-loop on `npm run migrate up` vs suspended Neon. The shared workspace's 750 h ran out in Oct 2026 (all 4 services auto-resumed Nov 1 by `Free Tier Usage Exceeded` removal). Other projects' 5-min keepalive Workers (pro-now, trader, sapako) are outside DOM scope; flagged to Dvir.

## DOM response (2026-11-23)
**Replaced, not built.** Dvir told DOM in chat today, after this was filed: stateless, no database, and only the money spent and the domains owned are kept, in this repo. Built as 7.0.0 (`docs/releases/v7.0.0.md`).
Taken over from this CR: Render free, `autoDeployTrigger: checksPass`, `buildFilter` for docs, no migrate, no `DATABASE_URL`, no keep-warm.
