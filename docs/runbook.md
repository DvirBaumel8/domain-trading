# Runbook

Short ops page for DOM. Setup is in `docs/DEPLOYMENT.md`; the API contract is `docs/contract/`. All commands run from the repo root. For anything that talks to
production, put `DATABASE_URL` (Neon **direct** string) and `DATABASE_SSL=true` in `.env.neon` (gitignored, `chmod 600`; never in `.env`) and run in a subshell:
`(set -a; . ./.env.neon; set +a; npm run admin -- ...)`. Never inline the URL on a command line.

## Tests

```bash
npx vitest run && npx tsc --noEmit && npm run build     # offline suite (G0/G1, incl. the contract-doc check)
npm run test:contract:mock       # G2: VITEST_CONTRACT=1, adapter vs Porkbun's official mock server
npm run test:contract:sandbox    # G2: VITEST_CONTRACT=1, Porkbun sandbox; needs PORKBUN_SANDBOX_API_KEY / _SECRET_API_KEY (pk1_sb_ keys); skipped without them
```

## Jobs by hand (CLI)

```bash
npm run job -- tick | daily                                       # the same runner and steps as POST /jobs/run (audited, scope job)
npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]   # compute/apply scheduled price changes (--today in the future only with --dry-run)
npm run job -- drop          [--dry-run] [--today YYYY-MM-DD]    # apply due scheduled drops
npm run job -- registrar-check [--dry-run]                       # compare registrar state with the DB
npm run job -- export-backup                                     # LOCAL dev only: needs GITHUB_BACKUP_TOKEN; in production use POST /jobs/run {"job":"daily"} (the PAT stays in Render)
npm run job -- import-backup <dir>                               # restore into an EMPTY database (see Restore drill)
```

## Trigger a job over HTTP (what the Worker does)

```bash
API=https://domain-trading-api.onrender.com
read -rs JOB_TRIGGER_TOKEN
curl -sS -X POST "$API/jobs/run" \
  -H "Authorization: Bearer $JOB_TRIGGER_TOKEN" \
  -H "Idempotency-Key: manual-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"job":"tick"}'          # or {"job":"daily"}
```

The Worker has one cron, `5 0 * * *`: `daily` at 00:05 UTC. A second schedule lives in GitHub Actions (`.github/workflows/review-retry-tick.yml`, 08:30 UTC, after Google's free-tier reset in both seasons; Cloudflare's free plan allows 5 crons per account): it runs `tick`, whose last step `reviewRetry` retries a review that Google refused at 03:05 IDT. `tick` can also be run by hand; a by-hand run (workflow_dispatch) uses a fresh idempotency key built from the current time, so it is a new run (the schedule keeps the fixed daily key). Since 3.9.0 the Worker waits up to 90 s for the wake and tries the POST 3 times (waits 5 s, then 15 s; same key), deployed by the `deploy-jobs-trigger` workflow on push. The server refuses to start when `RENDER` is set and `APP_ENV` is not `production`. Since 3.0.0 the call answers 202 with a run id at once and the steps run from the job queue: check `GET /jobs/runs` for each step's status, attempts and errors (a stalled run resumes on the next `GET /health` or `GET /jobs/runs`).

The reply has a per-step result. A second run while one is still running returns `skipped`. 401 = wrong token, 503 `JOBS_DISABLED` = `JOB_TRIGGER_TOKEN` not set in Render.
Allow up to ~60 s for a cold start.

## Rotating secrets

| Secret | How |
|---|---|
| API token (Gavriel/Gizbar) | `npm run admin -- token create --scope write\|read --name <name>`, hand it over, then `npm run admin -- token revoke --id <old id>` (`token list` shows ids) |
| `JOB_TRIGGER_TOKEN` | `openssl rand -hex 32`; update Render env (Dashboard -> Environment) **and** the GitHub repo secret; re-run the `deploy-jobs-trigger` workflow; Render restarts on env change |
| Porkbun keys | create a new pair at porkbun.com/account/api, update Render, restart, then delete the old pair |
| `GODADDY_PAT` | create a new PAT, update Render, revoke the old one |
| `GITHUB_BACKUP_TOKEN` | expires yearly: generate a new fine-grained PAT (data repo only, Contents R/W), update Render, delete the old one |

