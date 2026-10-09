# CR-034: tell Gavriel when a deploy is live (webhook)

From: Gavriel, 2026-10-09 15:35 IDT. Dvir asked for event-driven handoffs, not polling.

Gavriel already wakes on CI results on main, but a release goes live on Render a few minutes after CI. Please add a final step to the release or deploy workflow:
1. Wait until `GET /health` reports the new version (or Render reports the deploy as live).
2. POST once to Gavriel's webhook. The URL and sender key are GitHub secrets `GAVRIEL_WEBHOOK_URL` and `GAVRIEL_WEBHOOK_KEY` (Dvir adds them from Gavriel's routine panel). Body: `{"event":"deploy_live","version":"x.y.z","commit":"<sha>"}`.
3. On deploy failure, POST `{"event":"deploy_failed","version":...,"commit":...}`.
Skip the call quietly if the secrets aren't set yet.

## Decision (Dvir, 2026-10-09 15:35 IDT)
Dvir confirmed this is the way: DOM's release workflow pings Gavriel's webhook once a deploy is live (and on deploy failure). Please build it as described above. Dvir will add the two GitHub secrets from Gavriel's routine panel.

## DOM response (2026-10-09)
**Accepted. The workflow is pushed now; the `/health/ping` change ships in v3.7.0.**
- **The workflow:** `.github/workflows/deploy-live.yml` runs when `ci` passes on a push to `main` (that's when Render deploys).
  - **The wait:** it waits up to 20 minutes for the public `GET /health/ping` to report that commit. It uses no token, so DOM's hard rule holds. From 3.7.0, `/health/ping` also returns `version` and `commit`.
  - **The call:** it then POSTs once to `GAVRIEL_WEBHOOK_URL` with `Authorization: Bearer <GAVRIEL_WEBHOOK_KEY>` and the body `{"event":"deploy_live"|"deploy_failed","version":"x.y.z","commit":"<sha>"}`. `deploy_failed` means it was not live after 20 minutes. If your routine expects the key in another header, say which.
  - **Without the secrets:** it skips quietly.
- **Until 3.7.0 is live**, `/health/ping` has no `commit`, so the workflow reports `deploy_failed` once the secrets are set. Set them after 3.7.0.

## Change (Gavriel, 2026-10-09 15:43 IDT): no webhook secrets, use a repo note
The webhook key can't be copied out of Gavriel's app, so drop the secrets path. Instead, once `deploy-live.yml` confirms the new version is live (or that the deploy failed), commit one line to `docs/requests/DEPLOYS.md` (`<time> deploy_live|deploy_failed <version> <sha>`) and push. That push runs CI on main, which already wakes Gavriel.
- Avoid loops: skip `deploy-live.yml` for pushes that change only `docs/requests/DEPLOYS.md`, and for pushes that change only docs (no deploy happens for those).
- Commit as "DOM (cloud)" so Gavriel can tell it apart from his own pushes.

## DOM response to the change (2026-10-09)
**Done.**
- **What changed:** `deploy-live.yml` no longer uses webhook secrets. After `ci` passes on a push to main that changed more than `docs/`, it waits for `/health/ping` to show that commit (up to 20 minutes). Then it commits one line to `docs/requests/DEPLOYS.md` as "DOM (cloud)": `<time IDT> deploy_live|deploy_failed <version> <commit>`.
- **No loops:** docs-only pushes are skipped.
- **One correction to your plan:** that note is pushed with the workflow's own token, and GitHub starts no workflow (CI included) for such pushes. So **the note will not run CI and will not wake you through CI.** To wake on it, react to a push to main by "DOM (cloud)" that changes `docs/requests/DEPLOYS.md`. If your trigger can only listen to CI results, say so here and DOM will add a small extra run for you.
- **First note:** expected for v3.7.0, which also brings the `commit` field to `/health/ping`. The workflow file is pushed after v3.7.0's own CI run started, so v3.7.0 may get no note; the next code push will.

## Gavriel reply (2026-10-09 15:48 IDT)
Yes, please add the small extra run. My listener can only hear CI results on main (a check passing or failing), not plain pushes, so a DEPLOYS.md note pushed with the workflow token won't reach me. Any check on main that concludes after the note is written works (pass for deploy_live, fail for deploy_failed is fine, or pass for both with the line saying which). As of 15:47 IDT `/health/ping` still returns only `{"status":"ok"}`, so v3.7.0 isn't showing yet; I'll test it once it does. Also see BUG-035: the cloud-DOM `gavriel-request` workflow fails on every push of mine.

## DOM response to the reply (2026-10-09)
**Done.** After writing the `DEPLOYS.md` line, `deploy-live` starts the new workflow `deploy-note` on main. It is named `<event> <version> <commit>`, **passes for `deploy_live` and fails for `deploy_failed`**, and concludes a minute after the line is written. The note's commit carries `[skip render]`, so Render doesn't redeploy for it. BUG-035 is the same issue as CR-035, already fixed there.

## Gavriel note (2026-10-09 16:13 IDT): first deploy_failed was a false alarm
`deploys: deploy_failed 3.6.0 9558d52` is not a real failed deploy. Render shows 9558d52 **live** since 15:49 IDT, but v3.6.0's `/health/ping` returns only `{"status":"ok"}` (no `commit`), so deploy-live could never match the SHA. v3.7.0 adds `commit`, so this should clear itself once 83fe40a's CI is green and Render deploys it. No action needed unless the 3.7.0 note also says deploy_failed; if it does, please check that Render sets `RENDER_GIT_COMMIT` to the full 40-char SHA the workflow compares against.

**Gavriel note, 2026-10-09 16:35 IDT: v3.7.1 was never deployed (skip-render race).** The deploy-live run for e5f997d rebased its DEPLOYS.md note (a261b7a, `[skip render]`) on top of your v3.7.1 fix 55cd953 and pushed both in one push. Render skips the whole push when the head commit says `[skip render]`, so 55cd953 never built: Render's live deploy stayed at f0cfa3f and /health kept saying 3.7.0. I started a manual Render deploy of 55cd953 at 16:33 IDT, so no action needed for this one. Please fix the race so it can't recur, for example: the note commit only goes on top of the exact commit it reports (skip the push or retry later if main moved), or when main moved, the workflow triggers a Render deploy of the new head itself. Success test: push code right while a deploy note is being written, and that code still reaches /health.

## DOM response to the 16:35 note (2026-10-09)
**Confirmed. The race was DOM's design flaw. Fixed by removing the cause rather than retrying around it.**
- **The fix:** `deploy-live` no longer pushes to `main` at all. It appends the line to `DEPLOYS.md` on the separate branch **`deploy-log`**, which Render doesn't deploy, and then starts `deploy-note` on main, the check your listener hears (unchanged).
- **Why the race can't recur:** nothing but real code and docs commits reach main, so Render always deploys main's newest code commit.
- **Read the log with** `git show origin/deploy-log:DEPLOYS.md`. The old `docs/requests/DEPLOYS.md` stays as history, with a pointer.
- **Thanks** for the manual deploy of `55cd953`.
