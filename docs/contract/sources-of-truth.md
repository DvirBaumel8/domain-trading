# Sources of truth (CR-084, added in 5.63.0)

**Rule (Dvir, 27 Oct 2026, D-2026-10-27 §10 A):** every durable fact lives in the DOM database, in one place. Every consumer reads it through the DOM API only. Nothing else is a second writer.

**Company-box files are not a source of truth.** A CSV under the company box (`ledger/portfolio.csv` and any other copy of a price, a venue, a cost or a decision) is at most a **dated, lagging mirror** of what these endpoints answer. A bot or a digest never reads a box CSV as live truth, and never writes BIN, floor, walk-away or min offer into one as if it were the record. If a box file and the API disagree, the API is right. DOM has no route that reads or writes a company-box file (CR084-AT3).

Money is unchanged: a price, listing, buy, bid or renewal still needs Dvir's own line, which Gavriel passes as `approval_ref` where a route asks for one. Recording a fact here never changes a price or a listing by itself.

## The map

| Durable fact | The only writer (after Dvir's yes for money-adjacent fields) | The read endpoints (the only read path) |
|---|---|---|
| **Owned-name prices and plan:** BIN, floor, min offer, mode, grade, drop schedule; the **private walk-away** | DOM: `POST /buy` (the proposed listing), `POST /list/{domain}`, `POST /portfolio/import`, and the daily `priceJob` (scheduled drops). The `approval_ref` rules of those routes are unchanged | `GET /portfolio`, `GET /portfolio/{domain}`, `GET /books.csv` (the same cents; the walk-away is in these and never in `/export/*`) |
| **Listing provenance and venues:** who listed, with whose approval, `listed_venues`, `observed_venues`, hand listings and delistings | `POST /list/{domain}`, `POST /listings/{domain}/venue`, `POST /listings/{domain}/observed`, `POST /export/{venue}/uploaded`, `POST /export/afternic/push` | `GET /portfolio/{domain}` (`listing_history`, `export.<venue>`), `GET /portfolio` and `GET /books.csv` (`listed_venues`, `observed_venues`) |
| **Marketplace live state:** what Afternic shows today | the daily step `afternicSync` (read-only) into `afternic_listings_daily` | the `/report` warnings `AFTERNIC_DRIFT` and `AFTERNIC_NOT_LISTED`, and `GET /visits` (Afternic views and leads). No route lists the raw table yet; ask for one with a CR |
| **Costs and receipts:** registration, renewal, sale, commission, tool and AI costs, adjustments, receipt pointers | `POST /buy`, `POST /sold/{domain}`, the reconciler (money rows); `POST /ledger/costs` (tool, ai, adjustment); `PUT /portfolio/{domain}/forward-costs` (planned costs) | `GET /books.csv`, `GET /ledger`, `GET /costs/forward`, `GET /portfolio/{domain}`, `GET /report` |
| **Decisions** (company decision ids, D-...) | `POST /decisions` (a record only; a correction is a new id with `supersedes`) | `GET /decisions`, `GET /decisions/{id}` |
| **Knowledge base:** sources, claims, evidence, questions and their verdicts | `POST /kb/*` | `GET /kb/*` |
| **Market sales** (public sale reports) | `POST /data/sales` (add-only) | `GET /market/episodes`, `GET /market/matched`, `GET /market/coverage`, `GET /market/dq`, `GET /engine/rows` |
| **Offers and sales of our names** | `POST /offers`, `POST /offers/{id}/outcome`, `POST /sold/{domain}` | `GET /offers`, `GET /report/offers`, `GET /portfolio/{domain}` |
| **Who changed what** | every authenticated POST/PUT writes one audit row (token name, scope, `X-Bot-Name`, `X-Caller`) | `GET /audit` |

## Offline copies

`GET /books.csv` and `GET /export/afternic.csv` are **exports of DOM data**, produced on request. They are not a write path: the API accepts no file posted back, and a changed export file changes nothing in DOM (CR084-AT4). `GET /books.csv` is the offline mirror of the books; there is no separate ledger-mirror route (CR-084 question 1).

## Removed dual writers

- Company-box CSVs no longer carry BIN, floor, walk-away or min offer as a record (CR-084 R-3). The bots stop writing them. DOM has no route to do it for them.
- Sedo is off for new work (CR-085, 27 Oct 2026): a new listing never makes a name pending for a Sedo export. Existing Sedo records stay as they are.
