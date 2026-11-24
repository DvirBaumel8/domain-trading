# CR-125: CJ freight and stock reads, and the approved-listing publish job (one listing)

**Status:** Filed 24 Nov 2026. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** 24 Nov 2026, 23:09 IST, through Gavriel: hand Phase 1 of the dropshipping plan to DOM, the founder-rule exceptions in plan §3, and the standing auto-buy envelope.
**Spec:** `docs/requests/dropship/dom-plan-v1.md` (a copy of the plan; this CR wins where they differ).

This request does not authorize any listing, CJ purchase, price change, wallet top-up, or outside message. The domain line (CR-116, CR-117, `data/state.json`, the $1,500 cap) is unchanged. Do not print keys or tokens. This repo is public: no buyer name, address, phone, email or raw eBay user id in git, logs, test fixtures or API responses. Tests are the contract; at most two review rounds. The eBay developer account is still pending approval, so there are no real keys yet: build against the official docs, with mocks and fake values.

## Ask (plan §4.6, §4.7, Phase 1 items 4–7)

1. `GET /dropship/freight` and `GET /dropship/stock` call the official CJ API 2.0 live: `freightCalculate` and stock by vid. A CJ error or a missing key gives `SOURCE_ERROR` or `SOURCE_KEY_MISSING`, never a made-up shipping cost. `/dropship/quote` (CR-123) uses the real freight quote, not $7.50.
2. Add a `workflow_dispatch` job, `dropship-execute`, for `type=list` only. It runs exactly one approved action id and walks the Account API policies, `createInventoryLocation` (the real CJ US warehouse address), `createOrReplaceInventoryItem`, `createOffer` (EBAY_US, `Content-Language: en-US`), then `publishOffer`. It is idempotent and never lists twice. It publishes only if every one of these holds: the approval is valid, the price is at or above BE, the filters pass, the cap has room, the listing has its envelope, and `overseas_warehouse_approved` is true.
3. `overseas_warehouse_approved` is a code flag, false by default. It flips only in its own request, after eBay has actually approved overseas-warehouse fulfillment for this Israel-registered seller.
4. `GET /dropship/products` (read).

## Tests

- Publish is never called when the approval, BE, filters, cap, envelope or overseas-warehouse flag fails.
- The offer price equals the approved `list_cents`.
- A second run doesn't publish again.
- A mocked eBay error leaves the action `failed`, with no success ledger row.
- A mocked freight of $7.51 is used as $7.51.

## Done when

The tests pass. The code ships after Dvir's OK. Shipping the code publishes nothing. The single live listing runs later, only after Dvir's yes on that listing's card.
