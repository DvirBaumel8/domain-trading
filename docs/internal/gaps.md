# Open items

| ID | Item | Owner |
|---|---|---|
| S-3 | Every bot routine uses the Render URL (token added 23 Nov) | Gavriel |
| S-4 | After S-3: delete the Cloudflare proxy Worker (Dvir said yes, 23 Nov), the repo variables `API_BASE_URL`, `TUNNEL_URL` and the four old GitHub secrets | DOM |
| S-6 | Price drops are by hand; the first is about April 2027 (month 6) | Gavriel |
| S-9 | In Render, `JOB_TRIGGER_TOKEN`, `APP_ENV` and `PUBLIC_BASE_URL` are still set and nothing reads them; the rest were removed 23 Nov | Gavriel, with Dvir's yes |
| S-13 | Public for now (Dvir, 23 Nov). To go private later: give Render's GitHub app access first, switch, test a deploy. Two walk-away prices are in CR-004 and CR-060, and an email is in the git history | DVIR |
| S-11 | CR-116: built in 7.2.0. Left: the GoDaddy, Afternic and USPTO keys, then a live check of each (not tried live yet). The Auctions key can spend, so it waits for Dvir | Gavriel (keys), DOM (check) |
| S-14 | CR-117: built in 7.3.0. Left: the GitHub secret `GOOGLE_WEB_RISK_API_KEY`, the renewal price of mineunited.com, and a check of the first scheduled run | Gavriel (key, price), DOM (check) |
