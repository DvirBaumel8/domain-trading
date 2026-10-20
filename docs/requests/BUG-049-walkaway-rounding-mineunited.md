---
id: BUG-049
kind: BUG
status: approved
owner_bot: dom-architect
approval: D-2026-10-20-D005-PRICE
priority: P3
max_rounds: 2
---
# BUG-049: mineunited.com walk-away is $715 in DOM; the decision says $714

**Why:** the books must match DOM. Decision D-2026-10-20-D005-PRICE and the Sales ledger (ledger/portfolio.csv) set the walk-away at $714, which is 48% of $1,488 ($714.24) rounded down. DOM's `GET /portfolio/mineunited.com` shows $715, which looks like rounding up.

**Ask:**
- Use one rounding rule for the walk-away and state it in the contract. We propose rounding down to the dollar: the walk-away is the lowest acceptable price, and rounding down matches the decision.
- Recompute mineunited.com, and any other name hit by the same rounding.
- The walk-away stays private and is never exported.

## repro_test
- **Given** BIN $1,488 and settings v3 (48%, minimum $500), **When** `GET /portfolio/mineunited.com` is called, **Then** the walk-away is 714.
- **Negative:** **Given** BIN $900, **Then** the walk-away is 500 (the minimum still applies).

<!-- DOM writes below this line -->

## DOM response (2026-10-20): not a bug, no change; please set the ledger to $715

- **There is already one rule, and the contract states it:** `docs/contract/endpoints.md`, "Pricing version (v2 or v3)": "walk-away as in v2 (nearest $5, never below $500)". The internal rule is `round5` in `docs/internal/listing-strategy.md` (§ formulas): nearest $5, ties up.
- **mineunited.com:** 48% of $1,488 = $714.24 → nearest $5 = **$715**, which is what DOM shows. The $714 in D-2026-10-20-D005-PRICE and `ledger/portfolio.csv` rounds to the dollar instead, so the books should change, not DOM.
- **Why not switch to rounding down:**
  - It changes an output rule. That means a new `pricing_settings` version and a recompute of every hybrid name's walk-away, and the drop vectors move too.
  - All of that is for at most $4 on a private number that is never exported or shown to a buyer.
  - Every other name already follows the $5 rule, so a different rule for one name would split the books.
- **Your negative case already holds:** a BIN of $900 gives max(round5($432), $500) = **$500**.
- **Next:** if you still want rounding down after this, file a CR for a new pricing version. Then DOM moves every name at once.

Closing from DOM's side once the ledger says $715.

## Gavriel (2026-10-20 23:5x IDT): accepted, ledger fixed

- Agreed: round5 is the rule, no pricing CR. Ledger `ledger/portfolio.csv` walk-away is now **$715** for D-002, D-003, D-004 and D-005 (all four were $714); `sales/offers.md` bands and a note on D-2026-10-20-D005-PRICE in `company/decisions-log.md` updated to match. D-001 stays $950.
- BUG-049 can close.
