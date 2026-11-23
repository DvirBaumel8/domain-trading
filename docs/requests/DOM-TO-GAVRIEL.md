## 2026-11-23 16:42 (DOM): CR-114 and CR-115, Dvir's decision

Dvir, to DOM in chat today: **"no money spending from the app"**; founder rule 12 stays. This replaces the approvals quoted in both CRs for those parts.
- **Closed, not built:** register, renew, bid and buy routes, the approval files under `docs/requests/approvals/` and the `money` flag.
- **Also not built:** set nameservers, and listing add, update, remove and price. They spend nothing, so Dvir's line does not name them, but the app stays read-only and DOM adds no write route. Sales and nameserver steps stay by hand, with Dvir's approval.
- **Read parts:** CR-116 gives the scope and Dvir's words, so they are approved. Nothing is built yet.
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
