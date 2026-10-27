# Sedo delist plan — CANCELLED (keep existing listings)

**Status:** **KEEP existing 4** — delist **cancelled** by Dvir (t971u, 2026-10-27 ~03:18 IDT) after earlier YES (t967u) and pause on browser delist  
**Still in force:** `D-2026-10-27-SEDO` — no new Sedo automation, no T-SELL Sedo scrapes, no new Sedo investment  
**Author:** DOM Architect (Grok Bot)  
**Updated:** 2026-10-27 ~03:18 Asia/Jerusalem (IDT)

## Decision timeline
| When (IDT) | What |
|---|---|
| ~02:44 | §10 B FULL OFF proposed (T-SELL + delist) |
| t967u | Dvir YES remove 4 Sedo listings; Gavriel started browser delist |
| t971u | **Override: KEEP** the 4 live listings; do **not** delist. Claude Code Sedo UI struggle ≠ reason to remove inventory |

## Keep (live Sedo — do not remove)
| Domain | Note |
|---|---|
| aievalsconsulting.com | KEEP |
| promptinjectionaudit.com | KEEP |
| roofingvoiceagent.com | KEEP |
| ukcbamcompliance.com | KEEP |

**Skip:** mineunited.com — not on Sedo.

## DOM books (read-only context)
Books may still show `listed_venues=afternic` only; marketplace Sedo pages can exist without DOM `ours_confirmed`. **Do not** clear Sedo from books as if delisted. After any books sync, existing Sedo inventory stays unless Dvir says otherwise.

## Still required (CR-085 money-free half)
1. Drop Sedo from Monday T-SELL scrapes (no `n/a` ritual).
2. No new Sedo listings / exports / automation rebuild.
3. Research S2S alternatives stays bot/doc note only (Afternic API, Spaceship later).

## Out of scope
Afternic changes; Spaceship build; price edits; bak archive; revoking shared DOM token.

## Sign-off
- [x] Dvir: KEEP 4 (t971u) — delist cancelled
- [x] mineunited: skip (not on Sedo)
- [x] Gavriel: after pause, confirm browser left those 4 live (no accidental delist) — login wall then Dvir Wait; none removed (~03:19 IDT)
- [x] DOM Architect: plan + CR-085 notes updated to keep

## Changes
- 2026-10-27 ~02:46 IDT: filed waiting verify + Dvir tap.
- 2026-10-27 ~03:18 IDT: Dvir override KEEP; delist cancelled; T-SELL/no-new-Sedo still on.
- 2026-10-27 ~03:19 IDT: Gavriel confirm — browser never removed any of the 4; checkbox closed.
