## 2026-11-23 (DOM): the simple system. Please read this one; older notes are in the tag `archive-2026-11-23`

**What exists now (7.1.0):** a read-only API with seven routes (`docs/contract/endpoints.md`) on `https://domain-trading-api.onrender.com`. State is `data/state.json`: 5 domains, $71.16, confirmed by Dvir at 11:19. Wake it with `GET /health/ping` and wait up to 180 s. Everything else of 6.x is gone for good.

**Please do:**
1. **Your token, no hand-over needed.** Keep the token you already have in `~/.config/grok-bots/bots.token` (if it is missing or short, make one: `openssl rand -hex 32`, mode 600). Send only its hash here as a file `docs/requests/TOKEN-grok-bot.md`, one line: `grok-bot:<sha256>`. Make the hash with `printf %s "$(cat ~/.config/grok-bots/bots.token)" | shasum -a 256` (or `sha256sum`). Never the token itself. DOM adds the hash to `data/access.json` and the token works after the deploy. This replaces DOM's earlier note about a token from Dvir.
2. **Remove the four listings on the removed marketplace** (the only one that still has any): aievalsconsulting.com, promptinjectionaudit.com, roofingvoiceagent.com, ukcbamcompliance.com. Dvir approved it to DOM in chat today (question: "Should Gavriel remove the 4 listings?", answer: "yes"); it replaces his 27 October keep decision. Afternic stays as it is. Confirm here when done (`gaps.md` S-8).
3. **Switch every routine to the Render URL** and tell DOM. DOM then deletes the old Cloudflare proxy (Dvir: yes). It already answers 502 to everything.
4. **Trim `docs/requests/bot-logic/`.** It is yours, so DOM left it, but it still describes the shortlist, preflight, kills and job routes, which no longer exist. `docs/bot-logic/` (old copies) is deleted, and bots may push only to `docs/requests/`.
5. The $4.99 membership: send its date and receipt if it should be in the ledger (S-7).

**Deleted as redundant** (all in the tag): old requests, release notes, research, knowledge files, run packs, weekly reports, skills. Kept: this file, CR-113, and the four CRs that are the approval records of the five purchases. The `gavriel-request` workflow is gone too (it never had its secret); `deploy-live` still tells you when a deploy is live.

A purchase, renewal, cost or sale: a request here with Dvir's approval; DOM commits the row. Price drops are by hand (`docs/internal/pricing.md`).
