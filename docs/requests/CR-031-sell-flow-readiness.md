> Status: Draft. Sent by Gavriel. Nothing here spends money, changes a cap or a founder rule, or adds a paid service.

# CR-031: sell-flow gaps found before the first live listings (deploy 3.6.0, offer dry run, hand listings per venue)
| Field | Value |
|---|---|
| CR id | CR-031 |
| From | Gavriel (customer), on behalf of Dvir |
| Date | 2026-10-09 14:40 IDT |
| Approved by Dvir | not needed (no money, no rule change) |
| Priority | **A: P1** (blocks the two small buys today). B, C: P2 |
| Based on | Live API at 14:33-14:36 IDT: `/health` (3.5.0), `/pricing/preview`, `/tranches`, `/portfolio/promptinjectionaudit.com`, `/offers`, `/report`, `/export/sedo.csv` (501), `/check` for both names, `POST /list/promptinjectionaudit.com` dry runs (`lander: afternic`, `lander: sedo`). No src/ or tests/ read. |

## Why
Dvir wants the sell side to run live on ukcbamcompliance.com and aievalsconsulting.com as soon as DOM buys them under CR-030. The listing plan, lander and schedule checks all pass in dry runs. Three things stop or weaken the live run.

## A. 3.6.0 is committed but not live (P1)
- `bf9ba79` (v3.6.0, CR-030) was pushed at 14:24 IDT. `GET /health` still answered `"version":"3.5.0"` at 14:35 IDT, so `small_buy_exception` is refused as an unknown field (strict schema) and neither name can be bought.
- **Ask:** deploy 3.6.0 and add a line here or in `DOM-TO-GAVRIEL.md` when `/health` shows it.
- **Acceptance:** `/health` `version` = `3.6.0`, and a dry run `POST /buy` of each name with `small_buy_exception: true` answers 200 with a `small_buy` object.

## B. A dry run for offer routing (P2)
- `POST /offers` has no dry run. The only way to check that an offer on a name is classified and routed right (band, routing, `next_step`) is to log a real, append-only offer. So routing can't be tested before the first real offer, and a test offer on a live name would pollute the demand data that `/report` and the quarterly review use.
- **Ask:** `dry_run: true` on `POST /offers`: run every check and the classification against the prices in force at `received_at`, return the offer view (with `band`, `routing`, `next_step`, `warnings`) plus `dry_run: true`, and write only the audit row (no offer row, no hold, no dedupe key claimed).
- **Acceptance:** (1) a dry run of $500 / $960 / $1,000 / $1,600 on promptinjectionaudit.com from `afternic` returns `below_walkaway`/`auto_decline`, `mid_range`/`dvir`, `at_or_above_floor`/`auto_accept`, `at_or_above_bin`/`auto_accept`; (2) `GET /offers` is unchanged afterwards; (3) the private walk-away appears only in the bot view, as today.

## C. Record a listing made by hand on a venue (P2)
- Sedo listings are made by hand (no Sedo template; the headers come from Dvir's Sedo account). DOM has no way to record that a name **is** listed on Sedo, so `/portfolio/promptinjectionaudit.com` shows `export.sedo.pending: true` with no upload ever, forever. The same will hold for both new names. Without this record:
  - the `/sold` checklist can't say which other venue to pull the listing from;
  - CR-029's portfolio page can't show "where it's listed";
  - a Sedo price that drifts from the DOM plan after a scheduled drop isn't flagged.
- **Ask:** a way to record a hand listing per venue, for example `POST /listings/{domain}/venue {venue: "sedo"|"afternic", listed_at, shown: {mode, price, min_offer}, evidence: {source, ref}, note}`. Store it append-only. Show it in `/portfolio/{domain}` `export.<venue>` (`listed_by_hand_at`, `shown`), clear `pending` when `shown` matches the current plan, and raise `pending` again when a scheduled price event changes the plan after it. A delist by hand is the same call with `delisted: true`.
- **Acceptance:** (1) after recording Sedo for promptinjectionaudit.com (`make_offer`, price none, min offer $100), `/portfolio` shows it and `export.sedo.pending` follows the rule above; (2) a `/sold` dry case names the hand-listed venue in its checklist; (3) the walk-away is never accepted or stored in `shown`.

## Not asks (for the record)
- The Afternic upload itself stays with Dvir: there is no Afternic seller API, and the founder rule says the service never calls a marketplace.
- The Sedo template still needs Sedo's example file from Dvir's account (formats.md). Until then Sedo is listed by hand.
