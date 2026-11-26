# AVC CI files

`avc-tests.yml` runs the AVC tests (Python 3.13, no secrets, `contents: read`, outbound sockets blocked, loopback allowed).

1. Install: `cp ai-visibility-check/ci/avc-tests.yml .github/workflows/avc-tests.yml`, then commit it (a maintainer with workflow permission must do this).
2. The job id and name are `avc-tests`; keep them stable.
3. Making `avc-tests` a required check is a repository setting. It needs the owner's separate OK and is not done by this change.
4. Smoke test after a deploy: `ai-visibility-check/scripts/avc_smoke.sh https://<host>` (curl only).
5. It checks /health, /, a bad webhook signature (401), a non-US intake (400) and an instant free check (status `instant`).
6. It creates no order, spends nothing and sends no email. Exit code is non-zero if any check fails.
