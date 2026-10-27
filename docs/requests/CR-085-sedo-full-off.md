> **STATUS 2026-10-27 ~03:18 IDT: KEEP OVERRIDE (Dvir t971u)** — 4 Sedo listings stay live; delist cancelled. Scrape/automation-off parts still apply.

---
id: CR-085
kind: CR
status: approved
owner_bot: dom-architect
approval: "D-2026-10-27-SEDO + Dvir §10 B T-SELL/no-new-Sedo still on. Delist half CANCELLED by Dvir t971u (KEEP existing 4 Sedo listings). Earlier t967u YES to remove superseded. Research S2S alternatives. No new Sedo automation."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-085: Sedo full off (T-SELL + delist; S2S research note)

**Approval (amended):** `D-2026-10-27-SEDO` — drop T-SELL Sedo scrapes; no new Sedo automation/investment. **Delist cancelled** by Dvir **t971u** (KEEP aievalsconsulting, promptinjectionaudit, roofingvoiceagent, ukcbamcompliance). Earlier t967u YES to remove is superseded. mineunited not on Sedo — skip. Max **2 rounds** for money-free contract parts.

**Live override (2026-10-27 ~03:18 IDT):** Existing 4 Sedo listings **stay**. Do not browser-delist. Claude Code Sedo UI struggle is not a reason to remove inventory. See `SEDO-DELIST-PLAN-2026-10-27.md` status = keep / delist cancelled.

## Why
Don’t compete where we can’t win. Sedo automation is weak; Monday T-SELL all-n/a scrapes waste tokens. Dvir ordered **full removal**, not placeholders.

## Live note (2026-10-27 ~02:46 IDT)
`GET /books.csv`: all five owned names show `listed_venues=afternic` only (no `sedo` in listed/observed columns). Marketplace Sedo pages may still exist from earlier submits (CR-076 left some Sedo rows `unknown`). **Delist plan must verify Sedo dashboard / public pages before clicking.**

## Rules
- R-1 **T-SELL:** Sedo venue dropped from weekly sale-rate scrapes entirely (no placeholder rows). Sales/bot SOPs cite `D-2026-10-27-SEDO` full removal.
- R-2 **DOM records:** Do **not** clear Sedo as delisted for the KEEP-4. No fake new `ours_confirmed` Sedo rows for new work. Prefer existing routes; no new money path.
- R-3 **Delist execution:** **Cancelled (t971u).** Do not delist the KEEP-4. No new Sedo list/price clicks without a fresh Dvir yes. DOM does not browser-delist.
- R-4 **Exports:** Stop generating actionable Sedo export uploads for new work; `sedo.csv` may remain for history or return empty/disabled — document choice in release note (default: no new pending Sedo exports).
- R-5 **Research note (bot, not code):** Document server-to-server alternatives in this CR’s Changes or a sibling NOTE: Afternic Portfolio API (already), Spaceship SellerHub when keys land. No build of SellerHub in this CR.
- R-6 **No Sedo rebuild.** No new Sedo automation investment.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-5 for money-free parts; delist plan filed; no Sedo click without Dvir tap. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1 **T-SELL contract:** Documented bot/Sales rule: Sedo not scraped for Monday sale-rate; no `n/a` Sedo ritual.
- AT-2 **Books:** After delist+record, `GET /books.csv` / portfolio show no `sedo` in `listed_venues` for owned names (already true 2026-10-27; must remain after any cleanup).
- AT-3 **Negative — no new Sedo list:** Bots/docs do not instruct new Sedo listings; CR text forbids rebuild.
- AT-4 **Export:** New listing flow does not set Sedo `export_pending` for routine Afternic-only lists (or documents Sedo export disabled).
- AT-5 **Delist plan artifact:** `docs/requests/SEDO-DELIST-PLAN-2026-10-27.md` records KEEP-4 / delist cancelled (t971u); no UI delist of those names.

## Out of scope
- Delisting the KEEP-4 (cancelled).
- New Sedo listings without a fresh Dvir yes.
- Spaceship SellerHub implementation.
- Afternic Portfolio API sync (separate CR).
- Books sole-store (CR-084).

## Questions (≤3)
1. If Sedo dashboard shows zero live listings for our five names, is AT-2 + plan “none to delist” enough to close the delist half without a UI click? **Default yes.**
2. Keep `GET /export/sedo.csv` route returning empty/historical vs remove later? Default: leave route, stop using it.

## DVIR items
- **Delist:** cancelled (t971u KEEP). No further delist tap unless Dvir reopens.

## Changes
- 2026-10-27 ~02:46 IDT (DOM Architect): filed from Dvir §10 B; companion delist plan filed same commit.
- 2026-10-27 ~03:18 IDT (DOM Architect): Dvir t971u KEEP-4 / delist cancelled; T-SELL + no-new-Sedo still on; plan + this CR amended.
- Security A (same night, Gavriel): Mac secrets/local-tool access accepted for now; revisit before real money volume — not a CR-085 build item.
