# Step 6a: Free hosting (Render free + Neon free + Cloudflare Worker cron): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the service run at **$0/month** the way Dvir's trader and sapako projects do (Dvir, 5 Oct 2026: "It should be free. See how I handle it in trader and sapako"):
- **API** on a Render **free** web service. It sleeps when idle and wakes on the next request (~50 s).
- **Postgres** on **Neon free**: 100 CU-hours/project, 1 GB, scale-to-zero after 5 min, 6-hour history.
- **Scheduled work** is triggered by a free **Cloudflare Worker cron**, like `trader/keepalive`. It calls an authenticated job endpoint, so nothing depends on in-process timers while the instance sleeps.
- **Backups:** a nightly data export to the `data-backup` branch, run by the daily trigger, plus Dvir's monthly manual dump. There is no paid point-in-time recovery.

This step is code and docs only. The actual Render, Neon and Cloudflare setup is Dvir's (step 6b, from `docs/DEPLOYMENT.md`).

**Why this shape:**
- **Render instance hours.** The free tier has 750 instance hours per workspace per month, and a service kept awake 24/7 uses about 730 (sapako `docs/DEPLOYMENT.md`). trader and sapako may already be kept warm, so this service must **not** be kept awake. The Worker wakes it **hourly** (it then sleeps after ~15 min idle, about 180 h/month) and once a day for the daily jobs.
- **Neon compute.** Hourly wakes keep compute at roughly 0.25 CU × 5 min × 730 ≈ 15 CU-h/month, plus bot traffic, well under 100.
- **Locks need a direct connection.** The per-domain lock is a **session** advisory lock (`withDomainLock`), which breaks behind a transaction-mode pooler. The service must use Neon's **direct** connection string, not `-pooler`. A startup check enforces this.

**Spec:** `docs/specs/backup.md` (Layer 2 export, BK-1–BK-4); `docs/specs/buy.md` (reconciler); `docs/specs/00-architecture.md` §8; CLAUDE.md founder rules 7 and 11 (the backup job pushes data only, to `data-backup`). The trader/sapako patterns: `~/claude/trader/keepalive`, `~/claude/trader/render.yaml`, `~/claude/sapako/docs/DEPLOYMENT.md`.

## Global Constraints
- The default `npx vitest run` stays offline.
- No secrets in the repo. New secrets: `JOB_TRIGGER_TOKEN` (Render and the Worker), `GITHUB_BACKUP_TOKEN` (Render). Never logged.
- **Job endpoint:** `POST /jobs/run`. Authenticated by `Authorization: Bearer <JOB_TRIGGER_TOKEN>` with a constant-time compare; it is **not** a READ/WRITE API token. Idempotent through `Idempotency-Key` (the Worker sends a unique key per firing) and audited with scope `job`. With the token missing or wrong → 401 and audited. When `JOB_TRIGGER_TOKEN` isn't configured, the route returns 503 `JOBS_DISABLED`.
- **The job endpoint never runs two of the same job at once.** Each job already has a `running` flag, so a second trigger while one runs returns `skipped`.
- **Production timers:** with `JOBS_MODE=external` (set in `render.yaml`), `main.ts` starts **no** in-process timers and runs **nothing** at startup. With `JOBS_MODE=internal` (the default, for local dev and tests), today's behaviour stays.

## Decisions (Claude Code, under Dvir's delegation)

