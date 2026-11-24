> **PAUSED by Dvir 24 Nov 2026 23:17 IST, do not build.** Wait for a go from Dvir through Gavriel.

# CR-122: eBay marketplace account-deletion webhook (dropshipping item #1)

**Status:** Filed 24 Nov 2026. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** 24 Nov 2026, 23:09 IST, through Gavriel: hand Phase 1 of the dropshipping plan to DOM, the founder-rule exceptions in plan §3, and the standing auto-buy envelope.
**Spec:** `docs/requests/dropship/dom-plan-v1.md` (a copy of the plan; this CR wins where they differ).

This request does not authorize any listing, CJ purchase, price change, wallet top-up, or outside message. The domain line (CR-116, CR-117, `data/state.json`, the $1,500 cap) is unchanged. Do not print keys or tokens. This repo is public: no buyer name, address, phone, email or raw eBay user id in git, logs, test fixtures or API responses. Tests are the contract; at most two review rounds. The eBay developer account is still pending approval, so there are no real keys yet: build against the official docs, with mocks and fake values.

## Why

eBay keeps production keys disabled until the app subscribes to marketplace account-deletion notifications. We will hold a refresh token and order ids, so opting out would not be honest. Source: https://developer.ebay.com/marketplace-account-deletion

## Ask (plan §4.1, exactly)

- Route: `https://domain-trading-api.onrender.com/webhooks/ebay/marketplace-account-deletion`. HTTPS only, no redirect, no Bearer. The string that is hashed must equal `EBAY_DELETION_ENDPOINT_URL` byte for byte.
- **GET `?challenge_code=X`:** return 200 with `application/json` body `{"challengeResponse": hex(sha256(challengeCode + verificationToken + endpoint))}`, in that order. Build the body with a JSON library, with no BOM.
- **POST:** acknowledge with 2xx at once. Verify `X-EBAY-SIGNATURE` against the Notification API `getPublicKey` (key cached about 1h). Use Node `crypto` if possible, and avoid a third runtime dependency unless the official SDK is small and free. A bad signature gets 412. Dedupe on `notificationId`. Delete any personal data we hold for that userId, eiasToken or username (in Phase 1 this is usually nothing). A receipt may store only a hash of `notificationId` and a timestamp, never the username, userId or eiasToken.
- **Render Free sleep:** say in the contract how this meets eBay's rule that 24h without an ack marks the endpoint down. eBay retries until it gets an ack, but the cold start must finish inside eBay's request timeout. If it can't, say so plainly. Don't add a paid plan or a keep-warm ping without Dvir's yes.
- Rate limiting and body-size caps on this open path, so it can't be used to wake or load the service cheaply.

## Tests

- A known challenge, token and endpoint give the exact expected hex, and the body is valid JSON with no BOM.
- A different endpoint string (for example a trailing slash) gives a different hash.
- POST with a valid mocked signature gets 2xx, a deletion and a stored receipt. Sending the same notificationId again doesn't delete twice.
- POST with a bad signature gets 412.
- No identifier from the body appears in logs or in git.
- With `EBAY_VERIFICATION_TOKEN` missing, GET fails with a clear error and never hashes an empty token.

## Done when

The tests pass and the contract is updated. The route ships after Dvir's OK. Saving the URL and token in the eBay portal happens after deploy, and that step is Gavriel's with Dvir. Wake the service with `/health/ping` first.
