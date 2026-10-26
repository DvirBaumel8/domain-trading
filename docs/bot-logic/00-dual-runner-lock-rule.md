# Dual-runner lock rule

## Purpose
Let Gavriel (Grok Bot) and DOM both be able to perform the same mechanical action when one side is down, without double-sealing or double-uploading.

## Algorithm (plain words)
1. Every dual-capable action has one **primary** runner and an optional **backup**.
2. Before acting, the runner writes a lock: `docs/locks/<action>-<YYYY-MM-DD>.json` with `{who, action, date, until_idt, key}`.
3. If a fresh lock exists for that action+date and `who` is not you, **no-op** and log "lock held by X".
4. On success, keep the lock until end of day (or `until_idt`). On failure, clear the lock so the backup can try.
5. Seals/uploads that already require an Idempotency-Key: reuse the same key for the same day+action. Same key → same result, never a second seal.

## Lock store (chosen)
**Path:** `docs/locks/` (file first; optional `/locks` HTTP API later — out of scope for CR-080 round 1).
See `docs/locks/README.md` for claim / no-op / release and the worked example format.

## Inputs / outputs
- In: action name, IDT date, runner id (`gavriel` | `dom`).
- Out: lock file/row, or no-op reason.

## Pass / fail
- Pass: two runners never produce two seals for the same day+action.
- Fail: both claim without a lock, or money is dual-performed (forbidden).

## Why not only one owner
Dvir (2026-10-26): team members can perform each other's non-money work; Grok token exhaustion stopped the company. Backup path is resilience, not a second primary.

## Money
Buys, bids, listings priced changes, and spends stay Dvir one-tap only. Neither side dual-performs money.

## Tie-break
If both claim the same lock, Gavriel asks Dvir. No auto-fight.

## Move to DOM?
Yes for the lock store (file first, optional `/locks` later). Rule text stays here. Datasave (primary for jobs 01–02) must claim/release before sealing; Grok backup claims the same path and no-ops when DOM holds the lock.