| # | Decision | Why |
|---|---|---|
| H1 | **The Worker's crons:** `0 * * * *` → `{"job":"tick"}` (reconciler + NS verifier if due) and `30 0 * * *` → `{"job":"daily"}` (price job → drop job → registrar check → backup export). Two trigger kinds keep the daily work out of hourly wakes | Within the Render and Neon free limits |
| H2 | **The reconciler runs hourly in production** (was every 10 min). buy.md's "30-minute rule" still holds: a purchase is resolved on the first run after 30 min (≤ 90 min). Spec-sync note | Free-tier compute |
| H3 | **NS verifier:** runs from `tick`, but at most once per 24 h, tracked by the last `ns-verify` audit row's time | Keeps the daily cadence without a separate trigger |
| H4 | **`GET /health/ping`**: no auth, no DB, returns `{"status":"ok"}`. `render.yaml` `healthCheckPath` points at it, so Render's checks don't keep Neon awake. `/health` (with the DB check) stays for humans | trader pattern |
| H5 | **Backup export (backup.md Layer 2)** runs as part of `daily`, not as a Render cron (Render crons are billed). Files and rules exactly as backup.md: the CSVs/JSON, redaction, no commit when unchanged, missing token → warning and exit 0. It is a GitHub contents-API commit to `data-backup` only. `npm run job -- export-backup` runs it by hand, and `npm run job -- import-backup` is the restore path (BK-3) | backup.md + $0 |
| H6 | **Direct-connection guard:** with `APP_ENV=production` and a `DATABASE_URL` host containing `-pooler.` → refuse to start with a clear message. `DATABASE_SSL=true` turns on TLS (Neon requires it) | Session advisory locks |
| H7 | **Startup migrations** run from compiled JS in `startCommand` (`npm run migrate up && node dist/main.js`). Render free has no pre-deploy step. node-pg-migrate runs plain SQL, so no in-process TS compiling (the sapako lesson) | Free tier |

---

### Task 1: Job endpoint, `JOBS_MODE`, `/health/ping`, DB TLS and the direct-connection guard
**Files:** `src/api/jobs.ts`, `src/jobs/runner.ts` (`tick`, `daily` orchestration), `src/main.ts`, `src/config.ts` (`JOBS_MODE`, `JOB_TRIGGER_TOKEN`, `DATABASE_SSL`, pooler guard), `src/db/client.ts` (TLS when `DATABASE_SSL=true`), `src/api/health.ts` (`/health/ping`), `.env.example`, tests.

