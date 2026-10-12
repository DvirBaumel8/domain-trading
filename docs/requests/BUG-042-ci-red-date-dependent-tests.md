# BUG-042: main CI red since 12 Oct with no code change (6 tests look clock-dependent)

**From:** Gavriel, 2026-10-12 23:50 IDT

Every `ci` run on main since 81f4e25 (12 Oct, 23:06 IDT) has failed, through dec0830 (run 38302933367): 6 failed, 2484 passed. The last green run was 300d7e9 (10 Oct). `git diff 300d7e9 d5fdb7b -- src tests package.json` is empty: only docs changed, so the tests seem to depend on today's date.

Failing:
- `tests/modules/listing/pricing-v3.test.ts > v2 plans survive v3 (Review Focus 5)`, 5 tests:
  - a v3 plan applies ladder drops through the job (M6 1488 → 1088): expected 200, got 422
  - manual geo /list change under v3 ($349 → 422 BIN_NOT_IN_PRICE_LIST): expected 422, got 200
  - an override never waives the price list: `TypeError: Cannot read properties of undefined (reading 'code')`
  - non-geo plain bin under v3: expected 200, got 422
  - PR3-9: D-001 reprice via replan → 1488 / 967 / 950: the price arrays differ
- `tests/modules/reporting/report-warnings.test.ts > EXPORT_STALE / EXPORT_PENDING`: expected the warnings to include `EXPORT_PENDING`, got `['JOB_OVERDUE', 'FLOOR_AUTO_ACCEPT']`

My guess, for you to check: fixtures or plan dates are fixed in time and have now aged past a ladder step or the PR-37 pending window. A frozen clock (`vi.setSystemTime`) or relative dates would fix it for good.

Why it matters now: Render deploys only after `ci` passes, and the CR-041 Mac mini `deploy.sh` only deploys a tag whose `ci` passed, so a red main blocks the next release on both hosts. Please fix the tests (not the rules), push, and confirm here.

## DOM response (2026-10-12): fixed (tests only, no code or rule change)
Both were test-clock bugs; production behaviour is unaffected.
1. **pricing-v3 "v2 plans survive v3" (5 tests):** the block fixes its clock at 2026-10-12 09:00Z, but the helper `createV3` stamped pricing v3 with the real clock. After 09:00Z today, v3 started *after* the test's clock, so the tests ran under v2. `createV3` now takes the test's clock.
2. **report-warnings EXPORT_PENDING:** the last `export_runs` row took the database's real `now()` while the test's clock is fixed. It now has an explicit time.
Other users of `createV3` and fixed dates were checked; none mix a fixed clock with the real one. Full suite: 214 files, 2490 tests pass locally. CI on this push should be green; no release (tests only).
