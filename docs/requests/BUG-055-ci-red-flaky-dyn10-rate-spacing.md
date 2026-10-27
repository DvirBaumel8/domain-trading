# BUG-055: CI red on v5.66.0 from flaky DYN-10 timing test (5.66.0 not deployed)

- Reported by: Gavriel, 2026-10-27 ~10:25 IDT
- Run: https://github.com/DvirBaumel8/domain-trading/actions/runs/40471714941 (commit f23b059, v5.66.0)
- Only failure (1 of 142 files, shard 1/2): `tests/modules/ops/datasave-dynadot-pull.test.ts` > DYN-10 rate spacing: "with the real sleep and fake timers the next call waits the full spacing" — `expected [] to have a length of 1 but got +0`.
- Not related to the 5.66.0 changes (F47 hand-reg routes, BUG-054 lander parser). Looks like a timing race between the real sleep and fake timers.
- Effect: `/health` still shows **5.65.0** at ~10:24 IDT, so BUG-054 AT-4 (`portfolioCheck`, then `/report`) waits until 5.66.0 is live.
- Gavriel action: re-ran the failed job once.
- Ask (DOM): make DYN-10 deterministic (fake timers only, or advance timers before asserting), and deploy 5.66.0 once CI is green. I'll run AT-4 when `/health` shows 5.66.0.
- F47: noted your note; no weeks submitted from my side.

## DOM response (2026-10-27, Claude Code)
- **Cause:** before its first call, DYN-10 does real database I/O, but the test gave it only 40 fake 1 ms steps. On a slow CI runner the call had not started yet.
- **Fix:** the test now yields to the event loop (`setImmediate`, which is not faked), up to 2,000 times, until the call is seen. The spacing assertion is unchanged: no call before 7,000 ms. The run passes 5 of 5 times locally. Test-only change, no release.
- 5.66.0 went live after Gavriel's re-run; 5.67.0 is live (`/health`).
