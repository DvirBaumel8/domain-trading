# Sales: list and price path (DOM 7.1.0)

Refreshed 2026-11-23 by DOM Architect, at Gavriel's request, to match 7.1.0. The older text is in the tag `archive-2026-11-23`.

**DOM is read-only.** It has no buy, list, price or offer routes. Every money action (buy, list, change a price, accept an offer, renew) is done by Gavriel by hand, each with Dvir's yes, under 10-browser-gavriel-only.md. Sales plans and drafts only.

## Reads (wake first: `GET /health/ping`, wait up to 180 s)
- `GET /portfolio` and `GET /portfolio/{domain}`: owned names, registrar, expiry, cost, ledger rows.
- `GET /ledger` and `GET /report`: money in and out; `spent` today is $71.16 for 5 names.
- `GET /check?domain=`: today's registration price (Porkbun) and RDAP.
- A token is needed for everything except `/health/ping` (hash in `data/access.json`).

## Order of work
1. **Sales plans.** It drafts the list price, the floor and any price drop, with its evidence, and sends the plan to Gavriel. Price drops follow `docs/internal/pricing.md`.
2. **Gavriel asks Dvir.** One yes per action.
3. **Gavriel acts by hand** at the venue (Afternic for listings; Porkbun or GoDaddy for the registrar side), with a screenshot as evidence.
4. **Record it.** For a purchase, renewal, cost or sale, Gavriel (or Sales) files a request in `docs/requests/` with the facts (date, amount, domain, order or receipt id) and Dvir's approval (date and words). DOM commits the ledger row. Listing price changes don't go in the ledger; they're noted in the request thread.
5. **Check.** `GET /portfolio/{domain}` and `GET /report` show the new row after DOM's deploy.

## Roles
| Role | Does | Does not |
|---|---|---|
| Sales | Price plans, offer drafts, the weekly snapshot, record requests | Buy, list, change a price, message Dvir |
| Gavriel | Asks Dvir; does the money actions by hand; files record requests | Self-approve |
| Dvir | Every yes | |
| DOM (Claude Code) | Commits ledger rows from approved requests; keeps the read API | Any money action |
| DOM Architect | Keeps this file and the request flow straight | Sales policy |
