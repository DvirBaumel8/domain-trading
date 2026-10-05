# Runbook

Short ops page. Setup is in `docs/DEPLOYMENT.md`. All commands run from the repo root. For anything that talks to
production, set `DATABASE_URL` (Neon **direct** string) and `DATABASE_SSL=true` in the environment or a `chmod 600` `.env`.

## Tests

```bash
npx vitest run && npx tsc --noEmit && npm run build     # offline suite (G0/G1)
npm run test:contract:mock       # G2: VITEST_CONTRACT=1, adapter vs Porkbun's official mock server
npm run test:contract:sandbox    # G2: VITEST_CONTRACT=1, Porkbun sandbox; needs PORKBUN_SANDBOX_API_KEY / _SECRET_API_KEY (pk1_sb_ keys); skipped without them
```

## Jobs by hand (CLI)

```bash
npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]   # compute/apply scheduled price changes (--today in the future only with --dry-run)
npm run job -- drop          [--dry-run] [--today YYYY-MM-DD]    # apply due scheduled drops
npm run job -- registrar-check [--dry-run]                       # compare registrar state with the DB
npm run job -- export-backup                                     # push the data export to the data-backup branch (no token -> warning, exit 0)
npm run job -- import-backup <dir>                               # restore into an EMPTY database (see Restore drill)
```

## Trigger a job over HTTP (what the Worker does)

```bash
curl -sS -X POST https://domain-trading-api.onrender.com/jobs/run \
  -H "Authorization: Bearer $JOB_TRIGGER_TOKEN" \
  -H "Idempotency-Key: manual-$(date +%s)" \
  -H 'Content-Type: application/json' \
  -d '{"job":"tick"}'          # or {"job":"daily"}
```

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

1. Scratch Postgres: `npm run db:up` (docker, port 5433), then create an empty DB: `createdb -h localhost -p 5433 -U dt restore_drill` (password `dt`).
2. Migrate it: `DATABASE_URL=postgres://dt:dt@localhost:5433/restore_drill npm run migrate up`.
3. Get the data: `git clone --branch data-backup --single-branch git@github.com:DvirBaumel8/domain-trading-data.git /tmp/dt-data` (private repo).
4. Import (the target must be empty and at the same migration level): `DATABASE_URL=postgres://dt:dt@localhost:5433/restore_drill npm run job -- import-backup /tmp/dt-data`.
5. Compare `/report` from a local `node dist/main.js` (or `npm run dev`) on the restored DB with production `/report`: the money totals and counts must be identical. Create tokens only **after** the import.
6. Record the date and the result for Dvir. Delete `/tmp/dt-data` and the scratch DB afterwards.

## Where warnings show

`GET /report` (READ) lists warnings, for example `RENEWAL_PRICE_UNKNOWN`, `HIGH_VALUE_LOW_BIN`, upcoming renewal/drop dates, and the
budget and cap headroom. `GET /audit` shows every POST including `jobs/run` rows (a failed step is in the summary, e.g. `daily: failed export`).
`GET /health` shows the DB and adapter state. Render logs (Dashboard -> Logs) hold startup and migration output.
