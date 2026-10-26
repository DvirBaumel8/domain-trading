# Job: daily missing-name / portfolio ownership check (CR-079)

## Purpose
Each day, compare (1) registrar/registry hold, (2) Afternic/Sedo records we confirmed, (3) portfolio ledger. Warn Gavriel on `/report` if a name is missing, on hold, listed without approval trail, or missing a receipt pointer. Detects theft/mis-list risk without scraping marketplaces.

## Algorithm (plain words)
1. For each live name (owned | listed | delisted): read registrar presence + RDAP state; read DOM `ours_confirmed` venues + confirmed export; read ledger `receipt_ref`.
2. Raise existing codes where they already fit (`DOMAIN_LEFT_ACCOUNT`, `REGISTRY_MISMATCH`, `HOLD_STALE`, `RECEIPT_MISSING`).
3. New codes (fold into `portfolioCheck`, not a separate step):
   - `LISTING_RECORD_MISSING` (warn)
   - `LISTING_UNAPPROVED` (warn) — sealed/confirmed export counts as approval trail; pending/stale does not
   - `RECEIPT_POINTER_MISSING` (warn)
   - `OBSERVED_UNCONFIRMED` (info only)
4. Quiet when clean (`alerts_n: 0`). Gavriel reads `/report`; do not message Dvir for clean runs.

## Inputs / outputs
- In: portfolio, registrar adapters, listing venues, export confirms, ledger.
- Out: `/report` warnings + `portfolioCheck` job summary `by_code`.

## Pass / fail
- Pass: AT-1…AT-7 in CR-079; Gavriel sees warnings without a new bot.
- Fail: scraping Afternic/Sedo; separate `ownershipCheck` step; money/list writes.

## Why bot vs why DOM
Already specified as a **DOM daily job** (CR-079 → 5.58.0). Keep as DOM. No Grok primary.

## Token cost class
Low (DOM). Zero Grok if `/report` is only read on the morning DOM check routine when warnings fire.

## Owner
- Primary: DOM `portfolioCheck`
- Backup: none required for the check itself; Gavriel only **reads** `/report`

## Sources
`docs/requests/CR-079-daily-missing-name-check.md`; Dvir Oct 23 yes; Gavriel round-1 answers 2026-10-26.
