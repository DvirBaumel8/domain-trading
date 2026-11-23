> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-108 — Money and listing writes on the FileStore
| Field | Value |
|---|---|
| CR id | CR-108 |
| Series | S4 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. |
| Priority | P0 |
| Depends on | CR-105, CR-107 |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

Money and listing writes must go to the FileStore with the same approval, idempotency and fail-closed rules the API already has, and with CR-105's compare-and-swap. Only Gavriel does buys, sells and listings, with Dvir's OK. This CR does not perform any live money action.


## 2. Rules
- **R-1 (write routes on files): `POST /buy`, `/list/{domain}`, `/listings/{domain}/venue`, `/listings/{domain}/observed`, `/portfolio/{domain}/display-name`, `/offers`, `/offers/{id}/outcome`, `/sold/{domain}`, `/ledger/costs`, `PUT /portfolio/{domain}/forward-costs`, `/decisions`, `/auctions/prebid`, `/auctions/plans`, `/auctions/plans/{id}/result`, `/auctions/kills`, `/export/{venue}/uploaded`, `/outreach/emails`, `/portfolio/{domain}/renewal-price`, `/portfolio/{domain}/horizon`, `/portfolio/{domain}/stats`. Each uses the CR-105 FileStore. No database.**
- **R-2 (Dvir's yes): `/buy` (and any other money POST that already requires it) is refused without a fresh, in-window approval (max age 72 h). Nothing is written on a refusal.**
- **R-3 (idempotency): a replayed `Idempotency-Key` returns the original response, makes no second registrar call, and writes no second row.**
- **R-4 (crash after registrar, before commit): on boot, the reconciler finds an unmatched registrar order and writes the purchase/ledger row exactly once (same idempotency key).**
- **R-5 (atomic money): `/sold/{domain}` writes the sale row and the ledger `sale` row in one FileStore commit. `/buy` writes purchase, receipt (if any), ledger and audit in one commit.**
- **R-6 (caps from files): `max_domains` and spend-cap checks read `config/` and `state/ledger.csv`, not a database.**
- **R-7: no live buy, sell, list, or registrar call against production is part of this CR. Tests use fixtures and mocks.**

## 3. Acceptance criteria
- **AC-1 (MW-1): `POST /buy` without Dvir's approval, or with an approval older than 72 h → refused, FileStore unchanged.**
- **AC-2 (MW-2): replay the same `Idempotency-Key` on `/buy` → no second registrar call, no second row, original response.**
- **AC-3 (MW-3): simulate a crash after a successful registrar mock and before the FileStore commit → reconciler on boot writes the row exactly once.**
- **AC-4 (MW-4): `POST /sold/{domain}` writes the sale and the ledger row in a single commit (one new git sha); a mid-commit failure leaves neither row.**
- **AC-5 (MW-5): with `max_domains` at the current portfolio size, a further `/buy` is refused and nothing is written.**

## 4. Open questions for DOM
- Q1: none if CR-105's commit helper is reused as-is. If a write needs a different grouping than R-5, say so in the DOM response before shipping.

<!-- DOM writes below this line -->