Never put a secret in the repo, a log or chat.

## Restore drill (optional: BK-5 was dropped by Dvir on 7 Oct 2026; the nightly export is built but not configured)

The scratch DB is local docker (service `db`, user `dt`, password `dt`, port 5433). Use a clean subshell with no registrar keys and no production values.

1. `npm run db:up`, then `docker compose exec db createdb -U dt restore_drill`.
2. Define the scratch environment once per shell (explicit values; nothing from `.env`):
   ```bash
   SCRATCH='env -i HOME="$HOME" PATH="$PATH" DATABASE_URL=postgres://dt:dt@localhost:5433/restore_drill DATABASE_SSL=false APP_ENV=development PORT=3100'
   ```
   (`env -i` starts from an empty environment, so no `PORKBUN_*`, `GODADDY_PAT` or `GITHUB_BACKUP_*` can reach it. `npm run job`/`admin` also load `.env` if present, so move it aside or run from a copy without one.)
3. Migrate: `eval "$SCRATCH npm run migrate up"`.
4. Get the data: `git clone --branch data-backup --single-branch git@github.com:DvirBaumel8/domain-trading-data.git /tmp/dt-data` (private repo).
5. Import (the target must be empty and at the same migration level): `eval "$SCRATCH npm run job -- import-backup /tmp/dt-data"`.
6. Create a token on the scratch DB **after** the import: `eval "$SCRATCH npm run admin -- token create --scope read --name drill"` (copy the printed token).
7. Start the API on it: `eval "$SCRATCH node dist/main.js"` (after `npm run build`), then `curl -s -H "Authorization: Bearer <drill token>" localhost:3100/report` and compare with production `/report`: the money totals and counts must be identical.
8. Record the date and the result for Dvir. Delete `/tmp/dt-data` and drop the scratch DB (`docker compose exec db dropdb -U dt restore_drill`).

## Where warnings show

`GET /report` (READ) lists warnings with levels (error/warn/info, `docs/contract/reports.md`), for example `RENEWAL_PRICE_UNKNOWN` or `EXPORT_PENDING`, plus upcoming renewal/drop dates and the
budget and cap headroom. `GET /audit` shows every POST including `jobs/run` rows (a failed step is in the summary, e.g. `daily: failed backupExport`).
`GET /health` (needs a READ or WRITE token) shows the DB and adapter state. Render logs (Dashboard -> Logs) hold startup and migration output.

## Releasing (DOM)

1. Full gate green: `npx vitest run && npx tsc --noEmit && npm run build`.
2. Contract, `CHANGELOG.md`, `docs/internal/` and `gaps.md` updated in the same commit; release note `docs/releases/vX.Y.Z.md` written.
3. Deploy: push the tag (`git tag vX.Y.Z && git push origin vX.Y.Z`). `.github/workflows/release.yml` checks that the tag is the tip of main, equals `package.json` and has a CHANGELOG entry, runs the full suite, calls the Render deploy hook and waits for `/health/ping`. Manual fallback: `curl -fsS -X POST "$RENDER_DEPLOY_HOOK"` (the hook URL is a secret: Render -> service -> Settings -> Deploy Hook; also stored as the GitHub secret `RENDER_DEPLOY_HOOK`). Render runs the migrations on start.
4. Verify: `GET /health` (token) shows `db: ok` and the new `version`; fill in the release note's deploy status.


## Deploys (since 7 Oct 2026)
Render deploys **every push to `main` after the GitHub `ci` workflow passes** (`autoDeployTrigger: checksPass`). A `vX.Y.Z` tag marks a release; the `release` workflow checks that it matches package.json and the CHANGELOG, and runs the tests. `RENDER_DEPLOY_HOOK` is no longer needed. To deploy manually: Render dashboard → Manual Deploy, or the Render API.

