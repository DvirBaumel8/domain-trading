## 2026-10-27 00:55 IDT (Gavriel): v5.58.0 live; CR-079 live checks pass

- `/health` shows **5.58.0** (db ok, jobs ok). CI green on main.
- **AT-7 live pass:** `GET /portfolio` lists all 5 names with `receipt_ref` and `deal_id` (D-001..D-005) equal to the registration ledger; `GET /books.csv` keeps the old columns in order with `observed_venues,receipt_ref,deal_id` at the end.
- **AT-6 live (negative) pass:** `promptinjectionaudit.com` has `receipt_ref: godaddy:none` and no `RECEIPT_POINTER_MISSING` warning.
- **`/report` now:** 3 warnings (`AUTO_RENEW_UNCONFIRMED` x2 for mineunited.com and promptinjectionaudit.com, `DROP_FEED_STALE`). None of the CR-079 codes fire, which is the expected clean state (all 5 have an Afternic venue and a receipt pointer).
- AT-1..AT-5 are fixture tests and rely on CI (green). I did not run AT-5's `POST /listings/{domain}/observed` on a live name, to keep the live books untouched.
- **Still open:** `portfolioCheck` job summary `by_code` with the new codes; the last daily ran 2026-10-26 02:05 IDT (before 5.58.0). I'll check it after tonight's daily run. No settings activated.

## 2026-10-26 23:35 IDT (Gavriel): v5.57.0 live, AS557-1 passes; HG-6 fix green; CR-079 round 1 seen
- **`/health`:** `version: 5.57.0`, status ok, db ok (CI on main green after the HG-6 fix in a31fd85).
- **AS557-1 pass:** `GET /auctions/shortlist` (data_date 2026-10-26, generated 22:33 IDT): 23 rows, all `auction-v4`, no "capped" reason anywhere (was 3 of 24 before).
- **CR-079:** the round-1 Decisions match what I'd answer (fold into `portfolioCheck`, sealed/confirmed export counts as approval trail, `OBSERVED_UNCONFIRMED` info). No further clarification from me; I'll run AT-1..AT-7 once 5.58.0 shows on `/health`.

## 2026-10-26 22:30 IDT (Gavriel): correction, v5.57.0 CI failed (flaky size test), not green
- My 22:05 note said v5.57.0's CI was green. Wrong: the `ci` run for 61e52a2 (run 40391818106) failed, so the Mac host won't deploy the tag. `/health` still says 5.56.0 at 22:25 IDT.
- The only failure: `tests/modules/engine/holdout-guard.test.ts` HG-6 (AC-6), `/engine/unsold`: `db_bytes_after >= db_bytes_before` was false. 136 of 137 files passed; nothing touches v5.57.0's change. Hunch for you to verify: the database size can shrink between the two reads (autovacuum or another test), so "after not below before" is flaky. Consider asserting only positive integers, or a tolerance.
- I re-ran the failed job once (`gh run rerun --failed`). If it passes, the next 10-minute deploy tick should ship v5.57.0 and I'll run AS557-1 after the next data save. If it fails again, it's yours to fix.


## 2026-10-26 22:05 IDT (Gavriel): v5.55.0 and v5.56.0 confirmed live; v5.57.0 pending
- **`/health`:** `version: 5.56.0`, status ok, db ok.
- **v5.55.0 check passes:** today's shortlist (24 rows, field 572) has maximums falling by rank: $55 (ranks 1-8), $50, $45, down to $40.
- **v5.57.0** (pushed 22:00 IDT, CI green) is not on `/health` yet; 3 of 24 shortlist rows still say "capped", as expected before it ships. I'll run AS557-1 after the Mac host deploys it and the next data save runs. Nothing else needed from me now.
