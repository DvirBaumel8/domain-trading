> **PAUSED by Dvir 24 Nov 2026 23:17 IST, do not build.** Wait for a go from Dvir through Gavriel.

# CR-123: Dropshipping break-even, hard filters and budget reads

**Status:** Filed 24 Nov 2026. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** 24 Nov 2026, 23:09 IST, through Gavriel: hand Phase 1 of the dropshipping plan to DOM, the founder-rule exceptions in plan §3, and the standing auto-buy envelope.
**Spec:** `docs/requests/dropship/dom-plan-v1.md` (a copy of the plan; this CR wins where they differ).

This request does not authorize any listing, CJ purchase, price change, wallet top-up, or outside message. The domain line (CR-116, CR-117, `data/state.json`, the $1,500 cap) is unchanged. Do not print keys or tokens. This repo is public: no buyer name, address, phone, email or raw eBay user id in git, logs, test fixtures or API responses. Tests are the contract; at most two review rounds. The eBay developer account is still pending approval, so there are no real keys yet: build against the official docs, with mocks and fake values.

## Break-even formula (updated from the plan, per expert research 24 Nov)

The plan's `(cost + ship + $0.40) / 0.864` is replaced by a config-driven formula. All values are integer cents or basis points, with no floats:

- `fee_base = list × (10000 + sales_tax_bp) / 10000`. eBay charges its fees on the total including sales tax.
- `fees = fee_base × (fvf_bp + intl_fee_bp) / 10000 + fixed_cents`
- `returns_reserve = list × returns_reserve_bp / 10000`
- `be_cents` is the smallest whole-cent `list` where `list − fees − returns_reserve ≥ cost_cents + ship_cents`. Compute it by an exact integer search or a closed form with ceil, and test that one cent lower fails.

Config lives in a repo file. Bots may propose edits; DOM ships them. The starting values are proposals, and each carries a `confirmed: false` flag until it's read off the live seller account:
- `fvf_bp: 1360` (today's 13.6%)
- `fixed_cents: 40`
- `intl_fee_bp: 130` (about 1.3%; the tier for an Israel seller is **unconfirmed**)
- `sales_tax_bp: 1000` (a conservative 10% worst case)
- `returns_reserve_bp: 300` (a proposal)

`/dropship/quote` returns which values are still unconfirmed. Never drop a fee to make a product pass.

## Ask (plan §4.3)

- `GET /dropship/quote` (Bearer). Inputs: cost, freight (or `unknown`), competitor price (or `unknown`), product flags. Outputs: `be_cents`; `list_cents` (undercut the cheapest US offer, never below BE) or `skip` when the cheapest offer is at or below BE (we never sell at a loss); cap status `within`, `over` or `unknown`; and the filter failures. `within` is not an approval.
- **Hard filters in code, in a repo list file:** electronics, batteries, kids/children, a brand/VeRO denylist, and a skin-contact and fragile keyword denylist. The warehouse must be US, with stock of at least 10. Missing data never passes.
- `GET /dropship/budget`: spent, committed and remaining against **$1,000** (`MAX_DROPSHIP_SPENT_CENTS = 100_000`). Committed includes approved but unexecuted actions and the full value of every live standing envelope (CR-124). It has nothing to do with the domain `/budget` or the $1,500.

## Tests

- A worked example with the config above gives the exact cent, and one cent lower is rejected.
- Raising `sales_tax_bp` or `intl_fee_bp` raises BE.
- A cheapest competitor at or below BE gives `skip`. One cent above BE gives a list price at or above BE.
- An `unknown` freight or competitor price gives an `unknown` status, never `within`.
- A banned keyword, a non-US warehouse or stock under 10 is dropped.
- A quote that would push committed plus spent past $1,000 gives `over`.
- No floats anywhere in the money path.
