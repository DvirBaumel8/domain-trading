# CLAUDE.md: domain-trading API

You are building this service with **Dvir** (a senior backend developer, short on time). Read this file first, then `docs/specs/00-architecture.md`, then the spec for the part you're working on. **The specs are the contract.** If code and spec disagree, stop and ask Dvir; don't silently change either.

## What this is
- A small **backend service: HTTP API + Postgres, no frontend.** It runs a domain-name trading proof of concept with these limits:
  - **$1,500 total budget** (raised from $500; Dvir, 5 Oct 2026, 01:04 IDT);
  - **at most 50 domains** (raised from 10, same decision);
  - each domain is held **at most 2 years** (bought for 1 year, renewed **at most once**).
- It lets Dvir's chat bot **Gavriel** (on another machine) do the following over HTTPS with bearer tokens:
  - check prices across registrars;
  - buy a domain **after Dvir approves it in chat**;
  - point a domain at a for-sale lander;
  - compute each name's sell plan (floor, walk-away, price-drop schedule) from its BIN and category, and apply the scheduled drops;
  - log every offer received (`POST /offers`, or a CSV import) and report offer counts and highest offers as a demand signal;
  - export marketplace bulk-upload files;
  - record sales;
  - report spend, sales, ROI, budget and upcoming dates.
- Gizbar, the CFO bot, reads `/report` and `/ledger` with a READ token.

## Founder rules (non-negotiable; enforce them in code, not just in docs)
1. **Every purchase requires Dvir's explicit chat approval.** Gavriel passes it as `approval_ref {text, approved_at}`. The server validates it: present, ≤72 h old, not in the future, names the domain. The server **can't** prove a human said it; that trust boundary is accepted and documented.
2. **Caps live on the server:** $1,500 POC cap, 50 domains, per-call `max_price`. Caps change only through the admin command or a migration, **never through the API**.
3. **Max one renewal per domain.** Prices are compared on first year + one renewal. `renewals_used` is 0..1 (DB CHECK). `drop_date = expiry + 1 year`. 1-year registrations only.
4. **Listing and pricing by category** (`docs/specs/listing-strategy.md`; pricing process adopted by Dvir on 5 Oct 2026, 00:46 IDT):
   - **Geo names:** `bin` only, at a fixed grade price ($499 strong / $399 weaker), with no offers and no negotiation. At most one scheduled drop: $499 → $399 at month 12; a $399 name never drops (no $299).
   - **Every other category:** `hybrid`. The **server computes** floor = 65% of BIN (never below $750) and a **private** walk-away = max(48% of BIN, $500), never above the floor (also after drops), from `pricing_settings`. The marketplace **min offer is $100** (`hybrid_min_offer`), never the walk-away, and the walk-away is never exported. `offer` or plain `bin` only with an override **plus** Dvir's `approval_ref`.
   - **Scheduled drops (non-geo):** −20% at month 6 and month 18 (counted from the first listing date), a final push at `drop_date − 90` (BIN to the floor, rounded up to x95), and a delist at `drop_date − 7`. They are pre-approved by the buy approval and applied by a daily job, which never calls a registrar or marketplace.
   - **Every buy needs 2–3 comparable sales** (`pricing_evidence`).
   - **Pricing numbers live in `pricing_settings`**, versioned and append-only, changed only by the admin command. **Never hard-code** 65/48/20/750/500/100/499/399 in logic. The settings version changes whenever an output rule changes (current: **v2**).
   - Every domain has a `category`. Every mode or price change (manual or scheduled) is validated, audited and appended to `listing_history`.
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
- 19:01 / 19:17: Dvir bought D-001 (promptinjectionaudit.com) **by hand at GoDaddy** (not Porkbun). *Corrected 5 Oct:* the registry shows it **registered on 2026-10-04** (13:16Z); cost $13.73 (42 ILS); no order number. The service imports manual buys with an admin command (`report.md` §Import). GoDaddy is a **management-only** adapter: it can change NS with a PAT, since the account has ≥1 domain, but it can't check availability or buy (that needs 50+ domains). Fallback: Dvir changes NS by hand.
- 19:17: **listing strategy**: listing modes `bin` / `offer` / `hybrid` per category, with server guards. Dvir's `dt list … --bin/--offer` wording maps to `POST /list` fields; a thin CLI is optional (`docs/specs/cli.md`). D-001 is category trend, mode hybrid. *(Superseded on 5 Oct: see below.)*
- Multi-registrar support via an adapter interface; the cheapest **first year + one renewal** wins; Porkbun is the first adapter.
- Default lander is **Afternic** (`ns1/ns2.afternic.com`). **Dan.com was retired on 27 Jun 2025** and merged into Afternic. Sedo is a second listing (no Sedo nameservers by default).
- Marketplace uploads stay manual: CSV exports, Dvir uploads weekly. There is no marketplace API.
- No Gmail/mail-watching: marketplaces notify Dvir directly.
- 4 Oct 2026: stack switched from Python to **TypeScript** (Node 22, Fastify, Kysely, Vitest, MSW). Docs updated; no behaviour change.
- **5 Oct 2026, 00:39:** D-001's approved plan is BIN $1,995 / floor $1,295 / walk-away $950 (an approved exception; the formula gives $960; min offer $100 since 01:03), with lease-to-own off. Listing waits for this service.
- **5 Oct 2026, 00:46: pricing process adopted** (`listing-strategy.md` §10):
  - comps on every buy card;
  - fixed geo grade prices;
  - computed hybrid floor and walk-away;
  - scheduled drops with heads-ups only;
  - one approval on the buy card;
  - a quarterly review that changes `pricing_settings` (a new version), not code.
  - **Rounding:** BIN ends in 95 (geo 99), and floor and walk-away go to the nearest $5.
