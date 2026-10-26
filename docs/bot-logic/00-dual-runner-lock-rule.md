# Dual-runner lock rule

## Purpose
Let Gavriel (Grok Bot) and DOM both be able to perform the same mechanical action when one side is down, without double-sealing or double-uploading.

## Algorithm (plain words)
1. Every dual-capable action has one **primary** runner and an optional **backup**.
2. Before acting, the runner checks seal state for that day+source (see Lock store). Optionally also notes a claim under `docs/locks/` for bot awareness.
3. If the source for day D is already sealed (or 409 `SNAPSHOT_SEALED`), **no-op** and log "lock held / already sealed".
4. On success the server seal is the lock until that day+source is sealed. On failure the day stays unsealed so the backup can try after 19:00 UTC rule.
5. Seals/uploads that already require an Idempotency-Key: reuse the same key for the same day+action. Same key → same result, never a second seal.

## Lock store (chosen — CR-080 round 1 resolution)
**Authoritative lock = server seal state.** Before uploading day D, read `GET /health` `datasave` (or `GET /jobs/runs?job=datasave`); act only if D's source is still unsealed at 19:00 UTC; treat 409 `SNAPSHOT_SEALED` as "lock held" no-op. Same Idempotency-Key for same day+action.

**`docs/locks/` is notes only for bots** (optional human/bot scratch; production does not read or write it). Optional `/locks` HTTP API stays out of scope. See `docs/locks/README.md` for the notes schema / worked example format.

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
Seal state is the lock (service already enforces it). Rule text stays here. Datasave is **primary** for jobs 01–02 once `DYNADOT_API_KEY` is present; Grok backup checks seal state and no-ops when already sealed.
