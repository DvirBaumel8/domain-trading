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
