---
id: CR-101
kind: CR
status: done
owner_bot: dom-architect
approval: "Gavriel 2026-11-04: action item 1 from the Nov 3 discovery run (pack 90756002): drop prior kills before serving the shortlist, as a maintenance CR. Claude Code only, no CloudAgents. No money, no settings activation."
priority: P2
priority_note: "maintenance; 46% of the served shortlist was dead weight for Buyer on 2026-11-03"
depends_on: [CR-088]
supersedes: []
max_rounds: 2
---
# CR-101: GET /auctions/shortlist drops names a bot already killed (server-side prior-kill store)

## Facts (pack `docs/requests/discovery-runs/2026-11-03-v3/`)
- `GET /auctions/shortlist?date=2026-11-03&limit=10000`: total 240, rows 240.
- `kills.csv`: 240 rows: **110 `prior_exclude`** ("in Oct20-Nov2 kill/exclude/hold/declined list"), 127 `meaning_shape`, 3 `tier_a`. So 46% of the served list had already been judged and was thrown away again by Buyer.
- Prior kills live **only on the box** today (per-run `kills.csv` and `evidence/prior-exclude.txt`, 1,268 names, under `docs/requests/discovery-runs/*` and `/workspace/domain-trading/sourcing/buyer-first/*`). DOM has no auction-name kill table: `/data/tm-kills` is kill **terms** for TM_KILL, not judged names, and must not be reused for this.
- Auctions repeat (GoDaddy re-lists unsold names), so the same names come back daily.

## Ask
1. **New append-only table `auction_kills`** + `POST /auctions/kills` (WRITE or bots; batch 1..2,000 rows; idempotency key; strict body) row: `{domain (.com), kill_stage: meaning_shape|tier_a|tier_b|card|prior_exclude|declined|hold|other, kill_detail (≤500, no @), price_cents_at_kill?, data_date_at_kill (YYYY-MM-DD), run_id (≤80, e.g. pack sha), killed_at, supersedes?}`. No UPDATE/DELETE (`reject_mutation`, like `tm_kills`); a wrong kill is undone by a row with `kill_stage: "revoked"` + `supersedes`. Duplicate = same `(domain, kill_stage, data_date_at_kill)`. Small rows; covered by the CR-097 critical-write exemption only if it fits there, else normal 70% guard.
2. **`GET /auctions/kills`** (READ/bots) `?domain=&since=&limit=&offset=`: list, newest first, so bots stop keeping private lists.
3. **Shortlist serve rule:** `GET /auctions/shortlist` leaves out every row whose domain has a non-revoked kill, unless the re-show rule fires. Stored rows are **not** deleted (paper/funnel/replay still need them, as CR-088 says).
4. **Re-show rule (narrow):** a killed name is served again only when its kill is `tier_a|tier_b|card` with a stored `price_cents_at_kill` **and** today's price is at most half of it, **or** the kill is older than `settings.shortlist_kill_ttl_days` (default 90; a migration default, no settings activation needed). Meaning/shape kills do not change with price, so they never re-show inside the TTL. The row then carries `prior_kill: {kill_stage, killed_at, price_cents_at_kill, reshow_reason}`.
5. **Counts stay honest:** response adds `prior_kill_excluded_n` (rows left out for a kill). `field_n` (stored at build) is unchanged; `total` = live-eligible minus kill-excluded. Docs: `total + prior_kill_excluded_n + ended/prebid-dropped = field_n` for a same-day read. `GET /auctions/funnel.shortlisted` adds `prior_kill_excluded`.
6. **Seed load:** one-time bot load of the 1,268 names in `discovery-runs/2026-11-03-v3/evidence/prior-exclude.txt` plus all `kills.csv` rows from `discovery-runs/*` (`kill_stage` as in the file, `prior_exclude` when unknown). Bot side (DOM Architect) posts it after deploy; DOM only needs the endpoint.
7. Docs: `contract/endpoints.md`, `internal/auctions.md`, `bot-logic/04-buyer-shortlist-to-card.md` (Buyer posts its kills at the end of every run), CHANGELOG.

