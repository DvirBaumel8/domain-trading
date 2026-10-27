# Sedo delist plan (propose first — no clicks yet)

**Status:** Waiting verification + Dvir one-tap if any live Sedo listing must be removed  
**Decision:** `D-2026-10-27-SEDO` extended by Dvir §10 B (2026-10-27 ~02:44 IDT) — FULL OFF  
**Author:** DOM Architect (Grok Bot)  
**Date:** 2026-10-27 ~02:46 Asia/Jerusalem (IDT)

## What Dvir ordered
Drop Sedo T-SELL scrapes **and** remove/delist Sedo listings (not placeholders). Hold money/list clicks until his one-tap if UI requires it.

## DOM books (read-only, 2026-10-27 ~02:46 IDT)
All five owned names: `listed_venues=afternic` only — **no `sedo` in books.**

| Domain | Deal | DOM listed_venues |
|---|---|---|
| promptinjectionaudit.com | D-001 | afternic |
| ukcbamcompliance.com | D-002 | afternic |
| aievalsconsulting.com | D-003 | afternic |
| roofingvoiceagent.com | D-004 | afternic |
| mineunited.com | D-005 | afternic |

CR-076 historically noted Sedo for D-002/D-003 as `unknown` / ownership review — may still exist on Sedo’s site without DOM `ours_confirmed`.

## Proposed steps (Gavriel executes after Dvir tap if needed)
1. **Verify (no change):** For each domain above, check Sedo seller dashboard + public Sedo search whether a listing exists.
2. **If none exist:** record “none to delist” here; close delist half; still enforce T-SELL drop (CR-085). **No Dvir tap required.**
3. **If any exist:** list domain + Sedo listing id/URL + recommended action (seller delist / deactivate). **Stop.** Gavriel brings Dvir one-tap card with that exact list. Only then delist.
4. **After delist:** confirm public page gone; ensure DOM has no Sedo `listed_venues`; no new Sedo export pending.
5. **Do not** touch Afternic listings or NS.

## Out of scope this plan
Afternic changes; Spaceship build; price edits; bak archive.

## Sign-off
- [ ] Gavriel: Sedo dashboard verify done (date/result)
- [ ] Dvir one-tap: only if step 3 list non-empty
- [ ] DOM Architect: books re-check after any delist
