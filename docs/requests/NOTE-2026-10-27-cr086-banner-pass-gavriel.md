# NOTE — CR-086 stale-scout banner pass (Gavriel, company box)

**When:** 2026-10-27 ~16:25 Asia/Jerusalem (IDT)  
**Who:** Gavriel (executor), after Dvir t992u “complete JOINT-OPS leftovers”  
**No money. No bak deletes. No marketplace writes.**

## Bak half (AT-2 verified this turn)
- `find /workspace/domain-trading -name '*.bak*' ! -path '*/archive/*'` → **0**
- Files under `archive/bak-2026-10-27/` → **267** (266 moved `.bak*` + `MANIFEST.txt`)
- Inventory: `docs/requests/BAK-ARCHIVE-INVENTORY-2026-10-27.md` present
- Manifest: `archive/bak-2026-10-27/MANIFEST.txt` present

## Banner pass (company-box only; not in git clone paths)
Prepended one CR-086 / org-v2 / JOINT-OPS superseded banner (history keep; no body rewrite) to **13** files:

1. `knowledge/handoffs/geo-scout.md`
2. `knowledge/handoffs/signals-scout.md`
3. `knowledge/handoffs/drops-scout.md`
4. `knowledge/handoffs/rules-scout.md`
5. `knowledge/handoffs/scoring-scientist.md`
6. `knowledge/handoffs/cfo.md`
7. `knowledge/handoffs/data-engineer.md`
8. `knowledge/handoffs/legal.md`
9. `system/bot-team.md`
10. `system/README.md`
11. `company/company.md`
12. `company/dom-capabilities-and-split-2026-10-17.md`
13. `company/first-production-run-plan-2026-10-17.md`

**Already bannered (skipped):** `org/team.md` (existing SUPERSEDED 2026-10-20 by org-v2).

**Skipped on purpose (not day-to-day role owners / historical only):** `challenge/**`, `daily/**`, `dry-runs/**`, `qa/**`, `deals/**`, dated legal notes, `org/org-v2.md` (current), `company/brief/brief-team.md` (already says scouts retired).

**Git:** none of the above paths exist under `/workspace/dt` (BOXONLY). No docs commit for the banners themselves — this NOTE is the stamp request.

## Please stamp CR-086
If AT-2 + this banner pass satisfy R-3, set CR-086 `status: done` (or equivalent) and note the 13 paths + skip list. Architect owns the CR file status.

## Live API snapshot (same turn; for board, not CR-086)
- Working base this turn: `https://domain-trading-api-proxy.dvirbaumel9.workers.dev` (baumel8 proxy TLS EOF from box; Render `domain-trading-api.onrender.com` returns Service Suspended).
- `GET /health` → **version 5.67.0**, `datasave: ok`
- `GET /report` still has **3× LANDER_PRICE_MISMATCH**:
  - aievalsconsulting.com / roofingvoiceagent.com: shown **$49,999,999** (`checked_at` still ~02:06 IDT)
  - ukcbamcompliance.com: shown **$100,000** (`checked_at` 16:21 IDT) vs expected $1,488
- BUG-054 AT-4 **not cleared** yet (bots token cannot `POST /jobs/run`).
- CR-080: code claimed live in 5.62.0 notes; latest datasave job steps still `dynadotCloseouts` / `dynadotAftermarket` **`not_configured`** with reason `DYNADOT_API_KEY is not set` (runs through 2026-10-26 ~22:33 IDT). 3-day server-primary ok window **not started** on observed runs. Purchase adapter `dynadot.enabled: false` (expected for buy adapter).