- **5 Oct 2026, 01:03: decision #2, minimum offer and offers log.** Marketplace min offer = **$100** on every non-geo listing; the walk-away becomes a private threshold. Offers from $100 up to the walk-away are declined automatically but **logged** in an `offers` table. Offers from walk-away up to the floor go to Dvir; at or above the floor, Afternic auto-accepts. `POST /offers` (WRITE) + CSV import; `/report` shows per-domain offer counts and highest offers per period, plus per-strategy aggregates. Tests OF-1–OF-20.
- **5 Oct 2026, 09:17: pricing settings v2** (Dvir; pushed with this spec update): walk-away never below $500 (also after drops); geo gets at most one drop ($499 → $399 at month 12; no $299); Sedo is Make Offer with the $100 minimum (geo: min = BIN), resolving `SEDO_NO_FLOOR`; the drop clock counts from the first listing (decided). Calculator fixes: version label bumped to v2; the hybrid final push = BIN to the floor rounded up to x95 (floor and walk-away unchanged), replacing the flat $795. Phase-later docs: `GET /check/batch`, S7 auction `max_bid`. **Note:** the listing rules already built in step 1–3 code (geo [$299, $499] and high-value guards) must be updated to this spec in step 4.
- **5 Oct 2026, 19:42: payouts persisted + spec sync** (Dvir; step 4d-1). `/sold`'s optional payout is stored in a new `payouts` table (not a ledger row: the `sale` row already counts the money), linked to the sale and `payout_fee` rows, one per sale; facts immutable, `received_on` set once; warning `PAYOUT_MISMATCH` (> $1); `/report` `payouts_pending` + `PAYOUT_OVERDUE` (> 30 days). `POST /payouts/{id}/received` is v1 pending Dvir's confirmation at the 4d-1 gate. Synced: a `delisted` domain can be sold; `/sold` `offer_id` links the offer; `npm run admin -- drop-at-first-expiry` (Gate F; CHECK allows `drop_date = expiry_date`); GoDaddy `/list` may return `ns_status: "pending"`. Specs: `sold.md`, `00-architecture.md`, `report.md`, `list.md`, `cli.md`, `test-plan.md` (PO-1–PO-5).
- **5 Oct 2026, 19:47: sold is system-triggered** (Dvir). Gavriel calls `POST /sold/{domain}` automatically on a marketplace sale notification; no approval needed. `approval_ref` is optional; without it `transaction_ref` + `evidence {source, ref}` are required (422 `EVIDENCE_REQUIRED`). Same `venue` + `transaction_ref` → 409 `SALE_ALREADY_RECORDED`. New `sales` table (`recorded_by`, `confirmed`, evidence, `sale_ledger_id`; immutable). `/report`: `SALE_UNCONFIRMED` (info only) and `DOMAIN_LEFT_ACCOUNT` (daily registrar check). `POST /buy` still needs approval. Specs: `sold.md`, `00-architecture.md` §4/§6/§9, `report.md`, `cli.md`, `test-plan.md` (AU-10, SL-1–SL-7).
- **5 Oct 2026, 01:04: caps raised.** POC budget cap **$1,500** (`poc_cap_cents` 150000) and domain cap **50** (`max_domains` 50), confirmed by Dvir. The sales goal (several sales > $500 each) is unchanged.

