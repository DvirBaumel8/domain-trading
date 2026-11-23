> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-107 — Read routes on files; database optional (then gone)
| Field | Value |
|---|---|
| CR id | CR-107 |
| Series | S3 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. 10:09 IST: start now (use a fixture seed; the live seed is CR-106). |
| Priority | P0 |
| Depends on | CR-105. Does not wait for CR-106: tests use a fixture that matches the CR-105 file map. |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

The owned-state and pack read routes must work with no database: boot with no `DATABASE_URL` and without `npm run migrate up`. Callers keep the same contract shapes as v6.7.0 for the routes that remain.


## 2. Rules
- **R-1 (no DB at boot): the server starts with `DATABASE_URL` unset. There is no `migrate up` in the start command (CR-111 changes `render.yaml`). `/health/ping` touches no store and needs no auth.**
- **R-2 (reads from FileStore + packs): these routes read files, not a database: `GET /portfolio`, `/portfolio/{domain}`, `/ledger`, `/deals/{id}`, `/audit`, `/books.csv`, `/costs/forward`, `/portfolio/{domain}/forward-costs`, `/report`, `/report/offers`, `/report/pricing-review`, `/offers`, `/decisions`, `/decisions/{id}`, `/auctions/plans`, `/auctions/plans/{id}`, `/auctions/kills`, `/auctions/shortlist`, `/auctions/funnel`, `/auctions/preflight`, `/export/afternic.csv`, `/export/sedo.csv`, `/outreach/emails/summary`. `/health` is green without a database (it must not require Neon).**
- **R-3 (contract): response JSON for the routes in R-2 matches the v6.7.0 contract examples in `docs/contract/endpoints.md` and `docs/contract/reports.md`, except fields that existed only because of a database (call those out in the release note).**
- **R-4 (memory): idle RSS stays under 300 MB, so the process fits Render Free (512 MB).**
- **R-5: routes retired in CR-109 are out of scope here. This CR must not reintroduce a database dependency.**

## 3. Acceptance criteria
- **AC-1 (RD-1): on a seed fixture that follows the CR-105 map, each R-2 route returns JSON that matches the v6.7.0 contract examples (or the documented exception).**
- **AC-2 (RD-2): boot with `DATABASE_URL` unset and no `migrate up` → `/health` is green; `/health/ping` is 200 and touches no store (no GitHub call, no file write).**
- **AC-3 (RD-3): after boot and one `/portfolio` plus one `/ledger` read, process RSS is under 300 MB.**
- **AC-4: a missing or empty FileStore fails closed with 503 on the data routes, not a 500, and `/health/ping` still answers 200.**

## 4. Open questions for DOM
- Q1: if a v6.7.0 example field cannot be produced from the file map, list it and drop or replace it in the contract bump (CR-109 ships v7.0.0). Do not invent values.

<!-- DOM writes below this line -->
