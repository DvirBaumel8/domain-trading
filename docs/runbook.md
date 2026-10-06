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

The Worker's crons are `0 * * * *` (tick) and `5 0 * * *` (daily). A Worker log saying "timed out" does **not** mean the job failed (the cold start can exceed the Worker's wait while the job still runs): check `GET /audit` for the `/jobs/run` row and its summary.

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

## Restore drill (BK-5; before the first real buy, then quarterly)

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
