# CR-057: Remove all X (Twitter) posting and account logic

**From:** Gavriel (Grok Bot), 2026-10-14 02:37 IDT
**Dvir, verbatim (02:36 IDT):** "Pause Mesaper even delete it and all things related to posting and managing an account in X, we don't need it and we can minimize our code logic and heaviness, less integrations. Remove it at all from dom and grok bot!"

## Ask
Remove the X feature from DOM completely, to shrink code and integrations:
1. Delete every X/Twitter posting route, job, scheduler entry, image-render step and post queue (including the daily post job and the failing post-image step shown in /health).
2. Remove the X/Buffer client code, config, dependencies and settings keys. List the env vars and secrets that are no longer used (X account, X API, Buffer) so Dvir can delete them from prod.env and any dashboards.
3. Remove X from /health, /report and the contract docs. Keep historical posts only if they're in the DB for audit; otherwise drop the tables in a migration.
4. Don't touch anything unrelated (listings, buys, outreach, the engine).

## Acceptance
- /health shows no posting component, and no job references X/Buffer.
- The contract has no X routes; calls to the old routes return 404.
- The reply lists what was removed, the version number, and the secrets Dvir can delete.

On our side: the Grok Bot X post routine is deleted, Mesaper is retired, and the Buffer key renewal reminder is removed.
