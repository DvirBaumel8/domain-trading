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

## DOM update (2026-10-12): Dvir chose option A; the kit is built
Dvir: run it on the Mac mini, with Dvir starting it (DOM builds it and never runs it). The kit is in `scripts/local-host/`, and the steps are in `docs/runbook.md`, "Local host":
- **install.sh:** a separate checkout at `~/domain-trading-prod`, an env file Dvir fills from Render (`~/.config/domain-trading/prod.env`, chmod 600), and two LaunchAgents (the server, kept alive; a deploy checker every 10 min).
- **deploy.sh:** deploys the newest `vX.Y.Z` tag once its CI passed, never 23:45–01:00 UTC.
- **Tunnel:** Tailscale Funnel to `127.0.0.1:3000`, so the URL is fixed.
- **Daily job:** the GitHub variable `API_BASE_URL` points at the tunnel, and the Worker is redeployed by hand.
- **Switch back:** the runbook lists the steps in order (stop the Mac → variable back → resume Render), so only one server writes.

**Gavriel:** the URL arrives here once Dvir has started it. Then check `/health` (expect `version: 3.9.0`, `db: ok`) and the next daily run in `GET /jobs/runs`.

## DOM update (2026-10-12): tunnel changed to Cloudflare
Tailscale sign-up failed, so the kit now uses a free **Cloudflare quick tunnel** behind a stable proxy Worker (`api-proxy/`, `domain-trading-api-proxy` on workers.dev). Tailscale is gone from the kit and the runbook.
- **Gavriel:** the stable URL (`https://domain-trading-api-proxy.<subdomain>.workers.dev`) arrives in `DOM-TO-GAVRIEL.md` once Dvir has started the host and the first `deploy-api-proxy` run printed it. It never changes while the Mac host runs (only the hidden tunnel URL behind it does, and the proxy follows it within about a minute).
- First check: `GET /health/ping` through the proxy, then `/health` (expect `version: 3.9.0`, `db: ok`). During a tunnel restart the proxy can answer 502 `ORIGIN_UNREACHABLE` for up to about a minute, or 503 `ORIGIN_NOT_SET` if no tunnel URL was ever published; retry.
- The Worker only forwards (path, query, method, headers, body) and adds `x-forwarded-host` / `x-forwarded-proto`; the daily job's `API_BASE_URL` is set once to the same stable URL.
