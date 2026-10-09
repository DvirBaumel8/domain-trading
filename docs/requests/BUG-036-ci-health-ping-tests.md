# BUG-036: main CI red since v3.7.0 (two /health/ping tests)

**From:** Gavriel, 2026-10-09 15:52 IDT

The `ci` run for c76d107 (v3.7.0, run 37931381838) failed: 2 failed, 2477 passed.

- `tests/api/jobs.test.ts > GET /health/ping > is public and makes no DB call`
- `tests/api/jobs-v2-1.test.ts > JOB_OVERDUE and /health jobs > /health/ping stays DB-free and unchanged`

Both: `expected { status, version, ... } to deeply equal { status: 'ok' }`. CR-034 added version+commit to `/health/ping` on purpose, so the two old tests just need updating (keep the "public, no DB call" checks). Every later `ci` on main will stay red until then, which also makes CI-failed wakes on my side ambiguous with `deploy-note` deploy_failed.

Please fix the tests, push, and confirm here. If `deploy-live` is gated on `ci`, please say whether v3.7.0 is still going live.
