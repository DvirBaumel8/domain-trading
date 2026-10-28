---
id: CR-091
kind: CR
status: done
owner_bot: dom-architect
approval: "Dvir t1067u via Gavriel 2026-10-28 ~21:10 IDT: GO copy requests bot-logic stamps → live docs/bot-logic/ (incl. 04); Claude Code; no CloudAgents."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-091: sync live `docs/bot-logic/` from requests stamps

**Approval:** Dvir t1067u via Gavriel. **No money.** Docs only. No CloudAgents — Claude Code only (bots-edit-only blocks bot pushes to `docs/bot-logic/`).

## Why
Discovery v3 Option 1 + directions were stamped under `docs/requests/bot-logic/` (`04`, `09`, README; commit `775bfee7` and Buyer `95f932fb`). Live `docs/bot-logic/04-buyer-shortlist-to-card.md` is still on discovery v2. Bots and humans reading live path get the wrong cadence.

## Rules
- R-1 Copy **current** requests drafts into live paths (overwrite live with requests content for these files):
  - `docs/requests/bot-logic/04-buyer-shortlist-to-card.md` → `docs/bot-logic/04-buyer-shortlist-to-card.md`
  - `docs/requests/bot-logic/09-company-day-timeline.md` → `docs/bot-logic/09-company-day-timeline.md` (create if missing)
  - Optionally sync `05`–`08`, `10` if live missing and requests has them.
- R-2 Preserve live `00`–`03` mechanical stubs unless requests has a newer approved replacement.
- R-3 Update `docs/bot-logic/README.md` to list `04`/`09` as discovery v3 Option 1 locked.
- R-4 Include standing from CR-089: after discovery seal, commit run pack (path per CR-089) before exit — one short bullet in `04`.
- R-5 Do **not** change `src/` or workflows except if NOTE-2026-10-26 requests-only guard is updated in the same PR to allow bot edits to `docs/bot-logic/**` (optional; preferred so future stamps need no Claude for docs-only). If guard change is out of scope tonight, docs sync alone is enough.

## Acceptance tests
- AT-1 Live `docs/bot-logic/04` status line says discovery **v3** / Option 1 / A+B+D / C parked / full-stack passers.
- AT-2 Live `docs/bot-logic/09` (if created) says Option 1 locked after shortlist seal.
- AT-3 No product code change required for AT-1/AT-2.
- AT-4 (Optional) Bot commit touching only `docs/bot-logic/**` passes `requests-only` if guard updated.

## Out of scope
Shape features; health CR-090; money; CloudAgents.

## Questions (≤1)
1. Update requests-only.yml in this PR? **Default: yes if small; else docs sync only.**

## DOM response (28 Oct 2026, ~21:20 IDT): done

- **AT-1:** live `docs/bot-logic/04` = the requests copy (discovery v3, Option 1, A+B+D, C parked, full-stack passers). DOM fixed step 0.0 #3 in both copies to the CR-089 path.
- **AT-2:** live `docs/bot-logic/09` created from the requests copy. Its status line now says it was placed by CR-091.
- **README:** `04` and `09` added to the table.
- **R-1 optional files:** `05`–`08` and `10` were not copied, because their approval state isn't stamped. Now that bots may push to `docs/bot-logic/`, move them when they're approved.
- **Question 1 / AT-4:** yes. `.github/workflows/requests-only.yml` lets bot commits touch `docs/requests/**` and `docs/bot-logic/**`. `docs/DEPLOYMENT.md` updated.
- **Note:** `f6fe1a5f` (DOM Architect) edited `docs/contract/endpoints.md` and `docs/internal/auctions.md`. Those stay DOM-only. The wording was right and DOM kept it, but please send contract wording as a note or CR next time.
