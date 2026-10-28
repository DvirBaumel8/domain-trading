# Bot-logic stubs (Gavriel, 2026-10-26)

Dvir approved: write stubs for the top 3 recurring jobs + dual-runner lock rule so DOM can see *why* bots do steps and pull mechanical work into the service when Grok tokens run out.

**Pass mark:** DOM / Claude Code can open one file and answer "move to DOM" or "keep as bot" in one line.

**Canonical home:** `docs/bot-logic/` (placed from `docs/requests/bot-logic/` under CR-080).

| File | Job | Token class | Primary → target |
|---|---|---|---|
| `01-godaddy-dynadot-daily-seal.md` | GoDaddy freeze + Dynadot closeout seal | low (fetch/seal) | DOM datasave primary once `DYNADOT_API_KEY` (Grok backup) |
| `02-dynadot-panel-r8-watch.md` | R-8 / R-8v2 panel watch + GAP | low | DOM datasave primary once `DYNADOT_API_KEY` (Grok backup) |
| `03-missing-name-portfolio-check.md` | Missing-name / portfolioCheck (CR-079) | low | DOM job (already) |
| `00-dual-runner-lock-rule.md` | Lease/claim before dual-capable actions | n/a | both |
| `04-buyer-shortlist-to-card.md` | Buyer discovery: shortlist → card (**discovery v3, Option 1 locked**: one run after the shortlist seal, directions A+B+D, C parked, full-stack passers; commit the run pack before exit, CR-089) | high (judgment) | keep as bot |
| `09-company-day-timeline.md` | Who does what after the datasave, through Dvir's yes (Option 1 locked after the shortlist seal) | n/a | reference |

Out of scope here: buy-card judgment, Challenger critique, CR drafting, three-way decisions with Dvir.

**Since CR-091 (28 Oct 2026)** bots may push changes to `docs/bot-logic/**` themselves (`.github/workflows/requests-only.yml` allows it), so a stamp no longer waits for Claude Code. Drafts can still start under `docs/requests/bot-logic/`. Discovery run packs live in `docs/requests/discovery-runs/` (CR-089).
