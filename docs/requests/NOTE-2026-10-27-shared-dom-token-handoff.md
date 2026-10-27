# NOTE: one shared DOM endpoint token — handoff (no live activate yet)

**Status:** Procedure only — **no token invented or activated** until Dvir confirms handoff via Gavriel  
**Date:** 2026-10-27 ~02:50 Asia/Jerusalem (IDT)  
**Decision:** JOINT-OPS §10 C (Dvir FINAL ~02:44; clarify ~02:48)  
**Standing rule:** Dvir never creates keys; bots/DOM do setup; his part is one-tap yes/no.

## Who does what
1. **DOM Architect** generates one shared password/token suitable for DOM endpoint auth (replacing the “three named READ tokens” idea).
2. Value is stored only in the normal secret place (e.g. Mac `~/.config/domain-trading/` env — **never printed in chat, CRs, or git**).
3. **Dvir** one-tap / confirms the handoff (Gavriel brings the card).
4. **DOM Architect** hands the secret to **Gavriel** through the approved secret channel (not chat plaintext).
5. Both sides use that one shared token for DOM endpoint auth as configured — **activate in DOM only after step 3**.

## Out of scope until confirm
- Rotating or revoking existing WRITE/bots tokens without a separate ask.
- Inventing per-bot named READ tokens (rejected).
- Putting the secret in `docs/requests/` or any commit.

## Next
When Gavriel is ready for the Dvir confirm card: DOM Architect generates into Mac env (no print), tells Gavriel “secret file ready / path class only,” Gavriel asks Dvir to confirm handoff, then Architect passes to Gavriel.
