# Deployment (free: Render + Neon + Cloudflare Worker)

Everything runs at $0/month, the same pattern as trader and sapako.

| Piece | Host | Config |
|---|---|---|
| API | Render free web service | `render.yaml` (Blueprint) |
| Postgres | Neon free | none: `DATABASE_URL` is set by hand |
| Scheduled jobs | Cloudflare Worker cron `jobs-trigger/` | `.github/workflows/deploy-jobs-trigger.yml` |
| Backups | A private GitHub data repo, branch `data-backup` | written by the daily job |

Render's free Postgres expires and Render crons are billed, so neither is used. Do the steps in order.
Never paste a secret into chat, a commit, an issue or a log.

## 1. Neon (database)

1. neon.tech -> New project. Region **eu-central-1 (Frankfurt)**, **Postgres version 16** (pick it explicitly), next to Render's `frankfurt`.
2. Connect -> turn the **Connection pooling toggle OFF** and copy the **direct** string:
   `postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=verify-full`
   (no `-pooler` in the host).
3. Make sure it ends with exactly `?sslmode=verify-full` (production refuses to start with `require` or no sslmode; `verify-full` also makes `npm run migrate` verify the certificate): remove `&channel_binding=require` if Neon added it, and replace `sslmode=require` with `verify-full`.
   Why direct: the per-domain lock is a **session** advisory lock, which breaks behind Neon's transaction-mode pooler.
   The server refuses a `-pooler.` host when `APP_ENV=production`. Why TLS: Neon requires it, and `node-pg-migrate`
   reads TLS settings only from this URL.

Also keep the string for the admin commands (steps 7-8) in a local file, never in `.env` and never inline on a command line:

```bash
cat > .env.neon <<'EOT'
DATABASE_URL=<neon direct string>
DATABASE_SSL=true
EOT
chmod 600 .env.neon      # already covered by .gitignore (.env.*)
```

Every Neon command below runs in a subshell so the values never leak into your shell:
`(set -a; . ./.env.neon; set +a; npm run admin -- ...)`.

## 2. GitHub: private data repo for backups

