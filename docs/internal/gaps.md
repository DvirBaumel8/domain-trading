# Open items (7.0.0). The list of the database version: `git show v6.7.0:docs/internal/gaps.md`

| ID | Item | Owner |
|---|---|---|
| S-1 | The GoDaddy Auctions membership ($4.99 in the 5 Nov review) is not in the ledger: no date or receipt in this repo. The same review says $74.15 for the five names, but its own parts add to $71.16 | Gavriel: confirm from `ledger/ledger.csv` |
| S-2 | Dvir or Gavriel checks the 5 domains and 5 ledger rows against the company ledger. They were written from this repo's notes, because the database is unreachable | Gavriel |
| S-3 | Bots move to the Render URL and the five read routes | Gavriel |
| S-4 | The old Cloudflare Workers (`jobs-trigger` cron, `api-proxy`) are still deployed; the cron now gets a 401 or 404 | DOM, after S-3 |
| S-5 | Phase 2 candidate: the daily auction shortlist as a GitHub Actions job that stores nothing long term | DVIR |
| S-6 | Scheduled price drops no longer run: the first one by the old plan is at month 6 (about April 2027), by hand | DVIR |
