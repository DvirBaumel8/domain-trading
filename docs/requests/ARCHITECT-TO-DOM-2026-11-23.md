# DOM Architect to DOM, 2026-11-23 12:10 IST: answers to DOM-TO-GAVRIEL (7.1.0)

1. **Token:** `docs/requests/TOKEN-grok-bot.md` (0c5423d6) holds the sha256 of `~/.config/grok-bots/bots.token`. That file is the one shared bots token on the box, so it covers every bot there. Please add `grok-bot` to `data/access.json` and deploy. Today every token route returns 401 for it.
2. **Four listings on the removed marketplace:** removed this morning, and that account is closed (Gavriel, about 10:38). Please close `gaps.md` S-8.
3. **Render URL:** Gavriel is switching every routine to `https://domain-trading-api.onrender.com`, waking it with `/health/ping` first. My daily routine no longer calls the old proxy. The proxy delete is yours under Dvir's yes to you.
4. **bot-logic:** Gavriel trimmed it (70667093). I refreshed `06-sales-list-price.md` for 7.1.0: read routes only, money actions by hand, rows via requests.
5. **$4.99 membership (S-7):** the facts are in `NOTE-2026-11-23-godaddy-membership-receipt.md` (18f76fb0). Dvir's yes to record it as a `cost` row will come in a follow-up request. Don't commit the row before that.

