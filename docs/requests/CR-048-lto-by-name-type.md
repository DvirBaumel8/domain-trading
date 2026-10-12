# CR-048: lease-to-own by name type (amends CR-046 and CR-047)

From: Gavriel, 2026-10-13 01:38 IDT. Dvir's decision at 01:38 IDT: "Lease-to-own only for long-lasting names; off for names that drop after 12 months".

## What changes
- **CR-046:** "lease-to-own on at Afternic" is narrowed. LTO is offered only on future **evergreen** (long-lasting) names.
- **All 4 current names keep LTO off** (they are trend/regulation names under the 12-month drop rule): ukcbamcompliance.com, aievalsconsulting.com, roofingvoiceagent.com and our first name. Don't switch it on in any Afternic upload.
- **CR-047:** upload roofingvoiceagent.com with **LTO off** (`lto_max_months: null`, as the dry run shows). Ignore the LTO item there.

## Ask
- Make `LTO_NOT_ALLOWED` apply by name type: refuse `lto_max_months` on a name flagged for the 12-month drop (trend/regulation lanes, or a `drop_date` within about 12 months of the listing), and allow it only on evergreen names, still within the existing rules (hybrid, BIN range, ends before `drop_date`).
- Tell me the field or category that marks a name evergreen, so scouts can set it on buy cards.
- Receipt in `DOM-TO-GAVRIEL.md`.

## DOM response (2026-10-13)
**Accepted, and built with CR-045 item 2.**
- **The field that marks a name evergreen is `horizon`** (`evergreen` | `trend` | `regulation`): on the buy card at `/buy` (optional, default `evergreen`), or later with `POST /portfolio/{domain}/horizon`.
- **The rule:** `lto_max_months` is refused with 422 `LTO_NOT_ALLOWED` when the name's horizon is `trend` or `regulation`, or when its `drop_date` is the first expiry. On an `evergreen` name the existing LTO rules still apply: an override with Dvir's approval, a hybrid listing, and the lease must end before `drop_date`.
- **Scouts:** set `horizon` on each card. Trend and regulation names should also be bought with `drop_policy: at_first_expiry`.
- **This run (CR-047):** roofingvoiceagent.com is uploaded with LTO off, like the other three. D-002 to D-004 move to `trend` or `regulation` with the horizon route once it ships.

## Gavriel reply (2026-10-13 02:00 IDT)
Accepted. Scouts will set `horizon` on buy cards (`evergreen` | `trend` | `regulation`); trend/regulation also use `drop_policy: at_first_expiry`. Current four names stay LTO off. Horizon calls for D-002–D-004 wait until the CR-045 horizon route is live. Confirming v3.10.0 on `/health` separately.
