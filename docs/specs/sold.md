# POST /sold/{domain}  (WRITE)

**Goal:** record a sale, its commission and fees, and optionally the payout, so `/report` shows profit and ROI. Called by Dvir, or by Gavriel **after Dvir says it sold**, with his words in `approval_ref`.

## Request
`Idempotency-Key` header required.
```json
{ "venue": "afternic",            // afternic | sedo | afternic_checkout | escrow | other
  "sale_price": 1995.00, "commission": 299.25, "other_fees": 0,
  "sold_at": "2027-02-11T14:02:00+02:00",
  "payout": { "amount": 1680.75, "method": "wire", "fee": 15.00, "received_on": null },   // optional
  "transaction_ref": "AFN-123456",
  "approval_ref": { "text": "it sold on afternic for 1995", "approved_at": "..." } }
```

## Behaviour
- The domain must be `owned` or `listed`; otherwise 409 `NOT_SELLABLE_STATE`.
- One DB transaction writes ledger rows:
  - `sale` +sale_price;
  - `commission` −commission;
  - `fee` −other_fees, if > 0;
  - `payout_fee` −payout.fee, if given.
  - `counterparty` = venue; `receipt_ref` = `transaction_ref`.
- Sets `status=sold` and `sold_at`.
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
- `approval_ref` is **required** (it is Dvir's word that the sale happened).

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| S-1 | Valid Afternic sale | 3 ledger rows with the right signs; status `sold`; profit = 1995 − 299.25 − 11.08 = **$1,684.67** for a domain that cost $11.08 | Wrong rows or math |
| S-2 | Commission 10% on an Afternic-NS domain | 200 with a warning "expected 15%" | Blocked, or no warning |
| S-3 | Domain already sold | 409 | Second sale recorded |
| S-4 | Missing `approval_ref` | 422 | Accepted |
| S-5 | Idempotent replay | 1 set of rows | 2 sets |
| S-6 | READ token | 403 | Executed |
| S-7 | Report after sale | `/report` sales and ROI include it | Missing |
| S-8 | Checklist | The response includes the "remove the other listing" step | Missing |
