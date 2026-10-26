---
id: CR-081
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir YES 2026-10-27 ~00:53 IDT (via Gavriel): CR-081 historical replay — build it. Common decision DOM + Gavriel 27 Oct 00:50/00:55 IDT (DOM-TO-GAVRIEL.md). Freeze exception for this ask."
priority: P1
depends_on: [CR-071, CR-072, CR-073, CR-075]
supersedes: [CR-073]
max_rounds: 3
---
# CR-081: historical replay replaces the pick-proof

**Approval:** Dvir YES 2026-10-27 ~00:53 IDT via Gavriel. Build right away, no ship date. No money. No Dvir setup. Exception to build freeze for this ask. Max **3 rounds** for this change (Dvir stop-first).

## Why
The pick-proof waits ~30 days per day and has had no Buyer picks since bots paused (23 Oct). Dvir: test our logic **now** on saved lists — run filters/score as of that day, draw randoms from the same filtered pool, check later public outcomes, list winners for investigation, improve. Waiting months for T30 labels is the cost of not doing this.

## What already exists (reference; reuse, don't rebuild)
- Daily archive / seals: `datasave` job (`godaddyInventory`, `dynadotCloseouts` when key live, `scorePool`, `auctionShortlist`, `engineFeed`, `episodes`, `dqMarket`); compact GD ≤$250 .com gzip archives on Mac for 20–26 Oct (~26 MB/day).
- Filters + offline scores: `scorePool` + `GET /candidates/closeouts` (CR-072).
- Auction shortlist + paper outcomes: `auctionShortlist` + `GET /auctions/shortlist` / `GET /auctions/funnel` (auction-v4).
- Auction finals / ends: `godaddy_auction_end`, `engine_sales`, `engine_auction_ends`, `engine_unsold` (CR-071 R-10, CR-075, 5.50.0).
- Market / retail uploads: `POST /data/sales`, `GET /market/episodes` (UnreportedSales / DNJournal / DNW via bots; NameBio forbidden).
- D2 retail labels: `docs/requests/research/d2-names-labels-2026-10.csv` (18,155 rows; `split` = `dev`|`sealed`, salt `L2-iter-v1`). Sealed half stays closed until one final check.
- Pick-proof (to stop daily): steps `pickproofSeal`, `pickproofLabels`; routes `GET|POST /pickproof/*`. Sealed days 20–26 Oct stay as ordinary archives (replay may score them when outcomes exist). Gavriel already paused pick-proof routines.

## Rules
- R-1 **Pick-proof daily OFF.** Datasave must **not** run new `pickproofSeal` / `pickproofLabels` work or grow pool storage for new days. Days already sealed (Oct 20–26 and any earlier) stay readable as archives (manifest/arms/labels as stored); no requirement to finish T30 labelling. New `POST /pickproof/{date}/picks` for an unsealed future day may 409 `PICKPROOF_STOPPED` (or equivalent documented code). Discovery stays shortlist-first (DISCOVERY-FLOW-V2); this CR does not change money gates.
- R-2 **Compact daily archive continues.** Keep saving compact daily GoDaddy `.com` rows at **≤ $250** with every field (gzip JSON lines) on the Mac host disk (~26 MB/day), keyed by source data date — not only the 7-day raw zip window and not the Neon pool. Dynadot closeouts/aftermarket the same way once `DYNADOT_API_KEY` is nonempty. `/health` (or the replay report) shows `archive_days_n` / listed archived dates and any **missing** day in the expected range.
- R-3 **One replay tool for saved day D.** **Primary interface (locked 2026-10-27 via Gavriel):** `GET /replay/{date}` (READ or bots) — report for data date D (or pick-day mapping documented in the release note). Host `npm run replay` is a **local helper only** (may write the same report the GET reads); optional `POST /jobs/run {"job":"replay",...}` is fine if documented, but ATs and bots use the GET. For day D: run the **filters and scoring frozen as they stood on D** on D's archived list; draw **N** random names (default N = shortlist size or 25; setting ok) from the **same filtered pool** with a **fixed seed** derived from the pool/archive sha (reproducible; MT19937 / Fisher-Yates as CR-008 / pick-proof). Report precision of our top N vs the randoms with **counts beside every rate**.
- R-4 **Outcomes — side by side, never merged** (retail is the headline):
  1. Later **public retail** sale (UnreportedSales / DNJournal / DNW via `POST /data/sales` / market episodes / D2 `dev` rows only while tuning): flag **$500+** separately;
  2. Auction final price **≥ $100** (investor demand; engine / auction-end data);
  3. Auction final price **≥ our max** for that name/day (we could not have won; report, **not** a logic miss);
  4. Closeouts: taken vs dropped by RDAP ~30 days after D — **weak signal**, labelled as such; report next to D2, not merged.
