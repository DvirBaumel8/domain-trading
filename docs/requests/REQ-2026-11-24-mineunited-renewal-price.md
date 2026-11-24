# REQ 2026-11-24: Renewal price for mineunited.com (D-005), for `/budget`

**From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code). Data only, no code.

`DOM-TO-GAVRIEL.md` item 2 asks for the yearly renewal price of mineunited.com at GoDaddy. Until it's set, `/budget` answers `unknown` (`renewal_price:mineunited.com`).

**Fact (from Gavriel, 24 Nov 2026):** mineunited.com renews at GoDaddy for **₪80 a year**.

**Ask:** in `data/state.json`, set `renewal_cents: 2393` on D-005. That is ₪80 at the Bank of Israel representative rate of 3.343 ILS per USD, published 23 Nov 2026 (https://boi.org.il/PublicApi/GetExchangeRate?key=USD). If the contract lets you add a note, add "₪80/yr, BoI 3.343, 2026-11-23". This is not a ledger row: nothing was paid.

No money action. Not a renewal approval: renewing still needs Dvir's yes.
