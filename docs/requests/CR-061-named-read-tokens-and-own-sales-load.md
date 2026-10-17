> Status: Approved by Dvir 2026-10-17

# CR-061 — Named read-only tokens, a limited upload token for Data Engineer, and loading our own sales with a holdout date guard
| Field | Value |
|---|---|
| CR id | CR-061 |
| From | DOM Architect (Grok Bot), on behalf of Dvir |
| Date | 2026-10-17 03:30 IDT |
| Approved by Dvir | 2026-10-17 03:07 and 03:18 IDT, relayed by Gavriel (see Approval) |
| Priority | P1 (Scoring Scientist needs sale prices for Scorer v11; bots blocked on Gavriel for every read) |
| Owner bot | Scoring Scientist (sales load), DOM Architect (tokens) |

## 1. Business need
- Only Gavriel (WRITE+READ) and Gizbar (READ) hold tokens (`docs/runbook.md`). Every other bot asks Gavriel for each read, so Gavriel is a bottleneck.
- Data Engineer (Mahandes) builds the data but can't upload it. Gavriel has to make every bulk upload.
- Scoring Scientist needs our 15,960 graded sales (`data/sales/sales-graded.csv`) in `/engine/sales`. The holdout (sales after 2026-10-14) is sealed and must not reach DOM until Scoring Scientist unseals it.

## 2. Rules
- **R-1 (read tokens, no code):** Dvir creates READ tokens with the existing command `npm run admin -- token create --scope read --name <name>` for: `data-engineer`, `scoring-scientist`, `shomer`, `buyer`, `dom-architect`. Each bot sees only its own token. `/audit` shows `token_name`.
- **R-2 (Data Engineer upload token):** one token named `data-engineer-upload`. Non-money writes only. Allowed: `POST /candidates/intake`, `POST /engine/sales`, `POST /engine/unsold`, and the CR-063 bulk-load routes. Everything else is refused with 403 `SCOPE_FORBIDDEN`, including `/buy`, `/list/*`, `/sold/*`, `/offers*`, `/portfolio/import`, `/export/*/uploaded`, `/outreach/*`, settings activation, `/jobs/run`, seal/unseal and `/engine/train`. DOM chooses how to build it: widen the existing `intake` scope, or add a new `data` scope.
- **R-3:** WRITE stays with Gavriel only.
- **R-4 (holdout guard):** a setting `engine.sales_max_date`, default `2026-10-14`. On `POST /engine/sales`, any row with `sale_date` after it is rejected with reason `HOLDOUT_SEALED`. Only Dvir's approval line (through Gavriel's WRITE) can change it, after Scoring Scientist logs the unseal.
- **R-5:** the holdout file `holdout-sales-after-2026-10-14.csv` is never uploaded.
- **R-6 (size logging):** each bulk load reports the DB bytes before and after, as a step in `GET /jobs/runs` or in the upload response. Loads run now on the Mac-mini host. The Neon free limit is 0.5 GB, and `DB_SIZE_HIGH` trips at 70%.
- **R-7:** rows with no real `sale_date` are rejected as they are today. This covers T4 rows marked `sale_year=UNKNOWN`. We accept that.

## 3. Acceptance criteria
- **AC-1:** `GET /audit` after a READ call shows `token_name` = `scoring-scientist` and scope `read`.
- **AC-2:** a READ token on any POST write → 403 `SCOPE_FORBIDDEN`. (`POST /score` is the existing read-only POST exception.)
- **AC-3:** the `data-engineer-upload` token on `POST /engine/sales` → 201. On `POST /buy` (even with `dry_run`), `/list/x.com`, `/sold/x.com`, `/offers` or `/portfolio/import` → 403 `SCOPE_FORBIDDEN`.
- **AC-4:** a row dated 2026-10-15 → rejected with `HOLDOUT_SEALED`. A row dated 2026-10-14 → accepted.
- **AC-5:** the full `sales-graded.csv` upload gives `accepted_n + duplicate_n + rejected_n` = rows sent. Rejects are only `HOLDOUT_SEALED` or a missing/invalid date.
- **AC-6:** DB bytes before and after the load are visible, and after < 70% of 0.5 GB.

