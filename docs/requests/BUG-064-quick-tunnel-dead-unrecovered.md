---
id: BUG-064
kind: BUG
status: approved
owner_bot: dom-architect
approval: "Gavriel approved filing as a reliability bug fix (2026-11-12). No money. Named Cloudflare tunnel only if no new account, no payment, and no manual Dvir setup; otherwise STOP and report. Fallback watcher is approved either way."
priority: P1
depends_on: [CR-041]
supersedes: []
max_rounds: 2
repro_test: "Given a still-running cloudflared quick tunnel whose public URL is unchanged but the origin is unreachable (server-side 'Unauthorized: Tunnel not found'), When tunnel-watch ticks, Then within 5 minutes and with no human action the tunnel is restarted, a reachable URL is republished to the proxy, and GET https://domain-trading-api-proxy.dvirbaumel9.workers.dev/health/ping returns 200; a healthy tunnel is not restarted in a loop."
---
> Status: Approved — BUILD NOW (reliability; prod quick-tunnel outage)

# BUG-064: dead quick tunnel with an unchanged URL is never restarted

| Field | Value |
|---|---|
| BUG id | BUG-064 |
| From | DOM Architect (Grok Bot); Gavriel approved filing as a reliability bug fix |
| Date | 2026-11-12 17:49 IDT |
| Contract version | live API 6.7.0; host kit CR-041 (`docs/runbook.md` Local host) |
| Severity | blocks work |
| Type | Bug / reliability (no money; no settings activation) |
| Build | Recover a dead Cloudflare quick tunnel automatically. Prefer a named tunnel only if it needs no new account, no payment, and no manual Dvir setup; otherwise stop and report. Ship the watcher fallback unless the named tunnel lands. |

## Call made / expected / got

- **Call:** repeated reads of the stable prod proxy `https://domain-trading-api-proxy.dvirbaumel9.workers.dev` (`/health`, `/datasave`, `/datasave/status`, `/runs`, `/status`, `/preflight`) from about **17:42–17:43 IDT** on **2026-11-12**. Health had been ok earlier the same day (~08:53 IDT).
- **Expected** (`docs/runbook.md`, Local host / CR-041): the Mac API keeps a public path through a Cloudflare quick tunnel and the stable `api-proxy` Worker. `com.domaintrading.tunnel-watch` (StartInterval 60) is supposed to keep that path alive so bots can reach the origin. If the tunnel is down, the proxy may answer 502 `ORIGIN_UNREACHABLE` — but that state must not last until a human restarts the tunnel.
- **Got:**
  - Proxy HTTP **502** `ORIGIN_UNREACHABLE` (origin **530**) from **~14:25 IDT until 17:45 IDT**.
  - `com.domaintrading.tunnel` was still running a quick tunnel (`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3100`); the process had been up ~30 days.
  - From **2026-11-12T12:25:25Z** (14:25:25 IDT) `cloudflared` logged repeated `ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"`.
  - The API process stayed up on `127.0.0.1:3100`. The outage was the public tunnel registration, not the API.
  - `tunnel-watch.sh` only republishes `TUNNEL_URL` when the trycloudflare URL in `tunnel.log` **changes**. A dead tunnel that keeps the same URL is never restarted and never republished.
  - Manual recovery: DOM Architect ran `launchctl kickstart -k gui/<uid>/com.domaintrading.tunnel` at **17:45 IDT**. A new URL was published at **17:45:59 IDT** (GitHub Actions `deploy-api-proxy` run **43251330173**). The proxy reached the origin again after that.

## Why (working hypothesis — confirm in DOM response)

Quick-tunnel registrations can die on Cloudflare's side while the local `cloudflared` process stays alive (`KeepAlive` in `com.domaintrading.tunnel` only restarts a crashed process, not a still-running process that is failing to re-register). `scripts/local-host/tunnel-watch.sh` compares the newest `https://<id>.trycloudflare.com` in the last 2000 lines of `tunnel.log` to the saved URL and **exits 0 when they match**. It does not health-check the public URL or scan the log for `Tunnel not found`. So a dead, unchanged URL is a silent, lasting prod outage until someone kickstarts the tunnel.

## Rules

