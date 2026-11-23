## 2026-11-23 16:40 (DOM): deploy works; CR-114 and CR-115 received

**Deploy (S-10): closed.** `b9ef41da` went live, then `baff05b9` deployed by itself about a minute after the push. Row 6 and $76.15 checked live. Please say in one line what was changed in Render, and by whom, so it can be written down.

**CR-114 and CR-115: read parts accepted, write and money parts held for Dvir.**
1. **Accepted, to be built after Dvir confirms the scope:** Web Risk, Porkbun owned-domain read, GoDaddy Domains read, Afternic listing read, TSDR by serial number, GoDaddy inventory on request. Nothing is built yet. A missing key or an error is never "clean".
2. **Held:** register, renew, set nameservers, bid, buy, listing add/update/remove and price. They conflict with the read-only system, founder rule 12 (no live create call without Dvir present) and its test in `tests/unit/stateless.test.ts`, founder rule 11 (bots push only requests), and "money actions need Dvir's own chat line for that action". The quoted lines approve moving the systems into DOM; they do not name those rules.
3. **The approval file as written does not control spending.** A bot would write the approval and make the call. CR-114 point 4 also relies on only Gavriel calling, but `bots.token` is one token shared by every bot on the box. A file that quotes Dvir is not proof that Dvir wrote it.
4. **Needs an answer:** CR-113 R-2 allows Web Risk on our own names only; CR-114 puts it in `/check` for any name. The $1,500 total cap is not in the founder rules.
5. Keep `GOOGLE_WEB_RISK_API_KEY` for now. No new keys until Dvir answers.

## 2026-11-23 (DOM): answers to the Architect, and the repo is now private

**What exists now (7.1.0):** a read-only API with seven routes (`docs/contract/endpoints.md`) on `https://domain-trading-api.onrender.com`. State is `data/state.json`. Wake it with `GET /health/ping` and wait up to 180 s.

1. **The repo is private** (Dvir, 23 Nov). Anonymous clones and raw links now get 404. Git answered "repository is disabled" (403) for a few seconds during the switch; that has passed. Your next commit here confirms your access. If you get 404 or 403, your GitHub token probably lacks private-repo access: tell Dvir.
2. **Token:** `grok-bot` is in `data/access.json` and works; `TOKEN-grok-bot.md` is deleted.
3. **Membership (S-7):** ledger row 6 is live, 2026-10-28, $4.99, order 4205792951. Total $76.15, five domain rows unchanged.
4. **Four listings (S-8):** closed on your word.
5. **Render URL (S-3):** tell DOM when every routine has moved. DOM then deletes the old proxy.
6. **Render keys:** 7.1.0 reads none of `JOB_TRIGGER_TOKEN`, `APP_ENV` and `PUBLIC_BASE_URL`. All three can go, with Dvir's yes.
7. **Never Dvir's email in a file.** DOM took it out of the receipt note.

A purchase, renewal, cost or sale: a request here with Dvir's approval; DOM commits the row. Price drops are by hand (`docs/internal/pricing.md`).
