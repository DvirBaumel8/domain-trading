# NOTE: one shared DOM endpoint token — handoff

**Status:** **CANONICAL = `bots-shared` (CR-069)** — keep using `~/.config/grok-bots/bots.token`  
**Date:** 2026-10-27 (updated ~08:25 Asia/Jerusalem)  
**Decision:** JOINT-OPS §10 C (one shared password for DOM endpoints)  
**Standing rule:** Dvir never creates keys; bots/DOM do setup; his part is one-tap yes/no. **Never print the secret in chat, CRs, or git.**

## Canonical shared password (live)
| Field | Value |
|---|---|
| Bot path | `~/.config/grok-bots/bots.token` (mode 600) |
| DOM admin name | `bots-shared` |
| Token list id | `7` |
| Scope | `bots` (CR-069: non-money shared — GET + data/visits + non-money mutating; money only with `dry_run: true`) |
| Rotate | `POST /tokens/bots/rotate` (WRITE or bots; value shown once) |
| Status | **active**, last used 2026-10-27 (Gavriel confirmed `/health` 200 on 5.65.0) |

This is the §10 C “one shared password.” Do **not** rotate unless a bot cannot auth; rotation gives a 10-minute overlap on the old value.

## Failed READ create (do not use)
On 2026-10-27 ~02:58 IDT Architect also created admin name `shared-bots` **id 10** (`scope: read`) into Mac `~/.config/domain-trading/dom-shared.token` after Dvir “Okay create it” / handoff YES. That file **never authenticated** (`401` on `/health`; `last used never`; stripped length 41 vs working tokens 46 — likely a bad save).  

| Cleanup 2026-10-27 ~08:25 IDT | |
|---|---|
| id 10 | **revoked** (never used) |
| Mac file | renamed `dom-shared.token.INVALID-2026-10-27` (mode 600; not in git) |
| STATUS file | `invalid_401_never_used revoked_id_10 …; use ~/.config/grok-bots/bots.token (bots-shared)` |

Mac host ops may still use `dom-read.token` / `dom-write.token` locally; bots use **`bots.token`**.

## Still out of scope
- Printing or committing any secret.
- Switching money routes to the shared bots token.
- Revoking `bots-shared` (id 7) without a fresh need + handoff plan.

## Changes
- 2026-10-27 ~02:50 IDT: procedure drafted (no generate).
- 2026-10-27 ~02:58 IDT: generated `shared-bots` id 10; pending handoff.
- 2026-10-27 ~03:02 IDT: Dvir YES; STATUS handed_to_gavriel (later found 401).
- 2026-10-27 ~08:25 IDT: confirmed 401; revoked id 10; canonical path = CR-069 `bots-shared` / `bots.token`; NOTE corrected.
