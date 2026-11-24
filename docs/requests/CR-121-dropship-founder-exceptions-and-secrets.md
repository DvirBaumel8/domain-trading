# CR-121: Dropshipping line in DOM, part 1: founder-rule exceptions and secret handling

**Status:** Filed 24 Nov 2026. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** 24 Nov 2026, 23:09 IST, through Gavriel: hand Phase 1 of the dropshipping plan to DOM, the founder-rule exceptions in plan §3, and the standing auto-buy envelope.
**Spec:** `docs/requests/dropship/dom-plan-v1.md` (a copy of the plan; this CR wins where they differ).

This request does not authorize any listing, CJ purchase, price change, wallet top-up, or outside message. The domain line (CR-116, CR-117, `data/state.json`, the $1,500 cap) is unchanged. Do not print keys or tokens. This repo is public: no buyer name, address, phone, email or raw eBay user id in git, logs, test fixtures or API responses. Tests are the contract; at most two review rounds. The eBay developer account is still pending approval, so there are no real keys yet: build against the official docs, with mocks and fake values.

## Ask

1. **Write the four exceptions into the founder rules and contract docs,** each scoped exactly as in plan §3, and refuse anything wider:
   - One unauthenticated path: `/webhooks/ebay/marketplace-account-deletion` (GET and POST only). Every other route still needs a Bearer token, except `/health/ping`.
   - Money is spent only inside a GitHub Actions job running an approved action row (CR-124). There is no HTTP write, approve or execute route.
   - A second ledger and a second cap: dropshipping has a **$1,000** lifetime cap, kept apart from the domain **$1,500**.
   - Never top up a CJ wallet automatically. A top-up is its own action and needs Dvir's yes every time.
2. **Secrets (plan §4.2).** Env names are `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, `EBAY_VERIFICATION_TOKEN`, `EBAY_DELETION_ENDPOINT_URL` and `CJ_API_KEY`. They live in Render (`sync: false`) and GitHub Actions secrets only. Access tokens for eBay (~2h) and CJ (180d, error 1600003 means mint again) are created in memory only. `/health` may say whether each key is set, nothing more. A missing key gives `SOURCE_KEY_MISSING`, never a silent empty call. When the eBay refresh token is near expiry or revoked, the job stops and reports it, so Gavriel can ask Dvir to tap Agree again.
3. **Buyer personal data passes through and is never stored** (plan §2): read it from eBay, send it to CJ, drop it.

## Tests

- No secret value appears in any log, response, snapshot or test output. Fixtures use fake values.
- A missing env var gives a clear `SOURCE_KEY_MISSING` failure.
- A token refresh against a mocked endpoint works, and the token is never printed.
- A route-auth test lists every route. Only `/health/ping` and the webhook path are open.
- `check-state` (or a sibling check) fails if a dropship state row contains a field that looks like PII (address, phone, email, or a raw eBay user id).

## Done when

The tests pass, the founder rules and `docs/contract/` say exactly this, and it ships after Dvir's OK through Gavriel. Setting the real secrets in Render and GitHub is a separate step, done only after Dvir's OK on that exact change.
