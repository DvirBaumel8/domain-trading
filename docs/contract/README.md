# domain-trading API contract

**Version 7.0.0** (23 Nov 2026). The interface between **DOM** (the vendor) and its customers, Dvir's bots.

Phase 1 (Dvir, 23 Nov 2026): the app is stateless, has no database and **only reads**. It knows the domains owned and the money spent (`data/state.json` in this repo), and it can look up a price. Everything else of 6.x is gone; the routes answer 404.

| File | What |
|---|---|
| `endpoints.md` | Every route |
| `CHANGELOG.md` | Contract versions |

## Base URL
`https://domain-trading-api.onrender.com` (Render free). It sleeps when idle: call `GET /health/ping` first and wait up to 180 seconds for a 200. Do not poll it to keep it awake.

## Access
Every route except `GET /health/ping` needs `Authorization: Bearer <token>`. A token can only read; there is nothing to write. Missing or wrong: **401** `UNAUTHORIZED`. More than 20 failures from one address in 10 minutes, or more than 60 requests by one token in a minute: **429** `RATE_LIMITED` with `Retry-After`.

## Recording a purchase, cost, renewal or sale
Not through the API. File a request in `docs/requests/` with Dvir's approval; DOM adds the row to `data/state.json`, CI checks the founder rules and Render deploys.

## Conventions
- Money: integer cents (`*_cents`) and a display string. Negative in the ledger = money out. USD.
- Times: ISO 8601, Asia/Jerusalem. Dates: `YYYY-MM-DD`.
- Errors: `{"error":{"code":"…","message":"…","details":{}}}`.

| Code | Status | When |
|---|---|---|
| `UNAUTHORIZED` | 401 | No token, or a wrong one |
| `RATE_LIMITED` | 429 | See Access |
| `VALIDATION_ERROR` | 400 | `/check` without `domain` |
| `DOMAIN_INVALID`, `TLD_NOT_SUPPORTED` | 422 | Not a second-level .com name |
| `DOMAIN_NOT_FOUND` | 404 | Not in the portfolio |
| `NOT_FOUND` | 404 | No such route (every 6.x write route included) |
| `INVALID_REQUEST` | 4xx | A malformed request |
| `INTERNAL` | 500 | A fault in the app |

**Versioning (semver).** MAJOR breaks a caller, MINOR adds, PATCH fixes.
