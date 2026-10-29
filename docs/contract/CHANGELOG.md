# Contract changelog

Semver for the API contract (`README.md` §Versioning). Newest first. Each entry links to its release note in `docs/releases/`.

## 5.77.0 (2026-10-29): CR-097 small writes pass the size guard until 95%; CR-096 price_sanity samples; CR-095 part 1 vacuum after prunes, /health table detail
Release note: `docs/releases/v5.77.0.md`.
MINOR. `DB_SIZE_HIGH` on the write routes: a body of at most 64 KB is refused only past 95% (bulk loads still at 70%); `details.stop_percent` added (CR-097). `GET /market/dq` `price_sanity` `detail.samples` and `/report` `DQ_MARKET_FAIL.failures[].samples` (CR-096). `/health.db_size.tables[]` adds `heap_bytes`, `index_bytes`, `dead_rows_estimate`; the datasave `snapshotRetention` and `episodes` summaries add `vacuum` (CR-095 part 1).

## 5.76.0 (2026-10-29): CR-094 datasave starts 15:25 UTC (Mac) / 15:20 UTC (GitHub backup)
Release note: `docs/releases/v5.76.0.md`.
MINOR (schedule only, no route or field change). The daily `datasave` starts at 15:25 UTC on the Mac host (was 15:05) and 15:20 UTC on the GitHub backup schedule (was 15:00), because GoDaddy publishes its inventory files at about 15:10 UTC. The 60-minute `GODADDY_NOT_PUBLISHED` retry is unchanged.

## 5.75.1 (2026-10-29): CR-092 kbLoad 0008 supersede; CR-093 docs live API URL
Release note: `docs/releases/v5.75.1.md`.
PATCH, no API change. Data: the knowledge file `0008` marks its Ron Jackson author row `supersede: true`, so the daily `kbLoad` loads it (CR-092). Docs: runbook and DEPLOYMENT point at the live api-proxy URL instead of the suspended Render URL (CR-093). Also corrects this changelog's 5.74.0 heading (2 days, not 3).

## 5.75.0 (2026-10-28): CR-090 /health datasave_detail; CR-089 run packs in docs/requests/discovery-runs; CR-091 bot-logic sync and guard
Release note: `docs/releases/v5.75.0.md`.
MINOR. `GET /health` adds `datasave_detail` (CR-090): the latest datasave run step by step (`status`, `data_date`, `error`), `missing_files`, `dynadot_missing`, `dynadot_due_date`. `datasave` is unchanged.

## 5.74.0 (2026-10-28): Dynadot aftermarket rows kept 2 days (archived to disk first); episodes fold day by day; protects the free 1 GB
Release note: `docs/releases/v5.74.0.md`.
MINOR (migration `1769000000000_v5-74-0.sql`). Dynadot aftermarket rows are kept `settings.datasave_aftermarket_keep_days` = 2 days, and each older day is archived to the host's disk first (`<ARCHIVE_DIR>/dynadot/<date>-aftermarket.jsonl.gz`). `snapshotRetention` adds `aftermarket_cutoff_date`, `aftermarket_rows_deleted`, `aftermarket_archive`. `episodes` folds each sealed day into the stored episodes. Market coverage counts pruned sealed days from their manifests.

## 5.73.0 (2026-10-28): BUG-060/061/062: datasave retries until GoDaddy publishes today, no crash on a dropped DB connection and an error manifest for a failed Dynadot pull, dqMarket bigint
Release note: `docs/releases/v5.73.0.md`.
MINOR (no migration, no route change). BUG-060: `godaddyInventory` fails with `GODADDY_NOT_PUBLISHED` when the newest GoDaddy file day is older than the run's UTC day, so the 60-minute retry seals today. BUG-061: a failed Dynadot pull step leaves an `error` manifest `STEP_FAILED: ...` for its day; a dropped DB connection no longer crashes the server. BUG-062: `dqMarket` no longer fails with `integer out of range`.

## 5.72.1 (2026-10-28): Paper trading keeps a 25-name slice after CR-088; shortlist rows kept 30 days
Release note: `docs/releases/v5.72.1.md`.
PATCH (migration `1768900000000_v5-72-1.sql`: `settings.shortlist_paper_n` 25, `shortlist_keep_days` 90 -> 30). Fix to 5.72.0: with the whole field stored, paper trading counted every stored name as `shortlist` and drew the control only from names with no room under the maximum. Now `shortlist` = the top 25 of the stored field and the control = 25 of the rest, as before CR-088.

## 5.72.0 (2026-10-28): CR-088 full hard-filter auction field
Release note: `docs/releases/v5.72.0.md`.
MINOR: the datasave `auctionShortlist` step now stores all hard-filter passers (not just the top 25) for each data date. `GET /auctions/shortlist` adds `offset` (pagination) and raises `limit` max from 100 to 10,000; `total` is now the count of all eligible rows, not just the returned page. `settings.shortlist_size` defaults to 0 (= all); a nonzero value still caps. If more than 10,000 names pass hard filters, the step stores none and warns. Migration `1768800000000_v5-72-0.sql`. Tests CR088-AT1..AT5.

## 5.71.0 (2026-10-27): BUG-059 round 2: Afternic listing fallback on unknown; stale price fails stop raising
Release note: `docs/releases/v5.71.0.md`.
PATCH-level fix, no migration. BUG-059 round 2: `portfolioCheck` reads the Afternic listing page when the lander gives no price **or** an `unknown` price (5.70.0 only on no price); `/report` no longer raises `LANDER_PRICE_MISMATCH` from a price `fail` that a newer price check (any status) followed. Tests LP-15, LP-16.

## 5.70.0 (2026-10-27): BUG-059 Afternic listing fallback for stale lander mismatches
Release note: `docs/releases/v5.70.0.md`.
PATCH (no migration, no new route, no new code). Lander price-check fallback:
- BUG-059: when the primary apex/lander fetch fails (e.g. GoDaddy forsale 403) for an Afternic-NS name and no price check is possible, the `portfolioCheck` now also fetches `https://www.afternic.com/domain/<name>` and parses it with the same 5.69.0 rules (512k body, LIMIT_COPY, tight "buy it now for"). A matching BIN writes a price `ok` row that clears stale `LANDER_PRICE_MISMATCH` warnings. Test LP-13, LP-14.

## 5.69.0 (2026-10-27): BUG-058 raise LANDER_BODY_BYTES; treat "must be below" as limit copy
Release note: `docs/releases/v5.69.0.md`.
PATCH (no migration, no new route, no new code). Lander body-read window and parser fix:
- BUG-058: `LANDER_BODY_BYTES` raised from 200,000 to 512,000 so the buyer-visible "Buy it now for $X" (at ~byte 251k on current Afternic pages) is inside the parse window. "Buy Now price must be below $100,000" (offer-limit copy) is now classified as `LIMIT_COPY` and never treated as a shown BIN, same spirit as BUG-054's ceiling skip. Test LP-11, LP-12.

## 5.68.0 (2026-10-27): BUG-056 lander $100k false positive; BUG-057 Dynadot aftermarket deep-page GAP fix
Release note: `docs/releases/v5.68.0.md`.
PATCH (no migration, no new route, no new code). Two parser/seal fixes:
- BUG-056: the lander price check's tight "Buy it now for $X" pattern (requiring both "it" and "for") is now tried first across the whole page before falling back to proximity patterns, so an unrelated $100,000 near a generic "Buy Now" never wins over the actual buyer-visible price. Test LP-9, LP-10.
- BUG-057: the aftermarket `deep_pages_empty` GAP no longer fires when rows were successfully collected from other pages. Empty deep pages are sealed as partial coverage (`coverage.pages_empty`), not discarded. The page-1 check stays: a page 1 with a total but no items is still a GAP. Test DYN-7, DYN-7a, DYN-7b.

## 5.67.0 (2026-10-27): F47 removed (Dvir declined); drops the idle hand-reg tables
Release note: `docs/releases/v5.67.0.md`.
MAJOR in form, no caller affected (migration `1768700000000_v5-67-0.sql` drops `handreg_weeks`, `handreg_names`, `handreg_labels` and the three `settings.handreg_*` columns). F47 removed: Dvir declined the paper test (Gavriel relay 27 Oct 2026, ~09:47 IDT), then approved removing it. `POST /handreg/weeks`, `GET /handreg/weeks[/{week}]`, `GET /handreg/report`, the codes `HANDREG_*` and the datasave step `handregLabels` are gone; they were never called. The BUG-054 lander fix of 5.66.0 stays.

## 5.66.0 (2026-10-27): F47 hand-registration paper test; BUG-054 lander Buy Now parser
Release note: `docs/releases/v5.66.0.md`.
MINOR (migration `1768600000000_v5-66-0.sql`: tables `handreg_weeks`, `handreg_names`, `handreg_labels`; `settings.handreg_max_pool` 2000, `handreg_max_picks` 30, `handreg_labels_max_per_run` 200).
- F47 (Dvir, 27 Oct 2026): `POST /handreg/weeks` (WRITE or bots): one sealed submission a week of a pool and picks; the server draws a same-size random control from the rest of the pool (crypto seed, MT19937 Fisher-Yates, `drawControl`) and RDAP-checks both arms. `GET /handreg/weeks`, `GET /handreg/weeks/{week}`, `GET /handreg/report` (taken and sold per arm at 6 and 12 months; proxy, not profit). New codes `HANDREG_WEEK_SEALED`, `HANDREG_POOL_TOO_SMALL`, `HANDREG_WEEK_NOT_FOUND`. Datasave step `handregLabels` after `pickproofLabels`.
- BUG-054 (PATCH-level fix): the lander price check reads "Buy it now for $X" first and never takes Afternic's offer ceiling `$49,999,999` as the Buy Now price; the false `LANDER_PRICE_MISMATCH` on three names clears at the next `portfolioCheck`.

## 5.65.0 (2026-10-27): machine-competition measures in paper trading (F43), renew-or-drop signal per name (F44), Dynadot steps last in datasave
Release note: `docs/releases/v5.65.0.md`.
MINOR (migration `1768500000000_v5-65-0.sql`: `auction_outcomes.prev_seen_price_cents`, `settings.renew_views_min` 10).
- `GET /auctions/funnel` `paper`: per group `bands {opening, low, mid, high}`, `median_final_bids`, `price_jump {median_cents, jumped_50_last_window_n}`; shortlist `lost_at_max_n`, `lost_at_max_share` (F43).
- `GET /report` `per_domain[].renewal_signal` (also on `/portfolio`): `{views_30d, leads_30d, views_trend, offers_365d, days_to_expiry, renewal_available, signal: renew|reprice|drop|too_early|null, reason}`; info warning `RENEWAL_SIGNAL_DROP` within 60 days of expiry (F44). Advice only: Dvir decides every renewal.
- Datasave: `dynadotCloseouts` and `dynadotAftermarket` run last, so the ~40-minute Dynadot read no longer delays the shortlist; a day's Dynadot rows are scored and merged by the next run.

## 5.64.0 (2026-10-27): CR-083: card evidence cache (POST/GET /data/card-evidence; USPTO checks fresh for 24 h)
Release note: `docs/releases/v5.64.0.md`.
MINOR (migration `1768400000000_v5-64-0.sql`: table `card_evidence`). CR-083: `POST /data/card-evidence` (WRITE, bots or data; append-only; corrections by `supersedes`) and `GET /data/card-evidence[/{id}]` (READ, bots, WRITE): bots post their own USPTO and firm-screen results once; a `uspto_check` is `fresh` for 24 hours unless a newer `/data/tm-kills` row exists; `fresh_only` hides superseded and stale rows. The service never looks up trademarks itself and nothing here touches money. New code `CARD_EVIDENCE_NOT_FOUND`.

## 5.63.0 (2026-10-27): CR-084: decisions store (POST/GET /decisions), X-Caller attribution, sources-of-truth map; CR-085: no new Sedo export work
Release note: `docs/releases/v5.63.0.md`.
MINOR (migration `1768300000000_v5-63-0.sql`: table `decisions`, `audit_log.caller`). CR-084 (Dvir §10 A: one place per durable fact):
- New `POST /decisions` (WRITE or bots; append-only; same id + same content = duplicate, other content = 409 `DECISION_EXISTS`; corrections are a new id with `supersedes`), `GET /decisions`, `GET /decisions/{id}` (404 `DECISION_NOT_FOUND`). A decision is a record only: it triggers nothing.
- Optional request header `X-Caller` (any case, stored lower-case) recorded in the audit (`GET /audit` `caller`) and the request log.
- New `docs/contract/sources-of-truth.md`: the only writer and the read routes per durable fact; company-box CSVs are not a source of truth.
- CR-085: Sedo is off for new work: no new Sedo pending exports, no Sedo step in the `/list` checklist; `GET /export/sedo.csv` and existing Sedo records stay.

## 5.62.0 (2026-10-27): Dynadot read by the server (REST v2, signed, read-only key): aftermarket listings sealed daily with the GAP/R-8v2 rules; closeouts wait for the API path
Release note: `docs/releases/v5.62.0.md`.
MINOR (migration `1768200000000_v5-62-0.sql`: `snapshot_manifests.origin` adds `server`, `status` adds `gap`). CR-080 item 3: the datasave step `dynadotAftermarket` reads Dynadot's RESTful v2 API itself (signed, read-only key) and seals the day through the same path as `POST /snapshots/dynadot` (origin `server`); a collapsed total records a GAP instead of a panel (R-8/R-8v2). `dynadotCloseouts` reads `GET /restful/v2/aftermarket/get_expired_closeout_domains` (path from Gavriel's connector; `current_price` is in cents) the same way (`DYNADOT_CLOSEOUTS_PATH` overrides it). A day already sealed by either side is a no-op; a bot upload after a server seal gets 409 `SNAPSHOT_SEALED`. New code `EMPTY_RESULT`.