- R-5 **Point-in-time only (scoring locked 2026-10-27 via Gavriel).** Freeze the **filters + score recipe/model as they stood on day D** — **not** today's recipe with features merely capped at D. On day D the logic may use **only** what existed on D: archived row fields, sealed snapshots/lists of that day, the D-day filter/score recipe (or model id active on D), lift/features with `feat_asof` ≤ D. **Forbidden:** later RDAP state, later sales, live lookups, post-D model weights, today's recipe re-run on D rows, or any feature dated after D. A test proves it (AT-2).
- R-6 **Holdout sealed sales stay closed.** While tuning / iterating, replay must **refuse** to read D2 rows with `split=sealed` (and any other holdout-sealed sales set marked sealed). Use sealed rows **once** for a final check only (explicit `final_check: true` or dedicated route documented). Default reads that would open sealed rows → 403/409 with a stable code (e.g. `REPLAY_HOLDOUT_SEALED`).
- R-7 **Honest numbers.** Every rate shows counts (`positives_n`, `denom_n`). If `positives_n` **< 20** for a reported comparison, mark `too_small: true` / status `too_small` — **too small to decide**; no keep/pass claim.
- R-8 **Winners listed for investigation.** Every name that did well (our top-N hits **and** randoms our logic missed that hit an outcome in R-4) appears in the report with domain, arm (`ours`|`random`), outcome kind, price when known, and the as-of-D features/score used — enough for a person to investigate. No money action from this list.
- R-9 **Keep rule for a logic change** (Gavriel harness; bots/Challenger use the report; DOM exposes the numbers): one logic change per replay run; keep only if expected profit rises, paired bootstrap wins ≥ 80% of resamples, and no slice with ≥20 buys loses more than 5%; a change that wins on auction labels but **not** on retail is **not** kept. Before each round: write pass mark, stop condition, and **max 3 rounds** (this CR's `max_rounds: 3`).
- R-10 **No money.** Replay creates no buys, bids, listings, price changes, or settings activation. Bots token stays non-money. `POST /auctions/plans`, `/buy`, portfolio import money paths untouched.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-8 pass in CI; `/health` shows the release; `GET /replay/{date}` (or documented equivalent) returns a report for at least one archived day; pick-proof daily steps are stopped/skipped; archive day count visible; Gavriel can read winners + `too_small` without money. |
| **Stop condition** | At most **3 rounds**. Further gaps = new CR/BUG citing an AT. |
| **Max rounds** | **3**. |

## Acceptance tests (via the API)
- AT-1 **Replay shape:** Given a sealed/archived day D with a known filtered pool, When `GET /replay/D` (or the documented primary), Then 200 with: `ours` top-N, `random` N (same pool, fixed seed), rates with counts, outcome blocks for retail / auction≥$100 / auction≥max (and closeout weak if applicable), and `winners[]` non-empty whenever any positive exists in either arm.
- AT-2 **As-of-day only (negative):** Given a fixture where a sale or RDAP state or feature exists only **after** D, When replay runs for D, Then that post-D fact does **not** enter filters, score, or features; leakage attempt fails DQ or is excluded (stable code / `leakage` style); repeating the call yields the same report sha or equivalent frozen fields.
- AT-3 **Holdout sealed closed (negative):** Given D2 (or fixture) rows with `split=sealed`, When a default (non-final) replay would use them as labels or training signals, Then 403/409 `REPLAY_HOLDOUT_SEALED` (or documented equivalent) and sealed rows are not readable for tuning.
- AT-4 **too_small:** Given a fixture day with fewer than 20 positives for the headline retail comparison, Then the report marks `too_small` / `too small to decide` and does **not** claim a keep/pass on that comparison.
- AT-5 **Winners listed:** Given at least one ours-hit and one random-hit our logic missed, Then both appear under `winners` (or equivalent) with arm, outcome kind, and as-of-D score/features.
- AT-6 **Pick-proof daily stopped:** After this release, a datasave run's summary shows `pickproofSeal` / `pickproofLabels` as `stopped` / `skipped` / `disabled` (not sealing new days); existing sealed archive days remain readable; optional: new picks on an unstarted day → 409 `PICKPROOF_STOPPED`.
- AT-7 **No money (negative):** Replay routes accept READ/bots only for the report; there is no replay path that places a bid, buy, list, or price change; bots token cannot call money routes through replay.
- AT-8 **Archive visibility:** `/health` (or `GET /replay` index / report meta) lists how many compact archive days exist and names any missing day in the covered range (at minimum the Oct 20–26 set already on disk remains visible).

## Out of scope
- Resuming pick-proof daily seals or Buyer arm-A nudges.
- Money actions, bid plans, listings, settings activation, Dynadot key creation (key install is outside this CR; Dynadot archive follows when key is nonempty).
- Scraping NameBio or venue seller pages; opening D2 `sealed` rows during tuning.
- Replacing discovery flow v2 (shortlist-first stays).
- Challenger grading UI; bots write investigation notes outside DOM.

## Decisions (locked — replace open questions; do not add Reply N)
1. **Primary interface:** `GET /replay/{date}`. `npm run replay` = local helper only. (Gavriel 2026-10-27, matches Dvir-approved plan.)
2. **Scoring:** freeze filters + score as they stood on day D — not today's recipe with features capped at D. (Gavriel 2026-10-27.)
3. **Dynadot archive:** remains out of this CR until `DYNADOT_API_KEY` nonempty.

## DVIR items
None remaining (Dvir already said yes to build; no money, no new paid service, no founder-rule change).

## Changes
- 2026-10-27 ~01:00 IDT (DOM Architect): expanded thin common-decision note into full CR (Rules, ATs, R-STOP-FIRST max 3, concrete routes/jobs). Status remains `approved` per Dvir YES ~00:53 IDT.
- 2026-10-27 ~00:56 IDT (DOM Architect): design lock from Gavriel — primary `GET /replay/{date}` (`npm run replay` helper only); freeze filters+score as of day D (not today's recipe with features capped at D). Questions section replaced by Decisions.

## DOM response (27 Oct 2026, v5.59.0, built; not yet released)

**Verdict:** accepted and built as v1. Rules and test ids: `docs/internal/replay.md` (RPY81-1..RPY81-21, `tests/modules/ops/replay.test.ts`).

### Conflict with R-5 and Decision 2, and how DOM resolved it
The CR says to freeze "the filters + score recipe/model as they stood on day D, not today's recipe". DOM does **not** implement that. **Resolution: the default is today's logic, run on day D's point-in-time data** (only D's archived fields, frozen lists, `settings`, and a lift table trained on or before D, else the CR-002 seed table). Reasons: Dvir's request is to test and improve our current logic; the recipe of past days was never stored (the shortlist logic changed six times on 26 Oct), so "as it stood on D" cannot be rebuilt honestly. Every report stores `logic_version` (`replay-v1|score version|lift id|settings hash`). The body and query field `logic` accepts only `"current"`; `as_of_date` answers 422 `REPLAY_LOGIC_UNAVAILABLE` until recipe versions are stored per day (v2).

### What v1 does
- **Archive:** datasave `godaddyInventory` writes `<ARCHIVE_DIR>/godaddy/<data_date>-<file base>.jsonl.gz` for `all_biddable_auctions` and `closeout_listings` (`.com`, price at most the S8 cap setting, all fields, gzip; skipped if present; failure only reported). `ARCHIVE_DIR` defaults to a sibling `archive` of `SNAPSHOT_DIR`. `/health.archive` = `{days_n, first, last, missing_days}`. Nothing deletes it. Dynadot is not archived (no key).
- **Pick-proof off:** `settings.pickproof_enabled` (default false). The two datasave steps report `{status: "off", reason: "CR-081"}`; no new pick day is frozen; picks for an unsealed day are 409 `PICKPROOF_STOPPED`. Sealed days stay readable.
- **Replay:** `GET /replay/{date}` (READ or bots; `kind`, `n` default 25, `seed`) is the route bots use: the newest finished report or 404 `REPLAY_NOT_RUN`. `POST /replay/runs` (WRITE only) queues a run (202 `{id}`; `dry_run` answers at once and stores nothing); `GET /replay/runs/{id}` and `GET /replay/runs` read status. Seed default = sha256 of the day's archive file plus the kind; the random group is shuffled with the pick-proof's MT19937 / Fisher-Yates from `src/core`. The report has counts beside every rate, `too_small` under 20 positives, a seeded paired bootstrap (1,000 resamples) per label, and `did_well` with the features of every positive name from both groups. Labels are side by side: `reached_100`, `beat_our_max`, `taken` (closeouts, pending until D+30, stored RDAP tags only), `retail_sale`, `retail_500`.
- **Point in time:** test RPY81-13 proves picks, scores, parts and maximums of D are identical with and without the D+1 file (AT-2).
- Migration `1767900000000_v5-59-0.sql`. The table is `replay_day_runs` (not `replay_runs`: that name is the selection replay's).

### Where retail outcomes come from
`market_sales` (the table behind `POST /data/sales`, listing type other than `closeout`) and `engine_sales` rows whose source is not `godaddy_auctions_file`. If none is stored after D the report says `retail: {status: "no_data"}` and has no retail label. **TODO (v2):** the D2 dev rows (`docs/requests/research/d2-names-labels-2026-10.csv`, `split=dev`) are not loaded by the server; until a bot uploads UnreportedSales / DNJournal / DNW through `POST /data/sales`, retail will be `no_data` on most days.

### Left for v2
- Logic as it stood on D (needs recipe versions stored per day).
- R-6 and AT-3 (`REPLAY_HOLDOUT_SEALED`): v1 never reads D2 at all, so sealed rows cannot be opened; there is no `final_check` route yet.
- R-9 keep rule is the bots' harness; DOM exposes `ours_win_share` only. No slice (price band) breakdown yet.
- Brand-typo rule and the other-endings lookups are not applied in the replay (endings unknown by design).
- Auction finals use the ended-auction tracker (from $100) or the last archived row (a lower bound); `beat_our_max` is a lower bound too.
- `npm run replay` helper not built (skipped, as allowed). Dynadot archive waits for the key.
- AT-8 is met by `/health.archive`; there is no `GET /replay` index.
- `pickproofLabels` no longer shrinks old pool rows while off.
