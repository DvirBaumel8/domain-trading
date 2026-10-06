# POST /sold/{domain} (WRITE)

Records a sale with its commission and fees, so `/report` shows profit and ROI. **System-triggered (Dvir, 5 Oct 2026, 19:47):** Gavriel calls it automatically on a marketplace sale notification; no approval needed with evidence. Dvir's relayed words in `approval_ref` mark it `confirmed`. Shape: `docs/contract/endpoints.md`.

## Rules
- Without `approval_ref`: `transaction_ref` **and** `evidence {source, ref}` are required, else 422 `EVIDENCE_REQUIRED` (nothing written). `evidence.source` ∈ `afternic_email`, `sedo_email`, `afternic_dashboard`, `sedo_dashboard`, `escrow`, `other`; `ref` = the notification's Message-ID `<id@host>` for email sources, else a dashboard/escrow reference without `@` (`NO_PII`); never a person's address or name. Evidence may also accompany an approval. `transaction_ref` has no `@`. An `approval_ref` must name the domain and not predate `sold_at` (`APPROVAL_INVALID`).
- `sold_at` ISO with offset, ≤ 5 min in the future (`SOLD_AT_IN_FUTURE`), not before the buy date (`VALIDATION_ERROR`).
- Same `venue` + `transaction_ref` already in `sales` → 409 `SALE_ALREADY_RECORDED` (checked first, any domain). A same-key replay returns the stored response.
- Status must be `owned`, `listed` or **`delisted`** (outreach or a late buyer), else 409 `NOT_SELLABLE_STATE`; unknown domain → 404 `NOT_IN_PORTFOLIO`.
- `offer_id`: an `open`/`countered`/`accepted` offer on this domain, else 422 `OFFER_MISMATCH`; in the same transaction its outcome → `sold`, note `via /sold` (confirmed) or `system: <evidence.source> <evidence.ref>` with each `@` written as ` at ` (offer notes can't hold `@`; the exact ref stays in `sales.evidence_ref`).
- **One transaction** under the per-domain lock: ledger `sale` +price, `commission` −commission (if > 0), `fee` −other_fees (if > 0), `payout_fee` −payout_fee (if > 0, note `payout fee`); `counterparty` = venue, `receipt_ref` = `transaction_ref`. The payout amount itself is never a ledger row and isn't tracked (removed with the `payouts` table, 6 Oct 2026; a `payout` object → 422). `commission + other_fees + payout_fee ≤ sale_price`. Status → `sold`, `sold_at`; open schedule rows `cancelled`. One `sales` row (`sale_ledger_id`, amounts, `recorded_by` = the token name, `confirmed`, approval, evidence, `audit_id`; immutable).
- **Commission check (warning `COMMISSION_UNEXPECTED`, never a block)** when off by > $1: Afternic 15% if the lander NS was afternic at `sold_at`, else 25%, min $15; Sedo 10/15/20%; Afternic Custom Checkout 5%.
- **Response:** net proceeds and profit for this domain (sale − commission − fees − all acquisition costs), the `sales` summary, and the checklist: "Remove the listing on the *other* marketplace now (double-sale risk)"; "Do not send an auth code outside the marketplace flow"; "Auto-renew stays off"; plus the manual removal if the name is in `X-Manual-Delist`.
- Unconfirmed sales show in `/report` as `SALE_UNCONFIRMED` (info).

## Tests
| ID | Case | Pass |
|---|---|---|
| S-1 | Valid Afternic sale | 3 ledger rows with the right signs; `sold`; profit 1995 − 299.25 − 11.08 = **$1,684.67** |
| S-2 | 10% commission on an Afternic-NS domain | 200 + warning "expected 15%" |
| S-3 | Already sold | 409 |
| S-4 | No approval and no evidence (or no ref) / evidence + ref without approval | 422 `EVIDENCE_REQUIRED`, nothing written / 200, `confirmed: false`, rows as S-1 |
| S-5 | Replay | 1 set of rows |
| S-6 | READ token | 403 |
| S-7 | `/report` after a sale | Sales and ROI include it |
| S-8 | Checklist | Includes "remove the other listing" |
| S-9 | Sale of a `delisted` domain | 200, `sold`, rows as S-1 |
| S-10 | `offer_id` of an open offer on this domain | 200; offer `sold`; one transaction |
| S-11 | Another domain's offer, or a declined one | 422 `OFFER_MISMATCH`; nothing written |
| S-12 | S-1 + `payout_fee` 15.00 | A `payout_fee` row −1500 (note `payout fee`); no payout-amount row; replay writes nothing |
Removed 6 Oct 2026 (Dvir): S-13–S-15 (payout amount, `PAYOUT_MISMATCH`, `payouts`, `received_on`) and `PAYOUT_OVERDUE`.
