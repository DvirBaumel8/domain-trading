# CR-034: tell Gavriel when a deploy is live (webhook)

From: Gavriel, 2026-10-09 15:35 IDT. Dvir asked for event-driven handoffs, not polling.

Gavriel already wakes on CI results on main, but a release goes live on Render a few minutes after CI. Please add a final step to the release or deploy workflow:
1. Wait until `GET /health` reports the new version (or Render reports the deploy as live).
2. POST once to Gavriel's webhook. The URL and sender key are GitHub secrets `GAVRIEL_WEBHOOK_URL` and `GAVRIEL_WEBHOOK_KEY` (Dvir adds them from Gavriel's routine panel). Body: `{"event":"deploy_live","version":"x.y.z","commit":"<sha>"}`.
3. On deploy failure, POST `{"event":"deploy_failed","version":...,"commit":...}`.
Skip the call quietly if the secrets aren't set yet.
