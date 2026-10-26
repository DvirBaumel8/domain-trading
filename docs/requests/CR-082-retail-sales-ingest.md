---
id: CR-082
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir YES 2026-10-27 ~01:32 IDT via Gavriel: start public retail-sales ingest into DOM so CR-081 replay can score retail outcomes. Sources: UnreportedSales, DNJournal, DNW. No money. Bot time only."
priority: P1
depends_on: [CR-075, CR-081]
supersedes: []
max_rounds: 2
---
# CR-082: public retail-sales ingest (bots → POST /data/sales)

**Approval:** Dvir YES 2026-10-27 ~01:32 IDT via Gavriel. Build right away. No money. No Dvir setup. Bot time only. Max **2 rounds**. Freeze exception for this ask.

## Why
CR-081 `GET /replay/{date}` retail outcomes stay `no_data` until UnreportedSales / DNJournal / DNW rows land in `market_sales`. CR-075 already shipped `POST /data/sales`; this CR is the bot ingest path that fills it so replay can score retail (and flag **$500+**).

## What already exists (reuse — do not rebuild)
- `POST /data/sales` (WRITE / bots / data; append-only; NameBio 422; tier required; under-$500 stored but no episode) — CR-075 / v5.23.0; contract in `docs/contract/endpoints.md`.
- `GET /market/coverage`, `/market/episodes`, `/market/dq` — CR-075.
- Replay retail labels from `market_sales` (and non-auction `engine_sales`) — CR-081 / v5.59.0; `retail.status: "no_data"` when none after day D.
- Bot-collected staging: `POSITIVES-staging.csv` (~49 UnreportedSales + DNW rows, Oct 2026). Larger history: `sales-graded.csv` (~16k; phased).

## Rules
- R-1 **Bots fetch and POST.** DOM Architect (and sibling bots) fetch public UnreportedSales / DNJournal / DNW pages or feeds and `POST` rows to the existing `POST /data/sales` with a WRITE / bots / data token. **DOM does not scrape these sites in this CR.**
- R-2 **Source and venue labels.** `source` is one of: `unreportedsales_weekly` | `dnjournal_weekly` | `dnw_weekly` (or a stable documented equivalent). `venue` is lowercase (e.g. `unreportedsales`, `dnjournal`, `dnw`, or the marketplace when the report names it). `tier` = **B** for editorial weekly reports unless a better documented tier exists. NameBio remains forbidden (422).
- R-3 **Keep posted names and prices.** Keep letters-only `.com` and all `.com` as posted by the source. Store all USD prices as `sale_price_cents` (integer cents). The **$500+** floor for episodes / replay `retail_500` is already CR-075 / CR-081 — flag `$500+` clearly in coverage / report counts; under-$500 rows may store without creating an episode (`below_floor_n`).
- R-4 **Idempotent append-only.** Re-POST the same key at the same price → counted **duplicate**. Same key with a **changed** price → **409 `APPEND_ONLY`**. No PUT / PATCH / DELETE (405 `APPEND_ONLY`).
- R-5 **Cadence and backfill.** At least **weekly** bot upload of new posts. Backfill of existing `POSITIVES-staging.csv` is **in scope now**. Full `sales-graded.csv` (~16k) backfill may be **phased** (dry_run + small real batches ≤100 first; NameBio rows excluded).
- R-6 **No money / no new settings / no paid dump.** No buys, bids, listings, price changes, or settings activation. No paid dump unless a Question asks and Dvir says yes.
- R-7 **Prove the path.** After upload, `GET /market/coverage` (or episodes) shows source counts. For an archived day D with sales after D, `GET /replay/{date}` retail is **not** `no_data` once the `episodes` / datasave step has joined sales (contract: sales appear in episodes after the next `episodes` step). Document if a release later lets replay read `market_sales` without waiting for episodes — until then, coverage/source counts prove ingest; replay retail after datasave proves end-to-end.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-7 pass (tests-as-contract and/or live dry_run + one real batch); `/market/coverage` shows the new sources after upload; no money path; NameBio still 422. |
| **Stop condition** | At most **2 rounds**. Further gaps = new CR/BUG citing an AT. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1 **dry_run accept:** `POST /data/sales` with `dry_run: true` and a valid UnreportedSales-shaped row → 201, `accepted_n ≥ 1`, nothing stored.
- AT-2 **Real accept:** Same fixture row without dry_run → 201, `accepted_n ≥ 1` (or `duplicate_n` if already uploaded); row visible to coverage / later episodes.
- AT-3 **NameBio still 422:** `source` or `source_url` containing `namebio` → 422 `SOURCE_NAMEBIO_FORBIDDEN` (or documented equivalent); nothing stored.
- AT-4 **Duplicate ok:** Re-POST identical key+price → 201 with `duplicate_n` increment; stored row unchanged.
- AT-5 **Coverage / source visible:** After a real upload, `GET /market/coverage` (or equivalent) shows non-zero counts for `unreportedsales_weekly` and/or `dnw_weekly` / `dnjournal_weekly`.
- AT-6 **Replay retail join (or document dependency):** For archived day D with at least one uploaded retail sale after D, after `episodes`/datasave has run, `GET /replay/D` retail is not `no_data`. If replay still needs a datasave cycle, the release note / CR Changes say so explicitly (coverage counts still prove ingest).
- AT-7 **No money (negative):** Ingest uses only `POST /data/sales` (and read coverage/replay). No buy / bid / list / settings-activation path is opened; bots/WRITE token used here cannot turn this CR into a money action.

## Out of scope
- NameBio scrape or any NameBio-derived dump.
- Venue seller-page scrapes.
- Money actions, settings activation, Dynadot key creation.
- Changing the CR-081 scoring lock (filters+score frozen as of day D; primary `GET /replay/{date}`).
- Building a new DOM scrape module for UnreportedSales / DNJournal / DNW (bots POST; DOM only stores).

## Decisions / Questions (≤3)
1. **Full `sales-graded.csv` backfill:** phase after staging succeeds (dry_run + ≤100 real batches; NameBio excluded). Default unless Dvir says otherwise.
2. **DNJournal:** include when a public weekly post is fetched; same R-2 labels (`dnjournal_weekly` / venue `dnjournal`). No paid DNJournal dump without a new Dvir yes.
3. **Replay timing:** retail labels on `/replay/{date}` may lag until the next `episodes` datasave step joins `market_sales` — coverage proves ingest immediately.

## DVIR items
None (Dvir already said yes; no money; no paid dump; no founder-rule change).

## Changes
- 2026-10-27 ~01:35 IDT (DOM Architect): filed approved CR-082 per Dvir YES ~01:32 IDT via Gavriel; first POSITIVES-staging upload attempted in the same turn.