## Tests (pass/fail)
| id | test | pass |
|---|---|---|
| CR101-T1 | post 3 kills, GET shortlist for a date containing them | 0 of the 3 served; `prior_kill_excluded_n` = 3 |
| CR101-T2 | replay 2026-11-03: seed the 110 prior_exclude names, GET `?date=2026-11-03&limit=10000` | **0 prior kills served**; `prior_kill_excluded_n` ≥ 110 (minus any ended); stored row count for the date unchanged |
| CR101-T3 | counts | `field_n` on rows unchanged vs before; `total + prior_kill_excluded_n` = old `total` at the same `as_of` |
| CR101-T4 | re-show by price | `tier_a` kill at $40, today $18 → served with `prior_kill.reshow_reason="price_halved"`; today $25 → not served |
| CR101-T5 | meaning kill + price drop | `meaning_shape` kill, price halves → **not** served |
| CR101-T6 | TTL | kill dated 91 days ago → served with `reshow_reason="ttl"`; 89 days → not |
| CR101-T7 | revoke | `revoked` row superseding a kill → name served again |
| CR101-T8 | append-only | UPDATE/DELETE on `auction_kills` raises; duplicate post counted `duplicate_n`, no new row |
| CR101-T9 | validation | `@` in detail → 422 `NO_PII`; non-.com → reject row `TLD_NOT_SUPPORTED`; >2,000 rows → 422; data token GET → 403 |
| CR101-T10 | pagination | `limit`/`offset` page over the filtered list; no row on two pages; `total` = filtered count |
| CR101-T11 | perf | shortlist GET with 10k stored rows + 5k kills p95 < 800 ms (one anti-join, index on `auction_kills(domain)`) |
| CR101-T12 | regression | AS545-19..20 and CR088-AT2 still pass |

Fail rules: any prior-killed name served without `prior_kill.reshow_reason` = FAIL; any delete from `auction_shortlist` = FAIL; any settings activation = FAIL.

## Not in scope
Meaning prefilter upstream (separate idea in IMPROVEMENT-NOTES); changing the score; money.

## Approval (Gavriel, 2026-11-04 09:09 IST)
Approved (dc653e22). Ship via Claude Code. Conditions: no rows deleted; kill list reversible (revoke rows); served and skipped (prior_kill_excluded_n) counts recorded in each run pack. Low-appraisal filter: not wanted for now.
---

## DOM response (2026-11-04 ~09:30 IDT)

**Accepted as written. DOM builds it as 6.4.0, right after 6.3.0** (the `market_names` split for CR-100, which must ship before today's datasave).
- **`auction_kills`** follows the `tm_kills` pattern: append-only, with `revoked` + `supersedes` to undo a kill.
- **Storage:** about 100 B a row, so the seed of ~1.3k names plus each day's kills is well under 1 MB a month. It uses the normal 70% DB-size guard, not the CR-097 critical-write exemption (a kill can wait a day; a datasave can't).
- **Filter:** applied when the shortlist is read (one anti-join, index on `domain`). Stored shortlist rows are never deleted.
- **Re-show rule and counts:** as in asks 4–5. `prior_kill_excluded_n` goes on the shortlist and on `/auctions/funnel.shortlisted`.
- **Seed load:** yours after the deploy (ask 6). DOM posts here when 6.4.0 is live.

## DOM: 6.4.0 live (4 Nov 2026)

- **6.4.0 is live** (`/health/ping`). `POST /auctions/kills`, `GET /auctions/kills` and the shortlist filter are in, as asked. The fields and rules are in `docs/releases/v6.4.0.md`.
- **Decisions DOM took where the CR was silent:**
  - **Duplicates:** the duplicate key also includes `supersedes`, so two revokes of one name on the same day don't collide. Non-revoke rows follow the CR's rule.
  - **Revokes:** a `revoked` row needs `supersedes`, which must point to a kill of the same domain that is not itself a revoke. `supersedes` is refused on any other stage.
  - **Several active kills on one name:** it is left out if any of them blocks it. If none blocks, the newest re-showing kill is shown as `prior_kill`.
  - **`prior_kill`:** it is always present on a row (null when the name was never killed).
  - **`@` in `kill_detail`:** it refuses the whole request (422 `NO_PII`). Other bad rows are per-row rejects.
- **Next (DOM Architect):** the seed load from ask 6. Then run the CR101-T2 check on 3 Nov: `GET /auctions/shortlist?date=2026-11-03&limit=10000` should serve 0 prior kills, with `prior_kill_excluded_n` ≥ 110 minus any that ended.
- **Status:** `done` on DOM's side. Reopen it if the seed or T2 fails.
