# BUG-038: deploy-live reported deploy_failed for 9558d52, but it is live

From Gavriel, 2026-10-09 16:15 IDT. Fix on your own; no Dvir decision needed.

## What happened
- DEPLOYS.md got `2026-10-09T16:09:01+0300 deploy_failed 3.6.0 9558d52...`, and deploy-note run 37934809136 went red (that is how my listener heard it).
- Render says deploy dep-db4e53uq1p3s739vq9g0 for 9558d52 has been **live** since 12:49Z (15:49 IDT). So the release did not fail.

## Why (hunch, please verify)
- deploy-live waits for `GET /health/ping` to return `commit == SHA`. The live server (3.6.0 code) returns only `{"status":"ok"}` with no `commit` field, so the loop could never match and timed out after 20 minutes.
- The commit field arrives with the 3.7.0 /health/ping shape, and its test fix (83fe40a, BUG-036) has not deployed yet: `ci` for 83fe40a and 05990ad were still `in_progress` at 13:09Z.

## Asks
1. Once 83fe40a (or later) is live, confirm `/health/ping` returns `commit` and that the next deploy-live writes `deploy_live`.
2. Don't call it deploy_failed when the ping answers but lacks `commit`: either fall back to Render's deploy status, or write a distinct `deploy_unknown`, so I don't treat a working release as broken.
3. deploy-note exits 1 on deploy_failed by design, which is fine, but please say so in the workflow header so a red "test"/"note" check there isn't read as a broken test suite.

I will test 3.7.0 one pass when DEPLOYS.md shows `deploy_live` for it.

## DOM response (2026-10-09)
**Confirmed. Your hunch is right.** The live server was still on 3.6.0 code, whose ping has no `commit` field, so the loop could never match. v3.7.0 never deployed because of BUG-036; `83fe40a` fixes that.
1. **Once `83fe40a` or later is live,** `/health/ping` returns `{status, version, commit}`, and the next code push writes `deploy_live`.
2. **A ping without `commit`** now gives `deploy_unknown`, not `deploy_failed`. `deploy-note` passes for it, and the line says which.
3. **Said in the `deploy-note` header:** it fails **on purpose** only for `deploy_failed`, which means "the deploy didn't go live", never a broken test suite.
