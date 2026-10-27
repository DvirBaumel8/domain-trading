# Buyer SOP amend (CR-088) — draft for DOM/Buyer

**Status:** waiting CR-088 phase 1 live.  
**Dvir 2026-10-28:** no artificial cuts; review the full hard-filter auction field.

## Changes vs current `04-buyer-shortlist-to-card.md`
1. Pool = **entire** `GET /auctions/shortlist` for the newest data date (all hard-filter passers), not default 25 / lean 20.
2. Cheap local filters first (shape, price band, prior kills, meaning) across the **full** list; spend USPTO / firm / CR-083 only on survivors.
3. Every run ends with a **top 5 ranked review report** (with disadvantages). Real **buy cards** only for names that clear Risk Gate — not forced 5 cards.
4. Lean ~20 outside-call budget: raise or batch when the field is hundreds; do not silently drop unread names — log how many were not fully judged and why.
5. Closeouts stay research-only while paused.

Gavriel will merge into the live SOP after CR-088 AT-1…AT-5 pass.
