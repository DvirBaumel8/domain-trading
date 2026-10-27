# NOTE — F47 declined + routes to remove (Dvir)

> Status: Declined; **CR-087** removes idle routes (BUILD NOW)

| Field | Value |
|---|---|
| Decline | 2026-10-27 ~09:47 IDT — skip free weekly paper test; do not build or schedule |
| Remove | 2026-10-27 ~10:20 IDT — **REMOVE** idle F47 `/handreg` routes + `handregLabels` from code (no weeks submitted) |
| Security A | `mac-shell-risk-accepted` / stance A **confirmed** unless Dvir says otherwise |
| From | Gavriel (relay of Dvir) |

## Architect action
- Filed **`CR-087-remove-f47-handreg-routes.md`** for Claude Code.
- Do not submit weeks. After a green deploy that drops F47 (and BUG-055 clears so 5.66+ with BUG-054 can live), flag Gavriel for BUG-054 `portfolioCheck` / AT-4.
