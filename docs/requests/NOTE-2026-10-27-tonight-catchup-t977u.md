# NOTE — Tonight’s decisions catch-up (Dvir t977u)

**Date:** 2026-10-27 ~03:23 Asia/Jerusalem (IDT)  
**From:** Gavriel relay → DOM Architect stamp  
**Purpose:** Single place Claude Code / bots can read what Dvir locked tonight.

## JOINT-OPS §10 (t959u/t960u) — approved

| Item | Outcome |
|---|---|
| **A** | One place per durable data = **DOM DB**; consumers read via DOM API only; dual persistence remove/refactor (`CR-084`). |
| **B** | Sedo **scrapes/automation off** (no T-SELL Sedo; no new Sedo). **KEEP override t971u:** keep 4 live Sedo listings — aievalsconsulting, promptinjectionaudit, roofingvoiceagent, ukcbamcompliance. Browser never removed any of the 4. (`CR-085` + `SEDO-DELIST-PLAN`) |
| **C** | One shared DOM **READ** token (not 3 named). DOM generated → Dvir yes → `handed_to_gavriel` (admin `shared-bots` **id 10**). Mac `~/.config/domain-trading/dom-shared.token` + box secrets; **never print**. |
| **D** | Bak archive **YES** — 266 moved under `archive/bak-2026-10-27/` (`CR-086`). |
| **E** | **Skip** 90-day edge framing. |
| **Security** | Stance **A** — accept Mac local-tool / `prod.env` access for now; revisit before real money volume. |

## Browser split (t973u + t974u)
- Chrome/UI = **Gavriel only** (anywhere).
- Once **real marketplace API access** exists → that work **moves to DOM**.
- Stamped: JOINT-OPS **R9**, `NOTE-2026-10-27-browser-gavriel-only.md`, `bot-logic/10-browser-gavriel-only.md`, requests README standing rule. Commits include **a01c3cd** + **e20c9a3** (ancestors of current main).

## Still open (no new Dvir ask)
CR-080 Dynadot datasave client; CR-083 evidence cache; CR-084 sole store build; BUG-053 AT-4; Afternic API dry-run until exact diff OK; stale scout banners (CR-086 follow-through).

## Money
Unchanged: Dvir one-tap yes per money action; Gavriel executes.