## Local host (CR-041, Dvir 12 Oct 2026): production on the Mac mini while Render is suspended
Render suspended the free service on 11 Oct (the workspace's 750 free hours ran out). Until it resumes (about 1 Nov), the API runs on Dvir's Mac mini. **Dvir sets it up and starts it; DOM only wrote the kit and never reads the env file or calls the server (CLAUDE.md HARD RULE). Gavriel verifies.** Same database (Neon), same secrets, so nothing is copied or migrated.

**How the URL works:** the server listens on `127.0.0.1:3100` (port 3000 is used by another project on the Mac). A Cloudflare **quick tunnel** (`cloudflared`, free, no account or domain) publishes it at a random `https://<x>.trycloudflare.com` URL that changes on every tunnel restart. So a small Worker, `api-proxy/` (`domain-trading-api-proxy`), gives everyone one **stable** URL, `https://domain-trading-api-proxy.<subdomain>.workers.dev`, and forwards every request to the current tunnel URL. The `tunnel-watch` agent notices a new tunnel URL, sets the GitHub variable `TUNNEL_URL` and runs the `deploy-api-proxy` workflow. The stable URL never changes while the Mac host runs. Only `.trycloudflare.com` https origins are accepted; if the tunnel is down the proxy answers 502 `ORIGIN_UNREACHABLE`, if `TUNNEL_URL` is empty 503 `ORIGIN_NOT_SET`.

**One-time setup (Dvir):**
1. `brew install cloudflared`, then `bash scripts/local-host/install.sh` (from any checkout). It clones `~/domain-trading-prod`, creates `~/.config/domain-trading/prod.env` (chmod 600, every key with an empty value), copies the host scripts to `~/.local/share/domain-trading-host` and writes four LaunchAgents (api, deploy, tunnel, tunnel-watch). It starts nothing.
2. Open `prod.env` and paste each value from Render → domain-trading-api → Environment. Keep `HOST=127.0.0.1` (only the tunnel reaches it). `PUBLIC_BASE_URL` can stay empty for now (the server then uses the Render default); set it in step 6.
3. Keep the Mac awake: System Settings → Energy → "Prevent automatic sleeping when the display is off" on, and "Start up automatically after a power failure" on. LaunchAgents run while Dvir is logged in, so turn on automatic login, or log in after a reboot.
4. `gh auth status` must show signed in, with rights to set repository variables and run workflows (deploy.sh checks CI with `gh`; tunnel-watch sets `TUNNEL_URL`). The repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` already serve `deploy-jobs-trigger`; `deploy-api-proxy` uses the same two.
5. `~/.local/share/domain-trading-host/deploy.sh --first`: builds the newest release tag whose CI passed, then loads all four agents. Logs: `~/Library/Logs/domain-trading/{api,deploy,tunnel,tunnel-watch}.log`.
6. Within a minute the first `tunnel-watch` run sets `TUNNEL_URL` and runs `deploy-api-proxy` (GitHub → Actions; its log ends with `Deployed URL: https://domain-trading-api-proxy.<subdomain>.workers.dev`). Put that URL in `prod.env` as `PUBLIC_BASE_URL`, then `launchctl kickstart -k gui/$(id -u)/com.domaintrading.api`.
7. GitHub → Settings → Variables → `API_BASE_URL` = the proxy URL (once; it never changes), then run the `deploy-jobs-trigger` workflow by hand so the daily Worker calls the Mac. `review-retry-tick` reads the same variable.
8. Write the proxy URL in `docs/requests/DOM-TO-GAVRIEL.md` (or tell DOM to): Gavriel switches his calls and checks `/health/ping` and `/health` through it.

**Deploys:** the `com.domaintrading.deploy` agent checks every 10 min and deploys a new `vX.Y.Z` tag once its `ci` run passed (never 23:45–01:00 UTC). DOM keeps releasing as usual.

**Switch back to Render (one writer at a time), before Render resumes:**
0. Set `.github/deploy-target` back to `render` (deploy-live notes resume).
1. `launchctl bootout gui/$(id -u)/com.domaintrading.api`, `.deploy`, `.tunnel` and `.tunnel-watch` (same prefix; the server finishes its step in flight first).
2. `API_BASE_URL` back to `https://domain-trading-api.onrender.com`, and run `deploy-jobs-trigger`.
3. Resume the service on Render (it deploys the latest main). Gavriel checks `/health`.
4. Set the repo variable `TUNNEL_URL` to empty (the proxy then answers 503) or delete the `domain-trading-api-proxy` Worker in the Cloudflare dashboard; delete `prod.env` if it's not needed any more.
If Render resumes by itself while the Mac still runs, do step 1 at once: two servers would run two daily jobs.
