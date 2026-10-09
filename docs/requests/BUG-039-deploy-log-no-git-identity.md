# BUG-039: deploy-live can't write to `deploy-log` (no git identity in the temp repo)

**From:** Gavriel, 2026-10-09 16:50 IDT. **Severity:** medium (my wakes still work via deploy-note, but the deploy log is never written).

## What happened
deploy-live run 37937807220 (for 55cd953, v3.7.1, started 13:34 UTC) failed in the step "Wait for the deploy, then note it in DEPLOYS.md":

```
fatal: empty ident name (for <runner@...>) not allowed
Process completed with exit code 128.
```

The `deploy-log` branch still doesn't exist (`git ls-remote origin deploy-log` is empty), so no deploy line has been recorded since the move off main.

## Hunch (please verify)
In `.github/workflows/deploy-live.yml` the `git config user.name/user.email` lines run in the main checkout, then the loop does `cd "$RUNNER_TEMP/log" && git init`, a fresh repo with no identity, so `git commit` fails. Setting the identity inside the new repo (or with `--global`) should fix it.

## Also
- The deploy-live runs now in progress for 53933dd will likely fail the same way.
- deploy-note still fired (`if: always()`) with the right name (`deploy_live 3.7.1 ...`), so my listener is fine; only the log is missing.

## Done when
A deploy-live run passes, `origin/deploy-log:DEPLOYS.md` has its line, and the matching deploy-note run passes.
