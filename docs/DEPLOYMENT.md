# Deployment (Render free, $0)

The service is `domain-trading-api` on Render's free plan, described by `render.yaml`. A push to `main` deploys after every check on the commit passes, so no workflow may wait for the deploy (it would block it); a push that only changes `docs/` does not deploy. There is no database, disk, migration or scheduled job.

## Environment (Render dashboard, or the Render API)
| Key | Value |
|---|---|
| `NODE_VERSION` | `26` (in `render.yaml`) |
| `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` | For `GET /check`. Both or neither |

Remove the old `DATABASE_URL`, `DATABASE_SSL`, `API_TOKENS`, `JOB_TRIGGER_TOKEN`, `GITHUB_BACKUP_*`, `GODADDY_PAT` and other keys: nothing reads them.

## Access
`data/access.json` maps a name to the sha256 of its token. To add a reader, commit its hash; to remove one, delete the line. The token itself is a long random value kept only by its owner, so the file gives nothing away.

## Sleep
Free services sleep after about 15 minutes. Wake it with `GET /health/ping` and wait up to 180 seconds before acting. Do not keep it warm: the 750 free hours a month are shared by the whole workspace.

## Record a change (a purchase, renewal, cost or sale)
1. Dvir approves in chat (purchase, renewal, sale).
2. DOM edits `data/state.json`: adds a ledger row with the next `id`, and the domain if it is new. A mistake is corrected with an `adjustment` row; rows are never edited or removed.
3. `npm run check-state && npm test`, then commit and push. CI repeats the checks, then Render deploys.

The repo is public, so the file has no private data: no floor price, walk-away, approval text, address or key; the schema refuses any unlisted field. `approval.ref` says where the approval is recorded.

## Rollback
Revert the commit and push. For the old database version: tag `v6.7.0`. The Neon project is idle and kept, and the last dump is `~/domain-trading-backups-keep/` on the Mac; neither is used or deleted.
