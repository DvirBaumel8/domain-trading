# DOM improve notes — 2026-10-29 run (DOM Architect)

Written 29 Oct 2026 ~20:45 IDT (Asia/Jerusalem). API 5.75.1. DB 74.2% (796 MB of 1 GB).

## What the datasave did
- The 15:00 UTC run failed `GODADDY_NOT_PUBLISHED`. The retry `run_9ea5e2fc` (19:12–19:23 IDT) sealed GoDaddy with 134,092 closeouts. The Dynadot steps returned `SNAPSHOT_SEALED`.
- Dynadot aftermarket: 467 of 472 pages ok (107/108/210/312/414 failed). Dynadot closeouts: 47 of 50 pages ok (48–50 failed), 46,106 rows.
- `engineFeed` skipped: `db_size_high`. CR-095 covers this (retention/compaction plus a backfill of 900 candidates).
- CR-094 moves the cron to 15:20 UTC, because GoDaddy publishes late.

## Counter gap (Buyer 686/562 vs DOM 1,170/569). There is no loss.
| Counter | Value | Meaning |
|---|---|---|
| `candidates_n` (step summary) | 1,170 | in-range live auctions before the hard filters |
| `field_n` (row) | 686 | hard-filter passers stored at build (19:20 IDT) |
| `shortlisted_n` / `served_n` (step summary) | 569 | servable at build: not dropped by auto-prebid, not ended |
| GET `total` (Buyer, `as_of` 19:26 IDT) | 562 | live-eligible at read time: 7 more had ended in the 6 minutes after the build |
| Buyer judged | 562 (214 prior-excluded first) | — |

Both runs are the same (`data_date` 2026-10-29, `generated_at` 19:20 IDT). `field_n − total` = auto-prebid drops plus ended auctions. See `docs/contract/endpoints.md` and `internal/auctions.md` (f6fe1a5). Report all three numbers every run.

## Closeouts `NO_ACTIVE_MODEL`
- The docs say closeouts are ranked by the **active engine scoring model** (`POST /score`, model v12+) in the datasave step `scorePool` (`internal/closeouts.md` §4). Without an active model the score is null with `NO_ACTIVE_MODEL`, and the order falls back to alphabetical. A later run scores the old rows once a model exists (CC526-10).
- No model is active, so no engine model has been trained and promoted, and Oct 29 `engineFeed` was also skipped by the DB guard. Promoting a model is a DOM settings/model decision for Dvir/Gavriel. I did not change it.
- Until a model is active, the tip-200 is just `aaa…` names and is not a sample of anything (pool 149,130, ranked 77,538).

## Buyer's ideas
1. **Geo+trade and person-name tag before serving: yes, worth a CR.** About 95% of the field is $1 single-bid local or person names. It should be an offline tag (`tags: [geo_trade, person]`) that only sorts and labels names, not a hard filter at first. Measure it against Buyer kills for a week before it removes anything.
2. **Offset sampling for closeouts: needs a CR.** `/candidates/closeouts` has `limit ≤ 200` and no `offset`. Add `offset`, or `sample=random&seed=`, so Buyer gets an unbiased D sample while unscored. Better fix: get a model active, so the rank is meaningful.
3. **SOP `date=` vs `data_date=`: Buyer is right.** The query parameter is `date`; `data_date` is the response field. I fixed SOP 04 (Direction A).

## Blocker
The CR-083 evidence POST got 409 `DB_SIZE_HIGH` (6 rows, 1.6 KB). Filed **CR-097** (P1): small critical writes are exempt until 95%, and only bulk feeds throttle at 70%. The body is kept in `docs/requests/pending/`. I did **not** replay it, because the DB is still 74.2%. Replay it after CR-097, or once CR-095 brings the DB under 70%.

## Also filed
- **CR-096** (P2): `price_sanity` samples (16 jumps over 10× right now, no names exposed).
