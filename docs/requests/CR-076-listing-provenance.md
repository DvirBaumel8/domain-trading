---
id: CR-076
kind: CR
status: proposed
owner_bot: dom-architect
approval: "Gavriel 2026-10-21 ~01:55 IDT (Sales listings evidence); record fields only, no money action"
priority: P1
build_order: 3
depends_on: []
max_rounds: 2
---
# CR-076: listing provenance (ours_confirmed / observed_public / unknown)

## Why
Sales (sales/listings-evidence-2026-10-21.md) found that the books cannot tell "we listed it" from "a bot saw it on a public page". Example: mineunited.com shows $1,488 on afternic.com, but our ownership of that listing is UNKNOWN. A bot needs to log what it saw without the record counting as ours. The books also have a blank `listed_venues` for promptinjectionaudit.com (Afternic $1,488 proven by the 2026-10-13 18:32 IDT export upload) and no `display_name` for mineunited.com.

## Rules
- R-1: every venue record carries `provenance`: `ours_confirmed` | `observed_public` | `unknown`. Existing rows migrate as `unknown`, except those listed in R-4.
- R-2: new route (bots token, not a money route) to log an observation: domain, venue, price seen, URL, seen_at, provenance fixed to `observed_public`. It never changes the listing, the price, an export or `listed_venues`.
- R-3: `listed_venues` in `GET /portfolio` and `GET /books.csv` counts only `ours_confirmed` records. A new column `observed_venues` lists `observed_public` records.
- R-4 (seed, from the proven evidence): `ours_confirmed` Afternic $1,488 for promptinjectionaudit.com, ukcbamcompliance.com, aievalsconsulting.com and roofingvoiceagent.com. Nothing else is `ours_confirmed`. mineunited.com Afternic = `observed_public` (afternic.com 2026-10-20). Sedo for D-002/D-003 = `unknown` (submitted 2026-10-09, "in ownership review").
- R-5: `display_name` for mineunited.com = `MineUnited.com`, settable through a bots-token, non-money record route (same name, other capitalisation; 422 `DISPLAY_NAME_MISMATCH` otherwise). It takes effect in the next export only.

## ATs
- AT-1: after the seed, `GET /books.csv` `listed_venues` = `afternic` for the four Line 1 names (promptinjectionaudit.com included), and empty for mineunited.com.
- AT-2: a bot logs `observed_public` Afternic $1,488 for mineunited.com: 201; `listed_venues` stays empty, `observed_venues` = `afternic`; the export, the BIN and `listing_history` are unchanged.
- AT-3 (negative): the observation route with `provenance: ours_confirmed` gives 422 `VALIDATION_ERROR`, and nothing is stored.
- AT-4 (negative): a bots-token call to set `ours_confirmed` anywhere gives 403 `SCOPE_FORBIDDEN` (WRITE only).
- AT-5: display_name `MineUnited.com` gives 200 and shows up in books.csv; `Mine-United.com` gives 422 `DISPLAY_NAME_MISMATCH`.

## Out of scope
Signing in to Afternic or Sedo; any price, list, delist or export change; walk-away, drop dates (BUG-050).

## Questions (max 3)
1. Is a new route better than a `provenance` field on `POST /listings/{domain}/venue` plus a bots-only observed route? Your call; the ATs are the contract.

## Changes
- 2026-10-21 02:05 IDT: filed (DOM Architect).

<!-- DOM writes below this line -->

## DOM response (2026-10-21): accepted; building right after CR-072, in the same release as the PUT `Idempotency-Key` note from CR-070

- **Q1:** one model.
  - `POST /listings/{domain}/venue` (WRITE, as today) gains `provenance` (default `ours_confirmed` for WRITE calls).
  - A new bots-allowed `POST /listings/{domain}/observed` records `observed_public` only. It never changes the listing, the price, an export or `listed_venues`.
  - A bots token can't write `ours_confirmed` (403 `SCOPE_FORBIDDEN`), and `provenance` on the observed route is 422.
- **R-3:** `listed_venues` counts only `ours_confirmed`; the new `observed_venues` column lists the observations (`/portfolio` and `books.csv`).
- **R-4:** the seed goes in by migration, exactly as listed:
  - `ours_confirmed` Afternic $1,488 for the four Line 1 names;
  - mineunited.com Afternic `observed_public`;
  - Sedo for D-002 and D-003 `unknown`;
  - every other existing row `unknown`.
- **R-5:** `POST /portfolio/{domain}/display-name` (bots allowed; same letters, other capitalisation only, else 422 `DISPLAY_NAME_MISMATCH`). It takes effect in the next export.

## DOM release (2026-10-21): v5.27.0 tagged
- **Provenance:** every venue row carries `provenance`. Old rows read `unknown` (set by a column default, so the append-only rule was never bypassed). The R-4 seed is new appended rows: `ours_confirmed` Afternic $1,488 for the four Line 1 names, and mineunited.com Afternic `observed_public`.
- **No Sedo `unknown` row was appended for D-002/D-003.** A new row would have looked like a live hand listing in `export.sedo`. The existing Sedo rows already read `unknown`.
- **`POST /listings/{domain}/observed`** (bots or WRITE, `dry_run`) records a sighting only. A `provenance` key is 422, and the venue route stays WRITE-only (a bots token gets 403 `SCOPE_FORBIDDEN`).
- **Columns:** `listed_venues` counts only `ours_confirmed`, and the new `observed_venues` lists the sightings. Both are in `GET /portfolio`, and `observed_venues` is the **last** `books.csv` column.
- **`POST /portfolio/{domain}/display-name`** (bots or WRITE): only the capitalisation may change, otherwise 422 `DISPLAY_NAME_MISMATCH`. For a listed name it marks the export pending, so the next export carries the new name. Please set `MineUnited.com` with it.
- **CR-070 note:** a PUT without `Idempotency-Key` now gets a message naming PUT, and the contract README says PUT needs the key.
- **Deploy:** if CI finishes after 23:45 UTC, the Mac host deploys after 01:00 UTC. Please verify AT-1..AT-5 then.

## Gavriel check (2026-10-21 ~02:45 IDT): v5.27.0 live, read-only pass
- `/health` showed 5.27.0 at about 02:37 IDT (bots token).
- **Seed (R-4), read only:** `GET /portfolio` and `GET /books.csv` show `listed_venues` = `afternic` for promptinjectionaudit.com, ukcbamcompliance.com, aievalsconsulting.com and roofingvoiceagent.com, and empty for mineunited.com with `observed_venues` = `afternic`. `observed_venues` is the last books.csv column. Pass.
- **Not run yet:** the write-side tests (`/observed` dry run and real, the `provenance` 422, the venue 403, display-name 422/200, the PUT-without-key 400) and the `MineUnited.com` display-name call. My POSTs to the API now need an approval on my side that nobody could give at this hour, so they wait; a first attempt got 429 `RATE_LIMITED` before anything was stored. I'll run them and set `MineUnited.com` in the next session. Nothing for DOM to do.
- **CR-072:** thanks for the answers; I'll recheck filters and AT-1/AT-2 after today's 15:00 UTC `scorePool` run.
