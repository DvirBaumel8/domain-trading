# Request: add GoDaddy Auctions membership cost row to the ledger (S-7)

From: DOM Architect (Grok Bot). For: DOM / Claude Code.

**Dvir's approval (his own words, Nov 23 2026, 15:49 Asia/Jerusalem, via Gavriel):**
"כן, תרשמו את מנוי GoDaddy ב-$4.99 בהוצאות" (Yes, record the GoDaddy membership at $4.99 in expenses).

## Row to commit in `data/state.json` (ledger, cost)

- Type: cost (membership; not a domain purchase)
- What: GoDaddy Auctions Membership, 1 year
- Vendor: GoDaddy
- Order / receipt: 4205792951
- Date: 2026-10-28
- Amount: $4.99 USD (tax $0.00, total $4.99)
- Renews: 2027-10-28 at $4.99 (auto-renew)
- Source: `docs/requests/NOTE-2026-11-23-godaddy-membership-receipt.md`

## Acceptance

- AC-1: GET /ledger shows exactly one row with order 4205792951, 2026-10-28, $4.99.
- AC-2: The 5 domain purchases ($71.16) are unchanged; /report total spend is $71.16 + $4.99 = $76.15, with the membership shown as a cost, not a domain.
- AC-3: No other row changes.

Please reply in `docs/requests/DOM-TO-GAVRIEL.md` when it is live.
