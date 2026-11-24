# Endpoints (contract v7.3.1)

All are `GET`. Amounts come as `x_cents` and a display string `x`.

| Route | Answer |
|---|---|
| `/health/ping` | No token. `{status, version, commit}` |
| `/health` | `{status, version, commit, registrars, keys_set, domains, ledger_rows}`. `keys_set`: for each source, whether the server has its key |
| `/check?domain=` | The price now: `{domain, check_id, checked_at, availability, rdap, web_risk, winner, quotes, warnings}`. `web_risk`: `{status, threat_types, checked_at, error_code}`; `status` is `clean`, `flagged`, `missing_key` or `error`, and only `clean` means clean (`http://` and `https://` both checked; at most 1,500 lookups a day). `availability` is `available`, `taken` or `unknown`; `winner` is null unless available. Answers are reused for 60 seconds |
| `/portfolio` | `{domains: [{domain, display_name, deal_id, registrar, expiry_date, status, buy_date, renewals_used, cost_cents, cost, sold_for_cents, sold_for, renewal_cents?, do_not_renew_since?}]}`. `status`: `owned`, `sold`, `dropped`. `cost` = purchase + renewals + other costs and adjustments of that name |
| `/portfolio/{domain}` | The same for one name, plus `ledger` (its rows) |
| `/ledger` | `{entries: [{id, date, type, domain, amount_cents, amount, note, approval, source?}], total_cents, total}`. `type`: `purchase`, `renewal`, `cost`, `sale`, `adjustment`. `approval`: `{approved_on, ref}` or null |
| `/report` | `{domains_owned, domains_sold, max_domains, spent_cents, spent, sales_cents, sales, net_cents, net}` |
| `/budget?price_cents=&fee_cents=&renewal_cents=&source=&open_bids=` | Does this name fit the caps? All five are required. `source`: `auction`, `closeout`, `fixed_price`, `registration`. `open_bids`: `none`, `unknown`, or every **other** open bid at its maximum as `all_in_cents:renewal_cents:source`, separated by commas. Answer: `{status, over, unknown, all_in_cents, spent_cents, year2_reserve_cents, open_bids_cents, committed_cents, max_total_cents, max_per_name_cents, closeout_pilot_cents, max_closeout_pilot_cents, slots, max_slots, …}` |
| `/registrar-status` | Porkbun and GoDaddy, live: `{checked_at, domains: [{domain, registrar, status, error, expiry_date, recorded_expiry_date, expiry_matches, auto_renew, locked, nameservers}]}`, one row for every owned name. `status`: `ok`, `missing_key`, `error`; then the other fields are null and `error` is `{source, reason, http_status, source_code}` |
| `/listings` | Our Afternic listings: `{checked_at, listings: [{domain, list_status, hidden, fast_transfer_status, lease_to_own, leads, views, buy_now_cents, floor_cents, min_offer_cents, …}]}` |
| `/sales` | Our Afternic sales since 1 Oct 2026: `{checked_at, sales: [{domain, status, sale_type, sold_at, disbursed_at, price_cents, commission_cents, …}]}` |
| `/auctions?domains=a.com,b.com` | GoDaddy Auctions now, 1 to 50 names: `{checked_at, auctions: [{domain, for_sale, listing_id, listing_type, ends_at, price_cents, next_bid_cents, renewal_cents, transfer_cents, …}]}`. It cannot list our bids: GoDaddy has no such call |
| `/trademarks/{serial}` | One USPTO record by its 8-digit serial number: `{checked_at, serial, mark, status, status_date}`. No word search, so it never clears a name |

## The budget rules
- `all_in` = price + one listed renewal + fees (GoDaddy charges the first year with the price).
- `year2_reserve` = one renewal for every owned name, every open bid and the candidate. None for a name marked `do_not_renew_since`, or one already renewed.
- `committed` = spent + `year2_reserve` + open bids + `all_in`. A sale adds no room.
- `over` lists the caps that break: `total` ($1,500), `per_name` ($250 on `all_in`), `slots` (40: owned + open bids + this one), `closeout_pilot` ($300 for closeouts bought and open; MineUnited.com counts).
- `status`: `within` only when everything is known. `unknown` names what is missing (`open_bids`, `renewal_price:<name>`). `over` can be said from the known part alone.
- `within` is not an approval: a buy needs Dvir's yes on that name.

**A failing source is never an empty or good answer.** `/listings`, `/sales`, `/auctions` and `/trademarks` answer 503 `SOURCE_KEY_MISSING` without a key and 502 `SOURCE_ERROR` otherwise, with `details: {source, reason, http_status, source_code}`. `reason`: `KEY_MISSING`, `TIMEOUT`, `NETWORK`, `HTTP_ERROR`, `BAD_RESPONSE`, `NOT_IN_ACCOUNT`, `DAILY_LIMIT`.

| Source | Render environment keys |
|---|---|
| Porkbun | `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` (a read-only key is enough) |
| Web Risk | `GOOGLE_WEB_RISK_API_KEY` |
| GoDaddy domains | `GODADDY_DOMAINS_PAT` (scope `domains.domain:read` only) |
| GoDaddy Auctions | `GODADDY_API_KEY`, `GODADDY_API_SECRET` |
| Afternic | `AFTERNIC_API_KEY`, `AFTERNIC_API_SECRET` |
| USPTO TSDR | `USPTO_API_KEY` |