1. github.com -> New repository `DvirBaumel8/domain-trading-data`. **Private**, **initialized with a README** (GitHub's git data API refuses an empty repo with no commits: 409 "Git Repository is empty"; the export then fails with "backup repo has no commits; initialize it with a README"). It must never be the code repo:
   the server refuses it, and every backup run checks the repo is private.
2. Settings -> Developer settings -> Fine-grained tokens -> Generate:
   - Repository access: **Only select repositories** -> `domain-trading-data` only.
   - Permissions: **Contents: Read and write** (nothing else).
   - Expiry: **1 year** (put the renewal date in your calendar).
   This is `GITHUB_BACKUP_TOKEN`. The repo is `GITHUB_BACKUP_REPO=DvirBaumel8/domain-trading-data`. The branch is fixed: `data-backup`.

## 3. Generate the job trigger token

```bash
openssl rand -hex 32
```

That is `JOB_TRIGGER_TOKEN` (64 chars; the minimum is 32). It authorises only `POST /jobs/run`, not the READ/WRITE API.
You need the **same value** in Render (step 5) and in a GitHub repo secret (step 6).

## 4. Porkbun

1. porkbun.com/account/api -> **Create API Key**. Make a **new** pair (`pk1_...` and `sk1_...`), not one used elsewhere.
2. Same page: turn **Opt In All Domains ON**, and set a **Monthly API spend limit** (the default is $100).
3. Keep **auto top-up OFF** (Account -> Credit), and keep the account credit at **$0 until G4**. Do not add credit before G4; credit is added only at G4, with Dvir present, for the one approved buy. The prepaid credit is a second spending limit.
4. IP allowlist: **skip it**. Render free uses shared outbound IPs that change.
5. Account must have verified email and phone (else `VERIFICATION_REQUIRED`).
6. Paste the pair into Render only (step 5). Never into chat, the repo or `.env.example`.

## 5. Render (API)

0. **Workspace first.** trader and sapako each run a 24/7 keep-alive (~730 instance hours each), and the free tier gives only **750 hours per workspace per month**. Create a **new free Render workspace** for domain-trading (or use one with no always-on service). After a few days, check the workspace's free-usage page: domain-trading should show roughly 180 h/month.
1. In that workspace: New -> **Blueprint** -> connect `DvirBaumel8/domain-trading`. It reads `render.yaml`. The first deploy **starts automatically** when the Blueprint is created (auto-deploy is off only for later pushes).
2. Fill the `sync: false` prompts:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon **direct** string from step 1 |
   | `PORKBUN_API_KEY` / `PORKBUN_SECRET_API_KEY` | the pair from step 4 |
   | `GODADDY_PAT` | a GoDaddy PAT with `domains.domain:read` + `domains.nameserver:update`; leave blank if you don't have one (NS is then manual) |
   | `GITHUB_BACKUP_TOKEN` | the PAT from step 2 |
   | `GITHUB_BACKUP_REPO` | `DvirBaumel8/domain-trading-data` |
   | `JOB_TRIGGER_TOKEN` | the value from step 3 |

   The blueprint already sets `APP_ENV=production`, `DATABASE_SSL=true`, `LANDER_TARGET=afternic`,
   `ENABLED_REGISTRARS=porkbun,godaddy`. Later pushes do not deploy by themselves: use Manual Deploy.
3. The first start runs the migrations (`npm run migrate up`) and then boots. Watch the logs for `Migrations complete!` and `Server listening`.
4. Check, replacing the URL with yours (the first request may take ~50 s):
   ```bash
   curl -s https://domain-trading-api.onrender.com/health/ping   # {"status":"ok"}
   curl -s -H "Authorization: Bearer $READ_TOKEN" https://domain-trading-api.onrender.com/health        # "db":"ok", adapters listed
   ```
5. Note the service URL.

## 6. Cloudflare Worker cron (GitHub repo settings)

The Worker calls `POST /jobs/run` hourly (`tick`: reconciler, NS verifier if due) and daily at 00:05 UTC (shortly after the 00:00 tick, on the instance it already woke) (`daily`: price job, drops, registrar check, backup export).

1. Repo -> Settings -> Secrets and variables -> Actions -> **Secrets**:
   - `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`: the same values as the trader repo. GitHub secrets cannot be read back: if you did not store the old token, create a new one in Cloudflare (My Profile -> API Tokens -> Create Token, template **Edit Cloudflare Workers**).
   - Cloudflare's free plan limits **cron triggers per account** (check the current limit in the Cloudflare dashboard; trader and sapako already use some). This Worker needs 2.
   - `JOB_TRIGGER_TOKEN`: the same value as in Render.
2. **Variables** -> `API_BASE_URL` = the Render URL from step 5 (`https://domain-trading-api.onrender.com`, no trailing slash).
3. Actions -> `deploy-jobs-trigger` -> **Run workflow** (it only deploys on main and when `API_BASE_URL` is set).
4. Verify: Cloudflare dashboard -> Workers -> `domain-trading-jobs` -> Triggers shows the two crons. After the next full hour,
   `GET /audit` (READ token) has a row for `jobs/run` with scope `job`. A 401 there means the tokens differ.

## 7. API tokens for the bots

From your laptop, in the repo, against Neon (the plain token is printed **once**):

```bash
(set -a; . ./.env.neon; set +a; npm run admin -- token create --scope write --name gavriel)
(set -a; . ./.env.neon; set +a; npm run admin -- token create --scope read  --name gizbar)
```

Hand each token to its bot through the bot's secret store, not through a chat log. Gavriel gets only the WRITE token, Gizbar only the READ token.

## 8. Import D-001

Run it in the same `.env.neon` subshell. **Dry run first**, check the output, then drop `--dry-run`:

```bash
(set -a; . ./.env.neon; set +a; npm run admin -- import-domain --domain promptinjectionaudit.com --registrar godaddy --buy-date 2026-10-04 --cost 13.73 --cost-note "42 ILS @0.3269" --order none --deal D-001 --category trend --listing-mode hybrid --bin 1995 --floor 1295 --walkaway 950 --pricing-exception "Dvir approved 2026-10-05 00:39 IDT" --legacy-no-comps "bought before the comps rule; card found no comps" --approval-text "Approve the prices, but wait for the software to list it" --approval-at 2026-10-05T00:39:00+03:00 --manual --expiry 2027-10-04 --dry-run)
```

Optional: add `--renewal-price <GoDaddy renewal price, auto-renew off>` once known. Without it `/report` shows `RENEWAL_PRICE_UNKNOWN` and `committed_forward` is marked incomplete.

(`docs/specs/report.md` §Import is the source. `--manual` because GoDaddy is not an API source for this account; use the API path only if `GODADDY_PAT` is set and the account is eligible.)

## 9. G3: live read-only checks (no real purchase)

Use the READ and WRITE tokens (Gavriel runs these; see `docs/specs/test-plan.md` G3). Note the Porkbun balance and invoice list first. The Porkbun credit must be **$0** (see step 4).

1. `GET /health` (with a READ token) -> `db: ok`; `GET /health/ping` -> ok.
2. **CK-12:** `GET /check?domain=<a random unregistered .com>` -> `available`, Porkbun first-year and renewal equal Porkbun's public `pricing/get` .com prices (within $0.01). `GET /check?domain=promptinjectionaudit.com` -> `taken`, no winner.
3. **IM-4:** `GET /portfolio/promptinjectionaudit.com` -> registrar `godaddy`, cost $13.73, expiry 2027-10-04, `drop_date` 2028-10-04, category `trend`, hybrid 1995 / 1295 / walk-away 950 (private) / min offer 100, `pricing_source=approved_exception`, 4 schedule rows. `/ledger` holds only the D-001 row.
4. `GET /report` -> sane totals, no unexpected warnings.
5. `POST /buy` with **`"dry_run": true` set explicitly in the body** for a free test .com Dvir is willing to buy (a fresh `Idempotency-Key`; `approval_ref` text naming the domain; the other required fields per `docs/specs/buy.md`). With $0 credit the expected result is `INSUFFICIENT_FUNDS` (`REGISTRAR_FUNDS`) or the equivalent, and **that is a pass**. `wouldSucceed: true` or `VERIFICATION_REQUIRED` are also acceptable results. Never send the call without `dry_run: true` before G4.
6. **Pass criteria:** Porkbun balance, invoices and spend unchanged; audit rows present. **Any charge: stop everything, contact Porkbun support, revoke the WRITE token** (`npm run admin -- token revoke --id <id>`).

## 10. Restore drill (BK-5), before the first real buy

Required before G4. Steps are in `docs/runbook.md` (Restore drill). The first nightly export runs in the `daily` job at 00:05 UTC. To force one now, call the daily job over HTTP (the backup PAT stays in Render only, so do not use the laptop job CLI):

```bash
API=https://domain-trading-api.onrender.com
read -rs JOB_TRIGGER_TOKEN
curl -sS -X POST "$API/jobs/run" -H "Authorization: Bearer $JOB_TRIGGER_TOKEN" \
  -H "Idempotency-Key: manual-$(date +%s)" -H 'Content-Type: application/json' -d '{"job":"daily"}'
unset JOB_TRIGGER_TOKEN
```

Check the `export` step in the reply, then that the `data-backup` branch has a new commit. Report the result to Dvir: `/report` on the restored DB must equal production.

## 11. Caveats

- **Render 750 instance-hours per workspace per month.** trader and sapako each run a 24/7 keep-alive (~730 h each), so this service needs its own workspace (step 5). It is woken hourly (~180 h/month). **Do not add a keep-warm ping**;
  if a workspace runs out, every free service in it stops.
- **Cold start ~50 s.** Bots should use request timeouts of at least 60 s and retry once. The Worker uses 90 s.
- **Reconciler runs hourly** in production (was every 10 min), so a stuck purchase resolves within about 90 min.
- **Neon free:** 100 CU-hours per project per month, 1 GB, scale-to-zero after 5 min, only 6 hours of point-in-time history. The nightly `data-backup` export and your monthly manual dump are the real safety net. Hourly wakes use roughly 15 CU-h.
- **GoDaddy:** changing nameservers through the PAT may be refused for this account (403 `ACCOUNT_NOT_ELIGIBLE`). Then change NS by hand in GoDaddy and the NS verifier checks public DNS (`docs/specs/list.md` step 4). GoDaddy is never a buying source here.
- Check in GoDaddy that auto-renew is OFF for D-001 (renewals bill the card; the server cap cannot block them).
- **Idempotency keys:** the hourly Worker calls add a small `idempotency_keys` row each (about 8,800 a year). The growth is fine for now (1 GB Neon); prune later if it ever matters.
