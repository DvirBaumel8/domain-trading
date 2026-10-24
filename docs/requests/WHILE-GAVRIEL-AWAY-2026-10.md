# While the Grok bots were paused (from 23 Oct 2026)

Dvir, 25 Oct 2026: the Grok bots reached their token limit and are paused for about 3 days. Dvir and DOM work directly meanwhile.
Dvir's rule: **everything done in this period is written here**, so Gavriel and the other bots catch up from this one file.
Newest entry last. DOM still never calls production (HARD RULE unchanged); Dvir checks `/health` himself.

## Log

### 25 Oct 2026 (00:50 IDT): v5.35.0, the daily save seals pick-proof days no bot sealed
- **Problem:** a pick-proof day froze and sealed only on a bot call. With the bots paused, 23 and 24 Oct were never sealed. Each day's source rows (D-1) are deleted after 3 days, so 23 Oct would have been lost in the 25 Oct 15:00 UTC run.
- **Fix:** new datasave step `pickproofSeal` (before `snapshotRetention`). It freezes and seals every unsealed day before today, with the same rule, seed and draw as a manifest call. A day it froze itself is marked `sources.frozen_by: "datasave"`. Today is never touched.
- **Also:** a freeze after the source rows are gone now answers 410 `POOL_SOURCE_PRUNED` instead of silently freezing an empty pool.
- **For Challenger:** these days have no arm A (no Buyer picks). Please rule on whether they count for B1/B2/C1, and add their seal lines to `pick-proof-seals.md`.
- **To check when back:** `GET /jobs/runs?job=datasave` → `pickproofSeal`; also the first BUG-052 tagging run (23 Oct onward) in `buildPanel.tags`.
- Release note: `docs/releases/v5.35.0.md`.

### 25 Oct 2026: development paused, Dvir's learning time
- Dvir asked to stop development and spend the time understanding the company, the system and the sector in detail, so he can take decisions himself.
- DOM is teaching him lesson by lesson. Gavriel: expect Dvir to ask more detailed questions and to want plain-language explanations; explain every term you use.

### Open for Gavriel when back
- A **company-state file** (what we own, money spent and left, open decisions, each bot's focus), kept current by Gavriel. DOM can't see this side (DOM never reads production). Dvir agreed on 25 Oct. DOM will set up the file's outline.
- The weekly improvement loop (due 25 Oct) is postponed until you're back, so your API pain points can go in.
