# CLAUDE.md: domain-trading API

You are building this service with **Dvir** (a senior backend developer, short on time). Read this file first, then `docs/specs/00-architecture.md`, then the spec for the part you're working on. **The specs are the contract.** If code and spec disagree, stop and ask Dvir; don't silently change either.

## What this is
- A small **backend service: HTTP API + Postgres, no frontend.** It runs a domain-name trading proof of concept with these limits:
  - **$500 total budget**;
  - **at most 10 domains**;
  - each domain is held **at most 2 years** (bought for 1 year, renewed **at most once**).
- It lets Dvir's chat bot **Gavriel** (on another machine) do the following over HTTPS with bearer tokens:
  - check prices across registrars;
  - buy a domain **after Dvir approves it in chat**;
  - point a domain at a for-sale lander;
  - export marketplace bulk-upload files;
  - record sales;
  - report spend, sales, ROI, budget and upcoming dates.
- Gizbar, the CFO bot, reads `/report` and `/ledger` with a READ token.

## Founder rules (non-negotiable; enforce them in code, not just in docs)
1. **Every purchase requires Dvir's explicit chat approval.** Gavriel passes it as `approval_ref {text, approved_at}`. The server validates it: present, ≤72 h old, not in the future, names the domain. The server **can't** prove a human said it; that trust boundary is accepted and documented.
2. **Caps live on the server:** $500 POC cap, 10 domains, per-call `max_price`. Caps change only through the admin command or a migration, **never through the API**.
3. **Max one renewal per domain.** Prices are compared on first year + one renewal. `renewals_used` is 0..1 (DB CHECK). `drop_date = expiry + 1 year`. 1-year registrations only.
4. **Listing strategy by category** (`docs/specs/listing-strategy.md`):
   - Geo names: strict Buy It Now in [$299, $499], with no negotiation.
   - Trend, B2B and other high-value names: `offer` or `hybrid` only. They are never a plain BIN below $2,500 unless there is an explicit override **plus** Dvir's `approval_ref`.
   - Every domain has a `category`. Every mode or price change is validated, audited and appended to `listing_history`.
5. **Never Cloudflare Registrar** (no third-party nameservers, so no for-sale lander). Never premium or aftermarket names, auctions or backorders.
6. **Never top up a registrar balance**, and never call any top-up endpoint. The prepaid balance is a second spending limit.
7. **Registrar keys exist only as server env secrets.** They are never logged, never returned, never in git, and never in test fixtures (use fake values).
8. **Every POST is idempotent** (`Idempotency-Key` required) and **audited** (`audit_log`, append-only). `ledger_entries` is append-only too; corrections are reversing rows.
9. **No LLM calls inside the service.** Zero runtime tokens.
10. **The service never sends email or chat and never contacts buyers.** Gavriel talks to Dvir.
11. **Bots never add code to this repo.** Dvir (with you, Claude Code) writes the code. Gavriel only pushes spec docs that Dvir has reviewed. The optional backup cron pushes data only, to the `data-backup` branch.
12. **No live registrar `create` call without Dvir present** and without his chat approval for that domain. Tests use mocks, Porkbun's mock server, or Porkbun's sandbox (`pk1_sb_` keys).

## Decisions log (IDT, all 3 Oct 2026)
- 18:58: the architecture is an **API service + Postgres on Render**, with READ/WRITE bearer tokens and server-side caps. This replaces the earlier local-CLI design; a thin CLI is optional for v1.1.
- Max one renewal per domain, held 2 years at most.
- 19:01 / 19:17: Dvir bought D-001 (promptinjectionaudit.com) **by hand at GoDaddy** (not Porkbun) on 2026-10-03; price and order number pending. The service imports manual buys with an admin command (`report.md` §Import). GoDaddy is a **management-only** adapter: it can change NS with a PAT, since the account has ≥1 domain, but it can't check availability or buy (that needs 50+ domains). Fallback: Dvir changes NS by hand.
- 19:17: **listing strategy**: listing modes `bin` / `offer` / `hybrid` per category, with server guards. Dvir's `dt list … --bin/--offer` wording maps to `POST /list` fields; a thin CLI is optional (`docs/specs/cli.md`). D-001 is category trend, mode hybrid, BIN $1,995 / floor $950 (Dvir may raise the BIN).
- Multi-registrar support via an adapter interface; the cheapest **first year + one renewal** wins; Porkbun is the first adapter.
- Default lander is **Afternic** (`ns1/ns2.afternic.com`). **Dan.com was retired on 27 Jun 2025** and merged into Afternic. Sedo is a second listing (no Sedo nameservers by default).
- Marketplace uploads stay manual: CSV exports, Dvir uploads weekly. There is no marketplace API.
- No Gmail/mail-watching: marketplaces notify Dvir directly.

