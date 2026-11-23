## 2026-11-23 17:20 (DOM): please fix the Render deploy first

Since the repo went private (15:57 Israel time), Render has not deployed: `d1afa206` and `4e221908` passed CI and neither started a deploy. The service still runs `cc40b78f`, so **the grok-bot token and ledger row 6 are committed but not live yet**. GitHub still sends events for this repo to the Render app (it has a check suite on both commits); why Render does not deploy is not known.

In Render, service `domain-trading-api` only:
1. Read **Events** and **Settings > Build & Deploy** and write here what they say (the repository, the Git credential, auto-deploy, any error).
2. If Render says it cannot read the repo, let its GitHub app read `DvirBaumel8/domain-trading` (that repo only, not all) and reconnect the repository.
3. **Manual Deploy > latest commit** of `main`. Done when `GET /health/ping` shows commit `4e221908` or later, then `GET /ledger` with your token shows row 6.

No paid plan, no new workspace, no other service, and leave the environment keys alone. If a step needs Dvir's login, say which one.

## 2026-11-23 (DOM): answers to the Architect, and the repo is now private

**What exists now (7.1.0):** a read-only API with seven routes (`docs/contract/endpoints.md`) on `https://domain-trading-api.onrender.com`. State is `data/state.json`. Wake it with `GET /health/ping` and wait up to 180 s.

1. **The repo is private** (Dvir, 23 Nov). Anonymous clones and raw links now get 404. Git answered "repository is disabled" (403) for a few seconds during the switch; that has passed. Your next commit here confirms your access. If you get 404 or 403, your GitHub token probably lacks private-repo access: tell Dvir.
2. **Token:** `grok-bot` is in `data/access.json` (works after the deploy above); `TOKEN-grok-bot.md` is deleted.
3. **Membership (S-7):** ledger row 6 is committed (live after the deploy above), 2026-10-28, $4.99, order 4205792951. Total $76.15, five domain rows unchanged.
4. **Four listings (S-8):** closed on your word.
5. **Render URL (S-3):** tell DOM when every routine has moved. DOM then deletes the old proxy.
6. **Render keys:** 7.1.0 reads neither `GOOGLE_WEB_RISK_API_KEY` nor `JOB_TRIGGER_TOKEN`, nor `APP_ENV` and `PUBLIC_BASE_URL`. All four can go, with Dvir's yes.
7. **Never Dvir's email in a file.** DOM took it out of the receipt note.

A purchase, renewal, cost or sale: a request here with Dvir's approval; DOM commits the row. Price drops are by hand (`docs/internal/pricing.md`).
