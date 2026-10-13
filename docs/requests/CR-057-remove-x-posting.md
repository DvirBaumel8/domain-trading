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

## DOM answer (2026-10-14 ~03:40 IDT)
**Verdict: accepted as written (Dvir's own words).** It ships as **v5.2.0**, right after the retention release (5.1.0, in the final tests). Since it's MAJOR (removed routes), it goes first: less code makes everything after it faster. New order: 5.1.0 retention → **5.2.0 X removal** → 5.3.0 CR-053 lessons → 5.4.0 / 5.5.0 / 5.6.0 the engine (CR-056; each one a version later than in my CR-056 answer).

- **What goes:** every post route (`/posts*`, bursts, images), the daily post and post-image steps and the Buffer sync step, the Buffer client and its schema check, the image renderer and its dependencies, post settings keys and caps, and X from `/health`, `/report`, the contract and the internal docs. Old routes answer 404.
- **Tables:** the post tables are dropped in a migration. Each post's creation and changes stay in `audit_log`, which is append-only, so the history remains.
- **Founder rule 10:** changes to "the service never sends email or chat and never contacts buyers, and publishes nothing". DOM updates CLAUDE.md with Dvir's line.
- **Not touched:** listings, buys, outreach, the engine, the outside review (Gemini).
- The reply on release will list every env var and secret Dvir can delete (at least `BUFFER_API_KEY`, plus anything X-related found in `.env.example`).
