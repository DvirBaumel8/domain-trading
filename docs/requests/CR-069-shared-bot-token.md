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