## 4. Open questions for DOM
- Q1: widen `intake`, or add a new `data` scope? Which one keeps `/audit` clearest?
- Q2: should `sales_max_date` also apply to `/engine/unsold`?
- Q3: are tier/year_flag columns OK as optional fields on `/engine/sales`, or should they wait for the `sales_comps` table in CR-063?

## Approval (Dvir, 2026-10-17 IDT, relayed by Gavriel)
- 03:07, verbatim: "All bots are allowed to execute DOM read only actions or read/write but only for actions that are not impacting money (buy domain, sell domain, listing and more). For example fetch data online and write it to the database is allowed. I want us to decided on one only bot that will be in charge to do actions of buys sell and so on"
- 03:18, answering "named read-only tokens for the new bots, with the write token staying with Gavriel only", verbatim: "7. Yes they should"; and "Yes it can be you" (Gavriel is the only bot doing money actions).
- Coverage: 03:07 covers the `data-engineer-upload` non-money token and loading our sales now; 03:18 covers the named READ tokens and WRITE staying with Gavriel only.

<!-- DOM writes below this line -->

## DOM (2026-10-17): accepted, building as v5.10.0
- **Q1:** a new **`data` scope**, so `/audit` shows a load as `data`, not `intake`. The `intake` scope stays as it is. A `data` token may call only `POST /candidates/intake`, `POST /engine/sales`, `POST /engine/unsold`, and the CR-063 load routes (`POST /data/*`). Everything else, GETs included, gets 403 `SCOPE_FORBIDDEN`. The other bots read with their own READ tokens.
- **Q2:** yes. `engine.sales_max_date` also guards `POST /engine/unsold`, by that row's date.
- **Q3:** `/engine/sales` stays as it is. The tier, year_flag and other columns go into `sales_comps` (CR-063).
- **R-1 tokens:** DOM never touches production, so **Dvir** runs `npm run admin -- tokens create …` on the Mac host after the deploy (the release note gives the exact commands for the five READ tokens and `data-engineer-upload --scope data`). `/audit` gets `token_name` if it doesn't already show it.
- **R-4:** the holdout date moves only through `POST /engine/holdout-date` (WRITE, with Dvir's `approval_ref`; audited).
- **R-6:** every `/engine/sales` and `/engine/unsold` response carries `db_bytes_before` and `db_bytes_after` (`pg_database_size`). A load that would cross 70% of 0.5 GB is refused with 409 `DB_SIZE_HIGH`.

## Gavriel (2026-10-17 12:02 IDT): v5.10.0 live, acceptance with Gavriel's tokens
- `/health` shows 5.10.0 at 12:01 IDT (tag v5.10.0, 0620606).
- PASS AC-2: `gavriel-read` on `POST /engine/sales` and `POST /engine/holdout-date` → 403 `SCOPE_FORBIDDEN`; `/audit` shows `token_name` gavriel-read, scope `read`.
- PASS AC-4 (sealed half): WRITE row dated 2026-10-15 on `/engine/sales` and 2026-10-16 on `/engine/unsold` → 201, `rejected_n` 1, reason `HOLDOUT_SEALED`, nothing stored (aud_a0a7aa2d…, aud_f7d3cbe4…).
- PASS AC-6 fields: `db_bytes_before` 85,254,144 / `db_bytes_after` 85,278,720 (~17% of 0.5 GB).
- PASS: `GET /engine/holdout-date` → `{sales_max_date: "2026-10-14"}`; `POST /engine/holdout-date` with text not naming the date → 422 `APPROVAL_INVALID` (date unchanged).
- NIT: that 422 message says "approval_ref.text must name the domain"; it should say "the date".
- NOT YET RUN: AC-3 and the accepted half of AC-4 (row dated 2026-10-14 → 201) need the `data-engineer-upload` token, and AC-5 is the real load. I did not store a 2026-10-14 test row with WRITE, so the engine data stays clean. Waiting on Dvir to create the tokens on the Mac host.
- FYI: `/engine/health` on the Mac host shows `sales_n` 0, `unsold_n` 0 and no model, so the engine tables start empty there; the CR-061 load fills them.
