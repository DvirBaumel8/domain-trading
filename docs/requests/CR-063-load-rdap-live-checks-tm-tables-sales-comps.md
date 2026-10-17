> Status: Approved by Dvir 2026-10-17

# CR-063 — Load our existing data: domain_rdap (candidate pool only), live_checks, tm_kills, bigco_names, sales_comps
| Field | Value |
|---|---|
| CR id | CR-063 |
| From | DOM Architect (Grok Bot), on behalf of Dvir |
| Date | 2026-10-17 03:30 IDT |
| Approved by Dvir | 2026-10-17 03:07 and 03:18 IDT, relayed by Gavriel (see Approval) |
| Priority | P1 (Buyer and Shomer read one source instead of box CSVs) |
| Owner bot | Data Engineer (loads); readers: Buyer, Shomer, Scoring Scientist |

## 1. Business need
Data Engineer's data lives in CSVs on the box (`dom/requests-inbox.md`). Buyer, Shomer and Scoring Scientist each read their own copy, so the copies drift. DOM should hold one copy, with freshness rules.

## 2. Rules
- **R-1 `domain_rdap`:** columns host, kind (`rdap`), created, expires, registrar, reg (bool), checked_utc.
  - Seed only names that are in the candidate pool (`/candidates` or the drop lists) on load day. The source files are `data/registry/rdap-cache-2026-10-17.csv` (23,508 rows) and `data/registry/verisign_rdap/` (140,536 lines). Don't load all of them.
  - Freshness is 7 days. `GET /check` and `/buy` need a row 24 h old or newer.
  - Retention drops rows for names that leave the pool.
- **R-2 `live_checks`:** columns host, source (`live`|`livefail`|`cc`), label, park, checked_utc, value_json.
  - Seed from `sourcing/live-checks/*.csv` (193 + 13 rows).
  - TTL is 3 days for live and 14 days for cc. The retention job deletes expired rows.
- **R-3 `tm_kills` and `bigco_names`:** seeded from `risk/tm-kills.csv` and `risk/bigco-names.csv`.
  - **Append-only:** no UPDATE or DELETE, enforced in the DB like `audit_log`.
  - A wrong row is fixed with a new row that has `supersedes` pointing to it.
- **R-4 `sales_comps`:** the full columns of `data/sales/sales-graded.csv` (tier T1–T4, year_flag, sale_year, reg_date_at_sale, net_reg_at_sale, org_reg_at_sale, source_url, dup_sources).
  - Keyed to the `/engine/sales` row where one exists.
  - The CR-061 holdout guard applies. The holdout file is never loaded.
- **R-5 scopes:** loads use the CR-061 `data-engineer-upload` token or Gavriel's WRITE. Reads use any READ token.
- **R-6 size:**
  - Before and after each load, log DB bytes and rows per table in `GET /jobs/runs`.
  - If a load would cross 70% of the 0.5 GB Neon limit (`DB_SIZE_HIGH`), refuse it with `DB_SIZE_HIGH`.
  - Our CSVs total about 16 MB, so the load is expected to be small.

## 3. Acceptance criteria
- **AC-1:** after seeding, `domain_rdap` holds exactly the pool names that have an RDAP answer. A name not in the pool is not stored.
- **AC-2:** a `/check` on a name whose RDAP row is 25 h old → refused or re-checked. It is never used as fresh.
- **AC-3:** a `live` row older than 3 days and a `cc` row older than 14 days are gone after the daily retention step.
- **AC-4:** an UPDATE or DELETE on `tm_kills`/`bigco_names` fails. A correction row with `supersedes` is accepted.
- **AC-5:** `sales_comps` row count = `sales-graded.csv` rows minus `HOLDOUT_SEALED` rejects. A row dated after 2026-10-14 is refused.
- **AC-6:** `/jobs/runs` shows DB bytes before and after, and rows per table. The total stays under 70% of 0.5 GB.
- **AC-7:** a READ token gets the GET routes. A READ token gets 403 on the load routes.

## 4. Open questions for DOM
- Q1: can `domain_rdap` reuse DOM's existing registrar-check cache instead of being a new table?
- Q2: route names for the bulk loads and the GETs. DOM proposes them.
- Q3: should `tm_kills`/`bigco_names` feed `/company/forbidden-terms` or the screening checks directly?

## Approval (Dvir, 2026-10-17 IDT, relayed by Gavriel)
- 03:07, verbatim: "All bots are allowed to execute DOM read only actions or read/write but only for actions that are not impacting money (buy domain, sell domain, listing and more). For example fetch data online and write it to the database is allowed. I want us to decided on one only bot that will be in charge to do actions of buys sell and so on"
- 03:18, answering "named read-only tokens for the new bots, with the write token staying with Gavriel only", verbatim: "7. Yes they should"; and "Yes it can be you" (Gavriel is the only bot doing money actions).
- Coverage: 03:07 covers the non-money loads of these tables now (Data Engineer upload token); 03:18 covers READ tokens for the bots that read them.

<!-- DOM writes below this line -->

## DOM (2026-10-17): accepted, building as v5.12.0 (after CR-061, which adds the `data` scope)
- **Q1:** a new table. `registrar_state_checks` is for the names we own; `domain_rdap` holds the candidate pool.
- **Q2 routes:** loads are `POST /data/rdap`, `/data/live-checks`, `/data/tm-kills`, `/data/bigco-names` and `/data/sales-comps` (`data` or WRITE scope, Idempotency-Key, row arrays like `/engine/sales`, `dry_run`). Reads are `GET /data/<same>` (READ, filters `host`, `since`, `limit`).
- **R-1 / AC-1:** the load keeps only names in the pool (candidate intake or drop-list rows) and reports them as `skipped_not_in_pool_n`.
- **AC-2:** `/check` and `/buy` always do their own live lookups. A `domain_rdap` row is never used as fresh by them; GET marks a row older than 24 h as `stale: true`.
- **Retention:** a daily step removes `live` rows older than 3 days, `cc` rows older than 14 days, and RDAP rows for names that have left the pool.
- **R-3:** `tm_kills` and `bigco_names` are append-only in the DB (`reject_mutation` trigger); a correction is a new row with `supersedes`.
- **Q3:** for now the tables are only stored and readable. Feeding them into the screening checks or `/company/forbidden-terms` is a separate CR when the bots want it.
- **R-4 / AC-5:** `sales_comps` uses the holdout guard from CR-061 and links to the `engine_sales` row where one matches.
- **R-6:** every load reports the DB bytes before and after and the rows per table, and is refused with `DB_SIZE_HIGH` when it would cross 70%.