## 5.61.0 (2026-10-27): Afternic seller API: daily read of listings, views and leads, drift warnings, POST /export/afternic/push (dry run first); lease-to-own maximum 12 months
Release note: `docs/releases/v5.61.0.md`.
MINOR (migration `1768100000000_v5-61-0.sql`: table `afternic_listings_daily`, `settings.afternic_lease_months` 16 -> 12). Afternic released an official seller API on 22 Oct 2026.
- New daily step `afternicSync` (read-only): every Afternic listing, 30-day views and leads (`visit_daily` source `afternic`), stored per day.
- `/report`: new warnings `AFTERNIC_DRIFT` (Afternic differs from the plan: BIN, floor, min offer, lease, lander buttons, intake style, status) and `AFTERNIC_NOT_LISTED`.
- New `POST /export/afternic/push` (WRITE; dry run first): sets Afternic to the plan for the names that differ; records the upload when it covered every listed name; never sends the walk-away. Codes `AFTERNIC_NOT_CONFIGURED`, `AFTERNIC_API_ERROR`.
- Lease-to-own maximum 12 months in the export and the push (Dvir, 27 Oct 2026; NameBio's LTO data: longer terms cancel more).

## 5.60.0 (2026-10-27): BUG-053: mineunited.com listing history carries Dvir's $2,488 approval reference (record only)
Release note: `docs/releases/v5.60.0.md`.
PATCH-level data fix (migration `1768000000000_v5-60-0.sql`), no contract shape change: one append-only `listing_history` row for mineunited.com with the approval reference D-2026-10-27-D005-PRICE; prices, schedule and exports unchanged (BUG-053 AT-4).

## 5.59.0 (2026-10-27): CR-081 historical replay replaces the pick-proof; daily archive
Release note: `docs/releases/v5.59.0.md`.
MINOR (migration `1767900000000_v5-59-0.sql`: `settings.pickproof_enabled` default false, table `replay_day_runs`). New routes `POST /replay/runs`, `GET /replay/{date}`, `GET /replay/runs/{id}`, `GET /replay/runs`; codes `ARCHIVE_DAY_MISSING`, `REPLAY_NOT_RUN`, `REPLAY_LOGIC_UNAVAILABLE`, `PICKPROOF_STOPPED`. The datasave steps `pickproofSeal` / `pickproofLabels` report `{status: "off", reason: "CR-081"}` (behaviour change; no caller depends on their summary). `godaddyInventory` writes the daily archive (`archive` in its summary). `GET /health` gains `archive`. New env `ARCHIVE_DIR`.

## 5.58.0 (2026-10-26): CR-079 daily missing-name check folded into portfolioCheck (4 new warnings, receipt pointers on /portfolio and books.csv)
Release note: `docs/releases/v5.58.0.md`.
MINOR (migration `1767800000000_v5-58-0.sql`: `venue_listings.approval_source`, the CR-076 seed rows tagged `seed_cr076`). CR-079:
- `/report` warnings: new `LISTING_RECORD_MISSING` (warn), `LISTING_UNAPPROVED` (warn), `OBSERVED_UNCONFIRMED` (info), `RECEIPT_POINTER_MISSING` (warn); `REGISTRY_MISMATCH` is warn when every difference is a hold, pending-delete or redemption status (error otherwise).
- `portfolioCheck` step summary: `alerts_n`, `by_code`.
- `GET /portfolio` rows: `receipt_ref`, `deal_id`. `GET /books.csv`: the same two columns appended at the end.

## 5.57.0 (2026-10-26): auction-v4 name part is the lift alone (word quality removed after the retail backtest)
Release note: `docs/releases/v5.57.0.md`.
MINOR (no migration). `GET /auctions/shortlist` `auction-v4`: the name part is the lift alone (word quality no longer multiplies it) and there is no uncommon-word cap; `parts.name.word_quality` is still shown. Why: `docs/research/backtest-retail-d2-2026-10-26.md`.

## 5.56.0 (2026-10-26): personal-name filter in the auction shortlist (Census first names + surnames)
Release note: `docs/releases/v5.56.0.md`.
MINOR (no migration). `GET /auctions/shortlist`: a personal name (common US first name + common US surname, the first name not a common word) is refused before scoring; new `dropped.name_rules.PERSON_NAME` count in the step summary.

## 5.55.0 (2026-10-26): maximum bid by position in the day's field (factor 1 at the top 1% down to 0.4 at 9%)
Release note: `docs/releases/v5.55.0.md`.
MINOR (no migration). `GET /auctions/shortlist` `max_bid_suggested`: the expected-value maximum is multiplied by a position factor (1 for the top 1% of the day's field, falling linearly to 0.4 at the top 9%, 0.4 below); a new reason line names it. With today's settings: top 1% $55, top 4% about $40, top 9% and beyond about $20.

## 5.54.0 (2026-10-26): a sealed GoDaddy auction day is parsed again when its rows lack the demand fields (today's file was saved before v5.49.0)
Release note: `docs/releases/v5.54.0.md`.
MINOR (no migration). Datasave `godaddyInventory`: a sealed auction file whose day has live rows without the demand fields is parsed again from the kept raw file; file `code` `SNAPSHOT_SEALED_REPARSED`, summary `reparsed_n`.

## 5.53.0 (2026-10-26): the outside review (CR-011 part B, Gemini) is removed: no AI calls inside the service (Dvir 26 Oct 2026)
Release note: `docs/releases/v5.53.0.md`.
MINOR by usage, a removal by shape (migration `1767700000000_v5-53-0.sql`: the six review tables dropped). Dvir, 26 Oct 2026: "No need the outside review, remove it. We have it in another way." The `/reviews*` routes, the `outsideReview` and `reviewRetry` steps, `/health` `review`, `review_reason`, `review_model`, the `REVIEW_OVERDUE` warning and `GEMINI_API_KEY` are removed. No caller used them (traffic report: 0 calls; the review was off since about 9 Oct), so this is not released as MAJOR. `tick` keeps reconciler, nsVerifier and screeningResume (workflow renamed `tick.yml`, same schedule).

## 5.52.0 (2026-10-26): the 40 slots are shared by Line 1 and S8 (the 30/10 split is removed, Dvir 26 Oct 2026)
Release note: `docs/releases/v5.52.0.md`.
MINOR (migration `1767600000000_v5-52-0.sql`: `settings.s8_reserved_slots` dropped). Dvir, 26 Oct 2026: "No need to limit ourselves to 30 and 10 ... Remove this limitation please."
- `POST /buy` and `POST /portfolio/import`: only the total `settings.max_domains` (40) limits both lines; the S8 slots-full refusal is no longer raised (an import over the total gets `DOMAIN_CAP_REACHED`, as a buy does). 409 details `{domains, max_domains, line1_domains, s8_domains}`.
- `/report` `lines[]`: `max_names` is the shared total (40) on both rows, new `shared: true`.
- Removed (unused by the bots' routines): the reserve count in the `s8` block of the `POST /portfolio/import` answer.

## 5.51.0 (2026-10-26): auction-v4 reweighted after the backtest on our own labels: name 30, demand 40, age 25, bids 5; uncommon-word cap skipped when another ending has a live site
Release note: `docs/releases/v5.51.0.md`.
MINOR (no migration). `GET /auctions/shortlist` `auction-v4` weights: name 30 (was 70), demand 40 (was 15), age 25 (was 10), bids 5; the uncommon-word cap is skipped when `parts.demand.developed_tlds` >= 1. Shapes unchanged. Why: `docs/research/backtest-production-2026-10-26.md`.

## 5.50.0 (2026-10-26): warnings cleanup (forwarded names, floor auto-accept, review off, paused Dynadot, idle drop feed), lease-to-own in the Afternic export (on, 16 months), GET /engine/rows, auction-end labels
Release note: `docs/releases/v5.50.0.md`.
MINOR (migration `1767500000000_v5-50-0.sql`: `settings.afternic_lease_to_own` true, `settings.afternic_lease_months` 16, table `engine_auction_ends`).
- `/report` warnings: NS_UNVERIFIED and the nameserver part of REGISTRAR_DRIFT are not raised for a name with an active forward; FLOOR_AUTO_ACCEPT is no longer a /report warning (still in `/list` and plan answers); REVIEW_OVERDUE only while the outside review is enabled; DATASAVE_MISSED expects a Dynadot source only when one was uploaded in the last 3 days; DROP_FEED_STALE is info after 14 idle days.
- `GET /export/afternic.csv` (and the `/list` and pricing previews): Lease to Own `Y`, Max Lease Period `16`, Show Lease to Own Option `Y` for BIN and hybrid names with a BIN of $495 or more (Dvir, 25 Oct 2026); offer rows and lower BINs stay `N`.
- New `GET /engine/rows` (READ or bots): labelled rows by `kind` (sales, unsold, auction_ends), cursor `after_id`.
- Datasave `engineFeed`: ended in-range auctions under $100 with bids are stored in `engine_auction_ends` by band (opening, low, mid); `GET /engine/health` `data.auction_ends_n`. Training is unchanged.

## 5.49.0 (2026-10-26): improvement pass: storage cap on closeout expiries and the data-save pool, auction score v4 (position in the field, free GoDaddy demand fields, headroom as a filter), paper trading, $23 renewal ($55 maximum)
Release note: `docs/releases/v5.49.0.md`.
MINOR (migration `1767400000000_v5-49-0.sql`: `settings.closeout_expiry_collect_max` 1000, `datasave_pool_keep_days` 3 -> 2, index `datasave_pool_domain` dropped, `shortlist_renewal_cents` 1100 -> 2300, `godaddy_auctions_live` demand columns, table `auction_outcomes`).
- `GET /auctions/shortlist`: `score_version` `auction-v4` when a lift table exists: name part 70 = the name's position in the day's field (`parts.name.raw`, `parts.name.field_pct`), new `parts.demand` (15: other endings with a live site and exact-match registrations from GoDaddy's file), age 10, bids 5; no headroom points (still a filter). `max_bid_suggested` is $55 at full score (renewal $23).
- `GET /auctions/funnel`: new `paper` block (shortlisted names' final prices and would-win count at our maximum, against a random control of 25 a day).
- Datasave `buildPanel`: the closeout expiries collector keeps at most 1,000 new names a run (md5 sample) and deletes never-checked rows past the window (`stale_deleted_n`, `sample_max`, `eligible_new_n`).

## 5.48.0 (2026-10-26): expected-value maximum bid (F22 option b: 10% sale chance x net resale - renewal, $65 at full score), position in the day's field (field_n, top_pct)
Release note: `docs/releases/v5.48.0.md`.
MINOR (migration `1767300000000_v5-48-0.sql`: `settings.shortlist_sale_chance_bp` default 1000, `settings.shortlist_renewal_cents` default 1100, `auction_shortlist.field_n`).
- `GET /auctions/shortlist`: `max_bid_suggested` is the expected value (F22, Dvir's choice (b)): sale chance x net resale - one renewal, scaled by the score; $65 at full score with the defaults (was 20% of the net resale, $160). Names priced at $65 or more drop out as no headroom.
- `GET /auctions/shortlist`: new row fields `field_n` and `top_pct` (rank as a share of the day's filtered auctions); new `settings` fields `shortlist_sale_chance_bp`, `expected_resale_cents`/`expected_resale`, `renewal_cents`/`renewal`. The step summary has `field_n`.

## 5.47.0 (2026-10-25): Storage cut (pick-proof pool, closeout expiries), adult filter, lift scoring in the shortlist (auction-v3), bot-aware visit counter
Release note: `docs/releases/v5.47.0.md`.
MINOR (migration `1767200000000_v5-47-0.sql`: table `lift_models`, `visit_daily.suspect_hits`, `settings.closeout_expiry_keep_days`, `pickproof_pool_keep_days` 45 -> 1).
- New `GET /engine/lift` (READ or bots): the lift table (patterns, bins, lifts, counts, holdout AUC).
- New daily step `liftTrain` (after `engineTrain`): trains the lift table from the CR-002 seed and our own sales / unsold rows when they grew.
- `GET /auctions/shortlist`: `score_version` `auction-v3` when a lift table exists (name part from the lift, `parts.name.lift`, bids worth 5 points instead of 10); adult words and the company's forbidden terms are refused (`dropped.name_rules` `ADULT_TERM`, `FORBIDDEN_TERM`). The suggested-maximum rule is unchanged.
- `GET /pickproof/{date}/pool`: 410 `PICKPROOF_POOL_PRUNED` from the second day (was 45 days); the step `pickproofLabels` keeps only the arm names of older sealed days (`pool_rows_deleted_n`). Manifest, arms, hashes and labels unchanged.
- `buildPanel` `expiries` adds `regime_loaded`, `out_of_regime_deleted_n`, `decided_deleted_n`.
- `POST /visits/hit` accepts `ua_class: "suspect"`; `GET /visits` and `/visits/weekly` rows add `suspect_hits`; a name's human hits count at most 10 a UTC day, the rest are suspect.

## 5.46.0 (2026-10-25): First-run fixes: unsold feed for closeouts that run to their end, auction score v2 (common words, spread), the Mac starts the data save, engine age leak fix
Release note: `docs/releases/v5.46.0.md`.
MINOR (migration `1767100000000_v5-46-0.sql`).
- Datasave step `buildPanel` returns `expiries` (closeout names checked by RDAP after their end date); step `engineFeed` returns `expired_unsold_candidates_n` and `expired_unsold_inserted_n` and writes the dropped names to `engine_unsold`.
- `GET /auctions/shortlist`: `score_version` `auction-v2`; `parts.name` adds `word_quality`, `word_levels`, `all_common`; the suggested maximum is full from score 85 (was 70).
- Engine feature `com_age_years` is whole years.

## 5.45.0 (2026-10-25): Daily auction shortlist with suggested maximum bids, auto pre-bid checks and the weekly buying funnel; first knowledge base load (G-127, CR-078)
Release note: `docs/releases/v5.45.0.md`.
MINOR (migration `1767000000000_v5-45-0.sql`).
- New `GET /auctions/shortlist` (READ or bots): the daily shortlist of the best live GoDaddy auctions in our range, each with rank, auction score v1 and its parts, price, bids, end time, a suggested maximum bid (`max_bid_suggested`: 20% of a realistic net resale, $1,000 by default (`settings.shortlist_expected_resale_cents`), scaled by the score, at most the S8 cap, rounded down to $5), GoDaddy's valuation (shown, not scored), the automatic pre-bid (`prebid {id, verdict, checked_at, valid_until, flags}`) and plain-language reasons. New `GET /auctions/funnel` (READ or bots): plain counts over a date range (default 7 days): live auctions seen, shortlisted, auto pre-bid verdicts, pre-bids by bots, bid plans by status, imported, S8 names bought / listed / sold, views and leads of those names, sales. New datasave step `auctionShortlist` (after `engineFeed`; the job has twelve steps). New settings (migration only): `shortlist_horizon_hours` 72, `shortlist_size` 25, `shortlist_endings_n` 50, `shortlist_prebid_n` 10, `shortlist_keep_days` 90, `shortlist_expected_resale_cents` 100000. No existing route, field or code changes.
- First knowledge base load: `data/knowledge/0001-questions.jsonl`, `0002-october-research.jsonl` (step `kbLoad`).

## 5.44.0 (2026-10-25): Safety upgrades for auction names: brand typo and combosquat, URIBL, visible gaps, exact search strings, after-auction transfer check
Release note: `docs/releases/v5.44.0.md`.
MINOR release (migration `1766900000000_v5-44-0.sql`: `domains.transfer_confirmed`, `domains.transfer_checked_at`).
- `POST /auctions/prebid`: new checks `BRAND-TYPO-2` (typo, look-alike letters or a contained brand against the Majestic top 10,000 brand labels; FAIL, FLAG when the brand or the name is an ordinary word), `URIBL-1` (black FAIL, grey or red FLAG, a refused or unprovable query a FLAG), `SPAMHAUS-DBL` (always SKIP: free access is non-commercial only), `EUIPO-1` (always SKIP until the founder creates an EUIPO key). Every check has `checked_at`. `manual_required[EXACT_STRING_BUSINESS]` adds `name_as_words`, `camel_case`, `search_strings`; `HIST_WAYBACK` adds `wayback_url`.
- `POST /portfolio/import` (S8): the answer adds `transfer_confirmed` (RDAP's registrar is the one imported into: true / false / null) and a warning `S8_TRANSFER_UNCONFIRMED` when it is not true. `/report` warning `S8_TRANSFER_UNCONFIRMED` (warn) until the daily `portfolioCheck` step sees our registrar. Listing is not blocked.
- New codes in evidence: `URIBL_BLACK`, `URIBL_GREY_RED`. New report warning `S8_TRANSFER_UNCONFIRMED`.

## 5.43.0 (2026-10-25): Knowledge base, phase 1 (CR-078, G-132)
Release note: `docs/releases/v5.43.0.md`.
MINOR release.
- **New routes** (WRITE, bots or data token for the POSTs; READ or bots for the GETs; the POSTs take `Idempotency-Key`, are audited with row counts only, accept `dry_run` and 1..1,000 rows, and are all-or-nothing: one bad row is 422 `KB_ROWS_REJECTED` with `details.rejects[]`, nothing stored): `POST /kb/sources`, `/kb/authors`, `/kb/claims`, `/kb/evidence`, `/kb/links`, `/kb/questions`; `GET /kb/questions`, `/kb/questions/{id}/verdict`, `/kb/claims`, `/kb/sources`, `/kb/recheck`, `/kb/echo-candidates`.
- Rows name each other by natural key (source URL, author name, claim_key, question slug). Append-only with `supersede: true` corrections. Sources are deduplicated by canonical URL; excerpts get a MinHash for echo detection.
- `GET /kb/questions/{id}/verdict` computes the verdict in plain code from the versioned `kb_settings` (v1 = research §2.3): weight G x C x N x R x K, independence clusters, certainty high / moderate / low / very_low with each step down in plain words; appends a `kb_verdicts` row only when the result changed. Anything above very_low needs 3 independent clusters, 2 of them A or B.
- New daily step `kbLoad` (after `referenceRefresh`): loads DOM's repo files `data/knowledge/*.jsonl` once per file hash.
- New codes `KB_ROWS_REJECTED` (422), `KB_QUESTION_NOT_FOUND` (404). Data tokens may POST under `/kb/`. Migration `1766800000000_v5-43-0.sql` (nine `kb_*` tables).

## 5.42.0 (2026-10-25): Bulk work everywhere: batched DB reads and writes, parallel registry checks, faster sibling scan (G-121, G-122, G-124)
Release note: `docs/releases/v5.42.0.md`.
MINOR release of PATCH-level changes (no response shape, route or code changes; no migration).
- Internal bulk work: `POST /data/sales` (5,000 rows: 10,003 queries to 9), intake, T30 labels, disappearance tags, `engineEndings`, test-set seal, `POST /selection/labelled-names` and `POST /ledger/costs` read and write in batches; `ext_dates`, `same_name` and the pre-bid endings ask their registries side by side (each host keeps its pacer).
- `POST /selection/sibling-scan`: a name's siblings are checked 4 at a time with per-host pacing; `siblings.time_budget_seconds` stays the whole-call budget, capped at 90 s (under Cloudflare's ~100 s request limit).

## 5.41.0 (2026-10-25): Free data for the scoring engine: holdout block removed, engineFeed from GoDaddy closeouts and auctions
Release note: `docs/releases/v5.41.0.md`.
MINOR (migration `1766700000000_v5-41-0.sql`: `settings.datasave_auction_min_cents`).
- `POST /engine/sales`, `POST /engine/unsold` and the `/data/*` loads no longer reject rows dated after the holdout date; `HOLDOUT_SEALED` is no longer returned. `GET`/`POST /engine/holdout-date` stay, deprecated; their answers add `effect: "none since 5.41.0"`.
- `POST /engine/sales` refuses a row whose `venue`, `source` or `source_url` names NameBio (`SOURCE_NAMEBIO_FORBIDDEN`).
- Job `datasave`: new step `engineFeed` (unsold names from deleted GoDaddy closeouts, sold names from GoDaddy auction endings with a bid, into the engine tables, `by: datasave`); `buildPanel` tags engine-regime names first (`tags.regime_due_n`); `godaddy_auctions` keeps auctions from `settings.datasave_auction_min_cents` (default $100, was $500).

## 5.40.0 (2026-10-25): DB query counter per request and per job step (G-125)
Release note: `docs/releases/v5.40.0.md`.
MINOR (additive; no migration).
- **`GET /jobs/runs`:** each finished step gains `db: {queries, ms, errors?, top?}` next to `ms` (`jobs.md`). `top` (the three most repeated query shapes, SQL text only, never parameters) appears from 50 queries. Existing fields and `summary` are unchanged.
- No route, response body or error code changes. The host log line "request completed" gains `db_queries`, `db_ms` and, from 20 queries, `db_top`; `npm run traffic -- <api.log>` summarises it per route.

## 5.39.0 (2026-10-25): Auction bid plans: pre-bid check, Dvir's approved maximum, results, S8 import needs a plan (CR-077)
Release note: `docs/releases/v5.39.0.md`.
MINOR (additive; migration `1766600000000_v5-39-0.sql`), with one tightened rule: an S8 import without a bid plan, accepted before, is now 409 `BID_PLAN_REQUIRED`.
- **New `POST /auctions/prebid`** (WRITE or bots, idempotent, audited, stored in `prebid_checks`): the automatic safety checks of a registered auction name (SPELL-1, BRAND-1, BIGCO-1, TM_KILL, TYPO-1, SURBL-1, WEB-RISK-1, RDAP_STATUS, SAME_NAME_ENDINGS, UK_COMPANY), `verdict` pass/flag/fail, the manual checks still required, the other endings.
- **New `POST /auctions/plans`** (WRITE): Dvir's approved maximum bid; the approval names the domain and the maximum; a prebid of the last 72 h that did not fail; both manual checks confirmed; above $50 a reason; closeouts 409 `CLOSEOUTS_PAUSED` (`settings.s8_closeouts_allowed` false). **New `POST /auctions/plans/{id}/result`**, **`GET /auctions/plans`**, **`GET /auctions/plans/{id}`**.
- **`POST /portfolio/import` (S8):** needs an open or won plan and `price_paid` at or under its maximum (409 `BID_PLAN_REQUIRED` / `PRICE_ABOVE_PLAN`); with a plan, `approval_ref` may be left out (the plan's approval is used).
- New codes: `CLOSEOUTS_PAUSED`, `PREBID_REQUIRED`, `PREBID_FAILED`, `BID_PLAN_EXISTS`, `BID_PLAN_NOT_FOUND`, `BID_PLAN_CLOSED`, `PRICE_ABOVE_PLAN`, `BID_PLAN_REQUIRED`.

## 5.38.0 (2026-10-25): /health db_size.tables: the 10 largest tables (G-119, DB growth)
Release note: `docs/releases/v5.38.0.md`.
MINOR (additive; no migration).
- **`GET /health` `db_size.tables`:** the 10 largest tables of the public schema, largest first, `[{table, bytes, rows_estimate}]` (`bytes` includes indexes and TOAST; `rows_estimate` is the planner estimate, null before the first analyse). The other `db_size` fields are unchanged.

## 5.37.0 (2026-10-25): GoDaddy auctions in our buying range kept daily; GET /auctions/live
Release note: `docs/releases/v5.37.0.md`.
MINOR (additive; migration `1766500000000_v5-37-0.sql`).
- **New `GET /auctions/live`** (READ or bots): GoDaddy public auctions inside our buying range (`.com`, price up to `settings.s8_max_price_cents`, at least `settings.datasave_auction_live_min_bids` bids) from the latest daily save, with end time, price, bid count, age, GoDaddy valuation and pageviews; filters `date`, `max_price`, `min_bids`, `ends_within_hours`, `type`, `sort`, `limit`, `offset`, `include_ended`.
- **Datasave `godaddyInventory`** also keeps those rows (table `godaddy_auctions_live`, 7 days, `datasave_auction_live_keep_days`); its summary adds `live_kept_n` and `live_band_max_cents`, and `snapshotRetention` adds `auctions_live_cutoff_date` / `auctions_live_deleted`. `godaddy_auctions` ($500+) is unchanged.

## 5.36.0 (2026-10-25): S8 per-name price cap raised from $50 to $250 (Dvir, 25 Oct)
Release note: `docs/releases/v5.36.0.md`.
MINOR (a limit change; migration `1766400000000_v5-36-0.sql`).
- **`POST /portfolio/import` (S8):** the per-name price cap `settings.s8_max_price_cents` is now 25000 ($250; was 5000). `S8_PRICE_CAP` answers only above $250. Nothing else changes; the cap is still not settable through the API.

## 5.35.0 (2026-10-25): the daily save seals pick-proof days that no bot sealed
Release note: `docs/releases/v5.35.0.md`.
MINOR (additive; no migration).
- **New datasave step `pickproofSeal`** (after `buildPanel`, before `snapshotRetention`; the job now has ten steps): every pick-proof day before today (UTC) that is still unsealed is frozen if needed and sealed, as the first manifest call after the deadline would do. Same pool rule, seed and draw. A day it froze itself shows `sources.frozen_by: "datasave"`. Today is never touched.
- **New code `POOL_SOURCE_PRUNED` (410):** a call that would freeze a day whose closeout rows of D-1 are already deleted (3-day retention). Before, such a call would have frozen an empty pool.

## 5.34.0 (2026-10-22): BUG-052: closeout disappearances tagged bought, deleted or unknown by RDAP
Release note: `docs/releases/v5.34.0.md`.
MINOR (additive; migration `1766300000000_v5-34-0.sql`).
- **Datasave step `buildPanel` tags every disappearance by RDAP** (`jobs.md` row `datasave`): closeout names that left before their `ends_at` (GoDaddy, and sealed Dynadot closeouts uploads) and market episodes labelled `DISAPPEARED` get `bought` (registrar changed, active), `deleted` (404, redemption period / pending delete, or re-registered) or `unknown` (never a guess). The first run backfills every stored day pair. At most 1,500 live lookups a run, outside the bots' RDAP limit; an unknown is checked again daily for 7 days.
- **`buildPanel` summary adds** `gone_bought_n`, `gone_deleted_n`, `gone_unknown_n` (sum = `gone_before_end_n`), `dynadot` (the same for the two latest sealed Dynadot closeouts uploads) and `tags` (the tagging run). Existing fields keep their meaning.
- **`GET /market/episodes` adds** `disappearance_tag` and `disappearance_tag_reason` per row (null unless `outcome_rule` is `DISAPPEARED`) and `summary.disappeared_by_tag`.

## 5.33.0 (2026-10-22): CR-073a PP-V2: pick-proof two-word rule pickproof-v2 (common words, 3+ letters)
Release note: `docs/releases/v5.33.0.md`.
MINOR (additive; migration `1766200000000_v5-33-0.sql`).
- **Pick-proof recipe `pickproof-v2`** for every day frozen from this release on: `is_two_word` (the C1 sub-pool) = letters only, at most 10 letters, not SPELL-1, and at least one split into two parts of 3+ letters, each with a vowel and each on the frozen common-word list `data/wordlists/en-scowl-35-lower.txt` (sha256 `60ca88eb…41dc16`). `dhsar.com` is no longer two-word.
- **Manifest `recipe.version`** is now the version the day was frozen with (`pickproof-v1` for days frozen before, with their v1 hashes unchanged; `pickproof-v2` after). The v2 pool-rule text also states the tie rule correctly (dynadot before godaddy) and the `POOL_NOT_READY` freeze condition. `pool_sha256` and the draw are unchanged.

## 5.32.0 (2026-10-21): BUG-051: /snapshots/dynadot limits documented, ROWS_LIMIT and PRICE_CAP codes
Release note: `docs/releases/v5.32.0.md`.
MINOR (additive; no migration).
- **`POST /snapshots/dynadot` limits stated:** at most 50,000 rows per call; every price field at most 2,000,000,000 cents (inclusive).
- **New codes (422):** `ROWS_LIMIT` (`details.max_rows`, `details.received_n`) and `PRICE_CAP` (`details.max_cents`, `details.rows` up to 20 indexes, `details.over_n`). The row limit is checked first; the whole call is refused, nothing stored. Other problems stay `VALIDATION_ERROR` (they were all `VALIDATION_ERROR` before).

## 5.31.0 (2026-10-21): CR-073a: a pick-proof day freezes only after the daily filter step (POOL_NOT_READY)
Release note: `docs/releases/v5.31.0.md`.
MINOR (additive; no migration).
- **New code `POOL_NOT_READY` (409):** a pick-proof call that would freeze day D (picks, manifest, pool) while GoDaddy closeout rows of D-1 have not been through the daily filter step (`scorePool`) answers 409 with `details.pending_n`, and nothing is stored. Retry after the daily save finishes. Days already frozen are unchanged.

## 5.30.0 (2026-10-21): CR-073a: GET /pickproof/{date}/pool and the pool-hash recipe
Release note: `docs/releases/v5.30.0.md`.
MINOR (additive; no migration).
- **New `GET /pickproof/{date}/pool`** (READ or bots): the frozen pool rows `[domain, source, price_cents, passes_k1, is_two_word]` in byte order, with `pool_sha256`, `seed` and `sources`; the SHA-256 of the first three fields is `pool_sha256`. Freezes the day on first use like the manifest; shows no arm.
- **Manifest `sources.excluded_sales_graded`:** the names removed as sales-graded when the pool was frozen (days frozen from 5.30.0 on).
- **New code:** `PICKPROOF_POOL_PRUNED` (410) once the pool rows are removed after 45 days.
- **Doc fix:** a tie on price between a GoDaddy and a Dynadot row keeps the Dynadot row (byte order of the source name); the internal doc said GoDaddy (G-117). The code did not change.
- **Pool-hash recipe** written out in `docs/internal/pickproof.md` (CR-073a item 6). Also corrects the 5.29.0 release note: the `POST /rdap/batch` field is `domains`, not `names` (the contract was right).

## 5.29.0 (2026-10-21): CR-074 RDAP lookup service with cache and rolling limit; bots scope checked before the body
Release note: `docs/releases/v5.29.0.md`.
MINOR (additive; migration `1766100000000_v5-29-0.sql`).
- **New RDAP lookup service (`endpoints.md` §RDAP lookup service):** `GET /rdap/{domain}` (READ or bots; `?fresh=true`), `POST /rdap/batch` (1..500 `.com` names; READ, bots or WRITE; a read-only POST like `POST /score`: no `Idempotency-Key`, no audit row) and `GET /lookups/usage`. Row `{domain, registered: true|false|null, created, expires, registrar, status[], checked_at, cache_age_s, source: "rdap", reason_code?}`. One cache shared with the internal steps (TTL `lookups_rdap_ttl_hours`, default 24); a cached answer costs no limit.
- **Rolling limit:** `lookups_rdap_daily_limit` (default 200) live lookups per rolling 24 hours on UTC timestamps (no midnight reset), counted only for these routes; the internal daily steps never count. Over the limit: cached answers still 200; a needed live lookup is **429 `LOOKUP_LIMIT`** (`details.retry_after_s`, `Retry-After`). A batch cut off by the limit answers 200 with `limit_hit: true`, `retry_after_s` and `registered: null, reason_code: "LOOKUP_LIMIT"` rows; it is a whole 429 only when no row could be answered.
- **Errors are not zeros:** timeout, source error and an upstream 429 give `registered: null` with `reason_code` `TIMEOUT`, `SOURCE_ERROR`, `RATE_LIMITED`; never `false`, and never cached.
- **New code:** `LOOKUP_LIMIT` (429). 501 names in a batch: 400 `VALIDATION_ERROR`.
- **New settings (migration only):** `lookups_rdap_ttl_hours`, `lookups_rdap_daily_limit`. New tables `rdap_cache`, `lookup_usage` (not in the backup).
- **Bots scope before the body (CR-076 note):** a bots token on a money route is **403 `SCOPE_FORBIDDEN` whatever the body is**, an unparseable or too large one included (before: 400 `INVALID_BODY` for a body that is not JSON); with `"dry_run": true` the route's own validation follows. A WRITE token is unchanged.
- **Not built:** `GET /tm/{term}` (CR-074 R-3): no official no-key USPTO source; trademark kills keep loading through `POST /data/tm-kills`.

## 5.28.0 (2026-10-21): CR-073 pick-proof mechanics
Release note: `docs/releases/v5.28.0.md`.
MINOR (additive; migration `1766000000000_v5-28-0.sql`).
- **New routes (Pick-proof, `endpoints.md`):** `POST /pickproof/{date}/picks` (WRITE or bots, non-money: the Buyer's picks, arm A), `GET /pickproof/{date}/manifest` (the seal), `GET /pickproof/{date}/arms`, `GET /pickproof/report` (READ or bots). The pool of pick day D is the sealed CR-071 save of the evening before (data date D-1): `.com` closeouts of GoDaddy and a sealed Dynadot upload at $40 or less, minus sales-graded names, frozen with a sha256 on first use. Arms of `k` = 100 names (raise-only to 300): A the Buyer's picks, B1 random, B2 random from the K1-passing names, C1 random from two-word names of at most 10 letters; **C2 (.net-registered) is `not_built`** (deferred). Draws use the CR-008 MT19937 / Fisher-Yates recipe with a derived seed per arm.
- **New codes:** `PICKPROOF_SEALED` (409), `PICKPROOF_NOT_SEALED` (409), `NOT_IN_POOL` (422); `SNAPSHOT_MISSING` (409) is also returned for a pick day whose evening-before snapshot is not sealed.
- **Seal:** the first manifest call at or after 16:00 UTC of D draws B1, B2, C1 and seals the day; picks close at the same time (409 `PICKPROOF_SEALED`); the arms are shown only after that call. The bots append the manifest to `docs/requests/pick-proof-seals.md` (DOM commits no data).
- **New `datasave` step `pickproofLabels`** (ninth, last; `jobs.md`): T30 labels (`taken`, `not_taken`, `unknown`) for the names of the sealed arms 30 days after the pick day, Verisign RDAP only, at most 300 lookups a run; the one outside call is the public RDAP host. Changed from CR-073 R-4 as written: arm names only, not every pool name.
- **Report:** per arm n, events, rate, `unknown_n`; A against C1 (primary, one-sided Fisher, alpha 0.05, CMH by price band), B1 and B2 (Holm); overlap above 5% switches to a seeded within-day permutation test (10,000 shuffles); under 10 events `UNPOWERED`. Every output is labelled "proxy, not profit".
- **New settings (migration only):** `pickproof_k` (raise-only trigger, 1..300), `pickproof_deadline_hour_utc`, `pickproof_pool_max_price_cents`, `pickproof_labels_max_per_run`, `pickproof_pool_keep_days`. The seeded generator moved to `src/core/mt19937.ts` (bt1 outputs unchanged).

## 5.27.0 (2026-10-21): CR-076 listing provenance, display-name route; PUT Idempotency-Key wording
Release note: `docs/releases/v5.27.0.md`.
MINOR (additive; migration `1765900000000_v5-27-0.sql`).
- **Listing provenance (CR-076):** every `venue_listings` record carries `provenance` (`ours_confirmed` | `observed_public` | `unknown`). `POST /listings/{domain}/venue` (WRITE only, a bots token stays 403 `SCOPE_FORBIDDEN`) takes an optional `provenance` (`ours_confirmed` default, or `unknown`) and echoes it. **New route `POST /listings/{domain}/observed`** (bots or WRITE; `Idempotency-Key`; audited; `dry_run`): `{venue, price_usd: "1488", url, seen_at}` stores an `observed_public` record; a `provenance` key is 422 `VALIDATION_ERROR`; it never changes the listing, price, export, plan, `listing_history` or `listed_venues`.
- **`listed_venues`** in `GET /portfolio` (new field, array) and `GET /books.csv` counts only the latest `ours_confirmed` record per venue (not a removal). **New `observed_venues`**: `GET /portfolio` field and the **last** books.csv column (header now ends `...,listed_venues,observed_venues`).
- **Seed (migration, appended rows, no UPDATE):** Afternic $1,488 `ours_confirmed` for promptinjectionaudit.com, ukcbamcompliance.com, aievalsconsulting.com, roofingvoiceagent.com; mineunited.com Afternic `observed_public` (seen 2026-10-20); every earlier record reads `unknown` (the Sedo records of the two names included).
- **New route `POST /portfolio/{domain}/display-name`** (bots or WRITE; `Idempotency-Key`; audited): `{display_name}` must equal the domain apart from capitalisation, else 422 `DISPLAY_NAME_MISMATCH`; takes effect in the next export (a listed name is flagged `export_pending`).
- **Fix (docs and message):** a PUT without `Idempotency-Key` was already 400 `IDEMPOTENCY_KEY_REQUIRED`; the message now names the method ("every POST and PUT that changes data needs one (this request was a PUT)") and the README says so.

## 5.26.0 (2026-10-21): CR-072 ranked closeout and drop candidates
Release note: `docs/releases/v5.26.0.md`.
MINOR (additive; migration `1765800000000_v5-26-0.sql`).
- **New route `GET /candidates/closeouts?date=&source=dynadot|godaddy|all|drops&max_price=&limit=`** (READ or bots; read-only, no POST): the day's closeout rows (GoDaddy pool, sealed Dynadot upload) or the kept drop-list names, minus eight hard filters (`SPELL-1`, `BRAND-1`, `BIGCO-1`, `TM_KILL`, `FORBIDDEN_TERM`, `DIGITS_OR_HYPHEN`, `OWNED`, `SALES_GRADED`), ranked by the active scoring model. Rows `{domain, source, price_cents, price, ends_at, score, rank, filters_passed, words}`; summary `{pool_n, filtered_by, ranked_n, returned_n, snapshot_sha256}` with `pool_n - sum(filtered_by) = ranked_n`. `max_price` is integer cents (default and cap 4000), `limit` 1..200 (default 50; 500 is 400 `VALIDATION_ERROR`). A failed score is `score: null` with `score_reason` (`NO_ACTIVE_MODEL`, `SCORE_FAILED`, `NOT_SCORED_YET`), never 0.
- **New code `SNAPSHOT_MISSING` (409):** no sealed snapshot for the date and source (`source=dynadot` on a day without a sealed Dynadot closeouts upload). Not an empty list.
- **New `datasave` step `scorePool`** (after the Dynadot steps; `jobs.md`): filters and scores the pool and the sealed Dynadot closeouts rows **once, offline** (no registry ask or other outside call) and stores the result with the rows; the route only reads. New columns `filter_code`, `scored_at`, `model_version` on the pool, `score`, `score_reason`, `filter_code`, `scored_at`, `model_version` on the Dynadot rows, and the setting `closeouts_filter_digits_hyphen` (default on, migration only).
- **No change** to `POST /score`, `/buy`, the snapshots routes or any existing answer.

## 5.25.0 (2026-10-21): CR-070 ledger costs, forward-cost plans, books.csv
Release note: `docs/releases/v5.25.0.md`.
MINOR (additive; migration `1765700000000_v5-25-0.sql`).
- **New route `POST /ledger/costs`** (bots or WRITE; `Idempotency-Key`; audited): appends non-money cost rows `{rows: [{date, type: "tool"|"ai"|"adjustment", amount_usd: "-1.20", note, domain?}], dry_run?}` (1..500 rows). `dry_run: true` answers **200** with the counts and stores nothing; a real call answers **201**. Any other `type` (registration, renewal, sale, commission, refund, fee, payout_fee), a bad amount or date, an unknown field or an unknown `domain` is **422 `VALIDATION_ERROR`** with per-row `details.issues` and nothing stored. Corrections are reversing rows (the ledger stays append-only). `GET /ledger?type=` already filters by `tool`, `ai`, `adjustment`.
- **New route `PUT /portfolio/{domain}/forward-costs`** (bots or WRITE; idempotent; audited): body `{lines: [{month: "YYYY-MM", item, planned_usd, basis, cost_type}]}` replaces the planned lines of that name as a set; the old set stays as an earlier version (history). A derived field (`walkaway`, `floor`, `min_offer`, `bin`, `renewal_due`, `renewal_cost`, `forward_total`, `expiry_date`, `drop_date`, ... at the top level or in a line, also with a `_cents` or `_usd` suffix) is **422 `DERIVED_FIELD`**. Unknown domain: 404 `DOMAIN_NOT_FOUND`. New route `GET /portfolio/{domain}/forward-costs` (READ or bots): the current plan and every earlier version.
- **New route `GET /costs/forward?from=YYYY-MM&to=YYYY-MM`** (READ or bots; default: 12 months from the current month; at most 36): per month the planned lines (the current plan of every name) plus the committed renewals from `domains.renewal_price_cents` (the `/report` `spend.committed_forward` rule: renewal not yet used, not sold or dropped; a name that drops at its first expiry counts 0), with totals. A name whose renewal price is unknown has `renewal: null`, is never summed as 0, adds the warning `RENEWAL_PRICE_UNKNOWN` and makes the month and the totals `incomplete: true`.
- **New route `GET /books.csv`** (READ or bots; private, it carries the walk-away): one row per live name, values equal to `GET /portfolio`; columns in `formats.md` §Books CSV. Never part of `/export/*`.
- **Fix (`GET /market/matched`, CR-075):** an `asof` later than the newest sealed source day (complete `dynadot_aftermarket` / `dynadot_closed_auctions` snapshot; today UTC when none is sealed) is **409 `MATCHED_ASOF_FUTURE`** and stores nothing; a set with 0 positives is returned with `frozen: false` (and `frozen_at: null`) and is **not** stored, so a later call can freeze a real set. The migration removes the empty sets already stored. New codes `DERIVED_FIELD`, `MATCHED_ASOF_FUTURE`, `RENEWAL_PRICE_UNKNOWN` (warning).
- No change: the walk-away rule (48% of BIN to the nearest $5, never below $500; CR-070 R-4 declined) and `/export/*` (no walk-away).

## 5.24.0 (2026-10-21): CR-071 R-8b: coverage on Dynadot bot uploads
Release note: `docs/releases/v5.24.0.md`.
- **Added (MINOR):** optional `coverage` object on `POST /snapshots/dynadot` (CR-071 R-8b: partial seals with pull coverage), stored on the manifest, frozen at the seal and shown by `GET /snapshots` (`coverage`, null when not sent). An unknown key, a non-integer page or pages outside `pages_planned` is 422 `VALIDATION_ERROR`.

## 5.23.0 (2026-10-21): CR-075 market episodes, labels, matched sets, data-quality checks
Release note: `docs/releases/v5.23.0.md`.
MINOR (additive; migration `1765500000000_v5-23-0.sql`).
- **New route `POST /data/sales`** (WRITE, bots or data token; `Idempotency-Key`; audited with the row count only; `dry_run` supported; 1..5,000 rows, 4 MB): add-only sale reports `{name, venue, sale_price_cents, sale_date, source, source_url?, tier A..D, listing_type?}`. One bad row rejects the call with 422 `VALIDATION_ERROR` and per-row reasons: a `source` (or `source_url`) containing `namebio` is `SOURCE_NAMEBIO_FORBIDDEN`, a missing `tier` is `TIER_REQUIRED`. The same `(name, venue, sale_date, source)` sent again with a changed price is **409 `APPEND_ONLY`**, with the same price a counted duplicate. **`PUT`, `PATCH`, `DELETE` on `/data/sales` and `/data/sales/{id}` always answer 405 `APPEND_ONLY`.** New code `APPEND_ONLY`.
- **New routes (READ, bots too; a data token is 403):** `GET /market/episodes` (summary counts, then rows; filters `outcome`, `rule`, `band`, `from`, `to`, `venue`, `limit` up to 1,000), `GET /market/matched?asof=&ratio=4&seed=` (matched sold-vs-unsold set, frozen and sealed with a sha256 on the first call), `GET /market/dq` (latest data-quality checks), `GET /market/coverage` (rows per source per day, labels, bands, the 1,000 / 2,000 targets, `db_rows`).
- **`datasave` job:** two new steps last, `episodes` (merges the sealed Dynadot and GoDaddy snapshots and the sales into `market_names` episodes with the R-2 labels `SOLD_REPORTED`, `SOLD_BIDS`, `UNSOLD_60D`, `UNSOLD_30D`, `SEEN_ONCE`, `DISAPPEARED`, `TOO_SHORT`; idempotent) and `dqMarket` (duplicates, survivorship, leakage, price sanity, coverage, tier). The step list of `GET /jobs/runs?job=datasave` now has seven steps.
- **`GET /health`** adds `dq_market`: `ok | alert | unknown` (does not change `status`). **`/report`** adds the warning `DQ_MARKET_FAIL` (`reports.md`).
- Storage rule (CR-075 Q1): only episodes that can be a positive or a matched negative are stored, nothing under $500 (reported sales, Dynadot $500+ listings, closed auctions and GoDaddy endings of $500 or more). The closeout pool is not in `market_names`.

## 5.22.0 (2026-10-21): CR-071 R-8..R-10: Dynadot bot uploads, GoDaddy auction endings
Release note: `docs/releases/v5.22.0.md`.
MINOR (additive; migration `1765400000000_v5-22-0.sql`).
- **New route `POST /snapshots/dynadot`** (bots or WRITE; `Idempotency-Key`; audited, the audit row keeps only the row count; `dry_run` supported; body limit 8 MB): the bots upload the Dynadot rows they pulled (`kind` `aftermarket`, `closed_auctions` or `closeouts`, `data_date`, `rows`, optional `final`). The part with `final: true` seals the (kind, day) with a sha256; a later upload for it is **409 `SNAPSHOT_SEALED`** (the first HTTP use of that code). Aftermarket rows under $500 are dropped and counted. Integer cents only (422 `VALIDATION_ERROR` otherwise).
- `GET /snapshots` accepts `source` `dynadot_closed_auctions` and `godaddy_auction_end`, shows `origin` (`fetch` or `bot_upload`) per manifest, and with `rows=<n>` returns stored Dynadot rows; with `source=godaddy_auction_end` it returns `auctions` (the final states of GoDaddy auctions that left the files on that data date).
- `datasave` job: `godaddyInventory` also parses the four auction files into the GoDaddy auctions table (only `.com` names that reached $500 are followed; ended auctions keep their last bid count and price, 120 days); summary adds `auctions_seen_n`, `tracked_n`, `ended_today_n`. The four auction files now report `rows` (a number) instead of `null`; a parse failure makes that file `partial`. `dynadotCloseouts` / `dynadotAftermarket` stay `not_configured` and add `bot_upload` (is today's upload sealed).
- `/health.datasave` and `DATASAVE_MISSED`: once a Dynadot kind has had an upload, a missing sealed upload for the due day (after 16:00 UTC) makes the state `partial` and adds `dynadot_missing` and the source to the warning. Quiet before the first upload.
- New settings columns `datasave.dynadot_keep_days` and `datasave.auction_keep_days` (120 each; migration only).

## 5.21.0 (2026-10-20): CR-071 daily data save job (GoDaddy inventory), snapshots, datasave health
Release note: `docs/releases/v5.21.0.md`.
MINOR (additive; migration `1765300000000_v5-21-0.sql`).
- **New job `datasave`** (`POST /jobs/run {"job":"datasave"}`, also `GET /jobs/runs?job=datasave`): the daily data save at 15:00 UTC (GitHub Actions schedule). Steps `godaddyInventory`, `dynadotCloseouts`, `dynadotAftermarket`, `buildPanel`, `snapshotRetention` (`jobs.md`). The five official GoDaddy inventory files (setting `datasave.godaddy_files`: `closeout_listings`, `all_expiring_auctions`, `all_biddable_auctions`, `all_listings_ending_today`, `auctions_ending_today`) are fetched, hashed (sha256, size, Last-Modified) and kept raw for 7 days; only the closeouts are parsed (`.com`, up to $40, not adult, price in cents, kept 3 days). Files are keyed by the source's data date, never the run date.
- **Sealed manifests:** a complete file is write-once; a second save of a sealed day changes nothing and the step reports the code `SNAPSHOT_SEALED` per file (a step result code, no HTTP 409: no route writes snapshots). A failed fetch is `status: "error"` with `http_status` and `rows: null`, never zero rows. One retry 60 minutes after a failed `godaddyInventory` step. `RAW_EXPIRED` (410) is reserved, not emitted.
- **Dynadot:** `dynadotCloseouts` and `dynadotAftermarket` report `status: "not_configured"` (no Dynadot key exists); they never fail the run or `/health`.
- **New routes (READ, bots too):** `GET /snapshots?date=&source=` (manifests, row counts, `raw_available`; never raw contents) and `GET /snapshots/missing?from=&to=`.
- **`GET /health`** adds `datasave`: `ok | overdue | partial | error` (does not change `status`). **`/report`** adds the warning `DATASAVE_MISSED` (`reports.md`).
- `POST /jobs/run` accepts `datasave` (WRITE tokens too); `GET /jobs/runs?job=` accepts `datasave`. New optional server env `SNAPSHOT_DIR`.

## 5.20.1 (2026-10-20): BUG-047 mineunited.com BIN $1,488 (Dvir's approval); CR-069 old per-bot tokens retired
Release note: `docs/releases/v5.20.1.md`.
PATCH (data only; no route, field or code changes). Migration `1765200000000_v5-20-1.sql`: `mineunited.com` plan BIN $3,488 -> $1,488 (BUG-047, Dvir's approval 2026-10-20 17:24 IDT; floor $967, walk-away $715 private, min offer $100, final push BIN $1,088); the six old per-bot tokens (`data-engineer`, `scoring-scientist`, `shomer`, `buyer`, `dom-architect` READ; `data-engineer-upload` data) are revoked (CR-069 item 5).

## 5.20.0 (2026-10-20): CR-069 shared bots token; BUG-047 tick health + renewal price record; BUG-046 test hits dropped
Release note: `docs/releases/v5.20.0.md`.
MINOR (additive).
- **CR-069:** new token scope `bots`, the shared non-money key for all bots (every GET, data and visits routes, and every non-money mutating route; a money route only with `dry_run: true`, else 403 `SCOPE_FORBIDDEN`). New route `POST /tokens/bots/rotate` (WRITE or bots; returns the new value once; the old one works 10 more minutes). Optional `X-Bot-Name` header, shown as `bot_name` in `GET /audit` rows. The old tokens are retired later.
- **BUG-047:** `GET /health` `jobs` is also `overdue` when no `tick` run was created in 26 h, and a new field `jobs_last: {daily, tick}`. New route `POST /portfolio/{domain}/renewal-price` (WRITE or bots, not a money action); `GET /portfolio/{domain}` shows `renewal_price_source` and `renewal_price_as_of`.
- **BUG-046:** the test hits of the UTC day 2026-10-19 are removed from the visitor counter (data only).

## 5.19.1 (2026-10-20): BUG-046 visitor hits counted by active forward
Release note: `docs/releases/v5.19.1.md`.
PATCH (a fix back to the contract: hits for the forwarded names were refused).
- **BUG-046:** `POST /visits/hit` counts a hit for a `listed` name with an active forward (`POST /visits/forward`, not reverted). The stored `lander_ns` is no longer used here: it was stale and still said Afternic for the three Porkbun names, so every hit was 422 `DOMAIN_NOT_LISTED`. A refused hit is now logged on the host with its code and domain only.

## 5.19.0 (2026-10-20): visitor counter on without approval lines; BUG-045 live NS check
Release note: `docs/releases/v5.19.0.md`.
MINOR (two request fields become optional; one rule fixed). Dvir, 19 Oct 2026: an approved CR needs no further lines from him.
- `POST /visits/settings` and `POST /visits/forward/{domain}`: `approval_ref` is optional and ignored (was required, naming "visits"). The settings answer no longer carries `approved_at`.
- Migration `1765000000000_v5-19-0.sql`: `visits.enabled` is on (default true), and the visit-counter token is requested, so the Mac host hands it to the api-proxy Worker on its next deploy tick.
- **BUG-045:** "on Afternic nameservers" is decided by the live nameservers (also on `dry_run`), with the stored `lander_ns` as fallback. `lander: "afternic"` alone (the listing venue) no longer blocks `/visits/forward` or marks a name `afternic_ns` in `/visits/weekly`.

## 5.18.0 (2026-10-19): CR-068 visitor counter (proxy /r/ redirect, Porkbun forwards, visits scope)
Release note: `docs/releases/v5.18.0.md`.
MINOR (new routes, a new token scope, new error codes; nothing existing changes).
- **New token scope `visits`:** may call only `POST /visits/hit`, and only this scope may call it. Created with `npm run admin -- token create --scope visits --name visit-counter` or, without anyone seeing it, by the host hand-off below.
- **New routes:** `POST /visits/hit` (visits token; counts one visit; 202 `{counted, capped}`; not audited per hit), `POST /visits/import` (WRITE or data; Afternic 30-day Views/Leads), `POST /visits/settings` (WRITE; `enabled` and/or `token: "request"`; `approval_ref` must name "visits", and "visits token" for the request), `POST /visits/forward/{domain}` (WRITE; `approval_ref` names the domain and "visits"; `revert`, `dry_run`), `GET /visits` (READ, daily rows, up to 400 days), `GET /visits/weekly` (READ, `week_ending` a Saturday; `rows` and `not_countable` with reasons `afternic_ns` and `not_forwarded`).
- **New codes:** 409 `VISITS_DISABLED`, 422 `DOMAIN_NOT_LISTED`, 422 `FORWARD_NOT_ALLOWED` (`details.reason`), 422 `PUBLIC_BASE_URL_UNSET`.
- **Counting redirect (api-proxy Worker, not an API route of the service):** `GET|HEAD /r/{domain}` on the public base URL answers 302 to `https://www.afternic.com/domain/{domain}` and then sends the count.
- **Privacy:** counts only (human, bot, capped, referrer hosts); no IP, cookie, path, query or user agent is sent or stored. Rows kept 400 days. 1,000 counted hits per name per UTC day, then `capped`.
- **Off by default:** `visits.enabled` is false until `POST /visits/settings {enabled: true}`.
- Database: tables `visit_daily`, `visit_forwards`; `settings.visits_enabled`, `visits_token_request` (migration `1764900000000_v5-18-0.sql`).

## 5.17.0 (2026-10-19): GET /health db_size (Gavriel, loop 2026-10-18)
Release note: `docs/releases/v5.17.0.md`.
MINOR (one field added). Gavriel's first improvement-loop pain point.
- `GET /health`: new `db_size` `{bytes, limit_bytes, percent, warn_percent}` = the database size against Neon's free 1 GB, readable with a READ token (before, only the `/data/*` and upload answers carried `db_bytes_*`, which needed a write). `null` when the size can't be read and in the 503 answer. Nothing else in the answer changes.

## 5.16.0 (2026-10-18): ledger CSV formula guard, test clock guard (loop 2026-10-18)
Release note: `docs/releases/v5.16.0.md`.
MINOR (the ledger CSV text cells change; no route, field or error code added or changed). Improvement loop 2026-10-18.
- `GET /ledger?format=csv`: a text cell (`type`, `domain`, `deal_id`, `counterparty`, `receipt_ref`, `note`) that starts with `=`, `+`, `-`, `@`, a tab or a CR now gets a leading apostrophe, so a spreadsheet shows it as text instead of running it as a formula. `amount_usd` is never changed (a negative amount stays `-11.08`). The header, column order, row order and the JSON form of `/ledger` are unchanged. The Afternic and Sedo exports are unchanged.

## 5.15.0 (2026-10-17): the Internet Archive reader and unused NameBio calls are removed; the data tables are their own module
Release note: `docs/releases/v5.15.0.md`.
MINOR (two visible settings changes, one narrowed outbound allow-list, no route, field or error code added or changed). Tech-debt pass R4 (structure and dead features).
- **Removed (history check, S1):** the automated Internet Archive path (CDX index, capture fetches, classifier, `history.*` actions, the `ARCHIVE_UNAVAILABLE` family of reasons) is deleted. Dvir disabled it for good on 6 Oct 2026 and again on 14 Oct 2026. The `history` check still answers MANUAL_REQUIRED `MANUAL_SOURCE`, or uses a fresh domain record, exactly as before; manual HIST-2 records are unchanged. A manual record is now never ranked below an automated row (there is no automated history row any more).
- **Changed (settings):** `sources.wayback` accepts only `false` (a draft that sets it `true` is 422 `SETTINGS_INVALID`; stored versions with `false` parse as before). The unused `namebio.spot_max_per_min` key is no longer in `GET /selection/settings` (a stored version that still carries it is read without it; a draft that sets it is accepted and the key is dropped). The `history.*` keys stay in the document, unused.
- **Changed (NameBio, S2):** only POST `api.namebio.com/retailstats` and GET `/retailstats-download` can be called (TLDStats, the Verisign drop order and their file URLs were never read by any check or route). The table `namebio_tld_stats` is dropped; env `NAMEBIO_TLDSTATS_CSV_URL` and `NAMEBIO_DROP_ORDER_URL` are ignored. The nightly RetailStats CSV is read up to 100 MB (a longer file is refused whole, `errors[]` of the `referenceRefresh` NameBio summary) and only keywords of intake names, owned domains and names screened in the last 90 days are stored; `GET /selection/namebio` for any other keyword answers null until the name enters the pool.
- **Unchanged answers, new structure (S3, S4, S5):** `POST /buy`, `POST /list` and `import-domain` store a plan through one function (`applyPlan`); `buy.ts` is split into types, reservation, dry run, money phase and post-buy files; the five `/data/*` tables are the new `data` module on the shared bulk-upload helper (`/engine/sales`, `/engine/unsold` use the same one); job audit rows come from one writer; the admin and job commands share their start-up. Routes, codes and bodies are byte-identical.
- **Internal (S6):** unused barrel exports and about 380 exports nothing imported were un-exported; unused imports and constants removed.
- **Fixed (tests):** the flaky "manual history with a LOWER id" recompute test (the worker kicked by the manual POST raced with the test's sequence bump) and NB-12 (`pg_database_size` is not monotonic).
- **Migration:** `1764800000000_v5-15-0.sql` (drops `namebio_tld_stats`).

## 5.14.0 (2026-10-17): audit log keeps a count and hash for long lists; more data pruned; `/report` and other reads faster
Release note: `docs/releases/v5.14.0.md`.
MINOR (one stored-value change, retention scope, no route or field changed). Tech-debt pass R3 (database efficiency and growth).
- **Changed (audit, D2):** in `GET /audit` `request`, any array of more than 50 items, at any depth (drop-list rows, test-set or labelled names, intake lists, document sections), is now stored as the string `"[N items, sha256:<hex>]"` (N = the count, the hash is taken over the array's JSON). Before, only `/engine/*` and `/data/*` uploads were shortened (that `"[N rows]"` form is unchanged). Approval text and time are never shortened.
- **Changed (retention, D3):** the daily `retention` step also deletes drop-list checks, rows and lists once the list is more than 90 days past its `list_date` (60 days in tight mode; reads already ignored a list after 60 days), daily candidate lists older than 90 days (45 tight; never the newest), NameBio call counters older than 30 days, and `listing_sync_log` rows older than 180 days (90 tight) except the newest per name, venue and action. The `tables` object of the step summary has six more keys (`drop_list_checks`, `drop_list_rows`, `drop_lists`, `daily_candidate_lists`, `namebio_calls`, `listing_sync_log`). `audit_log`, `ledger_entries` and `listing_history` are still never pruned.
- **Changed (engine endings, D4):** an ending asked again that comes back with the same answer (same registered state, same registry creation date) updates its row in place instead of appending one. `engineEndings` summary: such a pair counts in `updated`, not `inserted`. A one-off migration deleted older rows of consecutive identical answers.
- **Changed (size guard, D9):** `details.payload_bytes` of the 409 `DB_SIZE_HIGH` on `/engine/*` and `/data/*` is the request body size from `Content-Length` when the client sent one (else the rows as JSON, as before).
- **Unchanged answers, faster:** `GET /report` (domains, offers and the Afternic pending set read once, the parts run together, applied events in two statements), `GET /portfolio/{domain}` (one name, not the portfolio), `POST /buy` and its dry run (the latest screening run read once), the buy-hold lookup (indexed), `GET /screening/runs/{id}/report.csv`, `GET /selection/buy-hold`, `GET /health`, the daily candidate list build, run checks (cache rows and registry answers read in bulk), engine training and the drift report (feature cache, event-loop turns), `/score` (cheaper cache key), `POST /export/{venue}/uploaded` (one statement under every name's lock).
- **Internal:** db pool max 10 to 20 (one `/report` now uses up to 8 connections at once).
- **Migration:** `1764700000000_v5-14-0.sql` (indexes on `screening_results`, `screening_packs`, `domain_records`, `drop_list_rows`, `audit_log` and a GIN index on `screening_runs.input`; the retention delete carve-out on five more append-only tables; the `engine_endings` cleanup).
- **Docs (from the R4a cleanup):** `endpoints.md` gains a "Start here" table of the main routes by task and scope; the contract README Base URL describes the Mac host behind the Cloudflare proxy until Render resumes. Runtime moves to Node 26; `npm run admin` / `npm run job` run the compiled `dist/`.

## 5.13.0 (2026-10-17): idempotency keys bound to their token; cancel `reason` stored; DB_SIZE_HIGH threshold 1 GB; money-path fixes
Release note: `docs/releases/v5.13.0.md`.
MINOR (additive field, one stricter rule, one threshold). Tech-debt pass R2.
- **Changed (idempotency, M3):** an `Idempotency-Key` belongs to the token that first used it. The same key from a different token is **409 `IDEMPOTENCY_KEY_MISMATCH`** (before: it replayed the first token's stored answer when the body matched, or mismatched on a different body). The owning token replays as before. No new code. Use a fresh key per token.
- **Changed (cancel, M15):** `POST /screening/runs/{id}/cancel` and `POST /selection/test-sets/{name}/cancel` now **store** `reason` (at most 200 characters; it was accepted and dropped). Both 200 answers gain `cancel_reason` (the reason, else null); `GET /screening/runs/{id}` shows `cancel_reason` next to `cancelled_at` / `cancelled_by` on a cancelled run.
- **Changed (size threshold, M7):** Neon's free plan is 1 GB per project, so `NEON_FREE_STORAGE_BYTES` is 1 GB (was 0.5 GB). `/report` `DB_SIZE_HIGH`, the 409 `DB_SIZE_HIGH` guard on `/engine/sales`, `/engine/unsold` and `/data/*` (70% of the limit: now 717 MB, was 358 MB) and the retention step's tight-age switch all move with it. `details.limit_bytes` on the 409 and `limit_bytes` on the warning read 1,073,741,824.
- **Fixed (no contract change):** `POST /portfolio/import` (S8) and the admin `import-domain` refuse any registrar that contains "cloudflare" after dropping punctuation (M1); a name bought through the reconciler gets `sell_or_drop_by` like a `/buy` completion (M2); the engine holdout date is read inside the upload lock and `POST /engine/holdout-date` takes the same lock (M4); `GET /data/tm-kills` and `/data/bigco-names` filter `host` case-insensitively (M6); the job queue's keep-alive ping runs only on Render (M8); `api_tokens.last_used_at` is written at most once a minute per token (M9).
- **Migration:** `1764600000000_v5-13-0.sql` (`screening_runs.cancel_reason`).

## 5.12.0 (2026-10-17): CR-063 data tables: domain_rdap (pool only), live_checks, tm_kills, bigco_names, sales_comps
Release note: `docs/releases/v5.12.0.md`.
MINOR (additive routes and tables). Gavriel / Dvir's bots, CR-063 (approved by Dvir 2026-10-17 03:07 and 03:18 IDT).
- **New routes:** `POST /data/rdap`, `/data/live-checks`, `/data/tm-kills`, `/data/bigco-names`, `/data/sales-comps` (WRITE or `data` scope, `Idempotency-Key`, `{rows, dry_run?}`, 20,000 rows, 8 MB; per-row reject reasons; answer `accepted_n`, `duplicate_n`, `rejected_n`, `rejects`, `skipped_not_in_pool_n` (rdap), `db_bytes_before`, `db_bytes_after`, `rows` per table); `GET /data/<same>` (READ; filters `host` (`domain` for sales comps), `since`, `limit`; a `data` token gets 403).
- **Pool rule:** `domain_rdap` stores only names in the candidate pool (a non-removed intake name or a kept drop-list row); others are counted in `skipped_not_in_pool_n`. `GET /data/rdap` marks a row older than 24 h `stale: true`. `/check` and `/buy` never read `domain_rdap`.
- **Append-only:** `tm_kills` and `bigco_names` reject UPDATE, DELETE and TRUNCATE in the database; a correction is a new row with `supersedes`.
- **Holdout and size guards:** `sales_comps` rows dated after `GET /engine/holdout-date` are `HOLDOUT_SEALED`; `engine_sale_id` links the matching `engine_sales` row. A load that would pass 70% of 0.5 GB is refused with 409 `DB_SIZE_HIGH`.
- **Retention (daily step):** deletes `live`/`livefail` rows over 3 days, `cc` rows over 14 days and `domain_rdap` rows of names that left the pool; summary adds `tables.live_checks` and `tables.domain_rdap`. The three other tables are never pruned.
- **Not in this release:** DB bytes are in each load answer and its audit summary, not in `GET /jobs/runs`; `tm_kills` / `bigco_names` do not feed the screening checks or `/company/forbidden-terms` (separate CR).
- **Migration:** `1764500000000_v5-12-0.sql` (five tables).

## 5.11.0 (2026-10-17): CR-062 NameBio free endpoints only, with attribution; GET /selection/namebio serves RetailStats placement stats
Release note: `docs/releases/v5.11.0.md`.
MINOR (additive fields; `source` value changes). Gavriel, CR-062 (approved by Dvir 2026-10-17 03:07 and 03:18 IDT).
- **Changed (`GET /selection/namebio`):** the numbers are NameBio's free RetailStats: per keyword `start_count`, `end_count`, `exact_count` (kept), plus `middle_count`, `fetched_at` and `placements {exact|start|end|middle: {sale_count, price_sum, price_avg, price_max, price_stddev}}`. `source` is now `"namebio_free"` (was `"nightly_csv"`). New field `attribution_url: "https://namebio.com"` next to `attribution: "Data from NameBio"` on every response, also `SOURCE_DISABLED`. `data_as_of` is the fetch date of the oldest requested keyword that is stored. `stale` follows `namebio.max_cache_age_hours` as before. The same `attribution_url`, `middle_count`, `placements`, `fetched_at` appear in the `namebio` check's `fields`.
- **Changed (daily `referenceRefresh` step):** while `sources.namebio` is on it fetches NameBio data (off by default, so nothing changes until Dvir turns it on): the free files `api.namebio.com/retailstats-download` and `/tldstats-download` (env `NAMEBIO_RETAILSTATS_CSV_URL`, `NAMEBIO_TLDSTATS_CSV_URL`, each at most once a day), else per-keyword `POST /retailstats` for candidate-pool keywords not cached within 24 h (at most 20 a night, 4 a minute). The `namebio` summary is `{mode, rows_written, file_bytes, requests, keywords_pending, errors[], db_bytes_before, db_bytes_after}`.
- **Allow-list (R-1, R-2):** only POST `api.namebio.com` `/retailstats`, `/tldstats`, `/verisign` and GET `/retailstats-download`, `/tldstats-download`, `/verisign-download` are ever called; any other host or path is refused before a request is sent. Rate limits in code and persisted: retailstats and tldstats 4 a minute, verisign 5 per 24 h and 100 domains a call; HTTP 429 waits 60 s and retries once. `NAMEBIO_DROP_ORDER_URL` (the drop-order file, at most once a day) is parsed but no daily step uses it yet.
- **Stored (R-4, R-5):** tables `namebio_keyword_stats` (`source = namebio_free`, `source_url`, `fetched_at`), `namebio_tld_stats`, `namebio_calls`. Nothing goes into `engine_sales`.
- **Unchanged:** `sources.namebio` stays false (R-6). No settings change, no new `pricing_settings` or selection settings version.
- **Migration:** `1764400000000_v5-11-0.sql`. New optional env: `NAMEBIO_RETAILSTATS_CSV_URL`, `NAMEBIO_TLDSTATS_CSV_URL`, `NAMEBIO_DROP_ORDER_URL`.

## 5.10.0 (2026-10-17): CR-061 `data` token scope, holdout guard on engine uploads, DB size in upload answers
Release note: `docs/releases/v5.10.0.md`.
MINOR (additive). Gavriel for Dvir, CR-061 (approved by Dvir 2026-10-17 03:07 and 03:18 IDT).
- **New token scope `data`** (admin: `token create --scope data`). A data token may call only `POST /candidates/intake`, `POST /engine/sales`, `POST /engine/unsold` and every `POST /data/*` route (CR-063). Everything else, GETs included, is 403 `SCOPE_FORBIDDEN`. Idempotency and audit are as for any write; `/audit` shows scope `data` and the token name. WRITE tokens can still call all of these. Named READ tokens need no code (`/audit` already carries `token_name`).
- **New routes:** `GET /engine/holdout-date` (READ) and `POST /engine/holdout-date` (WRITE only, `Idempotency-Key`, audited; body `{date, approval_ref}`; the approval text must name the date, at most 72 h old, not in the future; 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED`).
- **Holdout guard:** `POST /engine/sales` and `POST /engine/unsold` reject, per row, a `sale_date` / `observation_date` after the holdout date (default `2026-10-14`) with reason `HOLDOUT_SEALED`. Counts still add up (`accepted_n + duplicate_n + rejected_n = received_n`). A future date stays `DATE_IN_FUTURE`; a row with no valid date stays `DATE_INVALID`.
- **Changed (additive):** both upload answers gain `db_bytes_before` and `db_bytes_after` (`pg_database_size`). A load whose rows would take the database over 70% of 0.5 GB is refused before anything is written: 409 `DB_SIZE_HIGH` (`details.db_bytes_before`, `payload_bytes`, `limit_bytes`, `warn_percent`).
- **Migration:** `1764300000000_v5-10-0.sql` (`api_tokens` and `audit_log` scope checks allow `data`; `settings.engine_sales_max_date`, default 2026-10-14).

## 5.9.0 (2026-10-16): CR-060 S8 import accepts Dvir's approved Buy Now and floor; S8 ladder by name length; S8 expiry window; no M6/M18 drops for S8
Release note: `docs/releases/v5.9.0.md`.
MINOR (additive request fields; S8 pricing and schedule change, S8 only). Gavriel, CR-060 (approved by Dvir 2026-10-16 14:51 IDT).
- **New request fields** on `POST /portfolio/import` (`lane: "S8"`): `bin_override` and `floor_override` (integer cents). Each price must be named in `approval_ref.text` as a dollar amount (`$3,488`, `$3488`, `$3,488.00`, `$3488.00`; exact match), else 422 `APPROVAL_INVALID` (`details.override` names which). `floor_override` above the BIN is 422 `VALIDATION_ERROR`. Overrides on a geo name are refused (422).
- **Changed (S8 pricing):** without an override the BIN comes from the S8 ladder by name length (characters before `.com`): up to 8 **$4,888**, 9 to 12 **$3,488**, 13 or more **$2,488** (`settings.s8_bin_ladder`, migration only). This replaces the 5.8.0 price-list rung from `comps_value`; `comps_value` is now optional and stored as evidence only. Floor = 65% of the BIN to the whole dollar (or `floor_override`); walk-away max(48%, $500) never above the floor; minimum offer $100. S8 BINs are exempt from the Line 1 price list and the LANDER-1 check (also on `POST /list`, `replan` and the daily price job); Line 1 is unchanged.
- **Changed (S8 expiry):** `expiry_date` up to `buy_date` + 2 years + 30 days is accepted for S8; one day later is 422 `REGISTRATION_TERM_INVALID`. Line 1 and `/buy` are unchanged (one year + 7 days).
- **Changed (S8 schedule):** S8 names get no M6/M18 drops. The final push (`drop_date - 90`) and the delist (`drop_date - 7`) stay.
- **Changed (response):** `s8` gains `floor_cents`, `bin_source` (`override` | `ladder` | `grade_price`) and `floor_source` (`override` | `formula` | null).
- **Unchanged:** every CR-059 guard (approval, `S8_PRICE_CAP`, 10 slots, backorder refusal, sources). No new `pricing_settings` version, no settings activation; `/buy` unchanged.
- **Migration:** `1764200000000_v5-9-0.sql` (`settings.s8_bin_ladder`).

## 5.8.0 (2026-10-16): CR-059 S8 aftermarket import lane (Line 2): POST /portfolio/import, S8 slot reservation, /report lines
Release note: `docs/releases/v5.8.0.md`.
MINOR (additive; one behaviour tightening below). Gavriel, CR-059 (Dvir's decisions, 15 Oct 2026: "$50 limit only"; BIN rung from the price list).
- **New route:** `POST /portfolio/import` (WRITE, `Idempotency-Key`, audited, `dry_run`). Imports an existing .com that Dvir bought on a registrar website (`source`: `closeout`, `fixed` or `auction`; `registrar` e.g. `godaddy`, `dynadot`) as a Line 2 (S8) name. Needs Dvir's `approval_ref` (validated as at `/buy`). The BIN is the lowest price-list price at or above `comps_value` (founder rule 4 unchanged; no new `pricing_settings` version); floor, walk-away, minimum offer and the drop schedule are computed as for any non-geo hybrid name.
- **New codes:** `S8_SOURCE_INVALID` (400), `BACKORDER_SOURCE_REFUSED` (400; NameJet, SnapNames, DropCatch as source or registrar), `S8_PRICE_CAP` (400; over $50), `S8_SLOTS_FULL` (409).
- **Changed (additive):** `GET /report` gains `lines` (Line 1 and Line 2: names, spend, sales, P&L, committed renewals) and `per_domain[].line` / `lane`.
- **Changed (behaviour):** the 40-name cap now reserves 10 slots for S8: `POST /buy` is refused with 409 `DOMAIN_CAP_REACHED` once Line 1 (every name that is not S8) holds 30 names (a dry run reports `would_be_blocked: "DOMAIN_CAP_REACHED"`; `details` adds `line1_domains`, `line1_max`, `s8_reserved_slots`). Names held before this release are all Line 1.
- **Not built:** no money total for S8 (G-86: the budget stays with Gavriel). No API to change the caps.
- **Migration:** `1764100000000_v5-8-0.sql` (`domains.lane`, `settings.s8_max_price_cents` 5000, `settings.s8_reserved_slots` 10).

## 5.7.0 (2026-10-14): CR-058 owned-name endings watch (ENDING_REGISTERED, GET /owned/:domain/endings) and engine health hold-time slices
Release note: `docs/releases/v5.7.0.md`.
MINOR (additive). Gavriel, CR-058 (accepted with two changes, see the CR file).
- **New route:** `GET /owned/{domain}/endings` (READ): the current state of the .net, .co, .org, .io and .ai endings of an owned name plus its event history; 404 `DOMAIN_NOT_FOUND` for a name we do not own.
- **New warning:** `ENDING_REGISTERED` in `/report` (warn): one per `newly_registered` / `re_registered` event in the last 30 days; `details {owned_domain, host, created, registrar, kind, detected_at}`. This warning and the route are the lead list (no separate list is written; nothing is sent).
- **Job:** `engineEndings` also watches the owned names: their five endings are due weekly and are asked before the bulk names; each answer writes a `baseline`, `newly_registered` or `re_registered` event when the state changed (no event for an unanswered ask, never a duplicate).
- **Changed (additive):** `GET /engine/health` and `GET /engine/train/{id}` gain `slices {threshold, quick, held, unknown_n}` (hold-time split of the newest model's test rows: `n`, `recall`, `net_pit_share`, `auc` each); null for a model trained before 5.7.0 until the next training.
- **Migration:** `1764000000000_v5-7-0.sql` (table `owned_ending_events`, append-only; column `engine_endings.registrar`).
- **Not built:** no hyphen `.com` (the sibling scan covers it), no per-name leads list.

## 5.6.0 (2026-10-14): CR-056 part 3: engine health (drift per year and quarter, ablation without endings, bars report)
Release note: `docs/releases/v5.6.0.md`.
MINOR (additive). Gavriel, CR-056: the health side of the engine. `GET /engine/health` gains `drift` (per year of the sold data and `last_quarter`), `ablation`, `bar4_pass`, `bars` (six bars with status `pass`, `fail` or `not_measured`) and `bars_passed`. No new route, no migration. Contract: `endpoints.md` §GET /engine/health.

## 5.5.0 (2026-10-14): CR-056 part 2: engine model (features, GBM + logistic + price tier, POST /engine/train, weekly retrain, POST /score)
Release note: `docs/releases/v5.5.0.md`.
MINOR (additive). Gavriel, CR-056: the model side of the name-scoring engine. Contract: `endpoints.md` §Scoring engine, `jobs.md`, README §Idempotency.
- **New:** `POST /engine/train` (WRITE, `Idempotency-Key`, 202; at most one per 24 hours, else 409 `TRAIN_TOO_SOON` with `details.next_allowed_at`), `GET /engine/train/{id}` (READ), `POST /score` (READ token; **the one read-only POST**: no `Idempotency-Key`, no audit row; 409 `MODEL_NOT_READY` before the first training).
- **New codes:** `TRAIN_TOO_SOON`, `MODEL_NOT_READY`; in a failed run's `error` text `NOT_ENOUGH_DATA`, `TRAIN_TIME_BUDGET`.
- **Changed (additive):** `GET /engine/health` now fills `model_version` and adds `trained_at`, `train_rows`, `test`, `chosen_weighting`, `last_training` (null before the first model). The endings fill also asks the name's own `.com`, so `engine_endings` has a `com` row per name, `endings.pairs_n` is `names_n` x 6, `by_tld` gains `com`, and the first full fill takes longer: .com shares Verisign's request pacing with .net, so the Verisign asks double (about 13 nights for 32,000 names instead of about 7).
- **Jobs:** new last daily step `engineTrain` (the weekly retrain decision) and a new queue job kind `train` (step `trainModel`); neither is accepted by `POST /jobs/run`. `GET /jobs/runs?job=train` lists the trainings.
- **Model:** TypeScript only, no new dependency and no LLM call: histogram gradient boosting (the score), logistic regression (the reasons), 4-class boosting (price tier); time split on the newest full calendar quarter, test file hashed before training; word frequency is a SCOWL-level proxy (the split table's piece costs on a 0 to 8 scale), `wordfreq` is not used.
- **Migration:** `1763900000000_v5-5-0.sql` (table `engine_models`; `engine_endings.tld` accepts `com`; job kind `train`).

## 5.4.0 (2026-10-14): CR-056 part 1: engine data (POST /engine/sales, /engine/unsold, GET /engine/health, daily engineEndings RDAP fill)
Release note: `docs/releases/v5.4.0.md`.
MINOR (additive). Gavriel, CR-056 (Dvir approved the build on 14 Oct 2026): the data side of the name-scoring engine.
- `POST /engine/sales` and `POST /engine/unsold` (WRITE): up to 20,000 rows a call; counts of accepted, duplicate and rejected rows with reasons; sales within 20 days of a stored sale of the same name are duplicates; an unsold name is a duplicate by name and observation date.
- `GET /engine/health` (READ): data counts, newest dates, data age, last uploads and the progress of the endings fill; `model_version` is null until the model release.
- Daily job: new last step `engineEndings` (RDAP only): the same name's registration and creation date on .net, .co, .org, .io, .ai, filled in chunks across nights and kept permanently.
- New tables `engine_uploads`, `engine_sales`, `engine_unsold` (append-only), `engine_endings` (migration `1763800000000_v5-4-0.sql`); not in the backup export, not touched by retention.
- Release numbers: CR-056's model is now 5.5.0 and its health/drift release 5.6.0 (CR-057 took 5.2.0).

## 5.3.0 (2026-10-14): CR-053: scout lessons store (POST/GET/PATCH /lessons, /lessons/check, /lessons/report)
Release note: `docs/releases/v5.3.0.md`.
MINOR (additive). Gavriel, CR-053 (asked by Dvir): the scouts' lessons live in DOM, so a dead end is not rediscovered.
- **New routes:** `POST /lessons` (one or up to 200; merges a lesson on the same sector, rule and overlapping name into the stored one with `merged: true`), `GET /lessons` (`sector`, `since`, `rule`, `q`, `limit`), `GET /lessons/check?domain=`, `PATCH /lessons/{id}` (only `recheck_if`, `superseded_by`, `lesson`), `GET /lessons/report?month=YYYY-MM[&format=md]` (top 5 rules per sector, two examples each, rules with 3 or more lessons flagged recurring). See `endpoints.md` Scout lessons.
- **New code:** `LESSON_NOT_FOUND` (404). Body errors are 422 `VALIDATION_ERROR`, query errors 400, like the other routes.
- **Differences from the request:** the service does not write the monthly file into the repository (founder rule 11); Gavriel commits what the report returns. A lesson stores its names as a `domains` array and keeps dated `notes` when a merge brings different text. The table is not in the backup export.
- **Migration `1763700000000_v5-3-0.sql`:** the table `scout_lessons` (GIN index on `domains`, index on sector, rule and date). No existing route, field or job changed.

## 5.2.0 (2026-10-14): CR-057: X posting removed (post routes, jobs, Buffer client, image rendering and post tables)
Release note: `docs/releases/v5.2.0.md`.
MAJOR (removed routes, codes and fields). Dvir, 14 Oct 2026 (CR-057): "Pause Mesaper even delete it and all things related to posting and managing an account in X, we don't need it ... Remove it at all from dom and grok bot!" Founder rule 10 now reads: the service never sends email or chat, never contacts buyers, and publishes nothing.
- **Removed routes (now 404 `NOT_FOUND`):** `POST /posts`, `POST /posts/schema-check`, `GET /posts`, `GET /posts/{id}/images/{part}/{position}`, `POST /posts/{id}/remove`, `POST /posts/pause`, `POST /posts/burst`, `GET /media/{token}`. `GET /health/ping` is again the only public route.
- **Removed codes:** `POST_INVALID`, `POST_TOO_LONG`, `POSTING_PAUSED`, `POSTING_NOT_CONFIGURED`, `POST_DAILY_CAP`, `POST_FAILED`, `POST_NOT_REMOVABLE`, `POST_DELETE_UNSUPPORTED`.
- **Removed fields:** `GET /health` no longer has `posting` and `posting_reason`.
- **Removed daily step:** `postsRefresh` (it filled X links from Buffer). The daily order is otherwise unchanged (`outsideReview`, `retention`, `backupExport`).
- **Removed server settings:** the env vars `BUFFER_API_KEY` and `BUFFER_CHANNEL_ID`. `PUBLIC_BASE_URL` stays (the job queue's keep-alive ping).
- **Migration `1763600000000_v5-2-0.sql`:** drops the tables `posts`, `post_images`, `post_allowance_exclusions`, `posting_switches`, `posting_bursts` and the function `posts_guard()`. `audit_log` is untouched, so every post's creation and changes stay there. The nightly export no longer lists those tables.
- **Unchanged:** listings, buys, outreach emails (`/outreach/emails`), the outside review (Gemini), the company document and forbidden terms (still used by the review), the engine, retention.

## 5.1.0 (2026-10-14): G-95: daily data retention (old unbought screening data, old job logs and checks; tighter when the database nears the free-plan limit)
Release note: `docs/releases/v5.1.0.md`.
MINOR (additive). Dvir, 14 Oct 2026: "G-95: Yes, setup a smart retention ability (cron job deletes big old data)."
- **New daily step `retention`** (after `postsRefresh`, before `backupExport`; `jobs.md`): deletes old data of names never bought and never packed, and old job logs, in batches. Ages are normal / tight (halved when the database is at or over 70% of the 0.5 GB free-plan limit): screening results 180 / 90 days, screening evidence nothing points to 180 / 90, empty finished screening runs 180 / 90, sibling scans and registrar-state checks (not the newest per name) 90 / 45, quotes (not those a purchase names, not the newest check per name) 180 / 90, job steps and `job_runs` 60 / 30. Step summary: `{mode, dry_run, db_bytes_before, db_bytes_after, partial, tables}`.
- **Never pruned:** `audit_log`, `ledger_entries`, `sales`, `offers`, `listing_history`, pricing data, `manual_quotes`, verdicts, screening packs, `domains`, `purchases`, test sets, cohorts, labelled names, holdout suites, replay runs. Guarantee 6 now says the other append-only tables are deleted only by this step.
- **New `/report` warning `DAILY_JOB_MISSED`** (warn): no scheduled `daily` run (`job_runs.trigger = scheduled`) started in the last 26 hours; details `{last_scheduled_at, hours_since}`; silent on a database with no job run at all. `reports.md`.
- **No route or field changed.** Migration `1763500000000_v5-1-0.sql`: a delete trigger function that allows a DELETE only inside a transaction that set `app.retention = on` (used by the retention step only) on `screening_results`, `screening_evidence`, `candidate_screenings`, `sibling_scans`, `job_runs`, `registrar_state_checks`; UPDATE and TRUNCATE stay forbidden.

## 5.0.0 (2026-10-14): G-86: the service no longer tracks a money budget (POC cap, tranche spend cap, small-buy weekly cap and the /report budget block removed); Gavriel owns the budget
Release note: `docs/releases/v5.0.0.md`.
MAJOR (removed codes and fields). Dvir, 14 Oct 2026: "You shouldn't be aware of budget at all. That topic should be managed by grok bot." The service no longer knows a money budget. Gavriel owns it.
- **Removed codes:** `POC_CAP_EXCEEDED` (409, `/buy` and the admin `record-renewal`), `TRANCHE_SPEND_CAP` (409, `/buy` and `POST /tranches/{id}/members`), `SMALL_BUY_WEEKLY_CAP` (409, `/buy`). Warning `POC_CAP_EXCEEDED_BY_IMPORT` (admin `import-domain`) is removed too; `DOMAIN_CAP_EXCEEDED_BY_IMPORT` stays.
- **`POST /buy` (dry run and 201):** `poc_spent`, `poc_spent_cents`, `poc_remaining_after`, `poc_remaining_after_cents` (dry run) and `poc_spent_after`, `poc_spent_after_cents`, `poc_remaining`, `poc_remaining_cents` (201) are gone; so is the dry-run `small_buy` block. `would_be_blocked` loses `TRANCHE_SPEND_CAP` and `SMALL_BUY_WEEKLY_CAP`. `dry_run: "strict"` no longer returns `TRANCHE_SPEND_CAP`. The 201 `TOTALS_UNAVAILABLE` warning now means the domain count (`domains_owned`) could not be computed.
- **Tranches:** `POST /tranches` no longer takes `spend_cap`; `POST /tranches/{id}/members` no longer takes `est_cost`; the tranche view loses `spend_cap_cents`, `spend_cap`, `committed_cents`, `committed` and member `est_cost_cents` (a body that still sends the removed inputs is 422 `VALIDATION_ERROR`, strict schema). Geo cap, main-lane quota, size and `NO_TRANCHE` are unchanged.
- **`GET /selection/buy-hold`:** `small_buy` is now `{max_first_year_cents, max_first_year}` (the weekly figures are gone); step 7's evidence loses `cap_cents` and `cap`.
- **`GET /report`:** the `budget` block is renamed `spend` and keeps `spent` (pair), `committed_forward` and `domains` (count, max 40); `poc_cap` and `remaining` are gone. The markdown digest says `## Spend`.
- **Unchanged:** the 40-domain cap (`DOMAIN_CAP_REACHED`), per-call `max_price` / `max_two_year_price`, the approval rules, the ledger and `/ledger`, sales, profit and ROI in `/report`, founder rule 6 (never top up a registrar balance).
- **Database (migration `1763400000000_v5-0-0.sql`):** drops `settings.poc_cap_cents`, `tranches.spend_cap_cents` and `tranche_members.est_cost_cents`.

## 4.2.2 (2026-10-14): CR-052 follow-up: default hosting pages are not live businesses; no junk form-split hyphens
PATCH (fixes back to the contract; one additive `site_state` value). Release note: `docs/releases/v4.2.2.md`.
- **Sibling scan (S-3):** a registered sibling whose home page title is a hosting or web-server default or placeholder page is `site_state: "default_page"`, `live_business: false`, `company: null`, and counts like a parked one in `lead_points`.
- **Hyphen forms:** the form split is used only when every piece has 3+ letters (no `ppwr-la-belling.com`).
- **Correction to 4.2.1:** `.co.uk` siblings are answered by Nominet's RDAP, so `registered` true/false is a real answer (not `NO_REGISTRY_SERVICE`).

## 4.2.1 (2026-10-14): CR-052: sibling scan hyphen forms from real words (drs-compliance, fsma204-audit); .co/.us/.io via their registries' RDAP
PATCH (a fix back to the contract; no route, field or code change). Release note: `docs/releases/v4.2.1.md`.
- **Sibling scan hyphen forms (S-1):** built from real words, not the form split: a hyphen before the longest dictionary word ending the name (`drs-compliance.com`, `ppwr-labelling.com`), after the longest one starting it, and after a number followed by a letter (`ets2-compliance.com`, `fsma204-audit.com`); then the all-points form (`fsma-204-audit.com`), then the best split when it has at most three words. The lookalikes check keeps its old hyphen forms.
- **`.co`, `.us`, `.io` (S-2):** not in IANA's RDAP list, so they were always `NO_REGISTRY_SERVICE`; the sibling scan and the lookalikes check now ask the registries' own RDAP servers (rdap.registry.co, rdap.nic.us, rdap.identitydigital.services). `ext_dates` and `same_name` are unchanged.

## 4.2.0 (2026-10-13): keyword demand upload, Companies House matches
MINOR (additive; CR-044 item 3 follow-up, CR-046 item 2). Release note: `docs/releases/v4.2.0.md`.
- **New routes:** `POST /demand/keywords` (WRITE; body `{file_base64, location?, month?}`: the monthly Google Keyword Planner export, read by header name) and `GET /demand/keywords?keyword=` (READ; the latest stored values of a keyword). Codes `KEYWORD_CSV_INVALID` (422, `details.missing_headers`) and `KEYWORD_NOT_FOUND` (404).
- **New screening checks (feature checks, FLAG-level inputs, never a reject, no verdict changes):** `demand` (`fields.demand {keyword, avg_monthly_searches, competition_index, as_of}` or `{status: "unmeasured"}`; UNKNOWN `KEYWORD_NOT_IN_UPLOAD` when unmeasured) and `companies` (`fields.companies {uk_matches_n, items [{title, company_number, company_status}]}`, max 5, active first; UNKNOWN `SOURCE_DISABLED` without the key). Both end every plan while their `enabled` setting is on and never decide a pack.
- **`/report`:** the keep-signal of `RENEWAL_DROP_SUGGESTED` is now live: a name whose latest keyword upload shows at least `demand.keep_min_searches` average monthly searches is kept; `details.signals` gains `keyword_searches`.
- **Selection settings:** new `demand` (`enabled` true, `keep_min_searches` 10) and `companies` (`enabled` true, `max_per_minute` 60, `timeout_ms` 8000); a stored version without them reads the defaults, so no settings version changes.
- **Env (host):** `COMPANIES_HOUSE_API_KEY` (optional). **New append-only tables** `keyword_demand_uploads`, `keyword_demand` (migration `1763300000000_v4-2-0.sql`).

## 4.1.0 (2026-10-13): CR-050 sibling scan
MINOR (additive; CR-050 part 1, part 2 is not built). Release note: `docs/releases/v4.1.0.md`.
- **New routes:** `POST /selection/sibling-scan` (WRITE, 1 to 20 `.com` names; other endings 422 `TLD_NOT_SUPPORTED`) and `GET /selection/sibling-scan/{domain}` (READ, the newest stored scan). Per sibling: `domain`, `kind` (ending / hyphen / prefix), `registered` (RDAP; `null` with `reason_code`), `live_business`, `site_state`, `url`, `http_status`, `fetched_at`, `title`, `company`, `contact_url`; per scan a `lead_points` block `{points, formula, live_n, parked_n}`. No email address and no person name is stored: only the company name a page shows and the URL of its contact page.
- **New code:** `SIBLING_SCAN_NOT_FOUND` (404).
- **Selection settings:** new `siblings` key (endings, prefixes, `points_live` 10, `points_parked` 2, `max` 30, counted maxima, `max_checks`, `time_budget_seconds`); a stored settings version without it reads the defaults, so no settings version changes.
- **New append-only table** `sibling_scans` (migration `1763200000000_v4-1-0.sql`). Built on the CR-043 lookalike probe, which is now shared code; the lookalikes check's answers are unchanged.

## 4.0.1 (2026-10-13): CR-051 fixes: no test group without a pack, NO_PII names the field
PATCH: `screening_group` is null when a name has no screening pack (CR-051 B-1); the stats route's `NO_PII` message names `source` (B-2). Release note: `docs/releases/v4.0.1.md`.

## 4.0.0 (2026-10-13): portfolio discipline, outcomes, SellerHub
MAJOR (CR-044 to CR-049): `POST /buy` now **requires** `stre` and `stre_reason` (400 without them), a breaking change for the caller, as Gavriel asked in CR-046. Release note: `docs/releases/v4.0.0.md`.
- **Domain cap 40** (Dvir, 13 Oct 2026; migration; was 50). A dry run `/buy` at the cap reports `would_be_blocked: "DOMAIN_CAP_REACHED"` (a real buy and `dry_run: "strict"` are refused with the existing code).
- **`POST /buy`:** required `stre` (0..1) and `stre_reason`; the renewal maths gate (422 `RENEWAL_MATH_FAIL`, `renewal_math` in the dry run and the 201); optional `horizon` (`evergreen` default, `trend`, `regulation`; warning `HORIZON_DROP_POLICY_MISMATCH`); `screening_group` (`passed` | `borderline`) and `horizon` in the dry run and the 201. `LTO_NOT_ALLOWED` on a trend, regulation or first-expiry name (also `POST /list/{domain}`; CR-048).
- **New routes:** `POST /portfolio/{domain}/horizon` (Dvir's `approval_ref`), `POST /portfolio/{domain}/stats`, `GET /portfolio/outcomes`, `/portfolio/outcomes/monthly`, `/portfolio/outcomes/quarterly`, `POST /outreach/emails` (409 `EMAIL_CAP` at the 6th for a name), `GET /outreach/emails/summary`, `POST /patterns/sales`, `GET /patterns/latest`.
- **`/report` warnings:** `RENEWAL_DROP_SUGGESTED`, `SELL_BEFORE_DROP`, `HORIZON_DUE`, `DELIST_NEEDED`, `LANDER_PRICE_MISMATCH`, `LANDER_OFFER_MISSING`; `LANDER_DOWN` now reads `https://` and counts a TLS failure.
- **Daily steps:** `listingSync` (Spaceship SellerHub, off without keys) and `portfolioLifecycle` (expired unrenewed names, lookalike re-check in the renewal window, monthly holdout), both after `dropJob`.
- **Selection settings keys** (old stored versions read the defaults): `buy.renewal_math_min`, `buy.math_venue`, `buy.commission`, `renewal.*`, `outreach.max_emails_per_name`, `portfolio.*`.
- **Env (host):** `SPACESHIP_SELLERHUB_API_KEY`, `SPACESHIP_SELLERHUB_API_SECRET`.
- **Admin command** `record-renewal` (G-85; not an API route). Migration `1763100000000_v3-11-0.sql`.
- **Not built:** `POST /demand/keywords` (no real Keyword Planner export yet), the Companies House clue (no key), an Afternic stats CSV import (no real export).

## 3.10.0 (2026-10-13): CR-043 scout checks
MINOR, additive. Every new reject is **off** under the active settings (v11); a settings version activated with Dvir's `approval_ref` turns them on. Release note: `docs/releases/v3.10.0.md`.
- **New selection settings keys** (old stored versions read the defaults): `form.max_sld_chars` (null), `intake.require_sellers_min` (0), `intake.require_comps` (false), `intake.topic_window_days` (30), `lookalikes.*`, `buy.exclude_lanes` ([]). Codes: `SLD_TOO_LONG` (form check and intake), `SELLERS_TOO_FEW`, `COMPS_MISSING` (`tier`), `LANE_NOT_FOR_BUY` (final status `not_for_buy`).
- **`lookalikes` check** (G-70; feature check, never rejects): `fields.lookalikes {registered_n, in_use_n, unknown_n, items}`.
- **`POST /candidates/intake`:** optional `topic`; accepted names carry `topic` and `flags[TOPIC_REUSED]` with the earlier intake ids and times.
- **New route** `GET /screening/runs/{id}/report.csv` (READ).
- Not built: closest-past-sale lookup, search demand, the 404 check of sale pages, `competing_forsale_n`.

## 3.9.0 (2026-10-10): tech-debt pass (v3.0-v3.8)
MINOR, additive (new `/report` warning codes; the `DROP_POLICY_FAILED` 201 warning is removed because it can no longer occur). Release note: `docs/releases/v3.9.0.md`.
- **Reconciler never fails a purchase (Dvir, 10 Oct 2026).** A `register_sent`/`unknown` purchase whose name is absent at the registrar stays open, however long. `/report` raises the new warning `PURCHASE_UNRESOLVED` (`purchase_id`, `state`, `age_minutes`, `created_at`) after 30 minutes; the admin command `resolve-purchase` closes it. `PURCHASE_FAILED` now comes only from that command.
- **Reconciler books like `/buy`.** After booking a purchase it turns auto-renew off at the registrar (a failure is logged; `AUTO_RENEW_ON` covers the rest) and honours the stored request's `drop_policy` (`at_first_expiry`: `drop_date` = expiry). In `/buy` the drop date is now set in the booking transaction itself, so `DROP_POLICY_FAILED` is removed.
- **`/report`:** new `PURCHASE_UNRESOLVED` and `DB_SIZE_HIGH` (database over 70% of Neon's free 0.5 GB). `POST_BUY_INCOMPLETE` now means "a `/buy` purchase with no screening pack" (comps are optional since pricing v3).
- **`POST /candidates/screen`** with `domains`: a name already screened on demand today is free (CR-026) and is accepted at the cap; `ON_DEMAND_SCREEN_CAP` is answered only when no name can be taken.
- **Jobs:** a step retried after a timeout that finds the step still busy is `failed` (`previous attempt timed out and may still be running`), not an ok `skipped`. The daily list build takes the `daily_rebuild` lock itself.
- **Admin `import-domain`:** with `comps_min` 0 an import needs no comps and no legacy reason (same `pricing_evidence` row as `/buy` without comps); `--comps-file` still works.
- **Not contract-visible:** DB pool error listener and timeouts, refusal to start with `RENDER` set and `APP_ENV` not production (G-89), jobs-trigger Worker wake timeout 90 s and up to 3 POST tries, `review-retry-tick` workflow permissions and by-hand key, version-sync test.

## 3.8.0 (2026-10-10): CR-039, digits inside regime codes
MINOR, additive. Approved by Dvir on 10 Oct 2026. A digit inside a scout `words` piece that is on the `regime` list (ets2, nis2) no longer causes `HAS_DIGIT`, at intake or in the screening form check (SPELL-1). The `regime` list accepts terms with digits after a letter (`^[a-z][a-z0-9]{1,39}$`), and census list names may carry digits (`bt1_ets2compliance`). Release note: `docs/releases/v3.8.0.md`.

## 3.7.1 (2026-10-09): CR-038
PATCH, additive. A `/buy` dry-run error's `details` carry `display_name` and the drop-policy fields. Release note: `docs/releases/v3.7.1.md`.

## 3.7.0 (2026-10-09): CR-031 B/C, CR-033, CR-034
MINOR, additive. Release note: `docs/releases/v3.7.0.md`.
- **Offers:** `POST /offers` `dry_run`.
- **Listings:** new route `POST /listings/{domain}/venue` (hand listings; `export.<venue>` fields; the `/sold` checklist).
- **`/buy`:** `display_name` and `drop_policy` (with `renewal_committed_cents` and `drop_policy_line`).
- **Reads:**
  - `GET /selection/buy-hold` `small_buy`;
  - `/portfolio/{domain}` `registrar_state`;
  - `/report` `AUTO_RENEW_ON`, `REGISTRAR_DRIFT`, `LANDER_AWAITING_MARKETPLACE`.
- **Jobs and health:**
  - `nsVerifier` checks never-verified names on every tick;
  - `/health/ping` adds `version` and `commit`.

## 3.6.0 (2026-10-09): small-buy exception (CR-030)
MINOR, additive. `POST /buy` `small_buy_exception` with Dvir's "small buy" line skips `BUY_HOLD` for names at most $11.08 first year, within $50 a week; new 409 `SMALL_BUY_PRICE`, `SMALL_BUY_WEEKLY_CAP`; dry run `small_buy`. Release note: `docs/releases/v3.6.0.md`.

## 3.5.0 (2026-10-09): launch burst up to 6
MINOR. `POST /posts/burst` accepts `cap` 2–6 (CR-029 A); the cap is the day's total. Release note: `docs/releases/v3.5.0.md`.

## 3.4.1 (2026-10-09): CR-028
PATCH, additive. Release note: `docs/releases/v3.4.1.md`.
- **Re-screen:** `POST /candidates/screen` gets `force` (with `domains`).
- **Seller pages:** 401/403/429 and timeouts are unknown (`verified: null`), not unverified; a large page is judged on its first bytes; entries show `http_status` and `truncated`; new tier input `sellers_unknown_n` and `fields.sellers.unknown_n`.

## 3.4.0 (2026-10-09): CR-026, CR-027, CR-024 F-1/F-2
MINOR. Release note: `docs/releases/v3.4.0.md`.
- **Scout words (CR-027, a fix back to the contract of 3.3.0):** scout `words` now drive the `form` check and the tier's `n_words` (unknown pieces → PASS_WITH_NOTE `SCOUT_WORDS`); `words` and `split_source` appear on `GET /screening/runs/{id}`.
- **Re-screen (CR-026):** `POST /candidates/screen` takes `domains` and re-screens named names after a settings or record change (`skipped` with `NOT_CHANGED`, `NO_INTAKE`, `OWNED`).
- **OpenAPI (CR-024 F-1/F-2):** `/openapi.json` lists itself, and every POST has a body schema or `x-no-body`.

## 3.3.1 (2026-10-09): vendor test posts off the allowance
PATCH. Release note: `docs/releases/v3.3.1.md`.
- **Posting (CR-025):** DOM's own test posts don't count toward the daily allowance; the 04:13 IDT test post is excluded, so today's slot is free.
- **Doc fixes (CR-024 F-3, F-4):** `POST /candidates/daily/rebuild` answers 201 with a summary; `POST /selection/evaluate` lists `features.sellers_verified_n`.

## 3.3.0 (2026-10-09): CR-021, CR-022, CR-023
MINOR, additive. Release note: `docs/releases/v3.3.0.md`.
- **On-demand screening (CR-021):** `POST /candidates/screen`, with its own allowance `intake.on_demand_screen_daily_max` (30), job `screen`, and 409 `ON_DEMAND_SCREEN_CAP` / `ALREADY_RUNNING`.
- **Intake (CR-022):**
  - `words` on intake;
  - intake word rules on `bt1@v3`;
  - `POST /posts/schema-check` takes a real post body (`checked`).
- **Tier capability (CR-023 A–D):** tier inputs `lane` (`op: in`) and `sellers_verified_n`; `sellers` on intake and as a record kind; per-lane thresholds; tier `L`; adding a new tier's `p_passive` in a draft. The active settings are unchanged.
- **Daily list (CR-023 E):** `summary.screening_run_id(s)`, `rejected`, `failed_by_check_lane`, and per-lane counts in `why`; rows add `words`, `split_source`, `sellers`, `sellers_verified_n`.
- **API description (CR-023 F):** `GET /openapi.json`.
- **Quieter drop feed (CR-023 G):** `DROP_FEED_STALE` is `info` after 7 days by default (settings `drop_feed_stale_days`, `drop_feed_stale_level`).

## 3.2.2 (2026-10-09): the Buffer input from Buffer's live schema
PATCH, a fix back to the contract (posting). `createPost` sends `mode: shareNow`, `schedulingType: automatic`, `needsApproval: false`, always an `assets` list, and the image alt text under `image.metadata.altText`, as Buffer's live schema requires. `types` on `POST /posts/schema-check` follows only X's metadata. Release note: `docs/releases/v3.2.2.md`.

## 3.2.1 (2026-10-09): schema check returns Buffer's types
PATCH, additive. `POST /posts/schema-check` adds `types` (Buffer's live input definitions). The live check on 3.2.0 showed Buffer's live API differs from its published reference (`mode`, `schedulingType` and `needsApproval` are required; `ImageAssetInput` has no `altText`); 3.2.2 fixes the input from these definitions. Release note: `docs/releases/v3.2.1.md`.

## 3.2.0 (2026-10-08): CR-017, CR-018, CR-019 part C, CR-020
MINOR, **additive** (except: `summary.partial` narrowed to its documented meaning, and pending-delete names leave `failed_by_check.availability`). Release note: `docs/releases/v3.2.0.md`.
- **Posting (CR-017):**
  - the Buffer `createPost` input fixed (`assets: [{image}]`, `shareMode`);
  - new `POST /posts/schema-check`, and a real post checks the schema first;
  - a failed post doesn't use the allowance;
  - `review_reason` is `CODE: text`, at most 200;
  - a replay takes no rate-limit slot;
  - `triggered_by` is never null for new runs.
- **Daily (CR-018):** an interrupted screening run resumes at start; the list rebuilds automatically when screening finishes (`built_by: auto`); `summary.why`.
- **Intake (CR-019 C, CR-020):**
  - scout names first;
  - drop-list names only as leftovers that fit a kept lane (S2/S4/S6, else `NO_KEPT_LANE`), capped by `intake.drop_list_max_share`;
  - timeout retry in the same run;
  - pending-delete names show as `dropping`;
  - `dropWatch` re-checks names for 7 days after their drop;
  - `who_chases`;
  - `summary.partial` / `screening_ended_partial` / `timeout_n`;
  - settings `tranche.main_lanes` (default = today's rule).

## 3.1.0 (2026-10-08): CR-016, missed and stuck runs, review retries
MINOR, **additive**. Release note: `docs/releases/v3.1.0.md`.
- **`/report`:** new errors `JOB_MISSED` (today's 00:05 UTC slot passed by 30 minutes with no daily run) and `JOB_RUN_INCOMPLETE` (a daily run open for more than 2 hours). `GET /jobs/runs` `jobs.daily` adds `last_scheduled` and `missed_slot`. `/health` `jobs` is `overdue` in both cases.
- **Review:**
  - a Google 503 / UNAVAILABLE is retried inside the call (3 tries, 20 s then 40 s); `attempts` on `POST /reviews/run`;
  - only an `ok` review counts as the day's review;
  - `/health` `review_reason` when the review failed.

## 3.0.0 (2026-10-08): job queue in Postgres (refactor R3)
**MAJOR** for callers of `POST /jobs/run` (DOM's Worker and workflow, which are updated in this release; Gavriel was told in `DOM-TO-GAVRIEL.md`). Release note: `docs/releases/v3.0.0.md`.
- **`POST /jobs/run`** answers **202** `{run_id, job, status, skipped, steps}` at once instead of 200 with every step's result. An overlap answers with the running run's id.
- **Steps run from a queue** (`job_steps`), with attempts, time limits, and takeover of a step whose instance died. While it works, the service pings itself every 5 minutes so Render doesn't sleep mid-run.
- **`GET /jobs/runs`** adds `run_id`, run `status` and per-step `status`, `attempts`, `started_at`, `finished_at`; unfinished runs come first.
- **Unchanged:** `npm run job` (CLI) and `POST /jobs/preview`.

## 2.16.4 (2026-10-08): refactor R2 part 2, all code in modules
PATCH, **no contract change**. Release note: `docs/releases/v2.16.4.md`. Nine modules in all (registrars, listing, selection, buying, candidates, selling, reporting, outreach, ops); shared infrastructure in `src/core/`. Module dependencies have no cycle, and a test enforces that.

## 2.16.3 (2026-10-08): refactor R2 part 1, first modules
PATCH, **no contract change**. Release note: `docs/releases/v2.16.3.md`. Outreach (posting, review, company document, block list), reporting and selling (offers, sales) moved to `src/modules/<name>/` with one public `index.ts` each. A test enforces the boundaries.

## 2.16.2 (2026-10-08): refactor R1b, database locks and efficiency
PATCH. Release note: `docs/releases/v2.16.2.md`.
- **Visible:**
  - each job step has `ms`;
  - `GET /selection/test-sets/{name}` returns `lookups: null` and `unknowns: null` while its run is going (it used to compute them from every row on each poll).
- **Inside:**
  - every in-memory lock or "running" flag is now a database lock, so it holds across restarts and overlapping deploys (a second run is still `skipped`);
  - one shared polite pace per registry host for the whole service;
  - the screening engine makes about a third of the database calls it did (225 → 83 on a 20-name run).

## 2.16.1 (2026-10-08): refactor R1a, shared core
PATCH, **no contract change**. Release note: `docs/releases/v2.16.1.md`. One home (`src/core/`) for dates, money, validation and redaction; the duplicate copies are removed, and a test stops new copies. Responses, codes and messages are unchanged.

## 2.16.0 (2026-10-08): tech-debt pass, CR-014, CR-015
MINOR. Release note: `docs/releases/v2.16.0.md`. Mostly fixes. Additive fields and one new route. A few checks are now stricter, each listed here.
- **New:** `POST /candidates/daily/rebuild` (6 a day); `token_name` on `GET /audit` rows; `checked_at` on `POST /candidates/{domain}/records`; `unknowns` lists undecided names, with `unread` and `unknown_inputs`; cohort status `abandoned`; post statuses `pending` and `unknown`; `REVIEW_IN_PROGRESS`; admin `resolve-purchase`.
- **Stricter:**
  - a `tm_us` domain record needs an https evidence URL and the domain's own phrase (CR-014 N-1);
  - intake notes refuse personal data (`NO_PII`, CR-015 I-1) and remove `NO_SPLIT` / `ONE_WORD` names;
  - a test set seals only from a `done` run;
  - a cohort freezes only from a `done` run;
  - a real `/buy` refuses an unknown auto top-up state (`REGISTRAR_STATE_UNKNOWN`, founder rule 6);
  - geo LANDER-1 fails closed without a price list;
  - bot-posted review cost at most $5, and only Gemini cost counts toward the cap;
  - `/media` is limited to 120 a minute per IP.
- **Behaviour:**
  - **Posting:** a post is recorded `pending` before Buffer is called, so a retry can't post twice (`unknown` counts toward the cap).
  - **Reviews:** one review runs at a time.
  - **Jobs:**
    - a step with failed items is `ok: false`;
    - the walk-away is no longer in `/jobs/run`, `/jobs/preview` or `GET /jobs/runs`;
    - NS verification and the weekly blocklist follow IDT days;
    - the review-retry `tick` runs at 08:30 UTC.
  - **The daily list** judges domain records at build time.
  - **Idempotency:** a stale `in_progress` key says `stale: true`.
  - **Restore:** the backup now restores every exported table.

## 2.15.0 (2026-10-08): CR-013 acceptance fixes
MINOR, **additive**. Release note: `docs/releases/v2.15.0.md`.
- **Review:** one weekly rule (a failed review never uses up the full-document packet, F-1); actor and token ids in packets become `operator` (F-2); a 503, timeout or network error is retried at 10:30 IDT like a 429 (F-3); `GET /reviews/settings/history` (F-10); only calls that reach Google count toward 3 per hour (F-9).
- **Block list:** more key shapes, listed in the contract (F-4); a trailing `s`, `es` or `'s` matches a listed term (F-8); `POST /company/forbidden-terms/{id}/retire` (F-2). Codes `TERM_NOT_FOUND`, `TERM_ALREADY_RETIRED`.
- **Smaller fixes:** any unknown `/media/` token is 404 (F-6); removed drop-list rows show their tokens, and an empty cohort window names its reason (F-11).
- **Docs:** the cohort report shape (F-5), dry runs answer 200 (F-7), the remove 404 (F-11a).

## 2.14.0 (2026-10-07): CR-012 parts B and C, scout intake and the daily candidate list
MINOR, **additive**. Release note: `docs/releases/v2.14.0.md`.
- **Token scope `intake`:** may only `POST /candidates/intake` and `POST /selection/drop-lists`.
- **`POST /candidates/intake`:** scouts send names (30-day dedupe; owned refused).
- **Daily steps** `intakeScreening` (at most 30 names a day, intake first, then drop names due in 7 days) and `buildDailyList`.
- **`GET /candidates/daily`:** the day's ranked buy-ready list with sections and a summary; never the walk-away.
- **New tables:** `candidate_intake`, `candidate_screenings`, `daily_candidate_lists` (append-only, in the backup).

## 2.13.0 (2026-10-07): CR-012 parts A, D, E, and the sibling method bt1@v3
MINOR, **additive**. Release note: `docs/releases/v2.13.0.md`.
- **`bt1@v3`** (Dvir approved building it): `bt1@v2` plus a general token list; 1,826 of 1,900 vectors.
- **Unknowns explained (A):** `unknowns` on test sets and screening runs; rescore option `only_names_with_unknowns` with `from_set`, report `gaps`.
- **Records per domain (E):** `POST/GET /candidates/{domain}/records`; fresh records (tm_us 30 days, history 180) are reused by live runs; the per-run manual route also writes one. New append-only table `domain_records` (in the backup).
- **Path to a real buy (D):** `GET /selection/buy-hold` adds `steps` and `ready`.

## 2.12.0 (2026-10-07): CR-011 part A, posting to the company's X account through Buffer
MINOR, **additive**. Release note: `docs/releases/v2.12.0.md`. Founder rule 10 changed by Dvir (7 Oct 2026).
- **Routes:** `POST /posts` (dry run, images with alt text, threads, daily cap with a burst), `GET /posts`, `GET /posts/{id}/images/{part}/{position}`, `POST /posts/{id}/remove`, `POST /posts/pause`, `POST /posts/burst`, and the public `GET /media/{token}` (images for Buffer, 7 days).
- **Codes:** `POST_INVALID`, `POST_TOO_LONG`, `POSTING_PAUSED`, `POSTING_NOT_CONFIGURED`, `POST_DAILY_CAP`, `POST_FAILED`, `POST_NOT_REMOVABLE`, `POST_DELETE_UNSUPPORTED`.
- **`/health`** adds `posting`, `posting_reason`; daily step `postsRefresh`. Env `BUFFER_API_KEY` (secret), `BUFFER_CHANNEL_ID`, `PUBLIC_BASE_URL`.

## 2.11.2 (2026-10-07): CR-011 addendum C, review switch, model setting, free tier
PATCH-sized but **additive** routes (kept in the 2.11 line). Release note: `docs/releases/v2.11.2.md`.
- **`GET/POST /reviews/settings`:** `enabled` (default true), `model` (default `gemini-3.8-flash`, from an allowed list), `tier` (default `free`, cost 0; `paid` needs a note naming Dvir's approval). Codes `REVIEW_MODEL_NOT_ALLOWED`, `REVIEW_MODEL_NEEDS_PAID`, `REVIEW_DISABLED`. The env `GEMINI_MODEL` is removed.
- **429 retry:** the daily review stores nothing on a 429; a second Worker cron runs `tick` at 07:30 UTC (10:30 IDT) whose `reviewRetry` step tries once more, then stores `unknown`.
- **`/health`** `review: "disabled"` and `review_model`; `GET /reviews/cost` adds `enabled`, `model`, `tier`.

## 2.11.1 (2026-10-07): registry circuit breaker
PATCH. Release note: `docs/releases/v2.11.1.md`. After 5 refusals in a row from one RDAP registry within a run, the run stops asking it and answers the rest of its lookups UNKNOWN `RATE_LIMITED` at once (counted in `rate_limited`). It makes a rerun of a test set no longer wait on a registry that refuses everything (`.biz`, CR-010 T10-1).

## 2.11.0 (2026-10-07): CR-011 addendum B, DOM calls the outside reviewer
MINOR, **additive**. Release note: `docs/releases/v2.11.0.md`. Founder rule 9 changed by Dvir (7 Oct 2026, 19:07): one AI call is allowed, this review.
- **Daily step `outsideReview`** (once per IDT day, weekly on Sunday) and **`POST /reviews/run`** (WRITE, 3 per hour): build the packet, call Google Gemini, store the feedback with model and computed cost.
- **`/health`** adds `review`. New code `REVIEWER_NOT_CONFIGURED`. New optional env `GEMINI_API_KEY` (secret) and `GEMINI_MODEL`.
- **Guarantee changed:** "one AI call only (`src/services/review/gemini.ts`); no AI SDK, no other provider host" (checked by `tests/unit/no-llm.test.ts`).

## 2.10.0 (2026-10-07): CR-011 part B, the daily outside review (founder rule 9 kept)
MINOR, **additive**. Release note: `docs/releases/v2.10.0.md`.
- **Company document:** versioned upload and reads with diffs (`/company/document`).
- **Block list:** secrets, emails, phones and forbidden terms (`/company/forbidden-terms`) are refused as `TEXT_BLOCKED` with the category only.
- **Reviews:** `POST /reviews/packet` (what the reviewer gets, stored exactly), `POST /reviews/{packet_id}/feedback` (items marked new or repeat), `GET /reviews/items`, `POST /reviews/items/{id}/status`, `GET /reviews/cost` ($5 monthly cap); `/report` warning `REVIEW_OVERDUE`. DOM never calls an AI: Gavriel does.
- **New codes:** `TEXT_BLOCKED`, `DOCUMENT_VERSION_NOT_FOUND`, `DOCUMENT_MISSING`, `REVIEW_COST_CAP`, `PACKET_NOT_FOUND`, `FEEDBACK_EXISTS`, `REVIEW_ITEM_NOT_FOUND`. Six new append-only tables (in the data backup).

## 2.9.0 (2026-10-07): CR-010 v2.7.0 findings: cancel, answer source, run totals, pending
MINOR, **additive**. Release note: `docs/releases/v2.9.0.md`.
- **Cancel (F-1):** `POST /screening/runs/{id}/cancel` and `POST /selection/test-sets/{name}/cancel` (WRITE, audited); status `cancelled`; unfinished checks UNKNOWN `CANCELLED`; new code `RUN_NOT_RUNNING`. A cancelled run is never woken or reopened by a read. The contract now says when a read restarts work.
- **Answer source (F-3):** census siblings and `ext_dates` extensions add `source`.
- **Run totals (F-4):** `GET /screening/runs/{id}` adds `lookups`.
- **Pending (F-5):** a name whose checks are not all done in a running run is `pending` and not ranked.
- **Docs (F-2):** test-set features name the current methods and the measured times.

## 2.8.0 (2026-10-07): CR-007 G-2 (drop lists, source A) and G-1 (cohorts, the forward test)
MINOR, **additive**. Release note: `docs/releases/v2.8.0.md`.
- **Drop lists:** `POST /selection/drop-lists`, `GET /selection/drop-lists/{name}`, `GET /selection/drop-lists?drop_from=&drop_to=`; daily step `dropWatch` (registry status, expected drop date); `/report` warning `DROP_FEED_STALE`.
- **Cohorts:** `POST /selection/cohorts`, `GET /selection/cohorts/{name}`, `GET /selection/cohorts/report`; decisions frozen before the drop; daily step `cohortOutcomes` (drop outcome, re-registration at 30/60/90 days); FWD-1 pass line.
- **New codes:** `DROP_LIST_NAME_TAKEN`, `DROP_LIST_NOT_FOUND`, `COHORT_NAME_TAKEN`, `COHORT_EMPTY`, `COHORT_NOT_FOUND`.
- **New tables:** `drop_lists`, `drop_list_rows`, `drop_list_checks`, `cohorts`, `cohort_names`, `cohort_decisions`, `cohort_outcomes` (in the data backup).

## 2.7.0 (2026-10-07): CR-010 fast test runs
MINOR, **additive**. Release note: `docs/releases/v2.7.0.md`.
- **Provenance:** each census sibling and `ext_dates` extension shows `checked_at` and `reused`; census and `ext_dates` fields add `rate_limited_n`.
- **Test sets:** `max_answer_age_days` (default 7); `GET` adds `lookups {fresh, reused, unknown, rate_limited}` and `timing`. A stored answer is reused for an `as_of` only if read on or after it.
- **Speed:** test-set runs ask each registry up to 4 at a time, 250 ms apart, slowing down automatically on a 429 or refusal; stored answers are read in one query per name and never wait for the pacer. Live screening is unchanged.

## 2.6.0 (2026-10-07): CR-009 sibling method bt1@v2 (frequency-aware split) and acceptance fixes
MINOR, **additive**. Release note: `docs/releases/v2.6.0.md`.
- **Sibling method `bt1@v2` (N-8):** the `bt1` recipe on a frozen word split that prefers common words (SCOWL size levels, DOM's term lists, fixed costs; `data/bt1/bt1_v2_split.json` with its sha256). It agrees with the research split on 1,810 of 1,900 vectors (95.3%). `GET /selection/sibling-methods/{method}` adds `split_sha256`. `bt1@v1` is unchanged.
- **Test sets:** `sibling_method` (default `bt1@v2`) and, for `rescore`, `features_as_of: "row" | "now"`. A rescore may use a method not yet approved (it registers nothing); a `new` set and live screening still need the approval.
- **`POST /jobs/preview`:** adds `would_cancel` and `would_fail`; each array's item shape is documented (N-2).
- **Web Risk:** an UNKNOWN adds `http_status`, `error_status`, `error_reason`, `error_message` (never the key). The weekly blocklist check is `unknown` when a source failed and none listed the name (N-3).
- **`/jobs/run`:** a refused (401) call carries no `RateLimit-*` headers and uses no manual-run slot (N-4); every WRITE call counts, a 422 included (N-5); a WRITE-started run is audited under scope `write` (N-6).
- **Screening:** a name whose plan has no gating check is `not_screened` and left out of `ranking` (N-7).
- **Docs:** the `Connection` header over HTTP/1.1 and HTTP/2 (N-1).

## 2.5.0 (2026-10-07): CR-007 G-4 test sets and suites, CR-008 AC-10 rescore
MINOR, **additive** (one widening: a suite outside `holdout.required_suites` can now be frozen). Release note: `docs/releases/v2.5.0.md`.
- **Test sets:** `POST /selection/test-sets` (`new`: DOM filters, removes names used before, splits by seed and computes as-of features; `rescore`: as-of features and a report for names already registered), `GET /selection/test-sets/{name}`, `POST /selection/test-sets/{name}/seal` (registers the rows, freezes the test membership). New codes `SIBLING_METHOD_NOT_APPROVED`, `TEST_SET_NAME_TAKEN`, `TEST_SET_EMPTY`, `TEST_SET_NOT_FOUND`, `TEST_SET_NOT_READY`, `TEST_SET_ALREADY_SEALED`, `TEST_SET_NOT_SEALABLE`. New tables `test_sets`, `test_set_rows` (in the data backup).
- **Suites:** any suite id; new fields `gates_not_assessed` and `clears_hold`, each named in Dvir's approval. Holdout replays apply only the assessed gates and report `accepts_at_risk`.
- **Buy hold:** the hold suites are those with `clears_hold`; with none, `holdout.required_suites` as before. `GET /selection/buy-hold` adds `hold_suites_source`.

## 2.4.0 (2026-10-07): CR-008 sibling method bt1@v1 and ext.alt_list (CR-007 G-3)
MINOR, **additive**. Release note: `docs/releases/v2.4.0.md`.
- **Sibling method `bt1@v1`:** `GET /selection/sibling-methods/{method}` (READ: frozen pools, approval state, the 20 siblings for a domain or a word split) and `POST /selection/sibling-methods/{method}/approve` (WRITE, Dvir's `approval_ref` naming the method, once). New codes `SIBLING_METHOD_NOT_FOUND`, `SIBLING_METHOD_ALREADY_APPROVED`. New append-only table `sibling_method_approvals` (in the data backup).
- **Census:** an item's `census_list` may be `bt1@v1`: siblings built at run time; UNKNOWN `CENSUS_METHOD_NOT_APPROVED` before the approval. Per-name lists are unchanged.
- **`ext.alt_list` (C-1):** an optional settings key; `ext_dates` (`alt_tld_before_n`) reads it when present, else `ext.list`. `same_name` is unchanged. Existing versions behave as before.

## 2.3.0 (2026-10-07): CR-007 operations: manual runs, token expiry, automatic Web Risk, daily portfolio check
MINOR, **additive**. Release note: `docs/releases/v2.3.0.md`.
- **`POST /jobs/run` with a WRITE token (T-2):** `daily` or `tick` only, at most 4 calls per hour per token, same overlap lock; `GET /jobs/runs` adds `triggered_by` (the token's name). The READ token is still refused.
- **Token expiry (T-3):** a token may carry an expiry time set by DOM's admin command; after it the token gets 401 `UNAUTHORIZED` like an unknown one.
- **Automatic Web Risk (G-6):** with the server's Google Web Risk key, `web_risk` calls the Lookup API: a match is FAIL `UNSAFE`, no match is PASS (CAP-06; `requires_clean_history` applies only to manual records), errors are UNKNOWN `QUOTA` / `SOURCE_ERROR`, DOM's monthly cap (10,000) UNKNOWN `QUOTA_CAP`. Without the key, MANUAL_REQUIRED as before. The Update API is never called (a static test).
- **Daily `portfolioCheck` step (G-5):** registry (RDAP) and web answer daily, blocklists weekly, for every owned, listed or delisted name, hand-bought names included. New `/report` warnings `REGISTRY_MISMATCH` (error), `LANDER_DOWN` (warn, error from the 2nd day), `OWNED_NAME_BLOCKLISTED` (error). New append-only table `portfolio_checks` (operational, not in the data backup).
- **US trademark:** stays manual; the contract says the USPTO key gives no wordmark search (CR-007 Q-8).

## 2.2.0 (2026-10-07): CR-006 acceptance findings
MINOR, **additive**. Release note: `docs/releases/v2.2.0.md`. Two additions; the rest makes the docs match what the service and the platform do.
- **`/report` warning `AUTO_RENEW_UNCONFIRMED` (info, F-2):** on every report for each live name whose auto-renew the service can't read (GoDaddy, or `registrar_api: none`). Before, it appeared only in the import output.
- **`GET /deals/{id}` approvals add `dry_run` (Q-6):** `true` for a dry-run call, so a dry run and the real call with the same approval line read as one dry run plus one real row.
- **Platform responses (F-1, F-4, Q-5):** `README.md` §Errors now says which malformed paths the platform edge answers itself (`%ZZ` → 400 HTML, a truncated escape → 520) and that only `%C3%28`-style escapes reach the service's 400 `INVALID_REQUEST`. No `Connection` header reaches a client over HTTP/2. This corrects the 2.1.0 BUG-6 entry below.
- **Final push (Q-1):** stated: the final push changes only the BIN; floor and walk-away stay as set by the last drop (`endpoints.md` §Pricing version). Behaviour unchanged.
- **Job days (Q-2, Q-3):** `jobs.md` states the day each job acts (a drop on the first run after `drop_date`) and what a run does with rows due earlier (newest valid row applied, older ones superseded; a due delist wins). Behaviour unchanged.
- **Labels and evidence (F-3, F-5):** every contract file carries the contract version (`selection.md` was v1.1.0; the label test now checks it and `test-evidence.md`). `test-evidence.md` now covers the 40 listing rule codes under `POST /list/{domain}` (24 were missing; all had tests) and lists the platform responses.

## 2.1.0 (2026-10-07): CR-005 bugs and docs, daily-only schedule, CR-004 lander none and forecast fixes, job runs read, JOB_OVERDUE, strict dry run, rate-limit headers, drop preview, test evidence map
MINOR, **additive**. Release note: `docs/releases/v2.1.0.md`. No route, field or code is removed; the behaviour changes below only turn wrong answers into the documented ones.
- **Schedule (CR-005 Amendment A):** one Worker cron, `5 0 * * *`: `daily` only. `daily` now runs `reconciler`, `nsVerifier`, `screeningResume` first, then its own steps; `tick` stays callable by hand (`jobs.md`). A stuck purchase settles by the next daily run (up to about 24 h) or a manual run.
- **BUG-2:** every response timestamp uses the Asia/Jerusalem offset (tranches, `/report` `tranches[]`, screening runs and results, packs, manual records, manual quotes, selection activation and replays). UTC stays only on `uploaded_at` (`/export/{venue}/uploaded`) and `started_at` / `finished_at` (`/jobs/run`). New packs freeze their `content` (and its hash) with the offset form. Two things are passed through exactly as recorded: a screening check's `fields` object (the source's own dates, e.g. RDAP `created_at`, `as_of`) and a pack's `judgment` (the caller's own echoed `judged_at`).
- **BUG-3:** a `text/plain` body on a JSON route is 415 `INVALID_BODY` (it was 422 `VALIDATION_ERROR`).
- **BUG-4:** `POST /offers/{id}/outcome` checks the body (outcome value, note) before the id: an invalid body is 422 even for a bad or unknown id.
- **BUG-5:** replacing a locked parent (`tier.p_passive`, `lead.p_lead`, `priors_v91`, `holdout`) with a different value is 422 `SETTINGS_KEY_LOCKED` with `details.path` (it was `SETTINGS_INVALID` for a wrong-shaped value).
- **BUG-6:** a malformed percent-encoding in the path that reaches the service is 400 `INVALID_REQUEST` in the error shape, with a plain-ASCII body that does not echo the path. *(Corrected in 2.2.0: `%ZZ` and truncated escapes are answered by the platform edge before the service; no `Connection` header reaches a client over HTTP/2. See `README.md` §Errors.)*
- **DOCS-1 / DOCS-2:** the route table lists every route (48 at part 1; 50 with the two jobs routes of this release); the version labels follow the contract version; the code index lists every code a route throws (new entries: `MANUAL_REQUIRED`, `RUN_RUNNING`, `PACK_NOT_FOUND`, `JUDGED_AT_INVALID`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `MODE_INVALID` under Buying, the listing codes `DISPLAY_NAME_MISMATCH`, `REPLAN_NOTHING_LISTED`, `OVERRIDE_NEEDS_APPROVAL`, `DROP_DATE_UNKNOWN`, `LANDER_RETIRED`, `LANDER_INVALID`, `NS_INVALID`); `LABELLED_NAME_CONFLICT` is documented on `POST /selection/labelled-names`. `tests/contract/contract-doc.test.ts` now fails on a route without a table row or a section, a thrown code missing from the index, an index code nothing emits, and a stale version label.
- **DOCS-3:** `POST /selection/replays` (holdout) returns 422 `SUITE_UNKNOWN` (`details.required_suites`) for a suite not in `holdout.required_suites` (checked first), and `SUITE_NOT_DEFINED` only for a required suite with no frozen definition. Before, an unknown suite gave `SUITE_NOT_DEFINED`.
- **`POST /list` `lander: "none"` (CR-004 §10.3):** stores or changes the listing and plan with no nameserver action. New response fields `lander_pending` (every `/list` response) and `ns_status: "skipped"`; new `/report` info warning `LANDER_PENDING`. A later call with a real lander switches the nameservers and clears the flag. New column `domains.lander_pending` (migration `1760400000000_v2-1-0.sql`, default false).
- **Forecast fixes (CR-004 §10.3):** a name with `drop_date` = `expiry_date` counts no renewal in `budget.committed_forward` and gets no `RENEWAL_PRICE_UNKNOWN` (also on `import-domain`). `POST_BUY_INCOMPLETE` is not raised for a name imported as `legacy_no_comps`.
- **`GET /jobs/runs` (READ, CR-005 N-1, N-5):** every run since 2.1.0 (newest first) with `trigger` (`scheduled` / `manual` / `cli`), `scheduled_for`, times, `ok`, `skipped` and the full `steps`; per job `last_run_at`, `last_ok_at`, `next_due_at`; `reference` (popularity list, IANA refresh, NameBio disabled) and `backup` status blocks. New append-only table `job_runs` (migration `1760500000000_v2-1-0-job-runs.sql`; operational telemetry, not in the data backup).
- **`JOB_OVERDUE` (N-2):** `/report` error warning when no `daily` run has finished in 26 hours (constant `JOBS_OVERDUE_HOURS`); `GET /health` adds `jobs: "ok" | "overdue"` (`"unknown"` while degraded). `GET /health/ping` is unchanged.
- **`POST /buy` `dry_run: "strict"` (N-7):** the first real-buy gate refusal (`BUY_HOLD`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP`) is returned as the error, in contract order; otherwise identical to `dry_run: true`. Any other string is 422.
- **Rate-limit headers (N-8a):** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every authenticated response, a 429 included, per token and method class.
- **`POST /jobs/preview` (WRITE, N-4 narrowed):** `priceJob` and `dropJob` as a dry run on real data for `today` (default today, up to 3 years ahead); writes only the audit row; never counts as a run.
- **Test evidence map (N-11b):** `docs/contract/test-evidence.md`, generated by `npm run evidence` and checked in the default suite. New static checks: no LLM (SDK or provider host), and an append-only check over every append-only table.

## 2.0.2 (2026-10-07): dry-run /buy errors carry the gate fields
MINOR, **additive only**. Release note: `docs/releases/v2.0.2.md`. In a dry run, any `AppError` thrown after the DOM gates were evaluated (for example 409 `REGISTRAR_FUNDS`, `REGISTRAR_DRY_RUN_FAILED`, `REGISTRAR_STATE_UNKNOWN`, `PRICE_ABOVE_MAX`, `NOT_AVAILABLE`) now has `would_be_blocked`, `screening_pack` and `advisories` in `error.details` (same shapes as the 200 body). Real buys, the dry-run 200 and errors before the gates are unchanged.

## 2.0.1 (2026-10-07): documentation
- `GET /check`: states the existing rule that `available` needs at least one enabled adapter to confirm. RDAP `not_registered` with no enabled adapter gives `unknown`. Behaviour is unchanged (question from Gavriel's v2.0.0 acceptance run).

## 2.0.0 (2026-10-06): /buy requires a complete screening pack and an open tranche
**MAJOR (breaking, `/buy` only).** Release note: `docs/releases/v2.0.0.md`. Founder rules, caps, `approval_ref`, idempotency and audit are unchanged; manual imports are not affected.
- **`SCREENING_PACK_REQUIRED` (409, real buys):** the domain's latest pack must be `complete`, from its latest screening run, issued under the still-active settings version, and at most `pack.max_age_at_buy_hours` old (new selection setting, default 72, ruling G-75). `details.reason` is `NO_PACK`, `INCOMPLETE`, `NOT_FROM_LATEST_RUN`, `SETTINGS_NOT_ACTIVE` or `PACK_TOO_OLD`; `details.pack_id`. After `BUY_HOLD`, before any registrar call.
- **`NO_TRANCHE` (409, real buys):** the domain must be an active member of the open tranche.
- **`TRANCHE_SPEND_CAP` (409, real buys):** the tranche's optional `spend_cap` against this buy's cost plus its earlier purchases, re-checked under the global buy lock. New nullable `purchases.tranche_id` (migration `1760300000000_v2-0-0.sql`).
- **Dry run:** `would_be_blocked` is now the first of `BUY_HOLD`, `SCREENING_PACK_REQUIRED`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP`, or `null` (was only the literal `"BUY_HOLD"`). `advisories` is unchanged.
- **Not changed:** comps stay required (`comps_min`); making them optional needs a new `pricing_settings` version with Dvir's approval (gaps G-4).

**Migration note for Gavriel.** Before a real `/buy`: (1) screen the name (full plan) and record what it needs; (2) judge it and issue a pack (`POST /screening/packs`) from the **latest** run, with the active settings; (3) `POST /tranches` if none is open, then `POST /tranches/{id}/members` for the name (with `est_cost` if the tranche has a spend cap); (4) `POST /buy` with `dry_run: true` and read `would_be_blocked` (null means a real buy passes these gates); (5) the real `/buy` within 72 h of the pack. A new screening run of the name, a new settings activation or a removal from the tranche invalidates the earlier steps. Code that typed `would_be_blocked` as `"BUY_HOLD"` must accept the four codes.

## 1.2.0 (2026-10-06): screening pack, EU trademark record, same-name check, FLAG verdicts, same-run recompute
MINOR, **additive only**. Release note: `docs/releases/v1.2.0.md`. No route, field or code is removed, renamed or changed in meaning, and no call that v1.1.0 accepted is refused. **Lead verification (CAP-15/16) and erasure were cut on 6 Oct 2026 (Dvir: keep it simple); no lead route, `leadsResume` step or lead table exists in 1.2.0.** Manual records are per run (nothing is reused across runs), a pack from a settings version that is not the active one is never complete, and a run can go from `done` back to `running` when a manual history record triggers a recompute.
- **Selection settings keys (defaults fill the stored `v1` row, so every v1.1.0 route that reads settings works unchanged):** `eu_tm {required_lanes ["S6"], freshness_hours 168}`, `same_name`, `pack`, `lead.qualified_min`, `lead.verify` (**reserved, unused in 1.2.0**: stored and validated, read by nothing; its `never_fetch_hosts` must keep `linkedin.com`, else 422 `SETTINGS_INVALID`), `sources.business_sites` (true). A draft can now add a key under `freshness_hours`. See `selection.md`.
- **New check ids** `tm_eu` (G7, manual; MANUAL_REQUIRED for `eu_tm.required_lanes`, else PASS `NOT_REQUIRED_FOR_LANE`) and `same_name` (G8, CAP-12; implemented, see below). Neither is in a default gate list.
- **`same_name` (CAP-12, G8):** the same name on the other `ext.list` extensions: RDAP registration plus a polite read of each home page (`sources.business_sites`: robots.txt honoured, honest User-Agent, one request per `same_name.min_ms_between_fetches`, no login or CAPTCHA, never `linkedin.com`). FLAG `SAME_NAME_OPERATOR` when another extension is in use under our exact name or describes our service (`fields.same_name_operators`), FLAG `SITE_UNKNOWN` when a site answers but cannot be read (never PASS), PASS otherwise; also UNKNOWN `AS_OF_NOT_SUPPORTED` (a full run with `as_of`), `SOURCE_DISABLED`, `LIST_MISSING`, `ALL_EXT_UNKNOWN`. The page fetch goes through one outbound guard (public addresses only, vetted-IP connection, default ports, never-fetch hosts; `ADDRESS_BLOCKED`, `HOST_EXCLUDED`, `URL_NOT_ALLOWED` reasons). `same_name.parked_max_text_chars` (default 1500) is a new key. Not in any default gate list: a settings version adds it (release step). New evidence source `site`. `ext_dates` is unchanged. See `selection.md`.
- **`POST /screening/runs/{id}/manual`:** `check: "tm_eu"` (CAP-09; the EU, WIPO and UK IPO register search; FAIL `TM_LIVE_MARK`, FLAG `TM_GENERIC_HITS`, PASS), accepted for any name of the run. `CHECK_NOT_MANUAL` now lists four checks.
- **New route** `POST /screening/runs/{id}/verdicts` (a PASS or REJECT verdict on one FLAG result row) and `verdicts` on each name of `GET /screening/runs/{id}` (never changes `final_status` or `flags`). New codes: `VERDICT_RESULT_NOT_FLAG`, `VERDICT_RESULT_STALE`, `RESULT_NOT_FOUND`, `DECIDED_AT_INVALID`, result code `NOT_REQUIRED_FOR_LANE`. New table `screening_verdicts` (append-only; part of the backup export and restore).
- **Same-run recompute after a manual history record:** `POST /screening/runs/{id}/manual` with `check: "history"` now reopens a finished run and recomputes the checks that read history (`ext_dates`, `tier`, `price`, `tm_us`); rows are appended, earlier ones stay. New response field `recompute` (boolean, additive). While it runs `GET /screening/runs/{id}` shows `status: running`. Replaces the 1.1.0 note that these rows were not recomputed. See `selection.md` §Same-run recompute.
- **Screening pack (CAP-19):** new routes `POST /screening/packs` (WRITE), `GET /screening/packs/{id}` and `GET /screening/packs?domain=` (READ): a frozen, versioned pack built from a finished run's current rows, with `missing` codes (`NO_RESULT`, `FAIL`, `UNKNOWN`, `MANUAL_REQUIRED`, `NOT_RUN`, `FLAG_NO_VERDICT`, `FLAG_REJECTED`, `STALE_AVAILABILITY`, `STALE_QUOTE`, `JUDGMENT_REJECTED`). New codes `RUN_RUNNING`, `PACK_NOT_FOUND`, `JUDGED_AT_INVALID`, missing code `SETTINGS_NOT_ACTIVE`; dry-run advisory `PACK_NOT_FROM_LATEST_RUN`. `POST /buy` with `dry_run: true` gains `screening_pack` and `advisories` (`SCREENING_PACK_REQUIRED` unless the latest pack is complete); `would_be_blocked` is unchanged (only `"BUY_HOLD"`), and a real `/buy` still does not require a pack (enforcement is 2.0.0). New table `screening_packs` (append-only; part of the backup export and restore). See `selection.md` §Screening pack.

## 1.1.0 (2026-10-06): selection and screening (CR-001 P1a + CR-002 P1 + Amendment A)
MINOR, **additive only**. Release note: `docs/releases/v1.1.0.md`. Nothing is removed, renamed or tightened for an existing call:
- A client that never uses a new route sees the v1.0.1 behaviour. `POST /buy` has one new refusal, 409 `BUY_HOLD`, and it applies **only to a domain that has a screening result** under settings with `buy_hold` on (a never-screened domain behaves exactly as before; a dry run is never refused). Nothing screens a domain unless a caller starts a screening run.
- `NO_TRANCHE` on `/buy` (a buy outside an open tranche) and the `screening_pack` enforcement are **deferred to 2.0.0**, because they would break today's callers. `tranche.required_for_buy` is stored but not read.
- Pricing v3 applies only after DOM creates the v3 row with Dvir's approval; until then every v2 number is unchanged.
- Callers must ignore unknown response fields (README §Versioning); new fields (`/report` `tranches`, `would_be_blocked` on a dry run) are optional.

**New routes by area (all in `endpoints.md`):**
- Selection settings and lists: `GET` / `POST /selection/settings`, `POST /selection/settings/{label}/activate`, `GET` / `POST /selection/lists/{name}`, `GET /selection/namebio`, `POST /selection/evaluate`.
- Screening: `POST /screening/runs`, `GET /screening/runs/{id}`, `POST /screening/runs/{id}/manual`, `GET /screening/evidence/{id}`, `POST /quotes/manual`.
- Tranches: `GET` / `POST /tranches`, `POST /tranches/{id}/members`, `POST /tranches/{id}/close`.
- Replay and hold clearing: `POST /selection/labelled-names`, `POST` / `GET /selection/holdout-suites`, `POST /selection/replays`, `GET /selection/replays/{id}`, `GET /selection/buy-hold`.
- Jobs: hourly `tick` gains `screeningResume`; daily gains `referenceRefresh` (`jobs.md`).

**Sources switched off by default (`sources.*` in the selection settings, DOM-owned terms log `docs/internal/sources.md`):** NameBio (`sources.namebio` false: terms unverifiable, score feature only, `SOURCE_DISABLED`) and the Internet Archive (`sources.wayback` false by Dvir's decision of 6 Oct: its terms limit access to "scholarship and research", and Amendment B1 says no permission request is pending: it is off for good). With the archive off the `history` check is MANUAL_REQUIRED `MANUAL_SOURCE` and HIST-2 is recorded by hand (below). The popularity list is the Majestic Million (CC BY 3.0), not Tranco. `.co`, `.io` and `.us` have no RDAP service in the IANA bootstrap and are UNKNOWN `NO_REGISTRY_SERVICE`.

**Manual HIST-2 record (CR-002 Amendment B; no new route, shipped in 1.1.0 because 1.1.0 was not yet deployed):** `POST /screening/runs/{id}/manual` accepts `check: "history"` with `result: {result: PASS | REJECT_HARMFUL | FLAG_PRIOR_BUSINESS, category?, prior_business_name?, first_capture_year?, last_capture_year?, evidence_urls?, checked_by}`; `evidence_url` is now optional on the route (still required for `web_risk` and `tm_us`). The record maps to PASS / FAIL `HARMFUL_HISTORY` (`hist2_fail_class` = `category`) / FLAG `PRIOR_BUSINESS_FLAGGED`, runs the A1 guard on `prior_business_name`, and has the automated history's field shape, so tier, `ext_dates`, `price`, `web_risk` and tranche admission read it unchanged. Validation errors are 422 `VALIDATION_ERROR` (the contract's code; the request said 400); a domain not in the run is 404 `NAME_NOT_IN_RUN`; `checked_at` follows the 168 h history window (`CHECKED_AT_INVALID`). New error `409 MANUAL_REQUIRED` on `POST /tranches/{id}/members` for a name whose history is still waiting for a record; new reason code `PRIOR_BUSINESS_FLAGGED`. **Behaviour change inside the unreleased 1.1.0:** with `sources.wayback` false the automated `history` check answers MANUAL_REQUIRED `MANUAL_SOURCE` instead of UNKNOWN `SOURCE_DISABLED`, so the name is `pending_manual` rather than `unknown`. Recording a history result re-reads the name's earlier manual `web_risk` / `tm_us` records and appends a changed verdict; the run's tier / `ext_dates` / `price` rows are not recomputed, a manual record belongs to its run: a new run does not reuse it (superseded in 1.2.0, see below).

**Not in 1.1.0:** the screening pack and `NO_TRANCHE` (2.0.0), CAP-14/15/16/19 (1.2.0), CAP-25 and CAP-21b (P2).

Detail, task by task:
- **Replay, name registry and hold-clearing (CAP-21a, Amendment A2/A3; new routes `POST /selection/labelled-names`, `POST` / `GET /selection/holdout-suites`, `POST /selection/replays`, `GET /selection/replays/{id}`, `GET /selection/buy-hold`; additive):** the labelled-name registry (append-only; `fit`/`dev`/`test`), a diagnostic and a holdout replay through the same tier/DEMAND-2 code as live screening (holdout recomputes CAP-01 and CAP-02, needs TM-1/TN-1/HIST-2 + guard columns, applies gates per row, reports before/after), reports by slice, price band, lane and history type with precision at 1% / 2%, the leakage lint, the profit report, and the hold-clearing check behind `POST /selection/settings/{label}/activate` (`HOLDOUT_NOT_PASSED` now lists the suites). New setting `profit` (`bin_price_cents` 148800, `cost_per_name_year_cents` 1108). Suites are pre-registered (frozen with Dvir's approval naming the suite id; holdout takes only `suite` + `settings`); a failing holdout replay sticks per settings version; diagnostic refuses `test` rows. The registry field is `role` (the plan called it `split`). Suite definitions freeze their test-name membership (`member_hash`, `member_count`), are disjoint and non-empty, and cannot change once scored. New codes: `SUITE_ALREADY_SCORED`, `SUITE_OVERLAP`, `SUITE_EMPTY`, `SUITE_MEMBERSHIP_CHANGED`, `SUITE_NOT_DEFINED`, `SUITE_UNKNOWN`, `LABELLED_NAME_CONFLICT`, `ROWS_INVALID`, `REPLAY_EMPTY`, `HOLDOUT_CONTAMINATED`, `AS_OF_REQUIRED`, `REPLAY_INVALID_NO_GATES`, `VARIANT_NOT_PREREGISTERED`, `PROFIT_REPORT_INCOMPLETE`, `REPLAY_NOT_FOUND`.
- **Tranches and buy hold (CAP-04; new routes `GET /tranches`, `POST /tranches`, `POST /tranches/{id}/members`, `POST /tranches/{id}/close`; additive):** one open tranche at a time; the geo cap (`tranche.geo_max`, default 1) is checked on every addition (409 `GEO_CAP`), the main-lane quota (`ceil(members x min_main_lane / size)`, 10 of 15, **no waiver**) at close (409 `MAIN_LANE_QUOTA`); a name joins only from a non-backtest run on the **full** lane plan (`NOT_SCREENED_OK`, `details.reason` `BACKTEST` or `PARTIAL_PLAN`); a name whose main-lane standing cannot be told (S7, source lane unknown) is not main-lane; a tranche may close below target with `allow_below_target` and a reason (`TRANCHE_BELOW_TARGET` otherwise); optional per-tranche `spend_cap` and member `est_cost`, both at most the POC cap (`TRANCHE_SPEND_CAP`); closed tranches are read-only (service and database triggers) and appear in `/report` `tranches`. The view says `opened_under` and the close report `settings_version_used`. New codes: `TRANCHE_NOT_FOUND` (also on `POST /screening/runs` `tranche_id`), `TRANCHE_ALREADY_OPEN`, `TRANCHE_NAME_TAKEN`, `TRANCHE_CLOSED`, `TRANCHE_FULL`, `GEO_CAP`, `TRANCHE_SPEND_CAP`, `TRANCHE_BELOW_TARGET`, `MAIN_LANE_QUOTA`, `NOT_SCREENED_OK`, `MEMBER_NOT_FOUND`. The concentration check now counts real tranche members other than the item itself (`GEO_CAP`). **`POST /buy`:** new 409 `BUY_HOLD` for a real buy of a domain whose latest screening run (a run that lists the name but has no result yet counts) has `buy_hold` on, or is a backtest or a no-longer-active version; a never-screened domain behaves as before, and a dry run is not refused but reports `would_be_blocked: "BUY_HOLD"`. **`NO_TRANCHE` on `/buy` is deferred to v2.0.0** (breaking, with the P1b screening-pack enforcement); the POC cap still does not count renewals. New tables `tranches`, `tranche_members` (in the backup export and restore).
- **Name form (CAP-01, incl. FORM-2 and G-FORM-1):** new `selection.md` with the form result and its reason codes `HAS_DIGIT`, `HAS_HYPHEN`, `UNKNOWN_TOKEN`, `GFORM1_WORDS`, `GFORM1_LENGTH`, `GEO_ATTR_MISSING`, `CITY_PLUS_LEGAL`, `AMBIGUOUS_SPLIT`. The check runs inside a screening run (`POST /screening/runs`).
- **Pricing v3 (CR-001 G-1/G-2; `pricing_settings` columns, no new route):** when the current settings version has a price list (created only by the admin command, never seeded), new plans use the list, ladder drops, a whole-dollar floor, a geo M12 rung down to $299 and a final push to the lowest list price at or above the floor. New 422 codes on `/list`, `/buy` and `/pricing/preview`: `BIN_NOT_IN_PRICE_LIST`, `LANDER_EXCEPTION_REQUIRED` (always refused until the screening pack exists). `settings_version` is 3 in those responses. An override never waives the list. v2 plans, their schedules and every v2 number are unchanged unless replanned (a replan uses the current version) (`BIN_NOT_NICE` and `BIN_BELOW_FLOOR_MIN` stay for v2).
- **Selection settings, lists and evaluation (CAP-00, CAP-24, CAP-18; new routes):** `GET` / `POST /selection/settings`, `POST /selection/settings/{label}/activate`, `GET` / `POST /selection/lists/{name}`, `POST /selection/evaluate` (all in `endpoints.md`; the settings document, list formats, tier DSL, money fields and codes in `selection.md`). Settings are versioned and immutable; a draft is WRITE, **an activation needs Dvir's `approval_ref`**, the priors are locked against drafts (`SETTINGS_KEY_LOCKED`) and clearing `buy_hold` is refused until the holdout passes (`HOLDOUT_NOT_PASSED`). A census list is frozen only with `approval_ref`. New codes: `SETTINGS_NOT_FOUND`, `SETTINGS_KEY_UNKNOWN`, `SETTINGS_KEY_LOCKED`, `SETTINGS_INVALID`, `SETTINGS_NO_CHANGE`, `SETTINGS_LABEL_TAKEN`, `SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `LIST_NOT_FOUND`, `LIST_NAME_INVALID`, `LIST_TERM_INVALID`, `LIST_NO_CHANGE`, `CENSUS_LIST_SIZE`, `CENSUS_LIST_INVALID`, `FORBIDDEN_FEATURE`, `BIN_REQUIRED`, and the 500s `SELECTION_SETTINGS_MISSING` / `SELECTION_SETTINGS_INVALID`; warning `PRICING_V3_MISSING`. `approval_ref` is now also required for those two actions (README §Conventions).
- **Selection hardening:** an activation approval must name the settings label and a census freeze its list name or sld (`APPROVAL_INVALID` otherwise); `holdout.*` is locked against drafts; `tranche.geo_max` defaults to 1; `money.lander1` gains `message`.
- **Name form (CAP-01) settings:** `form.short_token_flag_min` (default 2: a split with that many dictionary-only 2-letter tokens, such as `animal·it·os`, is `FLAG` `AMBIGUOUS_SPLIT`) and `form.city_word_allowlist` (a place name that is also a dictionary word counts as a city only if listed there or in the `city_extra` list).
- **Registry, DNS and dated-extension checks (CAP-03, CAP-05, CAP-10, CAP-12; no new route):** the screening checks `availability` (G2, RDAP via the cache), `surbl` (G4, straight to the zone's authoritative servers with a per-run control), `census` (G8, sibling registered-share from a frozen census list) and `ext_dates` (G8, other extensions created before the .com) replace their `NOT_IMPLEMENTED` rows; their `fields` and reason codes (`REGISTERED`, `SOURCE_DISABLED`, `RATE_LIMITED`, `QUERY_REFUSED`, `SURBL_LISTED`, `CENSUS_LIST_MISSING`, `CENSUS_LIST_SIZE`, `TOO_MANY_UNKNOWN`, `ALL_EXT_UNKNOWN`, `NO_REGISTRY_SERVICE`, `AS_OF_REQUIRED`) are in `selection.md` §Screening runs. Dated inputs use strict `< as_of`; backtest and holdout runs need `as_of`. New cache tables `rdap_lookups` and `reference_files` (not part of the backup export). A census list must be frozen (approval recorded) and belong to the name (`CENSUS_LIST_MISMATCH`); an undated sibling is excluded and counted in `undated_excluded_n` (A2); SURBL only asks servers that passed the control; RDAP is paced per host (defaults `run.rdap_concurrency` 1, `run.rdap_min_ms_between` 1000; `surbl.list_bits` gains DM 4 and CT 32); a 404 must be an RDAP/JSON answer. Names are stored `unknown` on any registry, DNS or source error; nothing is read as available, not listed or not registered by default.

- **Daily reference refresh, TYPO-1, NameBio cache, quote, tier and price checks (CAP-02, CAP-11, CAP-17, CAP-24, CAP-18; new route `GET /selection/namebio`):** the screening checks `typo` (G1), `tier` (G8, gating, DEMAND-2), `namebio` (G8, feature), `quote` (G9) and `price` (G9) replace their `NOT_IMPLEMENTED` rows; fields and reason codes (`TYPO_MATCH`, `STALE_DATA`, `NOT_IN_CACHE`, `NO_QUOTE`, `DEMAND2_FAIL`, `DEMAND2_UNDECIDED`, `EV_NOT_POSITIVE`, `RATIO_BELOW_1`, `LANDER1_FAIL`, `COVERAGE_LOW`, `NO_KEYWORDS`, `BIN_REQUIRED`) are in `selection.md`. New daily job step `referenceRefresh` (between `registrarCheck` and `backupExport`; `jobs.md`): the popularity list, the IANA bootstrap, cache pruning. The popularity list is the **Majestic Million** (CC BY 3.0, terms verified at majestic.com), not Tranco (no licence of its own, one CC BY-NC upstream); the settings switch is `sources.popularity`. **NameBio stays disabled** (`sources.namebio` false; no fetcher; `GET /selection/namebio` answers from a stored cache only, `SOURCE_DISABLED` today) and its score feature is 0 points; any card that uses NameBio numbers shows `Data from NameBio`. `GET /screening/runs/{id}` adds `score` per name and a top-level `ranking` (tier, short names, score). The quote check never calls a create or top-up endpoint; a quote older than `quote.max_age_hours` (live) or `quote.manual_max_age_days` (manual) is UNKNOWN `STALE_DATA` in the quote and price checks; a manual quote is only a fallback for a registrar that cannot be machine-quoted (a live adapter error is `SOURCE_ERROR`); `quote` fields are tagged `quote_source` and `fallback_reason`. `tier` uses FLAG inputs, lists them in `flagged_inputs` and answers PASS_WITH_NOTE `TIER_FROM_FLAGGED_INPUT` when they decided the tier. TYPO-1 compares the registrable label (ccSLD aware). A manual check record posted while a check runs is no longer overridden by that check's own auto row in the worker's stop decision.

- **Screening runs, manual records, evidence, manual quotes (CAP-20, CAP-06, CAP-08, CAP-17; new routes):** `POST /screening/runs`, `GET /screening/runs/{id}`, `POST /screening/runs/{id}/manual`, `GET /screening/evidence/{id}`, `POST /quotes/manual` (`endpoints.md`; checks, statuses, final statuses and reason codes in `selection.md` §Screening runs). A run is persisted per (name, check), resumes after the service slept (hourly tick step `screeningResume` in `jobs.md`, and the next poll) and ends `partial` with every open check UNKNOWN `TIMEOUT` when it outlives `run.time_budget_minutes`. This release ships the offline checks `form`, `brand_lists`, `concentration` and the manual-record checks `web_risk`, `tm_us` (`MANUAL_REQUIRED` until a human result is recorded); every other planned check answers NOT_RUN `NOT_IMPLEMENTED` until it is built. While `buy_hold` is on a name that passes everything is `would_buy`, never a buy card. New codes: `DRAFT_NOT_ALLOWED_LIVE`, `AS_OF_LIVE_REFUSED`, `RUN_NOT_FOUND`, `NAME_NOT_IN_RUN`, `CHECK_NOT_MANUAL`, `EVIDENCE_NOT_FOUND`, `OBSERVED_AT_INVALID`. New tables: `screening_runs`, `screening_results`, `manual_quotes` (and with `selection_settings`, `selection_lists`, `screening_evidence` they are part of the backup export and restore). In a live run a name with an unbuilt gating check (other than `pack`, `leads`) is `unknown`; a backtest never yields `buy_candidate`; a manual record outranks an auto row; a manual `checked_at` must be inside the check's freshness window (`CHECKED_AT_INVALID`); a manual quote's registrar must be a configured name (`REGISTRAR_UNKNOWN`) and never Cloudflare (`REGISTRAR_NOT_ALLOWED`); lane gate lists must agree on gate order (`SETTINGS_INVALID`).
- **History HIST-2 with versioned signature lists, the prior-business guard and the source lane (CAP-07, CAP-03/04/12; no new route):** the screening check `history` (G6, gating) replaces its `NOT_IMPLEMENTED` row. It reads the Internet Archive (CDX index + raw captures, one request per second, retried, never "no history" on a failure) for captures **strictly before** the current registration or `as_of`, classifies the decisive ones with the versioned lists `sig_harmful_strong`, `sig_harmful_weak`, `sig_parked`, `sig_forsale`, and answers PASS / FLAG / FAIL / UNKNOWN by the `history.*` actions. Outputs: `prior_history`, `pre_caps`, `pre_cls` (`harmful`, `redirect_offsite`, `content`, `parked`, `redirect_error_only`, `none`, `unknown`), `hist2`, `hist2_fail_class` (exactly six: `blocklist`, `malware_phishing`, `spam`, `adult`, `scam`, `trademark_abuse`), `captures[]`, `evidence_urls[]`, `archive_span_yrs` (feature only, no E3 rule), `undated_excluded_n`, `as_of`. Prior-business guard (Amendment A1): `prior_business_use`, `prior_business_name` (from the capture's og:site_name, title or a company/copyright line), `prior_business_years`; the name runs through the brand and big-company lists (FAIL `PRIOR_BUSINESS_BRAND_HIT` / `PRIOR_BUSINESS_BIGCO_HIT`, a null name is FLAG `PRIOR_BUSINESS_NAME_UNKNOWN`) and is added to the manual `tm_us` request. New reason codes: `HARMFUL_HISTORY`, `HARMFUL_WEAK`, `REDIRECT_OFFSITE`, `FORSALE_HISTORY`, `PARKED_HISTORY`, `PRIOR_BUSINESS_NAME_UNKNOWN`, `PRIOR_BUSINESS_BRAND_HIT`, `PRIOR_BUSINESS_BIGCO_HIT`, `CAPTURE_UNAVAILABLE`, `BLOCKLIST_UNAVAILABLE` (and `fields.error_code` `ARCHIVE_UNAVAILABLE`). Parked and for-sale prior history is positive and never a reject; an off-site redirect is a FLAG (a redirect to a parking or for-sale marketplace host is parked / for-sale history). **Source lane (inferred from the archive, `source_lane_inferred: true`):** `source_lane` `expired_drop` / `fresh` / `unknown` on the history result and on each name of `GET /screening/runs/{id}`. `com_prior_registration` (`ext_dates`) now reads the history result. New signature classes `pbn` and `trademark` (`POST /selection/lists/sig_harmful_*`), and starter list versions v2 (migration `signature-lists-v2`: PBN and trademark terms, parking and for-sale marketplace hosts). **Fix round 1:** `sources.wayback` ships **false** (the Internet Archive's terms grant access "for scholarship and research purposes only"; superseded by Amendment B1: off for good, history is recorded by hand, see the manual HIST-2 entry above). Parked and for-sale pages are classified before harmful ones (strong words on a thin placeholder or a `sig_parked` page are FLAG `HARMFUL_ON_PARKED_PAGE`, never FAIL; new setting `history.parked_max_text_chars`); a manual `tm_us` record must query the prior business name (UNKNOWN `PRIOR_NAME_NOT_QUERIED`; `result.prior_name_live` is FAIL `TM_LIVE_MARK`); the index is filtered, paged by resume key and never silently cut (UNKNOWN `INDEX_TRUNCATED`; an empty body is UNKNOWN `SOURCE_ERROR`, only `[]` is "no captures"); a no-fetch scan of archived URLs adds FLAG `HARMFUL_PATH` (new setting `history.url_terms`); Web Risk after history: a FLAG history is final and clean, a FAIL history gives UNKNOWN `HISTORY_NOT_CLEAN`; `history.retries` defaults to 2 and `Retry-After` is honoured; prior-business names are read with linear scans, error and navigation titles are not names, a title equal to the domain is used with `prior_business_name_is_domain`, low-confidence names are no name (FLAG); quick meta refreshes are redirects, pages are decoded by their declared charset, `hist2_fail_class` is `blocklist` when a listing caused the FAIL. **Fix round 2:** the parked/for-sale override needs a thin page for both signatures; page text is read by a real tag scanner (quoted attribute values skipped, `<!-->` an empty comment, ASCII-only case folding, meta refresh parsed by position); a script or style block that never closes is UNKNOWN `CAPTURE_UNAVAILABLE` (`TRUNCATED_MARKUP`), a capture cut at the size cap is FLAG `CAPTURE_TRUNCATED`; `hist2_fail_class` is never null on a FAIL (unmapped class: `spam`). Also: `census` answers UNKNOWN when every sibling is undated (never a 0 of 0 share), and a SURBL result's `upstream_calls` now counts the control queries.

## 1.0.1 (2026-10-06): documentation corrections
PATCH. The code is unchanged except one message string; the contract now describes it exactly. Release note: `docs/releases/v1.0.1.md`. From the accuracy review (21 corrections).

**Wrong (would mislead a client):**
- `GET /audit` `request` is a JSON object (or null), not a string.
- An unknown **POST** route answers 403 / 400 (`SCOPE_FORBIDDEN`, `IDEMPOTENCY_KEY_REQUIRED`) before 404; the same for `POST /export/dan/uploaded`. Only GET gets a plain 404.
- `/list`: an off-grade geo BIN needs `approval_ref` (422 `APPROVAL_REQUIRED`); "no approval for any change within the rules" was too broad.

**Incomplete and cosmetic:**
- Money display: whole dollars only in the plan view and preview; `$1,995.00` elsewhere; the plan-view schedule has no `_cents` and no `(private)` suffix.
- `/report` `next_price_event`, upcoming `values`, `applied_7d` are flat `*_cents` + display pairs.
- Offer routing: `unpriced` (non-email) goes to `dvir`. `approval_ref` elsewhere is ignored unless a route says it is validated.
- `POC_CAP_EXCEEDED` and `REGISTRAR_FUNDS` `details` keys listed exactly.
- `pricing_evidence` problems are `COMPS_INVALID`, not `VALIDATION_ERROR`.
- HEAD on the export routes writes an `export_runs` row.
- `offers_by_strategy` scopes (listed names vs all-time); `domains_owned` differs between dry run and 201.
- Failed-auth limiter: 20 or more failures. `POST /jobs/run` with no job token: 503 even unauthenticated.
- `NOT_LISTED` never appears in export warnings. `OFFER_NOT_FOUND` comes after body validation. UTC time-field exceptions. Job step `skipped` only when the summary says so.
- v1.0.0 release note: removed the stale "$500" clause.
- **Message text (the only code change):** the `/buy` 202 `message` now says the bookkeeping resolves on the next hourly reconciler run (it said "within 10 minutes"). Messages are not part of the contract.

## 1.0.0 (2026-10-06): initial contract
The first written contract: the API as built after the 6 Oct 2026 cleanup (DOM handover). Release note: `docs/releases/v1.0.0.md`.

**Changes from the 5 Oct API** (all in this release):
- `POST /sold/{domain}`: the fee for the payout is a top-level `payout_fee` (USD). The `payout {amount, method, received_on}` object is gone (sending it → 422 `VALIDATION_ERROR`), and so are the `payouts` table, `POST /payouts/{id}/received`, `PAYOUT_MISMATCH`, `PAYOUT_OVERDUE` and `/report` `payouts_pending`.
- `POST /offers/import` (offers CSV import) is gone. Record offers one at a time with `POST /offers`.
- **Bots only:** every route except `GET /health/ping` needs a valid token; `GET /health` now needs one too. Unauthenticated requests write nothing. A per-IP failed-auth limiter answers 429 `RATE_LIMITED` after 20 failures in 10 minutes.
- **Exports are always the full file.** `changed_only` is gone; **any** query parameter on `GET /export/*.csv` → 422 `VALIDATION_ERROR`.
- **Jobs** run only through `POST /jobs/run` (`tick` hourly, `daily` 00:05 UTC). A bad body → **422** `VALIDATION_ERROR`. The service has no in-process timers (`JOBS_MODE` is gone).

**Where the contract differs from the inherited specs** (the specs DOM inherited are now `docs/internal/`; the full list with decisions is `docs/internal/gaps.md`). The contract describes the code:
- `POST /buy` still **requires 2–3 comps** (`pricing_evidence`, `COMPS_REQUIRED`) and does **not** accept `screening_pack` (an unknown field → 422). Selection v9.1 says comps are optional and a screening pack is required; that ships with CR-001 P1b.
- Pricing is **`pricing_settings` v2** (x95 BINs, −20% drops, a $399 geo name never drops, floor and walk-away to the nearest $5). The v3 price list, step-down drops and the geo $399 → $299 rung ship in 1.1.0 (see above); `BIN_NOT_IN_PRICE_LIST` and `LANDER_EXCEPTION_REQUIRED` were not emitted in 1.0.0.
- Not built: the selection endpoints (`/check/batch`, `/check/history`, `/check/tm`, `/check/quote`, `/score`, `/screening_pack`, …), `POST /distribution/confirm` and the FT-1 warning `DISTRIBUTION_INCOMPLETE`, `GET /renewal/decision/{domain}`, `POST /renew/{domain}` and the `dt` CLI.
- `POST_BUY_INCOMPLETE` means "bought without stored comps", not "without a screening pack".
- `GET /check` ignores unknown query parameters; every other GET with a query schema is strict.
- Codes the specs didn't list are now documented: `SOLD_AT_IN_FUTURE`, `EXPORT_NOT_FOUND`, `EXPORT_ALREADY_CONFIRMED`, `EXTERNAL_REF_CONFLICT`, `OUTCOME_FINAL`, `OUTCOME_TRANSITION_INVALID`, `OUTCOME_CHANGED_CONCURRENTLY`, `OFFER_SOLD_MISMATCH`, `SEDO_TEMPLATE_INVALID`, `DROP_DATE_UNKNOWN`, `LANDER_INVALID`, `NS_INVALID`, `COMMISSION_UNEXPECTED`, the `/buy` post-buy warnings and the export warnings.
