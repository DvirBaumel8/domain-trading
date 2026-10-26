# Job: Dynadot aftermarket panel R-8 / R-8v2 watch

## Purpose
Watch Dynadot aftermarket listing totals (sample pages) so we notice inventory-shape changes. If totals collapse (e.g. 5.73M → ~470k), do **not** upload a full panel — write GAP and keep R-8v2 unfrozen until two consecutive observed small-total days (rule as of Oct 2026).

## Algorithm (plain words)
1. Within the Dynadot daily call budget, read page 1 (and the frozen R-8 page set when in full mode) via `list_aftermarket_listings`.
2. Record total and page emptiness.
3. If total looks wrong vs recent complete days (order-of-magnitude drop or empty deep pages): write `GAP.md`, **do not upload** the panel, do not backfill.
4. If totals look normal: save/seal panel pages per CR-071 page list and upload under Idempotency-Key.
5. R-8v2 freeze: only after **2 consecutive** observed small-total days (one day alone is not enough).

## Inputs / outputs
- In: Dynadot aftermarket list API (read-only), prior day totals.
- Out: sealed panel for date D, or GAP note; R-8v2 freeze flag when criteria met.

## Pass / fail
- Pass: either a sealed panel or an explicit GAP; never a silent empty upload.
- Fail: uploading a collapsed total as if complete; freezing R-8v2 on a single observation day.

## Why bot vs why DOM
Mechanical watch + GAP rule. **Move to DOM as primary** inside datasave. Grok backup only.

## Token cost class
Low.

## Owner
- Primary: DOM datasave (R-8 watch step)
- Backup: Gavriel / DOM Architect with lock

## Sources
Oct 22 GAP (5.73M → 470k); Oct 26 catch-up (panel GAP ~471k, one observation day); data-engineer handoff §2 R-8 pages; CR-071.
