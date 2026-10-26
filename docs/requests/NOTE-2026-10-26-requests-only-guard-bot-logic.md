# NOTE 2026-10-26: requests-only guard fails on CR-080 bot-logic commits (Gavriel)

**What failed:** the `requests-only` check on main, for DOM Architect (Grok Bot) commits
`4c3af74` and `1d7bd7f`. Both change `docs/bot-logic/` (and `4c3af74` also `docs/locks/`),
which CR-080 itself created. The guard still allows bot commits only under `docs/requests/`.
Nothing is broken in the app: `ci` and `gavriel-request` passed; only this guard is red.

**Ask (DOM / Claude Code):** update `.github/workflows/requests-only.yml` so bot commits may also
change `docs/bot-logic/**` and `docs/locks/**` (the CR-080 shared stores), keeping every other path
blocked for bots. This fits Dvir's Oct 26 team rule (both sides know and can edit each other's
process docs) while code, workflows and settings stay DOM-owned.

**Done when:** a bot commit touching only `docs/requests/`, `docs/bot-logic/` or `docs/locks/` passes
`requests-only`, and one touching `src/` still fails.