- R-1 **Preferred fix:** move prod off the rotating quick tunnel to a **named Cloudflare tunnel** with a stable hostname on the **existing** Cloudflare account already used for `domain-trading-api-proxy` / `deploy-api-proxy`. Do this **only** if DOM / Claude Code can complete it with **no new account, no payment, and no manual Dvir setup**. If any of those is required, **STOP and report back** — do not start it. Dvir must say yes first.
- R-2 **Fallback (do this either way unless the named tunnel lands and makes this unnecessary):** `tunnel-watch` (or an equivalent host agent) must also health-check the public tunnel URL (for example `GET /health/ping`) and the `cloudflared` log. On `Tunnel not found`, or on N consecutive failures totaling about **3 minutes**, kickstart `com.domaintrading.tunnel` and republish the new URL to the proxy (existing `TUNNEL_URL` + `deploy-api-proxy` path is fine for a quick tunnel).
- R-3 **Rate-limit** restarts so a healthy or flapping origin cannot loop. **Log each restart** (time and reason) in the existing host log path.
- R-4 **Alert:** write a visible event bots can read without a secret scrape — for example a `/health` field, or a durable log line on a path bots already read — when the tunnel was restarted (timestamp + reason).
- R-5 Host-script updates must be picked up by the existing deploy path. **No manual step for Dvir** (no command, no copy/paste, no account or key creation). Secrets must never appear in logs, `/health`, or request files.
- R-6 No money, no registrar actions, no DOM settings activation.

## Acceptance tests (tests-as-contract)

Pass/fail checks. Automate as fixtures or a documented host-level rehearsal; each must have a pass and a fail case where that applies.

- AT-1 **Dead tunnel, unchanged URL:** simulate a still-running tunnel whose published URL is unchanged and whose origin is unreachable (equivalent to `Unauthorized: Tunnel not found` / proxy 502 `ORIGIN_UNREACHABLE`). The watcher detects it and, **within 5 minutes, with no human action**, kickstarts the tunnel, republishes a reachable URL, and **`GET` the stable proxy `/health/ping` returns 200**.
- AT-2 **No restart loop when healthy:** with a working tunnel and proxy `/health/ping` 200, repeated watcher ticks do **not** restart the tunnel or republish a new URL in a loop.
- AT-3 **Log + rate limit:** each restart is logged with a time and reason; a tight failure burst does not exceed the documented restart rate limit.
- AT-4 **Alert visible to bots:** after a recovery restart, the chosen `/health` field or readable log line shows that a restart happened (timestamp + reason). No secrets in that event.
- AT-5 **Negative:** no money routes; no settings toggled on; no secrets in logs or health output. If the named-tunnel path needs a new account, payment, or Dvir setup, it is **not** implemented in this release (STOP + report instead).

## Out of scope

- Asking Dvir to run `launchctl`, create a Cloudflare login, buy a domain or plan, or paste a key.
- Changing DOM application settings, or any buy/sell/list path.
- A full Dynadot redo, or any datasave backfill, as part of this fix.
- Re-architecting the stable proxy hostname unless the named tunnel lands under R-1 and the cutover is automatic.

## DVIR items

- Named tunnel (R-1): **none**, as long as it stays inside the existing account with no payment and no setup from Dvir. If DOM finds that any of those is required, **stop and write it here** — do not build that path until Dvir says yes.
- Watcher fallback (R-2–R-4): none.

## Evidence

- Mac `com.domaintrading.tunnel` / `tunnel.log`: process up ~30 days; from **2026-11-12T12:25:25Z** repeated `ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"`.
- Proxy `https://domain-trading-api-proxy.dvirbaumel9.workers.dev`: HTTP 502 `ORIGIN_UNREACHABLE` (origin 530) ~14:25–17:45 IDT; API on `127.0.0.1:3100` stayed up.
- `scripts/local-host/tunnel-watch.sh` + `com.domaintrading.tunnel-watch.plist` (StartInterval 60): publish only when the trycloudflare URL changes.
- Manual fix: `launchctl kickstart -k gui/<uid>/com.domaintrading.tunnel` at 17:45 IDT; new URL published 17:45:59 IDT (Actions run 43251330173).

## BUILD NOW — Claude Code (Architect kickoff 2026-11-12 17:49 IDT)

Gavriel approved filing this as a reliability bug fix through the normal Claude Code path. Dvir does not kick off Claude Code; Architect drives this. **Build immediately.** Max 2 rounds. No money. No settings activation. Prefer a named tunnel only under R-1; ship the R-2 watcher unless the named tunnel lands. Report when live (proxy `/health/ping` 200 and the watcher/named-tunnel behaviour is documented). Stamp `## DOM response` in this file and one line in `DOM-TO-GAVRIEL.md`.

Focus: a dead quick tunnel with an unchanged URL must recover within 5 minutes without a human; a healthy tunnel must not restart in a loop.

<!-- DOM writes below this line -->
## DOM response

## DOM response (2026-11-23)
Closed without a fix: 7.0.0 removes the database and the Mac tunnel (Dvir, 23 Nov 2026).
