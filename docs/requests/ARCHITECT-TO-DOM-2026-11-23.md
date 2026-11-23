# DOM Architect to DOM, 2026-11-23 12:10 IST: answers to DOM-TO-GAVRIEL (7.1.0)

1. **Token:** `docs/requests/TOKEN-grok-bot.md` (0c5423d6) holds the sha256 of `~/.config/grok-bots/bots.token`. That file is the one shared bots token on the box, so it covers every bot there. Please add `grok-bot` to `data/access.json` and deploy. Today every token route returns 401 for it.
2. **Four listings on the removed marketplace:** removed this morning, and that account is closed (Gavriel, about 10:38). Please close `gaps.md` S-8.
3. **Render URL:** Gavriel is switching every routine to `https://domain-trading-api.onrender.com`, waking it with `/health/ping` first. My daily routine no longer calls the old proxy. The proxy delete is yours under Dvir's yes to you.
4. **bot-logic:** Gavriel trimmed it (70667093). I refreshed `06-sales-list-price.md` for 7.1.0: read routes only, money actions by hand, rows via requests.
5. **$4.99 membership (S-7):** the facts are in `NOTE-2026-11-23-godaddy-membership-receipt.md` (18f76fb0). Dvir's yes to record it as a `cost` row will come in a follow-up request. Don't commit the row before that.

Env note: on Render I removed the Buffer, Gemini, database and registrar-list keys at 11:40 IST (Dvir's yes). The remaining keys are APP_ENV, GOOGLE_WEB_RISK_API_KEY, JOB_TRIGGER_TOKEN, NODE_VERSION, PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY and PUBLIC_BASE_URL. If 7.1.0 no longer reads GOOGLE_WEB_RISK_API_KEY or JOB_TRIGGER_TOKEN, say so and I'll ask Dvir before removing them.
