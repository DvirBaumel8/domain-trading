# CR-124: Dropshipping approval records, separate ledger and $1,000 cap, standing auto-buy envelope

**Status:** Filed 24 Nov 2026. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** 24 Nov 2026, 23:09 IST, through Gavriel: hand Phase 1 of the dropshipping plan to DOM, the founder-rule exceptions in plan §3, and the standing auto-buy envelope.
**Spec:** `docs/requests/dropship/dom-plan-v1.md` (a copy of the plan; this CR wins where they differ).

This request does not authorize any listing, CJ purchase, price change, wallet top-up, or outside message. The domain line (CR-116, CR-117, `data/state.json`, the $1,500 cap) is unchanged. Do not print keys or tokens. This repo is public: no buyer name, address, phone, email or raw eBay user id in git, logs, test fixtures or API responses. Tests are the contract; at most two review rounds. The eBay developer account is still pending approval, so there are no real keys yet: build against the official docs, with mocks and fake values.

## Ask (plan §4.4 and §4.5, plus Dvir's envelope decision)

1. Create a new file, `data/dropship-state.json`, on main: append-only and CI-checked like `data/state.json`, and separate from it.
2. **Action rows** with `id`, `type` (`list`, `reprice`, `delist`, `fulfill`, `cj_wallet_topup` or `cost`), `sku`, cents, `created_on`, `expires_on`, `status` and `approval: {approved_on, ref}`. Bots never mark an action approved. One-shot approvals expire after 72h.
3. **Standing auto-buy envelope (Dvir, 24 Nov 23:09 IST).** A `list` approval carries `fulfill_envelope_cents` for that SKU. While the offer is live, a sale may be bought on CJ automatically only when all of these hold: CJ cost plus freight is at or below the envelope, the quantity is what was sold, it ships from the named US warehouse, stock is enough, and the $1,000 cap still has room. Above any of those, the job stops and opens an `awaiting_dvir` action, which goes to Dvir through Gavriel. **In Phase 1, record and check the envelope only.** The auto-fulfill job itself is Phase 2, a later CR. Until then the first order is handled by hand, as the plan says.
4. **Ledger rows** with the types from plan §4.5, signed cents. A payout or sale never lowers `spent` and never raises the cap. Rows are never edited; mistakes are fixed with adjustment rows. Notes must be public-safe: SKU, order id and amounts only.
5. Reads: `GET /dropship/actions`, `/dropship/actions/:id`, `/dropship/ledger` and `/dropship/report`. No POST routes.

## Tests

- An executed money row without a valid approval, a rewritten past row, or an execution after expiry fails CI. A live envelope is the only exception to expiry.
- A cost one cent over the envelope, or one that breaches the cap, is refused and opens `awaiting_dvir`.
- `cj_wallet_topup` never executes without its own approval row.
- Dropship rows never change the domain ledger or `/budget`. The $1,000 and $1,500 caps are independent.
- No approval wording, secrets or PII in the file.
