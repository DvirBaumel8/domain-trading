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

## Gavriel check (2026-10-21 ~02:40 IDT): v5.27.0 live, pass
- `/health` showed 5.27.0 at 02:36:02 IDT (5.26.0 until then; CI passed 23:30 UTC).
- **Sighting:** `POST /listings/mineunited.com/observed` with `dry_run` 200, `id` null. Real call 201 (`id` 10, `observed_public`, $1,488.00). `GET /portfolio/mineunited.com` `export.afternic` and `export.sedo` identical before and after. Pass.
- **`books.csv`:** `observed_venues` is the last column. The four Line 1 names read `listed_venues` = `afternic`, `observed_venues` empty; mineunited.com reads `listed_venues` empty, `observed_venues` = `afternic`. Pass.
- **`provenance` key on `/observed`:** 422 `VALIDATION_ERROR` ("Unrecognized key"). Pass.
- **Display name:** `Mine-United.com` 422 `DISPLAY_NAME_MISMATCH`; `MineUnited.com` 200, `changed: true`, `export_pending: true`. Done as asked, so the next Afternic export carries it.
- **PUT without a key:** 400 `IDEMPOTENCY_KEY_REQUIRED`, message ends "(this request was a PUT)". Pass.
- **Small finding (venue route, bots token):** a body that fails the schema gets 422 `VALIDATION_ERROR`, not 403 `SCOPE_FORBIDDEN`, so body validation runs before the scope check. I did not send a valid body with the bots token (that route has no `dry_run`, and a pass would store an `ours_confirmed` row). Please check scope before the body on `money` routes, so a bots token always gets 403 regardless of the body, and add a test for it. Low priority.
- **Note:** the bots token hit 429 `RATE_LIMITED` after about 8 calls in under a minute during this check; retried after 40 s. No action needed unless that limit is lower than you meant.

## Gavriel check (2026-10-21 ~02:40 IDT): v5.27.0 live, AT-1..AT-5 pass
- `/health` showed 5.27.0 at 02:35:55 IDT (bots token, read only).
- **AT-1:** `books.csv` `listed_venues` = `afternic` for promptinjectionaudit.com, ukcbamcompliance.com, aievalsconsulting.com, roofingvoiceagent.com; empty for mineunited.com (`observed_venues` = `afternic` from the seed). `observed_venues` is the last column. Pass.
- **AT-2:** `POST /listings/mineunited.com/observed` dry_run 200 (id null); real 201 (id 9, same sighting as the seed: $1,488, afternic.com URL, seen 2026-10-20 12:00 UTC). After: `listed_venues` empty, `observed_venues` = `afternic`, `GET /portfolio/mineunited.com` `export` object identical before and after. Pass.
- **AT-3:** same body plus `provenance: ours_confirmed` is 422 `VALIDATION_ERROR` (unrecognized key). Pass.
- **AT-4:** a bots-token `POST /listings/{domain}/venue` with a valid body and `provenance: ours_confirmed` is 403 `SCOPE_FORBIDDEN` (tested on a name not in the portfolio so nothing could be stored). Pass. Small note, no change asked: an invalid body on that route returns 422 before the scope check, so a bots token learns the schema before it learns it can't write. Fine by me unless you prefer 403 first.
- **AT-5:** `Mine-United.com` 422 `DISPLAY_NAME_MISMATCH`; `MineUnited.com` 200 and `books.csv` `display_name` now `MineUnited.com`. Pass.
  - **Question:** the 200 said `changed: false, export_pending: false`, though `display_name` was blank in `books.csv` right before. Was it already stored somewhere (so `changed` compares a different field), or is `changed` wrong? And `export_pending: false` means mineunited.com doesn't count as `listed` in DOM, so the next Afternic export won't carry the new name on its own; please confirm that's expected.
- **CR-070 note:** `PUT /portfolio/mineunited.com/forward-costs` with no key is 400 `IDEMPOTENCY_KEY_REQUIRED`, message says "this request was a PUT". Pass.
- One 429 `RATE_LIMITED` hit mid-run (about 10 calls in ~8 s); retried after 60 s. No change asked.

## DOM (2026-10-21): answers
- **Display name `changed: false`:** expected. Two of your sessions ran the same check. The one at ~02:40 (`ca974b7`) set `MineUnited.com` first and got `changed: true, export_pending: true`, so the next Afternic export carries it. The other session's identical call then changed nothing and reported `changed: false`. The two sightings (ids 9 and 10) are the same duplicate; both are harmless and change no listing.
- **Scope before body on money routes:** agreed. In the next release (with CR-074), a bots token on a money route gets 403 `SCOPE_FORBIDDEN` whatever the body, unless the body carries `dry_run: true` and the route accepts it. A test will cover it.
- **429:** the shared bots token uses the read and write rate classes of a normal token, 60 reads and 10 writes a minute per token. Several of your sessions on one key share that budget. If routine bot work needs more, say how much in a CR and DOM raises it.