## Conventions
- **Money:** integer **cents, USD**. Responses carry `*_cents` plus a display string (`"$11.08"`). Never use floats for money.
- **Time:** stored as `timestamptz` in UTC. API output is ISO 8601 with an offset; reports render Asia/Jerusalem (IDT/IST).
- **Errors:** `{"error":{"code":"UPPER_SNAKE","message":"…","details":{}}}`. Codes are stable and listed in the specs. Branch on registrar error **codes**, never on messages.
- **Domains:** lowercase in the DB; `display_name` holds the CamelCase form for marketplaces.
- **Stack (default; Dvir may change it):** Python 3.12, FastAPI, SQLAlchemy 2, Alembic, httpx, pydantic, pytest, respx. Postgres 16 (docker locally).
- **Layout (suggested):** `app/main.py`, `app/api/*`, `app/db/*` (models + migrations), `app/registrars/{base,porkbun,…}.py`, `app/services/{selection,buy,listing,report,export}.py`, `app/admin.py`, `app/jobs/*`, `tests/{unit,api,contract}`.
- **No network calls in unit and API tests** (a socket-blocking fixture). Contract tests are marked and opt-in.

## Data formats that must match exactly
- **Afternic bulk CSV header** (from the official template in `templates/afternic_bulk_upload_sample_v3.xlsx`):
  `Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden`
- **Sedo bulk file:** the headers are **not public**. They come from `templates/sedo_template.json`, which Dvir fills in from Sedo's example file. Until then the endpoint returns 501. Don't guess.
- **`/ledger?format=csv`:** `date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note`.

## Where things are

| File | What |
|---|---|
| `docs/specs/00-architecture.md` | Endpoints, data model, adapter interface, Porkbun mapping, auth, errors, hosting, risks |
| `docs/specs/check.md` | `GET /check`: availability + price comparison |
| `docs/specs/buy.md` | `POST /buy`: checks, purchase flow, reconciler |
| `docs/specs/list.md` | `POST /list/{domain}`: lander nameservers, the manual-NS fallback, DNS verification |
| `docs/specs/listing-strategy.md` | Categories, modes (bin/offer/hybrid), guards, Afternic/Sedo support per mode, export mapping, LS/LG/LH/LX tests |
| `docs/specs/cli.md` | Optional thin `dt` CLI with Dvir's flags |
| `docs/specs/export-csv.md` | Afternic and Sedo exports |
| `docs/specs/sold.md` | `POST /sold/{domain}` |
| `docs/specs/report.md` | `/report`, `/portfolio`, `/ledger`, `/deals`, `/audit`, `/health` |
| `docs/specs/backup.md` | Render backups, nightly git export, restore drill |
| `docs/specs/test-plan.md` | Gates G0–G5, cross-cutting tests, kill criteria |
| `docs/research/registrars.md` | Vendor comparison with sources; what is verified and what isn't |
| `docs/research/marketplaces.md` | Afternic/Sedo facts with sources |
| `render.yaml` | Hosting sketch (price unverified; Dvir approves the spend) |
| `.env.example` | Every server env var, with how to get each key |

## Build order (stop at each gate; show Dvir the results)
1. Skeleton, DB models, migrations (append-only triggers, CHECK constraints), auth, audit, idempotency middleware, `/health`. Then G0/G1 for these.
2. Registrar adapter base + Porkbun adapter + selection logic + `/check`. Then G0/G1.
3. `/buy` with all checks, the locks and the reconciler. Then G1 (B-1–B-25, CAP-*, ID-*, DR-*).
4. Listing strategy (`listing-strategy.md`: categories, modes, guards, `listing_history`), then `/list`, exports per mode, `/sold`, `/report`, the read endpoints, and `import-domain` (including GoDaddy `--manual`). Then G1.
5. Porkbun mock-server and sandbox contract tests. Then **G2**.
6. Deploy to Render (after Dvir approves the cost), create the tokens, run the live read-only checks. Then **G3**.
7. First real API buy (the next approved deal; D-001 was bought by hand on 3 Oct and is imported at G3 with `app.admin import-domain`), only with Dvir present and his chat approval. Then **G4**. Post-acquisition checks follow (G5).
8. Optional: the backup cron + restore drill (the BK-5 drill is required before G4).

## Don't
- Don't add a frontend, a token-creation endpoint, a settings-write endpoint, multi-year registration, auto-renew ON, or marketplace scraping.
- Don't put a real key, token or personal address in code, fixtures, logs or commits.
- Don't "fix" a failing spec test by editing the test to match the code without Dvir's OK.
