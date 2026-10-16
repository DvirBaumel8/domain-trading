# CR-060 · S8 import accepts Dvir's approved Buy Now and floor
**From:** Gavriel (Grok Bot) · 2026-10-16 ~14:55 IDT · Follow-up to CR-059 (v5.8.0). **APPROVED by Dvir 2026-10-16 14:51 IDT — build.** No settings activation; /buy stays dry_run.

## Urgency
Dvir's import approval for **mineunited.com** (D-005, GoDaddy closeout, $24.19, live on Afternic at $3,488 BIN / $2,267 floor) expires **~2026-10-19 14:50 IDT** (72h). Today a dry-run import prices it at $1,488 (the CR-059 rung search stops at the top Line-1 rung), which would clash with the live listing. Please ship before that deadline.

## Why
CR-059 maps S8 BIN to the lowest price-list rung ≥ comps value; the list tops out at $1,488. Dvir's 2026-10-14 decision set the S8 ladder at $2,488 / $3,488 / $4,888 by length with a 3-year hold. The import also trips `REGISTRATION_TERM_INVALID` for closeouts, whose expiry often lands about a year after transfer.

## Scope (build)
1. **Approved overrides:** `POST /portfolio/import` with `lane=S8` accepts optional `bin_override` and `floor_override` (integer cents). Accept them only when `approval_ref.text` names the price (e.g. contains "$3,488" for 348800); otherwise 422 `APPROVAL_INVALID`. Echo the stored values in `s8.bin_cents` / `s8.floor_cents`.
2. **S8 default ladder:** without an override, S8 BIN comes from the S8 ladder per Dvir's 2026-10-14 decision ($2,488 / $3,488 / $4,888 by name length; DOM proposes the length cut-offs in the reply, matching the NOTE-2026-10-14-S8-aftermarket-lane.md plan), not capped at $1,488. Line 1 pricing unchanged.
3. **Floor default:** 65% of BIN when `floor_override` is absent (S8 only).
4. **Expiry window:** for S8, accept `expiry_date` up to `buy_date + 2 years + 30 days` (closeout plus the transfer year), so `REGISTRATION_TERM_INVALID` doesn't trip. Line 1 unchanged.
5. **Price-drop schedule:** S8 deals don't get the Line-1 M6/M18 drops (3-year hold per Oct 14 decision) unless a schedule is set explicitly on the deal.
6. **Keep every CR-059 guard:** approval required; `price_paid` ≤ $50 (`S8_PRICE_CAP`); 10 S8 slots; NameJet / SnapNames / DropCatch refused (`BACKORDER_SOURCE_REFUSED`); source must be closeout | fixed | auction. No new `pricing_settings` version, no settings activation.

## Acceptance (pass/fail)
1. Dry run `POST /portfolio/import` for mineunited.com (lane S8, closeout, GoDaddy, $24.19, buy_date 2026-10-16, expiry 2027-09-07) with `bin_override` 348800, `floor_override` 226700 and approval text naming $3,488 → 200, `s8.bin_cents` 348800, `s8.floor_cents` 226700, `would_be_blocked` null.
2. Same without `approval_ref` → 422 `APPROVAL_INVALID` (still refused).
3. Override whose price is not named in `approval_ref.text` → 422 `APPROVAL_INVALID`.
4. No override → BIN from the S8 ladder (≥ $2,488), floor = 65% of BIN.
5. S8 expiry at buy_date+2y+30d accepted; one day later refused with `REGISTRATION_TERM_INVALID`.
6. S8 deal shows no M6/M18 drop in the price schedule / `POST /jobs/preview`.
7. CR-059 guards unchanged: $50.01 → `S8_PRICE_CAP`; source namejet → `BACKORDER_SOURCE_REFUSED`.

Gavriel's test script (dry run only): `qa/s8import/imp.py` on Gavriel's box.

## Approval (2026-10-16 14:51 IDT)
Dvir, verbatim: *"Yes, file CR-060 so DOM accepts my approved Buy Now and floor for S8 names"*

DOM: cleared to build CR-060 as scoped. Do not activate or change settings beyond this scope; `/buy` stays `dry_run: true`; every live import still needs Dvir's own line naming the domain.

## Prior trail
- CR-059-s8-import-lane-and-line-pnl.md (receipt 2026-10-16 13:31 IDT)
- NOTE-2026-10-14-S8-aftermarket-lane.md
