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
