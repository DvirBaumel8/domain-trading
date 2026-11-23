> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-112 — Stateless cutover: Render target, pause Mac jobs, leave Neon idle
| Field | Value |
|---|---|
| CR id | CR-112 |
| Series | S8 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. 10:09 IST: autoDeploy stays ON; no new workspace and no suspending of the other services. 10:19 IST (via Gavriel): add §5 Cloudflare retirement (pause, do not delete; Dvir picks the production URL and the 03:05 cron option). |
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
- Q1: superseded by §5 (2026-11-23 10:19 IST). DOM must not pick option 1 vs 2, or 5b, in this CR; flag the choice as **DVIR** and implement the one he names. Until that yes, land the docs and the pause-not-delete path only. Do not delete the proxy, any Worker, tunnel, DNS or Cloudflare token.


## 5. Cloudflare retirement (added 2026-11-23 10:19 IST, Dvir via Gavriel)

This section extends R-1 and supersedes Q1. Do not start the retirement until the Render service serves `GET /health/ping` (CR-111). No spend. Claude Code only; at most the remaining rounds of this CR.

### 5a. Retire the Mac tunnel path (after Render `/health/ping` is green)
Pause, do not delete: the Cloudflare quick tunnel (`com.domaintrading.tunnel`), `tunnel-watch` (`com.domaintrading.tunnel-watch`), and the Mac deploy-tag path (`com.domaintrading.deploy`, `deploy.sh` building release tags into `~/domain-trading-prod-releases/`). Stop production use of the GitHub variable `TUNNEL_URL` and of `.github/workflows/deploy-api-proxy.yml` (it exists only to push a new trycloudflare origin into the proxy). Leave the plists, host scripts, the `api-proxy/` tree, the workflow file, and the `TUNNEL_URL` variable in place until Dvir's explicit yes (5d).

### 5b. Option: move the 03:05 jobs-trigger cron to GitHub Actions
Today the `jobs-trigger` Worker cron is `5 0 * * *` (03:05 IST). An allowed option is to replace that cron with a GitHub Actions schedule that calls the chosen production URL using the CR-111 wake-before-act rule (`GET /health/ping`, wake, backoff up to 180 s, then act; fail loud, no partial write). If this option is taken, pause the Worker schedule (do not delete the Worker or its Cloudflare deploy). If it is not taken, the Worker stays and must use the same wake-before-act rule against the URL chosen in 5c.

### 5c. Production URL: two options for `https://domain-trading-api-proxy.dvirbaumel9.workers.dev`
Dvir picks one. Until he does, document both and do not delete the proxy.

- **Option 1 — keep the proxy as a thin forwarder to Render.** The Worker stays at the same workers.dev URL and forwards every request to `https://domain-trading-api.onrender.com` (or the URL Render shows). Strip Mac / tunnel logic: no `TUNNEL_URL`, no `.trycloudflare.com`-only origin check (today `parseOrigin` rejects any non-trycloudflare URL, so option 1 needs that check replaced with a fixed Render origin). No Mac reachability errors. Callers can keep using the proxy URL. Still apply CR-111 wake-before-act, because Render Free sleeps.
- **Option 2 — retire the proxy URL from callers.** Replace the proxy URL with the onrender URL everywhere below. The Worker is left in place but unused (pause `deploy-api-proxy`; do not delete it).

**Caller list to update** (every one must pass against the chosen URL after cutover; historical `docs/requests/` and `docs/releases/` files are not callers and are left as written):

Repo / scheduled callers:
- `.github/workflows/datasave.yml` (uses `vars.API_BASE_URL`)
- `.github/workflows/tick.yml` (uses `vars.API_BASE_URL`)
- `jobs-trigger/` Worker (`wrangler.jsonc` service binding `API` → `domain-trading-api-proxy`, plus `API_BASE_URL`; cron `5 0 * * *` unless 5b moves it)
- `.github/workflows/deploy-jobs-trigger.yml` (deploys that Worker with `vars.API_BASE_URL`)
- `.github/workflows/deploy-live.yml` (already defaults to `https://domain-trading-api.onrender.com` for `/health/ping`; confirm it stays on the chosen URL)
- GitHub repository variable `API_BASE_URL` (today the proxy URL)

Bot and contract docs:
- `docs/contract/README.md` (base URL)
- `docs/bot-logic/04-buyer-shortlist-to-card.md`
- `docs/runbook.md` (live `API=` line and the "Local host" / "Switch back to Render" sections)
- `docs/DEPLOYMENT.md`
- `docs/internal/code-map.md` (`api-proxy/` / `TUNNEL_URL` description)
- `docs/internal/afternic-api.md` (mentions `API_BASE_URL`; confirm it does not hard-code the proxy)

Box / one-off scripts (not in this repo; update or stop using when the chosen URL is live):
- `/workspace/chk.sh`
- `/workspace/watch098.sh`
- `/workspace/domain-trading/scripts/dom_buy.py`
- `/workspace/qa-work/call.sh` (today hits `https://domain-trading-api.onrender.com` directly)
- `/workspace/qa-work/poll.sh` (today hits onrender `/health`, not `/health/ping`)
- `/workspace/posting/post_phase1.py` (today hits onrender directly)

Mac host scripts (`datasave-trigger.sh`, `deploy.sh` including `visits-token.sh` and `dom-read-token.sh`) are paused with the launchd jobs in 5a, not retargeted.

One-off QA helpers on the box (qa202, qa210, qa220, qa400 and similar) also hard-code a URL; they are not production callers.

### 5d. No Cloudflare deletion without Dvir's explicit yes
Do not delete the `domain-trading-api-proxy` Worker, the `jobs-trigger` Worker, the quick tunnel, any DNS, or the GitHub secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`, and do not delete the `TUNNEL_URL` variable, until Dvir says so in a later yes. Pause and stop using them only.

### Acceptance criteria (this section)
- **AC-5 (CF-1):** after cutover, every caller in the 5c list that is still in service gets a successful `GET /health/ping` (CR-111 wake-before-act) against the chosen URL (option 1: the proxy URL, now forwarding to Render; option 2: the onrender URL). Failures are loud; no leftover caller still points at a trycloudflare origin or at a tunnel-backed proxy.
- **AC-6 (CF-2):** `com.domaintrading.tunnel`, `com.domaintrading.tunnel-watch` and `com.domaintrading.deploy` are paused (bootout + disable), not deleted. Plists, host scripts and the Nov 12 keep-folder dump remain. `TUNNEL_URL` is unused in production and is not deleted.
- **AC-7 (CF-3):** no Cloudflare Worker, tunnel, DNS record or Cloudflare token was deleted in this CR.
- **AC-8 (CF-4):** if option 5b is taken, the 03:05 run is a GitHub Actions schedule that uses CR-111 wake-before-act, and the Worker cron is paused (not deleted). If 5b is not taken, the existing Worker cron uses the same wake-before-act rule against the chosen URL.

<!-- DOM writes below this line -->
