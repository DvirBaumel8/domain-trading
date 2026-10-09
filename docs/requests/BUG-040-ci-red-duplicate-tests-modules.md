# BUG-040: CI red on main since 363a392 (a copy of the whole test suite under `tests/modules/` rode in with the BUG-039 fix)

**From:** Gavriel, 2026-10-09 17:00 IDT. **Severity:** high (main is red; every later code push fails CI until this is fixed).

## What happened
CI run 37939261188 on 363a392 ("ops: deploy-live sets the git identity inside the deploy-log temp repo (BUG-039)") failed: 1 failed, 2478 passed (170 files). The failing test:

```
tests/unit/test-evidence.test.ts > the committed docs/contract/test-evidence.md is what `npm run evidence` generates
- | `NOT_SCREENED_OK` | ... (8 tests) |
+ | `NOT_SCREENED_OK` | ... (4 tests) |
```

CI passed on the commit before it (53933dd).

## Why (please verify)
363a392 changes 144 files, but only 2 belong to BUG-039 (`.github/workflows/deploy-live.yml` and the BUG-039 note). The other 142 are new files under `tests/modules/<module>/...`, which look like copies of the existing tests in `tests/api/` and `tests/unit/` with only the import paths changed (e.g. `tests/modules/ops/admin-cli.test.ts` vs `tests/api/admin-cli.test.ts`, `tests/modules/selection/screening-packs.test.ts` vs `tests/api/screening-packs.test.ts`). Hunch: a test move into `tests/modules/` was half done locally (copies made, originals not deleted, evidence not regenerated) and got swept into the BUG-039 commit. Every test now runs twice, the evidence counts double, and the CI run took about 11 minutes instead of the usual few.

## Asked
Either finish the move (delete the originals, run `npm run evidence`, commit the result) or take `tests/modules/` back out until it's ready. Keep the BUG-039 workflow fix.

## Done when
CI on main is green again, the test count is back to one copy of each test, and `docs/contract/test-evidence.md` matches `npm run evidence`.

## DOM response (2026-10-09)
**Confirmed, DOM's slip.** A local builder reorganizing the tests by module had staged its new `tests/modules/` files, and DOM's BUG-039 commit took the whole staged index instead of only its two files. Fix: those files are removed from main (the tree is as before `363a392` plus the two intended changes). The reorganization lands later as one deliberate commit, with the old files moved, not copied. DOM now commits only named paths (`git commit -- <paths>`) while a builder works in the tree.
