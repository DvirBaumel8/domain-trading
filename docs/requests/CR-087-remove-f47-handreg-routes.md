---
id: CR-087
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir Oct 27 ~10:20 IDT via Gavriel widget: REMOVE idle F47 hand-registration routes. Decline of F47 stands; no weeks submitted. mac-shell-risk-accepted / stance A confirmed unless he says otherwise."
priority: P1
depends_on: ["BUG-055"]
supersedes: ["F47-handreg-5.66.0"]
max_rounds: 2
---

# CR-087: remove idle F47 hand-registration routes

**Approval:** Dvir ~10:20 IDT (Gavriel relay + `GAVRIEL-TO-DOM.md`). **BUILD NOW.** Report when live on `/health`. No money. Max **2 rounds**.

## Why
5.66.0 shipped `POST/GET /handreg/*` and datasave `handregLabels` after a mix-up (Dvir "Yes accept" was read as F47 start; Gavriel's ~09:47 decline relay wins). Dvir then ordered the **idle routes removed from the code**. No weeks were submitted; nothing to migrate.

## Rules
- R-1 **Remove public surface.** Drop `POST /handreg/weeks`, `GET /handreg/weeks`, `GET /handreg/weeks/{week}`, `GET /handreg/report` (contract §Hand-registration paper test, 5.66.0). Those paths must **404** (or equivalent not-found) with no body that accepts a week seal.
- R-2 **Remove job step.** Drop datasave step `handregLabels` from the jobs contract and from the run order. A datasave run must not call RDAP for hand-reg labels.
- R-3 **Remove settings / tables / docs that exist only for F47.** `handreg_*` settings, hand-reg week tables, `docs/internal/handreg.md` (or archive under `docs/archive/`), and contract sections for F47. Keep unrelated "handreg" **feature names** in the scoring engine (`acq` / `handreg_share` = creation-age feature) — those are not F47.
- R-4 **No weeks data.** Zero submissions expected. If any row exists, leave it unread and drop with the tables (or archive once then drop) — prefer empty drop.
- R-5 **Decisions stay.** Keep `/decisions` rows `f47-handreg-paper-declined` (and any supersede chain). Do not re-open F47.
- R-6 **No money / no browser / no registrar.** Removal only.
- R-7 **CI.** Pair with **BUG-055** (flaky DYN-10) so a green build can deploy: either 5.66.0 then this follow-up, or one release that includes BUG-054 + BUG-055 + this removal. Prefer one green deploy that **does not** leave `/handreg` live if avoidable.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-5 pass; `/health` bumps; no `/handreg` surface; no `handregLabels` step. |
| **Stop condition** | Max **2 rounds**. Further gaps = new BUG citing an AT. |
| **Max rounds** | **2**. |

## Acceptance tests
- AT-1 **POST gone:** `POST /handreg/weeks` with a valid-looking body → **404** (or not routed). Nothing sealed.
- AT-2 **GETs gone:** `GET /handreg/weeks`, `GET /handreg/weeks/{any}`, `GET /handreg/report` → **404**.
- AT-3 **Datasave:** job step list / run summary has **no** `handregLabels`. A full datasave does not RDAP for F47 labels.
- AT-4 **Contract:** `docs/contract/endpoints.md` and `jobs.md` no longer document the Hand-registration paper test / `handregLabels` as live API. Version bump on contract README.
- AT-5 **Negative — scoring untouched:** engine `acq` / training drift `handreg_share` (creation ≤36 months) still documented and behaving as before 5.66.0 F47 ship. No portfolio / money route change.

## Out of scope
- Re-building F47 later (needs a new CR + fresh Dvir yes).
- BUG-054 lander parse (already in 5.66.0 tree — keep that fix).
- BUG-055 DYN-10 flake (fix in same or prior green CI).
- CR-086 banners (Architect).

## DVIR items
None further — remove already ordered.

## Changes
- 2026-10-27 ~10:25 IDT (DOM Architect): filed from Gavriel relay of Dvir REMOVE widget.
