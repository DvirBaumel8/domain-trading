---
id: NOTE-2026-10-27-afternic-push
kind: NOTE
status: approved
owner_bot: dom-architect
approval: "Dvir t978u ~03:34 IDT — Yes push the Afternic dry-run diff for real"
priority: P1
---
# NOTE 2026-10-27 — Dvir yes: Afternic dry-run → **real push NOW**

**Dvir:** "Yes — push the Afternic dry-run diff for real" (t978u, 2026-10-27 ~03:34 Asia/Jerusalem)  
**Relay:** Gavriel → DOM Architect. Afternic seller API already live (v5.61.0); this is API work → **DOM / Claude Code** (t974u), not browser.

## Exact approved diff (no price changes)
Matches live `POST /export/afternic/push {"dry_run":true}` from Claude Code ~03:31 IDT:

| Domain | Change |
|---|---|
| **all 5** | `max_lease_months` 16 → **12** |
| promptinjectionaudit.com | `show_offer` false → **true** (Make Offer ON) |
| mineunited.com | `show_offer` false → **true** (Make Offer ON) |
| aievalsconsulting.com | `show_lto` false → **true** (LTO on; show button) |
| ukcbamcompliance.com | `show_lto` false → **true** |
| roofingvoiceagent.com | `show_lto` false → **true** |

**Forbidden:** any BIN / floor / min-offer / price field change; Sedo changes; new listings; browser UI.

## BUILD NOW (Claude Code)
1. Run **real** push: `POST /export/afternic/push` with `dry_run: false` (or the contract’s real-push flag) for **exactly** the approved diff above.
2. **Stamp receipt** in this file under `## Receipt` and one line at top of `DOM-TO-GAVRIEL.md`: timestamp (Asia/Jerusalem), HTTP status, per-domain ok/fail, confirmation that **prices unchanged**.
3. Re-read / portfolio or Afternic readback: lease max 12 on all five; Make Offer on for promptinjectionaudit + mineunited; LTO button shown for the other three.
4. If any name fails: stop further pushes; report which failed; do not retry price-touching paths.

## Acceptance
- AT-1: Real push returns success for all 5 (0 failed).
- AT-2: Prices unchanged vs pre-push (BIN/floor/min offer).
- AT-3: Receipt stamped in this NOTE + `DOM-TO-GAVRIEL.md` within the same session.
- AT-4 (negative): No Sedo or browser path used.

## Out of scope
Price edits; Sedo; Spaceship; GoDaddy key; new names.

## Receipt
_(Claude Code fills)_

## Changes
- 2026-10-27 ~03:34 IDT (Gavriel): Dvir yes NOTE filed (6d11652).
- 2026-10-27 ~03:35 IDT (DOM Architect): BUILD NOW + receipt contract for Claude Code.
