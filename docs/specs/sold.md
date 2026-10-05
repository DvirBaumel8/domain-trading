# POST /sold/{domain}  (WRITE)

**Goal:** record a sale, its commission and fees (and an optional payout fee), so `/report` shows profit and ROI. **System-triggered (Dvir, 5 Oct 2026, 19:47 IDT):** Gavriel calls it **automatically** when a marketplace sale notification arrives; no approval from Dvir is needed. Gavriel may also send Dvir's words in `approval_ref` (relayed from chat), which marks the sale `confirmed`. **Gavriel calls every endpoint; Dvir never calls the API** (5 Oct 2026).

## Request
`Idempotency-Key` header required.
```json
{ "venue": "afternic",            // afternic | sedo | afternic_checkout | escrow | other
  "sale_price": 1995.00, "commission": 299.25, "other_fees": 0,
  "sold_at": "2027-02-11T14:02:00+02:00",
  "payout_fee": 15.00,              // optional; becomes the `payout_fee` ledger row
  "offer_id": 42,                   // optional: the `offers` row this sale came from
  "transaction_ref": "AFN-123456",   // required when approval_ref is absent
  "evidence": { "source": "afternic_email", "ref": "<a1b2c3@mail.afternic.com>" },   // required when approval_ref is absent
  "approval_ref": { "text": "it sold on afternic for 1995", "approved_at": "..." } }   // optional
```

## Behaviour
- **Approval or evidence:** `approval_ref` is optional. Without it, the request must carry `transaction_ref` **and** `evidence {source, ref}`, else 422 `EVIDENCE_REQUIRED` (nothing written).
  - `evidence.source`: `afternic_email` | `sedo_email` | `afternic_dashboard` | `sedo_dashboard` | `escrow` | `other`.
  - `evidence.ref`: the notification's `Message-ID` (email sources) or the dashboard/escrow reference. It may contain `@` (Message-IDs do); it must not be a person's email address or name.
  - `evidence` may also be sent with `approval_ref` (stored either way).
- **Duplicate check:** a sale with the same `venue` + `transaction_ref` already in `sales` → 409 `SALE_ALREADY_RECORDED` (checked before the state check; any domain). A same-key replay still returns the stored response.
- The domain must be `owned`, `listed` or **`delisted`** (a delisted name can still sell, e.g. via outreach or a late marketplace buyer); otherwise 409 `NOT_SELLABLE_STATE`.
- **`offer_id` (optional):** must be an `open`, `countered` or `accepted` offer on this domain, else 422 `OFFER_MISMATCH`. In the same transaction the offer's outcome becomes `sold` (note `via /sold`, with Dvir's approval text, or, when unconfirmed, `system: <evidence.source> <evidence.ref>` with each `@` written as ` at ` because offer notes can't contain `@`; the exact reference stays in `sales.evidence_ref`).
- One DB transaction writes ledger rows:
  - `sale` +sale_price;
  - `commission` −commission;
  - `fee` −other_fees, if > 0;
  - `payout_fee` −`payout_fee`, if given.
  - The payout amount is never a ledger row (the `sale` row already counts that money) and is not tracked at all.
  - `counterparty` = venue; `receipt_ref` = `transaction_ref`.
- Sets `status=sold` and `sold_at`.
- Writes one **`sales`** row (`00-architecture.md` §4): `sale_ledger_id` = the `sale` ledger row, `venue`, `transaction_ref`, amounts, `sold_at`, `offer_id`, **`recorded_by`** = the calling token's name, **`confirmed`** = `approval_ref` given, `approval_text`/`approval_at`, `evidence_source`, `evidence_ref`, `audit_id`.
- **Removed 6 Oct 2026 (Dvir):** the `payouts` table, `POST /payouts/{id}/received`, the `payout {amount, method, received_on}` request object, `PAYOUT_MISMATCH`, `PAYOUT_OVERDUE` and the response `payout` block. The request takes only `payout_fee` (USD, 2 decimals, ≥ 0); `commission + other_fees + payout_fee` must not exceed `sale_price` (422 `VALIDATION_ERROR`). A request that still sends a `payout` object is refused as an unknown field (422 `VALIDATION_ERROR`).
- **Commission check (a warning, not a block):** compares the commission to the expected rate.
  - Afternic: 15% if the lander NS was afternic at `sold_at`, else 25%, with a $15 minimum.
  - Sedo: 10%, 15% or 20%.
  - Afternic Custom Checkout: 5%.
  - Warns if the difference is more than $1.
- **Response:**
  - net proceeds and profit for this domain (sale − commission − fees − all costs for the domain);
  - the **post-sale checklist**:
    1. "Remove the listing on the *other* marketplace now (double-sale risk)".
    2. "Do not send an auth code outside the marketplace flow".
    3. "Auto-renew stays off".
  - `sale: {id, confirmed, recorded_by, evidence_source, evidence_ref}`;
- `approval_ref` is **optional** (Dvir, 5 Oct 2026, 19:47). Without it the sale is recorded with `confirmed: false` on the evidence, and `/report` lists it as `SALE_UNCONFIRMED` (information only).

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| S-1 | Valid Afternic sale | 3 ledger rows with the right signs; status `sold`; profit = 1995 − 299.25 − 11.08 = **$1,684.67** for a domain that cost $11.08 | Wrong rows or math |
| S-2 | Commission 10% on an Afternic-NS domain | 200 with a warning "expected 15%" | Blocked, or no warning |
| S-3 | Domain already sold | 409 | Second sale recorded |
| S-4 | No `approval_ref` and no `evidence` (or no `transaction_ref`) / `evidence` + `transaction_ref` without `approval_ref` | 422 `EVIDENCE_REQUIRED`, nothing written / 200, `sale.confirmed: false`, ledger rows as S-1 | Accepted without evidence / refused with evidence |
| S-5 | Idempotent replay | 1 set of rows | 2 sets |
| S-6 | READ token | 403 | Executed |
| S-7 | Report after sale | `/report` sales and ROI include it | Missing |
| S-8 | Checklist | The response includes the "remove the other listing" step | Missing |
| S-9 | Sale of a `delisted` domain | 200; status `sold`; same ledger rows as S-1 | 409 |
| S-10 | `offer_id` of an open offer on this domain | 200; the offer's outcome `sold`; one transaction | Offer unchanged |
| S-11 | `offer_id` of another domain's offer, or a declined one | 422 `OFFER_MISMATCH`; nothing written | Sale recorded |
| S-12 | S-1 sale with `payout_fee` 15.00 | A `payout_fee` ledger row of −1500 (note `payout fee`); no ledger row for the payout amount; replaying the same key writes nothing new | Missing row, or an amount row |
| S-13 to S-15 | Removed 6 Oct 2026 (Dvir): payout amount, `PAYOUT_MISMATCH`, `payouts` row, `received_on` validation | n/a | n/a |
