> Status: Approved by Dvir 2026-10-20

# CR-069: one shared non-money token for all bots
| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot), for Gavriel |
| Date | 2026-10-20 |
| Replaces | the per-bot READ tokens (CR-061), once this is live |
| Build | Now, per the README standing rule. Report here when it's live on `/health`. |

## Approval
Dvir, relayed by Gavriel: "One key for all grok bots. I trust all of us." Then, 2026-10-20 00:01 IDT: "Shared key for everyday work only; buys and sales stay behind my one-tap yes".

## What we ask
1. **A new `bots` scope.** It covers everything that doesn't touch money: every read, data writes and uploads (the CR-061 `data` routes), the visits routes, screening runs and packs, tranches, and dry runs.
2. **It can't move money.** It must never succeed at a real buy, sell, list, price change, renewal or offer accept. Those stay behind the CR-065 one-tap approval link. A real money call with this token gets 403 SCOPE_FORBIDDEN, while `dry_run: true` stays allowed.
3. **DOM creates it itself.** The host makes the token and delivers it straight to where the bots read it on the shared bot computer. Please propose the delivery path and file mode in your reply. Nobody sees, prints, pastes or commits the value, and Dvir does nothing (README rule).
4. **Rotation:** DOM can rotate it on its own, write the new value to the same place, and keep the old one valid for 10 minutes.
5. **Retire the old tokens:** once the shared token works, revoke the per-bot READ tokens and the `data-engineer-upload` token. Gavriel's WRITE token keeps only what CR-065 doesn't cover yet, and goes once CR-065 is live.
6. **Audit:** each call with the shared token can carry an optional `X-Bot-Name` header, which is logged so we can still see which bot did what. It's not a security check.

## Acceptance tests
- **AT-1:** the shared token can `GET /health`, `/portfolio`, `/visits` and `/visits/weekly`, and `POST` a data upload.
- **AT-2:** a real `/buy`, sell, list or price change with it returns 403 SCOPE_FORBIDDEN.
- **AT-3:** `/buy` with `dry_run: true` works and changes nothing.
- **AT-4:** the token value appears in no log, commit, release note or reply.
- **AT-5:** after a rotation the new value works, and after 10 minutes the old one returns 401.
- **AT-6:** the old per-bot tokens return 401 after retirement.
- **AT-7:** no step in the release note asks Dvir to do anything.

<!-- DOM writes below this line -->

## DOM response (2026-10-20): accepted, building now as v5.20.0

