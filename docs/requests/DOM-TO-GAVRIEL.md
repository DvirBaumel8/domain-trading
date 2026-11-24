## 2026-11-24 06:30 (DOM): CR-116 is live in 7.2.0, except the inventory files

Checked live on Render (`d216ba52`): `/check` has `web_risk` (it answered `clean` for promptinjectionaudit.com; a flagged name was tested with fakes only). `/registrar-status` reads the three Porkbun names: auto-renew **off**, locked, Afternic nameservers, expiry equal to our record. The other sources answer "missing key". Routes, errors and key names: `docs/contract/endpoints.md`. `GET /health` shows which keys are set.

1. **Keys still missing in Render:** `GODADDY_DOMAINS_PAT`, `AFTERNIC_API_KEY` + `AFTERNIC_API_SECRET`, `USPTO_API_KEY`. Their answers are built from the official docs and not tried live; tell DOM when each is set and DOM checks it. Until the PAT is set, auto-renew of mineunited.com and promptinjectionaudit.com is unknown.
2. **Please hold `GODADDY_API_KEY` + `GODADDY_API_SECRET` (Auctions).** By GoDaddy's docs the same classic key can bid and buy with a saved payment method, and they show no read-only form. Dvir: no money spending from the app. DOM asks Dvir. Do not save a payment profile for it.
3. **The Afternic key can change listings** (its docs show no read-only key). The app has no call that does. Dvir should know before it is made.
4. **Porkbun:** its keys can be limited to the `read` permission. Please replace the key in Render with a read-only one, with Dvir's yes; then nothing there can buy.
5. **GoDaddy has no call that lists our bids** (the Auctions API has availability, bid, payment profile and purchase only). The CR-117 plan to read open bids through it does not work.
6. **Inventory files moved to CR-117's daily job.** The closeouts alone are 327 MB of JSON, and each page of an API answer would read the file again on Render's free server.
7. **CR-117:** not started; Dvir wants CR-116 finished first. Its ledger baseline should be $76.15.

## 2026-11-23 16:42 (DOM): CR-114 and CR-115, Dvir's decision

Dvir, to DOM in chat today: **"no money spending from the app"**; founder rule 12 stays. This replaces the approvals quoted in both CRs for those parts.
- **Closed, not built:** register, renew, bid and buy routes, the approval files under `docs/requests/approvals/` and the `money` flag.
- **Also not built:** set nameservers, and listing add, update, remove and price. They spend nothing, so Dvir's line does not name them, but the app stays read-only and DOM adds no write route. Sales and nameserver steps stay by hand, with Dvir's approval.
- **Read parts:** built, see the 24 November entry.
- **$1,500 total cap: added** to founder rule 2 and `npm run check-state` (Dvir to DOM, 23 Nov). Every cost counts (the membership too); a sale adds no room. $76.15 is spent.
- **The repo stays public for now** (Dvir to DOM, 23 Nov).
- **Please note:** CR text that quotes Dvir is public.

Buying stays by hand: Dvir approves, Gavriel buys in the browser, a request here, DOM commits the row.

## 2026-11-23 16:40 (DOM): deploy

**Deploy (S-10): works while the repo is public.** Checked by DOM: the repo is public, changed at about 16:25 Israel time, 25 seconds before `b9ef41da` started deploying. DOM had written that it worked with the private repo; that was wrong. The stale lines in `CLAUDE.md`, `README.md` and `DEPLOYMENT.md` are corrected, as you asked.

## 2026-11-23 (DOM): answers to the Architect

**What exists now (7.1.0):** a read-only API with seven routes (`docs/contract/endpoints.md`) on `https://domain-trading-api.onrender.com`. State is `data/state.json`. Wake it with `GET /health/ping` and wait up to 180 s.

1. **The repo is public** (see above). Everything committed here can be read by anyone.
2. **Token:** `grok-bot` is in `data/access.json` and works; `TOKEN-grok-bot.md` is deleted.
3. **Membership (S-7):** ledger row 6 is live, 2026-10-28, $4.99, order 4205792951. Total $76.15, five domain rows unchanged.
4. **Four listings (S-8):** closed on your word.
5. **Render URL (S-3):** tell DOM when every routine has moved. DOM then deletes the old proxy.
6. **Render keys:** 7.1.0 reads none of `JOB_TRIGGER_TOKEN`, `APP_ENV` and `PUBLIC_BASE_URL`. All three can go, with Dvir's yes.
7. **Never Dvir's email in a file.** DOM took it out of the receipt note.

A purchase, renewal, cost or sale: a request here with Dvir's approval; DOM commits the row. Price drops are by hand (`docs/internal/pricing.md`).
