# CR-041: Run DOM on Dvir's Mac mini until Render returns (urgent)

From: Gavriel, 2026-10-12 23:14 IDT. Render suspended domain-trading-api (free plan, billing suspender) at 2026-10-11 01:30 IDT. Every free service on the account was suspended at the same moment, most likely because the monthly free hours ran out; they reset around Nov 1. Dvir won't pay for a plan, and he cleaned up the other services.

Ask: run the production API on Dvir's Mac mini (you control it) until Render resumes.
1. Use the same production data (DB) and the same secrets (from Render env vars; don't paste them in the repo).
2. Give it a stable public HTTPS URL (for example a free Cloudflare named tunnel), and keep it running across reboots (launchd).
3. Run the daily cron and hourly jobs locally too.
4. Write the URL in DOM-TO-GAVRIEL.md. I'll switch my calls to it and run checks.
5. Plan the switch back to Render on Nov 1 without data loss: one writer at a time.
Waiting after this: CR-040 (Sedo TXT verification, deadline about Oct 19), X post 5, and D-004 listing.

## DOM response (2026-10-12)
**Verdict: DOM can build the kit, but DOM can't run it. Running production on the Mac goes against the HARD RULE in CLAUDE.md (DOM never operates production, never uses production secrets, never touches the production DB). That rule is Dvir's, so only Dvir can decide how this runs: DVIR.**

1. **What DOM can do without breaking the rule:** add a "local host" kit to the repo:
   - a start script that runs the built server and the migrations check against an env file outside the repo;
   - a launchd plist so it restarts after a reboot;
   - the tunnel config;
   - a runbook section.

   Dvir copies the Render env vars into that env file himself; DOM never reads or pastes them. Dvir (or Gavriel) starts it, and Gavriel verifies on `/health`. DOM never calls it.
2. **Stable HTTPS URL:** a Cloudflare *named* tunnel needs a domain whose DNS is on Cloudflare, and we have none we should use (our .com names are for sale). The free option with a fixed URL is **Tailscale Funnel** (`https://<machine>.<tailnet>.ts.net`). A Cloudflare quick tunnel is free too, but its URL changes on every restart.
3. **Daily job:** no local cron is needed. The Cloudflare Worker already triggers the daily run; only its `API_BASE_URL` (a GitHub variable, set by Dvir) changes to the new URL, and back in November. The review-retry tick workflow uses the same variable.
4. **One writer at a time (the switch back):** Render must not resume while the Mac runs. Before 1 Nov: stop the Mac service (`launchctl unload`), point `API_BASE_URL` back to Render, then resume Render, so the database never has two servers or two daily runs. The database itself (Neon) is unchanged, so no data moves and none is lost.
5. **Why Render stopped:** a free workspace gets 750 instance hours a month for all its services together. One always-on service uses about 744, so the other services pushed it over. With only this service left, November should fit. DOM checks whether the queue's self keep-alive adds hours, and reports here.

**Waiting on Dvir:** whether to make an exception to the HARD RULE (and its wording), and whether he runs the kit himself. Until then, DOM continues CR-040 (Sedo, no production calls).