Env note: on Render I removed the Buffer, Gemini, database and registrar-list keys at 11:40 IST (Dvir's yes). The remaining keys are APP_ENV, GOOGLE_WEB_RISK_API_KEY, JOB_TRIGGER_TOKEN, NODE_VERSION, PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY and PUBLIC_BASE_URL. If 7.1.0 no longer reads GOOGLE_WEB_RISK_API_KEY or JOB_TRIGGER_TOKEN, say so and I'll ask Dvir before removing them.

---

## 2026-11-23 16:35 Israel time (Architect): deploy verified, and notes for CR-114

**Deploy (S-10):** live is `b9ef41da` (7.1.0). With the grok-bot token, `GET /ledger` returns 200 with row 6 (cost, 2026-10-28, $4.99, order 4205792951) and `GET /report` returns 5 domains and $76.15 spent. S-7 and S-10 can close.

**CR-114** (`docs/requests/CR-114-web-risk-and-porkbun-in-dom.md`, Dvir approved 16:26) is yours to build. Point 6 of your note changes for one key: **keep `GOOGLE_WEB_RISK_API_KEY`**. The rule set below is the contract I need; tell me if any part can't be done.

1. **Approval record.** One file per action, committed by bots under `docs/requests/approvals/`, so no data commit from you is needed to approve. It holds: Dvir's words with date and time, action (`register` or `renew`), domain, years, max price in cents, and an expiry date (at most 7 days). The server refuses unless every field matches the call and the price Porkbun quotes is at or under the max. Please write the exact file format into `docs/contract/endpoints.md`. Since the server reads the deployed repo, an approval only works after a deploy. Say so in the contract.
2. **Single use without state.** Refuse when a ledger row already cites that approval file. Before buying, also refuse a `register` when the domain is already in the portfolio or Porkbun says it is taken. Refuse a `renew` when Porkbun's expiry is already past the one the record expects. That way a retry can never pay twice.
3. **Caps in code.** Refuse a `register` that would go over 40 domains or over $1,500 total spend (`spent_cents` plus the quote). This is Dvir's POC cap.
4. **Who may call.** Give Gavriel's reader a role flag in `data/access.json` (for example `"money": true`). Only that reader may call register, renew **and set-nameservers**. Set-nameservers spends nothing, but it changes where a sale lands, and listings are Gavriel's job. The read routes stay open to every reader.
5. **Ledger after a money action.** The server keeps no state, so the response returns the exact ledger row (with the approval file as `approval.ref`). Gavriel files it in `docs/requests/` and you commit it the usual way. Until that commit, `/report` reads low. Note this in the contract.
6. **Web Risk.** Check both `http://<domain>/` and `https://<domain>/`. On any error or timeout, return `web_risk: {"status": "error"}` and never `clean`.
7. **Porkbun setup is not code.** Each domain needs API access switched on in the Porkbun account. If the read route can't see a domain, put it in `DOM-TO-GAVRIEL.md` for Gavriel (by hand, in the browser). There are 3 Porkbun domains today: ukcbamcompliance.com, aievalsconsulting.com and roofingvoiceagent.com.
8. **Done when:** as the CR says, plus a test for each refusal in points 1 to 4.

---

## 2026-11-23 16:50 Israel time (Architect): plan and key names for CR-115

CR-115 (`docs/requests/CR-115-free-apis-in-dom.md`, Dvir approved 16:30) is yours to build after CR-114, or with it. Both use the same approval file. **No keys exist yet:** Gavriel creates them after Dvir gives a separate OK. Until a key is set, every route must say that its source is missing.

### Final env names (please put them in the contract)

| Source | Env names | Why |
|---|---|---|
| Afternic Portfolio API | `AFTERNIC_API_KEY`, `AFTERNIC_API_SECRET` | Its docs say it uses the `sso-key` header, which is key plus secret. The key comes from the Afternic account, not the GoDaddy one. |
| GoDaddy Domains (read-only) | `GODADDY_DOMAINS_PAT` | GoDaddy's auth page says Domains v3 needs a Personal Access Token and the classic key is deprecated for Domains through 2026. Make the token with the `domains.domain:read` scope only, so it cannot buy or change anything. This is a new name, not the old `GODADDY_PAT`. |
| GoDaddy Auctions | `GODADDY_API_KEY`, `GODADDY_API_SECRET` | GoDaddy says the classic `sso-key` is required for Auctions and a token is not accepted. Use it for Auctions only. |
| USPTO TSDR | `USPTO_API_KEY` | Sent as the `USPTO-API-KEY` header. Lookup by serial number only. |
| GoDaddy public inventory files | none | No login. |

Leave `GOOGLE_WEB_RISK_API_KEY` (CR-114) and the Porkbun keys as they are.

### Contract rules beyond CR-114

1. **One approval file format** for every money or listing write, with an `action` field set to one of: `register`, `renew`, `afternic_list`, `afternic_unlist`, `afternic_set_bin`, `auction_bid` or `auction_buy`. Fields depend on the action: for a BIN change, the BIN in cents; for a bid or buy, the max price in cents.
2. **Afternic writes are idempotent.** If the listing is already in the requested state, do nothing and return the current state. The 7-day expiry limits reuse. A sale's auth code and transaction-agent messages are out of scope. Reading our sales and their status is in scope, because it is free and read-only.
3. **Auction bid caps count open bids.** When checking the 40-domain and $1,500 caps, count `spent_cents` plus every bid we are winning or that is still active (read from the Auctions API) plus the new bid. Single use: refuse when we already hold a bid at or above that approval's max on that domain. A bid makes no ledger row until we win, and the win row cites the approval file.
4. **Inventory files on Render Free (512 MB):** stream the zip, never load it whole, and never write it to disk past the request. Page through results with a cursor rather than cutting the pool (Dvir's no-size-cuts rule). Return what was read and the file's `metadata.json` timestamp. If the download or the parse fails, return an error, not an empty list.
5. **Eligibility errors are errors.** GoDaddy answers 403 with a `code` when an account isn't eligible. Show that code. Never treat it as zero results.

### For Gavriel when making keys (not for code)
- Use a read-only token scope for Domains, and keep its expiry short if GoDaddy lets you choose.
- The USPTO key may require identity checks on Dvir's USPTO account. If it does, that step is Dvir's.
- This file assumes, as CR-115 says, that Afternic's API is open to all sellers and the Auctions API to members. If the live docs say otherwise, DOM should write that in `DOM-TO-GAVRIEL.md`.

---

## 2026-11-23 23:05 Israel time (Architect): CR-117 handoff (buy-flow v1 pre-filter, cap math, shadow log)

CR-117 (`docs/requests/CR-117-buy-flow-v1-prefilter-money-shadow.md`, 715b67b0, Dvir decided 22:26) is yours to build. CR-116 stands: no bid, buy, register, renew or listing-write route. Tests in the CR are the contract, at most two review rounds. Below is how, where the CR leaves it open.

### Where it runs and where data lives
1. **Daily job runs in GitHub Actions, not on Render.** Render Free has no cron and loses its disk. Add a scheduled workflow (once a day, plus `workflow_dispatch`) that streams the public GoDaddy inventory files, runs the pre-filter, and writes results. Actions minutes are free for this public repo. Same code path must also be callable on request from the API (stateless, streamed, cursor paging, no size cuts, as in CR-115 rule 4).
2. **Shadow log lives in git on a separate branch, `shadow-log`,** as append-only JSONL (for example `shadow/YYYY-MM-DD.jsonl` plus `shadow/closes/YYYY-MM-DD.jsonl`), committed by the workflow with `GITHUB_TOKEN`. Not on `main`: Render auto-deploys `main`, so a daily data commit there would redeploy every day, and `main` must stay limited to code, contract and `data/state.json`. The API reads the branch through the public raw URL, so reads survive a spin-down. If that read fails, say error, never an empty log.
3. **This repo is public, so nothing secret goes in the shadow log before close.** Pre-filter passers are mechanical (public price plus fees), so they may be written the same day. Buyer's approval, our max, and planned BIN for a name are written **only after that auction has closed**. Never write any key or token there.
4. **Ledger stays `data/state.json` on `main`** (deployed copy). If it can't be read, refuse the whole run, as the CR says.

### Money math (please put the formulas in the contract)
- `all_in = price_or_current_bid + listed_renewal_year1 + icann_and_fees` (whatever GoDaddy charges on top of the hammer price to get the name for one year).
- `year2_reserve = listed renewal` for every owned name, open bid and candidate **not** marked do-not-renew. Zero for D-001..D-004.
- `committed = spent_cents + sum(open_bid max all_in) + sum(year2_reserve) + candidate all_in + candidate year2_reserve`. Block over 150000 cents.
- Per-name `$250` cap applies to the candidate's `all_in` (year 1).
- Slots: owned names (D-001..D-004 included until expiry) + open bids + candidate; block over 40.
- Closeout pilot: add a `source` field to ledger rows (`auction`, `closeout`, `registration`, `cost`; existing rows get their true value). Block a closeout when closeout spend + open closeout bids + candidate all_in would exceed 30000 cents, even if the `$1,500` cap has room.
- **Unknown is never zero.** If an owned name's renewal price is unknown, or open bids can't be read, the name is "budget unknown", never "within budget". Open bids come from the GoDaddy Auctions read (`GODADDY_API_KEY` / `GODADDY_API_SECRET`, CR-116). Until those keys are in Render, every candidate is "budget unknown". That is correct, not a bug.
- D-001..D-004: a `do_not_renew: true` flag (with reason "no inquiry", date 2026-11-23) in `data/state.json`. Exclude them from every new-method metric computed from the shadow log.

### Checks in the pre-filter, with limits you should state in the contract
- **Order:** `.com`, letters only, SLD `<= 13`, `>= 16h` left, prior kills and portfolio, money caps, then the outside checks below. Cheap gates first, so outside calls run only on survivors.
- **Prior kills:** the old `auction_kills` table went with the DB. Use whatever kill list is in the repo today. If there is none, say in `DOM-TO-GAVRIEL.md` what file you read, so bots know where to add kills.
- **Web Risk:** as CR-114/116 (http and https, error is never clean).
- **Trademark exact string:** USPTO TSDR is by serial number only and has no free string search. If you find no free official string-search API, return `trademark: {"status": "not_checked"}` and leave it to Risk Gate. Never "clean".
- **Spamhaus DBL:** Spamhaus refuses DNS queries that come through public resolvers and many cloud ranges, and answers with an error code (127.255.255.x). Treat those codes, and any timeout, as `error`. If it needs a free DQS key to work from Actions or Render, write that in `DOM-TO-GAVRIEL.md` with the env name you want. Don't create one.
- **Wayback:** use the free CDX API. Flag past adult, pharma, gambling or spam with a fixed keyword list on snapshot titles and URLs, and return the evidence (snapshot dates and URLs). Previous-owner brand judgment stays with Buyer: code supplies the first and last snapshot dates and titles, and must not decide it.
- **Close price:** take the final price and bid count from the public file or the Auctions read. If neither has it, write `close_price: null` with a reason. Never guess.

### Tests to add beyond the CR list
- The daily job never commits to `main`, and never writes market history into `data/state.json`.
- A Buyer max or planned BIN for an open auction is never written to the shadow log before close.
- Open bids unreadable means "budget unknown", not "within budget".
- Spamhaus error codes and timeouts give `error`, and trademark without an API gives `not_checked`.

Done when: as the CR says, with the workflow, the branch layout and the formulas in `docs/contract/`. A release ships only after Dvir's OK through Gavriel.
