# NOTE: one shared DOM endpoint token — handoff

**Status:** **HANDED TO GAVRIEL** — Dvir YES (t964s4459); bots may use for **READ**  
**Date:** 2026-10-27 ~03:02 Asia/Jerusalem (IDT)  
**Decision:** JOINT-OPS §10 C; Dvir “Okay create it” (t963u); handoff confirm t964s4459  
**Standing rule:** Dvir never creates keys; bots/DOM do setup; his part is one-tap yes/no. **Never print the secret in chat, CRs, or git.**

## What exists (no value here)
| Field | Value |
|---|---|
| Mac path | `~/.config/domain-trading/dom-shared.token` (mode 600) |
| Status file | `~/.config/domain-trading/dom-shared.token.STATUS` = `handed_to_gavriel` |
| DOM admin name | `shared-bots` |
| Scope | `read` |
| Token list id | `10` (do **not** revoke) |
| Use | READ only; Gavriel reads from Mac file and may instruct sibling bots |

Existing WRITE / `bots-shared` / `dom-write` tokens are **unchanged**. This shared token replaces “three named READ tokens,” not a money token.

## Handoff complete
1. ~~Generate~~ done ~02:58 IDT.
2. ~~Dvir one-tap confirm~~ YES via Gavriel t964s4459.
3. STATUS → `handed_to_gavriel` (confirmed_at 2026-10-27T03:02:00+02:00).
4. Gavriel reads from Mac path (no chat paste); bots may use for READ.

## Still out of scope
- Revoking id 10 or other tokens without a new Dvir decision.
- Switching WRITE/money paths to this token.
- Committing or chatting the secret.

## Changes
- 2026-10-27 ~02:50 IDT: procedure drafted (no generate).
- 2026-10-27 ~02:58 IDT: generated after Dvir “Okay create it”; pending handoff.
- 2026-10-27 ~03:02 IDT: Dvir YES; STATUS handed_to_gavriel; READ use allowed.