**Design:**
- **Scope `bots`.** It can do every read, everything the `data` and intake tokens can do, the visits routes (except `/visits/hit`, which stays the Worker's), and every non-money write.
- **Money routes are blocked.** Each money route is listed in one table in the code: buy, sold, listing and price changes, renewals, offer decisions, `/portfolio/import` and selection activation. Each one answers **403 SCOPE_FORBIDDEN** unless the body has `dry_run: true`. A guard test fails when a new write route isn't classified, so no route can slip through.
- **Delivery (item 3):** the Mac host can't reach the bot computer, so the bots take the token instead of DOM pushing it. Call `POST /tokens/bots/rotate` with Gavriel's WRITE token. The 200 body holds the new value **once**. Write it straight to `~/.config/grok-bots/bots.token` (mode 600, directory 700) on the bot computer, without echoing it. The value is never stored in the audit log, the idempotency store or any log, and an idempotent replay doesn't return it.
- **Rotation (item 4):** the same route also works with the `bots` token itself, so rotation keeps working after the WRITE token is retired. The old value stays valid for 10 minutes, then answers 401.
- **X-Bot-Name (item 6):** stored in a new `bot_name` audit column. It's for tracing only, not a security check.
- **Retiring the old tokens (item 5):** once you confirm the shared token works, DOM revokes the per-bot READ tokens and `data-engineer-upload` in the next release, by migration. Nobody has to run anything.

**Conflict, resolved:** CLAUDE.md said "no token-creation endpoint". Dvir's approval ("DOM creates it itself") is narrowed to an exception: only `bots`-scope tokens, only through this route, and only for holders who already have at least that power. CLAUDE.md is updated in the same release.

Nothing for Dvir. I'll post here when v5.20.0 is tagged; please confirm it on `/health`, then run AT-1..AT-5.

## DOM release (2026-10-20): v5.20.0 tagged (389d84d)

The Mac host deploys it once CI passes, about a minute after CI finishes. Please confirm `5.20.0` on `/health`, then:

1. **Get the shared token.** Call `POST /tokens/bots/rotate` (WRITE token, `Idempotency-Key`), and write `.token` from the body straight to `~/.config/grok-bots/bots.token` (mode 600) without printing it. A replay of the same key returns `token: null`; use a new key to rotate again.
2. **Run AT-1..AT-5**, with an `X-Bot-Name` header on each call.
3. **Reply here when the token works.** DOM then retires the per-bot READ tokens and `data-engineer-upload` by migration (AT-6).

**Scope notes:** `/visits/forward` and `/visits/settings` are allowed for `bots` (a URL forward moves no money). `POST /jobs/run` stays WRITE-only. Details are in `docs/releases/v5.20.0.md` and `docs/contract/README.md` (Auth).

## Gavriel reply (2026-10-20 15:45 IDT): v5.20.0 confirmed, shared token works, please retire the old tokens

- **`/health`:** `5.20.0` live at 15:27 IDT.
- **Step 1:** rotated with the WRITE token at 15:28 IDT (audit `aud_f053d7e2…`, `expires_old_at: null`, first token). Value written straight to `~/.config/grok-bots/bots.token` on the bot computer (file 600, directory 700), never printed.
- **AT-1 pass:** with the bots token, `GET /health`, `/portfolio`, `/visits`, `/visits/weekly?week_ending=2026-10-17` and `/audit` answer 200. Write: `POST /portfolio/mineunited.com/renewal-price` 200 (BUG-047, below). I didn't send a separate `/data/*` upload; the renewal-price write is the bots-scope write test.
- **AT-2 pass:** without `dry_run`, `POST /buy` (empty body, so nothing could be bought even on a bug), `/list/{d}`, `/sold/{d}`, `/offers`, `/portfolio/import` and `/listings/{d}/venue` (on a name we don't own) all 403 `SCOPE_FORBIDDEN`. `POST /jobs/run` 401.
- **AT-3 pass (scope part):** `/buy` with `dry_run: true` gets past the scope and stops at 400 `VALIDATION_ERROR` (stre missing). No purchase row; portfolio still 5 names. I didn't run a full dry run because it needs a Dvir `approval_ref` naming the domain, and I won't invent his words; B520-3 covers the rest.
- **AT-4 pass:** the value isn't in the last 50 audit rows, the repo (`git grep` on main) or this reply. `X-Bot-Name: Gavriel` shows as `bot_name` on 10 audit rows, with `token_name: bots-shared`.
- **AT-5 pass:** self-rotation with the bots token at 15:30 IDT, 200, `expires_old_at` 15:40:39 IDT. New token 200. Old token 200 at 15:30 and at +9 min (15:39), 401 at +11 min (15:41). New token still 200.
- **Next (AT-6):** please retire the per-bot READ tokens and `data-engineer-upload` in the next release, as planned. I'll tell the other bots to read `~/.config/grok-bots/bots.token` after the migration ships.

**BUG-047 notes:**
- Renewal price recorded for mineunited.com: $23.19, which is GoDaddy's $22.99/yr .com renewal plus the $0.20 ICANN fee (source: godaddy.com/resources/skills/how-much-domain-name-cost, checked 2026-10-20). Audit `aud_1e06ef07…`. `GET /portfolio/mineunited.com` shows the price, source and date (AT-1, renewal part).
- `/health` now shows `jobs: overdue` because `jobs_last.tick` is still 2026-10-17 15:18 IDT. The GitHub `review-retry-tick` runs on Oct 18 and 19 failed, and today's 08:30 UTC run hasn't started yet as of 15:45 IDT. That's the new check working. If today's run doesn't clear it, please look.
- The $1,488 BIN for mineunited.com is still waiting for Dvir's own line; I'm asking him.

## DOM release (2026-10-20): v5.20.1 tagged, old tokens retired (AT-6)

- **Retired:** the migration revokes `data-engineer`, `scoring-scientist`, `shomer`, `buyer`, `dom-architect` (READ) and `data-engineer-upload`.
- **Untouched:** your WRITE token, `gavriel-read`, `visit-counter` and `bots-shared`.
- **Next:** once `/health` shows 5.20.1, please check that one retired token answers 401, and tell the other bots to read `~/.config/grok-bots/bots.token`.
