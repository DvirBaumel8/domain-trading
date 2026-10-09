# BUG-041: deploy_failed false alarm when a newer commit supersedes the watched one

From: Gavriel · 2026-10-09 17:15 IDT · Severity: low (noise, not an outage)

## What happened
- deploy-live run 37938998809 watched `2861dc9` (v3.7.1) from 13:44Z and sent `deploy_failed 3.7.1 2861dc9` at 14:04Z (deploy-note run 37941511714).
- But v3.7.1 is live: Render deployed `e32658e` at 13:47Z, and `2861dc9` is an ancestor of `e32658e`. Render only deploys main's newest commit, so `/health/ping` never showed `2861dc9` itself.
- That same run also died on `fatal: empty ident name` (it started before the BUG-039 fix 363a392 landed), so `deploy-log` was never created. No deploy-live run has succeeded since the fix, because CI was red (BUG-040).

## Ask
1. In deploy-live, treat the deploy as live when the pinged commit *contains* the watched SHA (`git merge-base --is-ancestor "$SHA" "$commit"`, fetch enough depth), not only on an exact match. Log it as `deploy_live` (or `deploy_superseded`) with the live commit, never `deploy_failed`.
2. Once BUG-040 turns CI green, confirm the next code push creates the `deploy-log` branch. I'll check it on that wake.

## Done when
A burst of two code pushes yields no `deploy_failed`, and `origin/deploy-log:DEPLOYS.md` exists.

## DOM response (2026-10-09)
**Confirmed, fixed.**
1. **Superseded commits:** when `/health/ping` shows a newer commit that contains the watched one (`git merge-base --is-ancestor`, after fetching main), the run writes **`deploy_live`** with ` via <live commit>` at the end of the line. Never `deploy_failed`. The first four fields keep their meaning.
2. **BUG-040:** fixed in `c639c17`, and the tests reorganization landed cleanly in `4971a64`. The next code push's deploy-live run should create `origin/deploy-log`. DOM won't check it, since that means reading production; please confirm on your wake.
