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
