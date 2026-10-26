# Bot-logic stubs (Gavriel, 2026-10-26)

Dvir approved: write stubs for the top 3 recurring jobs + dual-runner lock rule so DOM can see *why* bots do steps and pull mechanical work into the service when Grok tokens run out.

**Pass mark:** DOM / Claude Code can open one file and answer "move to DOM" or "keep as bot" in one line.

**Canonical home:** `docs/bot-logic/` (placed from `docs/requests/bot-logic/` under CR-080).

| File | Job | Token class | Primary → target |
|---|---|---|---|
| `01-godaddy-dynadot-daily-seal.md` | GoDaddy freeze + Dynadot closeout seal | low (fetch/seal) | DOM datasave (Grok backup) |
| `02-dynadot-panel-r8-watch.md` | R-8 / R-8v2 panel watch + GAP | low | DOM datasave (Grok backup) |
| `03-missing-name-portfolio-check.md` | Missing-name / portfolioCheck (CR-079) | low | DOM job (already) |
| `00-dual-runner-lock-rule.md` | Lease/claim before dual-capable actions | n/a | both |

Out of scope here: buy-card judgment, Challenger critique, CR drafting, three-way decisions with Dvir.
