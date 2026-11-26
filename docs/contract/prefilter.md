# The daily pre-filter and the shadow log (CR-117)

A GitHub Actions job (`.github/workflows/prefilter.yml`, once a day after 15:00 UTC, or by hand after that hour; GitHub starts it hours late on some days, so wait for `runs/DATE.json`). It reads GoDaddy's public inventory files, drops what fails fixed rules, and logs the rest. It judges nothing and buys nothing. It is not a route: the files are too big for the Render server.

## Where the log is
Branch `shadow-log` of this repo, one file a day (UTC date), read by raw URL, so it does not depend on Render:
`https://raw.githubusercontent.com/DvirBaumel8/domain-trading/shadow-log/runs/YYYY-MM-DD.json`

| File | Inside |
|---|---|
| `runs/DATE.json` | The day's counts: read, dropped by reason, killed with the evidence, logged, totals. Written last: **no file = no complete run that day, never "no names"** |
| `shadow/DATE.jsonl` | One line a name: `domain, source, auction_id, logged_at, file_built_at, ends_at, price_cents, bids, age, exact_match_tlds, developed_tlds, budget, checks, open_checks`. `checks` = `web_risk, history, exact_name, trademark, spamhaus` |
| `closes/DATE.jsonl` | The day after: `domain, source, logged_at, last_price_cents, last_bids, seen_at, final, reason` |

**The log is public.** Never put our maximum, planned price or Buyer's view in it. Gavriel keeps those.

## The gates, in order
1. `.com`, letters only, at most 13 letters.
2. Auctions (`auctions_ending_tomorrow`): at least 16 hours left and **at least one bid**. Each auction is seen once, the day before it ends.
   Closeouts (`closeout_listings`): $5 to $11, the same name live on at least 3 other endings (`developedTlds`), at least 5 years old. They usually end the same evening.
3. Not adult by GoDaddy's mark, not a name of ours, not in `docs/requests/kills.txt` (bots add lines there), not logged in the last 14 days.
4. Not over a cap on the price alone. The files have no renewal price, so a logged name is always `budget: unknown`: ask `/budget` for a finalist.
   **Name quality** (last of the cheap gates, pure code, before any outside call; reasons in `dropped`):
   - `person_name`: a given name beside a trade word (`joeplumbing`), or beside a family name when the name is not plain words (`danielmooney`). A name that is plain words is never a person.
   - `local_business`: a city, state or local abbreviation beside a trade word (`houstonmarina`, `sflroofing`).
   - `not_plain_word`: the name is not one dictionary word, or two, or three (`xwsy`, `qynaps`).
   Lists in `src/prefilter/lists/` (sources and licences in the header of `src/prefilter/names.ts`): SCOWL words, US SSA given names, hand-written places and trades. Unclear names stay in. No cap on how many are left.
5. Web Risk: `flagged` is killed. `missing_key` and `error` stay open, never clean.
   Then, on every name left, **the exact-name search**: is there already a company, product or app with this name? Source: DuckDuckGo's HTML search (`html.duckduckgo.com/html/`), no key, no cost, about one request a second, two queries (the name and `"name"`), title, address and snippet only. A result counts as the same name when its site is the name on another ending (`name.net`) or its title starts with the name; the name's own `.com` and explainer sites do not. A hit is **killed** (`by: "exact_name_search"`, with up to 3 title and address pairs) and not logged. The page is unofficial and can change or rate-limit: no readable answer, a timeout, a block or no adapter is `error` / `not_checked`, **never clean**, and the name stays with `exact_name` in `open_checks`; after 5 failures in a row the rest of the run is an error. No cap on how many names are searched. `exact_name.status` is `no_hit`, `error` or `not_checked`. It runs after Web Risk and before Wayback.
6. Wayback addresses (not page text): two different ones with an adult, pharma, gambling or spam word kill, one is `suspect`. `no_hits` is not "clean". `partial` = more than 300 pages. The archive is slow: after 40 minutes the rest is `not_checked`, auctions with most bids go first.

`open_checks` lists what a bot still has to do; it always has `budget`, `trademark` (USPTO has no word search by API) and `spamhaus` (its free lists are for non-commercial use only, so it is not called). The previous owner's brand is Buyer's check.

## Prices after the end
No public file has a final price. `closes` has the last price seen on the closing day, a few hours before the end, always `final: false`; a later bid is not in it. Gavriel reads the final price of Buyer's picks.

## When it refuses
An unreadable ledger or kill list, or a file that is missing, cut, empty, changed or over 12 hours old: nothing is written and the run fails.