**Tests:**
- 401 without or with a wrong bearer (audited);
- 503 when the token isn't configured;
- `tick` runs the reconciler, and the NS verifier only when 24 h have passed;
- `daily` runs price → drop → registrar check → export in order, with errors isolated (one failing job doesn't skip the others) and a per-job result summary;
- a same-key replay → the stored response;
- a concurrent second `daily` → `skipped`;
- `JOBS_MODE=external` → `main` starts no timers and runs nothing at startup (test the factored startup function);
- `/health/ping` → 200 with no DB call (stub db that throws);
- the pooler URL guard → startup error in production;
- `DATABASE_SSL` → pg ssl option set;
- `/jobs/run` doesn't accept READ/WRITE API tokens.

### Task 2: Backup export and import (backup.md, BK-1–BK-4)
**Files:** `src/jobs/backup-export.ts`, `src/jobs/backup-import.ts`, `src/job.ts` subcommands, wired into `daily`.
- Writes `backup/portfolio.csv`, `backup/ledger.csv` (the `cfo-ledger` header), `backup/purchases.json`, `backup/receipts.json` (addresses redacted with the existing `redactInvoice`), `backup/audit.jsonl` (approval text kept, `client_ip` dropped), plus `offers.csv`, `sales.json` and `payouts.json`. Those three tables came after backup.md; spec-sync note.
- Commits through the GitHub contents API (`GITHUB_BACKUP_TOKEN`, `GITHUB_BACKUP_REPO`, `GITHUB_BACKUP_BRANCH`, default `data-backup`) as one commit via the git data API (tree + commit + ref update). If the branch doesn't exist, it's created from an orphan commit. Skipped when every file's content hash equals the branch's.
- **Never touches `main`:** the branch must not be `main`/`master`, else refused.

**Tests** (GitHub API mocked with MSW):
- BK-1: the files are written, the headers are exact, and a grep test finds no `pk1_`/`sk1_`/token/billing address;
- BK-2: unchanged → no commit;
- BK-3: import round trip into an empty DB → `/report` JSON identical;
- BK-4: no token → warning, exit 0, the service is unaffected;
- branch `main` → refused.

### Task 3: Cloudflare Worker `jobs-trigger/` + deploy workflow
**Files:** `jobs-trigger/{package.json,tsconfig.json,vitest.config.ts,wrangler.jsonc,src/index.ts,src/index.test.ts}`, `.github/workflows/deploy-jobs-trigger.yml`. Copy trader's keepalive structure.
- `wrangler.jsonc`: name `domain-trading-jobs`, `workers_dev: false`, crons `["0 * * * *", "30 0 * * *"]`, var `API_BASE_URL` (set by the workflow from a repo variable), secret `JOB_TRIGGER_TOKEN` (set by the workflow with `wrangler secret put` from a repo secret).
- `scheduled(controller)`: map `controller.cron` → job (`tick`/`daily`), then `POST {API_BASE_URL}/jobs/run` with the bearer, `Idempotency-Key: <cron>-<scheduledTime>` and a 90 s timeout to cover the cold start. Log a non-2xx. Never throw.
- **Workflow:** on main pushes touching `jobs-trigger/**`, run `npm ci`, test, typecheck and `wrangler deploy --dry-run`; on main, deploy with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets.

**Tests** (vitest in `jobs-trigger`, fetch mocked):
- the cron → body mapping;
- the headers (bearer, idempotency key);
- the timeout;
- a non-2xx is logged without throwing;
- the token never appears in log output.

The root `npx vitest run` doesn't include `jobs-trigger/` (it has its own config).

### Task 4: `render.yaml` (free), `docs/DEPLOYMENT.md`, docs/runbook
- **`render.yaml`:**
  - `plan: free`, `region: frankfurt`, `NODE_VERSION` 22.x;
  - `buildCommand: npm ci --include=dev && npm run build && npm prune --omit=dev`;
  - `startCommand: npm run migrate up && node dist/main.js`;
  - `healthCheckPath: /health/ping`;
  - `autoDeployTrigger: 'off'`.
  - env: `APP_ENV=production`, `JOBS_MODE=external`, `DATABASE_SSL=true`, `LANDER_TARGET=afternic`, `ENABLED_REGISTRARS=porkbun,godaddy`;
  - secrets with `sync: false`: `DATABASE_URL`, `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY`, `GODADDY_PAT`, `GITHUB_BACKUP_TOKEN`, `JOB_TRIGGER_TOKEN`;
  - remove the stale caps and geo env vars (caps live in the DB), the database block, and the cron block.

  Check the `migrate` script works from the compiled output with prod dependencies only. If node-pg-migrate is a devDependency, move it to dependencies.
- **`docs/DEPLOYMENT.md`:** step by step, like sapako's.
  1. **Neon:** create a project in `eu-central-1` and copy the **direct** (non-pooler) string, because session locks need it.
  2. **Render:** New → Blueprint → this repo, then paste the secrets. Generate `JOB_TRIGGER_TOKEN` with `openssl rand -hex 32`.
  3. **Porkbun:** create a key pair, turn on Opt In All Domains, set a monthly spend limit, keep auto top-up off, and paste the pair into Render only.
  4. **GitHub:** a fine-grained PAT, this repo only, Contents R/W, for `GITHUB_BACKUP_TOKEN`; the repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `JOB_TRIGGER_TOKEN`; the repo variable `API_BASE_URL`.
  5. **First deploy:** watch the migrations, then `GET /health`.
  6. **Tokens:** `npm run admin -- token create` for Gavriel (write) and Gizbar (read), run locally with `DATABASE_URL` set to the Neon direct string.
  7. **D-001:** import it with the exact command from report.md.
  8. **Checks:** the G3 live read-only checklist.
  9. **Restore drill (BK-5):** run it before G4.

  Note the Render 750-hour shared workspace caveat.
- **`docs/runbook.md`:** G2 commands (`test:contract:*`), G3 checklist, restore drill.

---

### Task 5 (Opus): Review, then report to Dvir with the setup checklist and the spec-sync note for Gavriel
The spec-sync note covers:
- backup.md Layers 1/2 and BK-6 under free hosting;
- 00-architecture §8;
- the reconciler running hourly (H2);
- `/jobs/run` and `/health/ping`;
- `JOBS_MODE`;
- the G2 command row (`VITEST_CONTRACT`).
