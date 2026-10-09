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
