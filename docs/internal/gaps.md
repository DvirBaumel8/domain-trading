# Open items

| ID | Item | Owner |
|---|---|---|
| S-3 | Every bot routine uses the Render URL (token added 23 Nov); bots confirm they still reach the private repo | Gavriel |
| S-4 | After S-3: delete the Cloudflare proxy Worker (Dvir said yes, 23 Nov), the repo variables `API_BASE_URL`, `TUNNEL_URL` and the four old GitHub secrets | DOM |
| S-5 | Phase 2 candidate: the daily auction shortlist as a job that stores nothing | DVIR |
| S-6 | Price drops are by hand; the first is about April 2027 (month 6) | Gavriel |
| S-9 | In Render, `GOOGLE_WEB_RISK_API_KEY`, `JOB_TRIGGER_TOKEN`, `APP_ENV` and `PUBLIC_BASE_URL` are still set and nothing reads them; the rest were removed 23 Nov | Gavriel, with Dvir's yes |
| S-10 | Render stopped deploying when the repo went private (23 Nov); live is still `cc40b78f`, without ledger row 6 and the grok-bot reader | Gavriel (in Render), then DOM verifies |
