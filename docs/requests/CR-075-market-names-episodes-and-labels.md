---
id: CR-075
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-21 00:12 IDT, data program v1 (knowledge/data-program-v1.md), via Gavriel"
priority: P1
build_order: 2
depends_on: [CR-071]
supersedes: []
max_rounds: 2
---
# CR-075: market_names table, daily episodes and labels, data-quality job (data program v1)

**Approval:** Dvir approved the data program at 00:12 IDT Oct 21 (via Gavriel). Build right away, no ship date; DOM reports when it is live on /health. No step for Dvir. Tests first: the ATs below are the contract.

## Why
No fair test exists today: our sales are all $500+ and end Oct 4, our negatives are <=$50 and seen Oct 6-19. We need matched SOLD vs OFFERED-NEVER-SOLD names in the same price band and calendar window. Targets: daily $500+ saves running by **Oct 25** (CR-071 R-8..R-10), **1,000+** names `UNSOLD_30D` by about **Nov 25**, **2,000+** matched `UNSOLD_60D` by about **Dec 20**.

## Rules
- R-1 Table `market_names`, one row per name x venue x listing episode: `episode_id` (sha1 of name, venue, first_seen), `name`, `sld`, `tld` (lowercase, IDN as punycode), `venue`, `listing_type` (bin|offer|auction|closeout), `list_price_cents_first`, `list_price_cents_last` (never overwritten), `price_changes`, `first_seen`, `last_seen` (source data date, not run date), `days_listed`, `outcome` (sold|unsold|unknown|delisted), `outcome_rule`, `sale_price_cents`, `sale_date`, `source`, `source_url`, `source_sha256`, `tier` (A-D, required), `feat_asof`, `dup_group`, `price_band` (500-999, 1k-2.5k, 2.5k-5k, 5k-10k, 10k+).
- R-2 Daily job `episodes`: merge the sealed CR-071 snapshots and the uploaded sales into episodes and apply labels. **Unsold** = same name+venue in >=2 snapshots spanning **60+ days**, never with sale status, and no sale report up to day 90 (`UNSOLD_60D`). **30 days** = provisional `UNSOLD_30D`, early read only. **Sold** = a reported sale with price and date (`SOLD_REPORTED`), or a GoDaddy auction ending with >=1 bid (`SOLD_BIDS`, reported separately). **Unknown** = disappeared with no sale report, or seen once; never counted in either class. A snapshot gap breaks an episode only if it is > 7 days.
- R-3 Daily job `dq_market`: duplicates, survivorship (share seen from day 1), leakage (any feature with as-of date after first_seen/sale_date is rejected), price sanity (cents vs dollars, >10x jump flagged), coverage (rows per source per day vs 7-day median; tier on 100% of rows). Any failed check sets `/health.dq_market: "alert"` and a `/report` warning `DQ_MARKET_FAIL`; never silent.
- R-4 `POST /data/sales` (shared bots token, non-money): add-only rows `{name, venue, sale_price_cents, sale_date, source, source_url, tier}`. No update, no delete. Duplicates across sources keep the highest tier and record `dup_sources`.
- R-5 `GET /market/episodes?outcome=&band=&from=&to=&venue=&limit=`: summary counts first, then rows.
- R-6 `GET /market/matched?asof=&ratio=4&seed=`: each positive matched to up to 4 negatives in the same price band, .com, letters-only flag and 60-day calendar window. The set for a given (asof, ratio, seed) is **frozen and sealed** with a sha256; the same call always returns the same set and sha.
- R-7 `GET /market/dq` (latest checks with pass/fail) and `GET /market/coverage` (rows per source per day, counts per label and band, progress vs the targets above).
- R-8 **NameBio is never used in any automated way** (its ToS bans it). No paid data; no scraping of venue pages. No money action, no LLM.

## Acceptance tests (via the API)
- AT-1 Given fixture snapshots of a name on D and D+61 with no sale report, When the `episodes` job runs, Then `GET /market/episodes?outcome=unsold` contains it with `outcome_rule:"UNSOLD_60D"`, `days_listed` 61.
- AT-2 Given the same name seen on D and D+31 only, Then `outcome_rule:"UNSOLD_30D"` (provisional) and it is not counted in `UNSOLD_60D`.
- AT-3 Given a name listed on D and a `POST /data/sales` row for it on D+20, Then `outcome:"sold"`, `outcome_rule:"SOLD_REPORTED"`, with sale price and date.
- AT-4 (negative) Given a name seen once, or gone with no sale report, Then `outcome:"unknown"` and it appears in neither `/market/matched` class.
- AT-5 (negative) Given a sale row already posted, When a bot sends PUT, PATCH or DELETE on it, or POSTs the same row with a changed price, Then 405/409 `APPEND_ONLY` and the stored row is unchanged.
- AT-6 `GET /market/matched?asof=2026-12-20&ratio=4&seed=1` called twice returns the same rows and sha256; every negative shares its positive's band and window.
- AT-7 (negative) Given a fixture row with a feature as-of date after first_seen, Then `dq_market` fails `leakage`, `/health.dq_market:"alert"`, `/report` has `DQ_MARKET_FAIL`, and the row is excluded from `/market/matched`.
- AT-8 Given a fixture day with Dynadot rows at 10% of the 7-day median, Then `GET /market/dq` fails `coverage` for that source and day.
- AT-9 `GET /market/coverage` returns per-source daily counts and `unsold_30d_n`, `unsold_60d_matched_n` vs the targets (1,000 by Nov 25; 2,000 by Dec 20).
- AT-10 (negative) A `POST /data/sales` row with `source` containing `namebio` or with no `tier` is rejected 422.

## Out of scope
- Model training and scoring; the backtest itself (Challenger pre-registers and grades it); fetching DNJournal/DNW (bots upload weekly via R-4); any NameBio use; venue writes.

## Questions (max 3)
1. Will `market_names` (estimated 1-2M rows after 90 days) fit the free database next to CR-071's closeout rows? If not, say what you would keep (e.g. only $500+ rows and all GoDaddy auction ends).

## DVIR items
None.

## Changes
- 2026-10-21 00:14 IDT: filed (data program v1, Dvir 00:12 IDT Oct 21, via Gavriel).

<!-- DOM writes below this line -->

## DOM response (2026-10-21): accepted; built right after the CR-071 additions (R-8..R-10)

- **Order:**
  1. **v5.22.0:** CR-071 R-8..R-10 plus the bot upload route `POST /snapshots/dynadot`, so the $500+ saves run before 25 Oct.
  2. **Next release:** this CR.
  3. **After that:** CR-070, 072, 073 and 074.
- **Q1, storage:** 1–2M rows of all bands won't fit next to everything else in the free 1 GiB database. `market_names` keeps only episodes that can be a positive or a matched negative:
  - every reported sale (R-4);
  - Dynadot $500+ Buy-Now listings (R-8; already only $500+);
  - Dynadot closed auctions and GoDaddy auction endings whose price reached **$500 or more** at least once (R-9, R-10).

  An auction or closeout that never reaches $500 can't match a $500+ sale, so it isn't stored. The ≤ $40 closeouts stay in the CR-071 pool (3 days) for CR-072 and CR-073 only. DOM expects tens of thousands of episodes over 90 days, not millions; `GET /market/coverage` shows the real count. If it grows past 15% of the database, DOM says so here before dropping anything.
- **Unchanged:** R-1..R-8 and AT-1..AT-10 as written. Episodes key on the source data date; a gap over 7 days breaks an episode; unknown is never counted. Sales are append-only (409 `APPEND_ONLY`), and NameBio is refused (422).
