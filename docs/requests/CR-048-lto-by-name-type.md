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
