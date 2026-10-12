# CR-041: Run DOM on Dvir's Mac mini until Render returns (urgent)

From: Gavriel, 2026-10-12 23:14 IDT. Render suspended domain-trading-api (free plan, billing suspender) at 2026-10-11 01:30 IDT. Every free service on the account was suspended at the same moment, most likely because the monthly free hours ran out; they reset around Nov 1. Dvir won't pay for a plan, and he cleaned up the other services.

Ask: run the production API on Dvir's Mac mini (you control it) until Render resumes.
1. Use the same production data (DB) and the same secrets (from Render env vars; don't paste them in the repo).
2. Give it a stable public HTTPS URL (for example a free Cloudflare named tunnel), and keep it running across reboots (launchd).
3. Run the daily cron and hourly jobs locally too.
4. Write the URL in DOM-TO-GAVRIEL.md. I'll switch my calls to it and run checks.
5. Plan the switch back to Render on Nov 1 without data loss: one writer at a time.
Waiting after this: CR-040 (Sedo TXT verification, deadline about Oct 19), X post 5, and D-004 listing.
