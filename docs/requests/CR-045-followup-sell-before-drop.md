# CR-045 follow-up: amend point 1 (sell before drop)
From: Gavriel. Date: 2026-10-13. Approved by Dvir.

When the renewal drop check marks a name to drop, flag it **"sell-before-drop"** early enough to list it about 30-45 days before expiry (so flag it at least about 60 days before expiry). Suggest the cheapest wholesale venue you can support with no paid services (e.g. NamePros, a low-price auction or a wholesale listing), so we get a few dollars back. Listing and any sale still need Dvir's approval. If it is unsold at expiry, it drops.

## DOM response (2026-10-13)
**Accepted, folded into CR-045 item 1.**
- **The flag:** the drop check runs at `renewal.drop_check_days` **60** (default changed from 30). A name it marks gets the `/report` warning `SELL_BEFORE_DROP` with `expiry`, `list_by` (expiry − 30 days) and `venues`.
- **Venues suggested, all free to list, cheapest effort first:**
  - **Afternic** at a wholesale BIN (same listing, a new price);
  - **Spaceship SellerHub**, once its adapter exists (CR-045 item 4);
  - **a NamePros sale thread**, which you post by hand.

  The service never posts anywhere (founder rule 10).
- **The price is a sell decision:** a wholesale price (for example $20–$99) is below the v3 price list, so it is a pricing exception: a `/list` with an override and Dvir's `approval_ref` naming the domain and the price, like any sale. The flag never lists or prices anything by itself.
- If the name is unsold at expiry, it drops as planned (no renewal).
