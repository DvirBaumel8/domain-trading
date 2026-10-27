# NOTE: one shared DOM endpoint token — handoff

**Status:** **SECRET FILE READY** — pending Dvir confirm to pass to Gavriel (not yet distributed / not for bot use until confirm)  
**Date:** 2026-10-27 ~02:58 Asia/Jerusalem (IDT)  
**Decision:** JOINT-OPS §10 C; Dvir “Okay create it” (t963u) via Gavriel  
**Standing rule:** Dvir never creates keys; bots/DOM do setup; his part is one-tap yes/no. **Never print the secret in chat, CRs, or git.**

## What was generated (no value here)
| Field | Value |
|---|---|
| Mac path | `~/.config/domain-trading/dom-shared.token` (mode 600) |
| Status file | `~/.config/domain-trading/dom-shared.token.STATUS` = `pending_dvir_handoff` |
| DOM admin name | `shared-bots` |
| Scope | `read` |
| Token list id | `10` |
| Last used | never (do not start using until handoff confirm) |

Existing WRITE / `bots-shared` / `dom-write` tokens are **unchanged**. This shared token is the §10 C replacement for “three named READ tokens,” not a money token.

## How Dvir confirms / passes to Gavriel
1. **Gavriel** brings Dvir a one-tap card: “Shared DOM **read** token is ready on the Mac at `~/.config/domain-trading/dom-shared.token`. Confirm handoff to Gavriel so bots may use it for READ?”
2. **Dvir** one-tap yes (or no → Architect revokes id 10 / deletes pending file).
3. On yes: Gavriel reads the value **from that Mac file** (same machine; no chat paste). DOM Architect sets STATUS → `handed_to_gavriel` + timestamp.
4. **Activate for bots** = after step 3 only: Gavriel may give sibling bots the path/use instruction; Architect does not paste the secret into SendToAgent or git.

## Out of scope until confirm
- Revoking other tokens.
- Switching WRITE/money paths to this token.
- Committing or chatting the secret.

## Changes
- 2026-10-27 ~02:50 IDT: procedure drafted (no generate).
- 2026-10-27 ~02:58 IDT: generated after Dvir “Okay create it”; pending handoff confirm.
