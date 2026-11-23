# Endpoints (contract v7.1.0)

All are `GET`. Amounts come as `x_cents` and a display string `x`.

| Route | Answer |
|---|---|
| `/health/ping` | No token. `{status, version, commit}` |
| `/health` | `{status, version, commit, registrars, domains, ledger_rows}` |
| `/check?domain=` | The price now: `{domain, check_id, checked_at, availability, rdap, winner, quotes, warnings}`. `availability` is `available`, `taken` or `unknown`; `winner` is null unless available. Answers are reused for 60 seconds |
| `/portfolio` | `{domains: [{domain, display_name, deal_id, registrar, expiry_date, status, buy_date, renewals_used, cost_cents, cost, sold_for_cents, sold_for}]}`. `status`: `owned`, `sold`, `dropped`. `cost` = purchase + renewals + other costs and adjustments of that name |
| `/portfolio/{domain}` | The same for one name, plus `ledger` (its rows) |
| `/ledger` | `{entries: [{id, date, type, domain, amount_cents, amount, note, approval}], total_cents, total}`. `type`: `purchase`, `renewal`, `cost`, `sale`, `adjustment`. `approval`: `{approved_on, ref}` or null |
| `/report` | `{domains_owned, domains_sold, max_domains, spent_cents, spent, sales_cents, sales, net_cents, net}` |