## Conventions
- **Money:** integer **cents, USD**. Responses carry `*_cents` plus a display string (`"$11.08"`). Never use floats for money.
- **Time:** stored as `timestamptz` in UTC. API output is ISO 8601 with an offset; reports render Asia/Jerusalem (IDT/IST).
- **Errors:** `{"error":{"code":"UPPER_SNAKE","message":"…","details":{}}}`. Codes are stable and listed in the specs. Branch on registrar error **codes**, never on messages.
- **Domains:** lowercase in the DB; `display_name` holds the CamelCase form for marketplaces.
- **Stack (chosen by Dvir, 4 Oct 2026):** Node 22 LTS, TypeScript (strict), Fastify, zod, Kysely + pg, node-pg-migrate (plain SQL migrations), native fetch, Vitest, MSW. Postgres 16 (docker locally).
- **Layout (suggested):** `src/main.ts`, `src/api/*`, `src/db/*` (schema types + queries), `migrations/*.sql`, `src/registrars/{base,porkbun,…}.ts`, `src/services/{selection,buy,listing,report,export}.ts`, `src/admin.ts`, `src/jobs/*`, `tests/{unit,api,contract}`.
- **No network calls in unit and API tests** (network blocked via MSW `onUnhandledRequest: 'error'`). Contract tests are marked and opt-in.

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
| `docs/specs/listing-strategy.md` | Categories, modes, guards, Afternic/Sedo support per mode, export mapping, **pricing calculator, drop schedule, `GET /pricing/preview`, price job, pricing settings versioning (§10)**, LS/LG/LH/LX tests |
| `docs/specs/cli.md` | Optional thin `dt` CLI with Dvir's flags |
| `docs/specs/export-csv.md` | Afternic and Sedo exports |
| `docs/specs/sold.md` | `POST /sold/{domain}` |
| `docs/specs/report.md` | `/report`, `/portfolio`, `/ledger`, `/deals`, `/audit`, `/health` |
| `docs/specs/backup.md` | Render backups, nightly git export, restore drill |
| `docs/specs/test-plan.md` | Gates G0–G5, cross-cutting tests, **pricing tests PR-***, kill criteria |
| `docs/research/registrars.md` | Vendor comparison with sources; what is verified and what isn't |
| `docs/research/marketplaces.md` | Afternic/Sedo facts with sources |
| `render.yaml` | Hosting sketch (price unverified; Dvir approves the spend) |
| `.env.example` | Every server env var, with how to get each key |

## Build order (stop at each gate; show Dvir the results)
1. Skeleton, DB models, migrations (append-only triggers, CHECK constraints), auth, audit, idempotency middleware, `/health`. Then G0/G1 for these.
2. Registrar adapter base + Porkbun adapter + selection logic + `/check`. Then G0/G1.
3. `/buy` with all checks, the locks and the reconciler. Then G1 (B-1–B-25, CAP-*, ID-*, DR-*).
4. Listing strategy and pricing (`listing-strategy.md`: categories, modes, guards, `listing_history`, then §10: `pricing_settings` + admin command, the calculator, `GET /pricing/preview`, `price_schedule`, the daily price job), then the offers log (§10.11: `offers`, `POST /offers`, the CSV import, `/report` offer aggregates). Then `/list`, exports per mode (with `changed_only` and the upload confirmation), `/sold`, `/report` (incl. `/report/pricing-review`), the read endpoints, and `import-domain` (including GoDaddy `--manual`). Then G0/G1 (PR-*, OF-*).
5. Porkbun mock-server and sandbox contract tests. Then **G2**.
6. Deploy to Render (after Dvir approves the cost), create the tokens, run the live read-only checks. Then **G3**.
7. First real API buy (the next approved deal; D-001 was bought by hand at GoDaddy, registered 4 Oct, and is imported at G3 with `npm run admin -- import-domain`), only with Dvir present and his chat approval. Then **G4**. Post-acquisition checks follow (G5).
8. Optional: the backup cron + restore drill (the BK-5 drill is required before G4).

## Don't
- Don't add a frontend, a token-creation endpoint, a settings-write endpoint (that includes `pricing_settings`), multi-year registration, auto-renew ON, or marketplace scraping.
- Don't let the price job touch registrars, marketplaces or nameservers, or send anything. It only changes DB rows and flags the export.
- Don't put a real key, token or personal address in code, fixtures, logs or commits.
- Don't "fix" a failing spec test by editing the test to match the code without Dvir's OK.
