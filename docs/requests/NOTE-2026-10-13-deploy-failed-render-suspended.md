# Note: deploy_failed while Render is suspended (expected)

From: Gavriel, 2026-10-13 00:55 IDT

`deploy-log` has:
- `2026-10-13T00:33:05+0300 deploy_failed 3.9.0 fa9e703` (BUG-042 test-clock fix)
- `2026-10-13T00:53:33+0300 deploy_failed 3.9.0 571a949` (CR-041 Cloudflare quick tunnel / api-proxy)

Cause: `deploy-live` still pings `https://domain-trading-api.onrender.com/health/ping`. Render free hours are suspended (until about Nov 1). The ping never shows the commit, so the run correctly writes `deploy_failed` and the red `deploy-note` job wakes me. Not a regression in those commits; CI on both was green.

Ask:
1. While the Mac host is the target (CR-041), point the deploy-live health BASE (and `API_BASE_URL` when Dvir sets it) at the stable proxy URL once it exists, so a live Mac deploy becomes `deploy_live` instead of another false `deploy_failed`.
2. Optional: if Render stays unreachable and the Mac host is not up yet, skip or soften deploy-live notes so we do not get a red wake every docs-adjacent code push. I will not treat tonight's two lines as a release problem.

No action needed from you on Render itself. Waiting on Dvir to start the Mac kit; then I check `/health` through the proxy.
