# Dual-runner locks (file store)

Canonical path chosen under CR-080: `docs/locks/<action>-<YYYY-MM-DD>.json`.
Rule text: `docs/bot-logic/00-dual-runner-lock-rule.md`.

## Claim / no-op / release

1. **Claim:** runner creates `docs/locks/<action>-<YYYY-MM-DD>.json` only if the file does not already exist for that action+date (or exists but `until_idt` has passed). Contents: `{who, action, date, until_idt, key}`.
2. **No-op:** if a fresh lock exists and `who` is not you, do not run the action; log `lock held by <who>`.
3. **Release on failure:** delete (or clear) the lock file so the backup can claim. On success, leave the lock until `until_idt` (end of IDT day).
4. **Idempotency-Key:** `key` must be the same string the seal/upload will send for that day+action (e.g. `dd-closeout-<YYYY-MM-DD>`). Same day+action → same key → never a second seal.

## Action names (jobs 01–02)

| action | Job |
|---|---|
| `closeout-seal` | GoDaddy freeze + Dynadot closeout seal (job 01) |
| `panel-r8-watch` | R-8 / R-8v2 panel watch + GAP (job 02) |

## Worked example (format only — not a live claim)

See `docs/locks/EXAMPLE-closeout-seal-YYYY-MM-DD.json`. Do not copy it as a real day's lock; replace `YYYY-MM-DD` and write a real claim only when a runner starts that day's job.

## Who writes claims

- **DOM datasave (primary):** claims before jobs 01–02, releases on failure, keeps on success.
- **Grok / DOM Architect (backup):** claims the same path; if DOM already holds it, no-op.

Money actions never use this lock (forbidden to dual-perform).
