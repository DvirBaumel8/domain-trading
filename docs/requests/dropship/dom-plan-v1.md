# DOM plan v1 — eBay US dropshipping line

**Status:** Plan only. No code, no commits, no messages to other bots.  
**Date:** 24 Nov 2026, Asia/Jerusalem.  
**For:** DOM Architect, then DOM (Claude Code), after Dvir agrees to the scope and to the founder-rule exceptions in §3.  
**Repo:** `DvirBaumel8/domain-trading` (public). Live API: `https://domain-trading-api.onrender.com` on Render Free.  
**This is not a CR.** A later CR in `docs/requests/` would ask DOM to build one phase at a time.

The company rule stays in force: code is only for exact, fixed work (money, storage, rule enforcement, scheduled jobs). Judgment stays in bots' plain-language instructions so it can improve with the model. Recurring work should move into DOM so it does not spend Grok tokens.

---

## 1. Purpose

Build the smallest amount of DOM code that can:

1. Unlock eBay **production** keys by hosting the required marketplace account-deletion webhook.
2. Hold eBay and CJ tokens safely, refresh them, and call official APIs.
3. Enforce the break-even price, the product filters that are mechanical, and the **$1,000** dropshipping cap (this cap is separate from the domain-trading **$1,500** cap).
4. Gate every money action (list, buy from CJ, change a price, top up a CJ wallet, record an AI or ad cost) on Dvir's yes for that action.
5. Run the order path and the stock/price sync on a schedule, without a bot in the loop, once a standing fulfillment envelope exists.

Nothing in this plan authorizes a listing, a CJ purchase, a price change, a wallet top-up, or an outside message.

---

## 2. How this fits DOM today

DOM is a small, mostly read-only HTTP API. The whole domain-trading state is `data/state.json` in git. There is no database and no Render disk. A money row is a commit, checked by `npm run check-state`, and Render deploys only after CI passes. Scheduled work already lives in **GitHub Actions** (the daily pre-filter), not on Render: Render Free has no cron, no disk, and no keep-warm, and the service sleeps after about 15 minutes. The repo is **public**. Keys live only as Render and GitHub secrets. Runtime dependencies are `fastify` and `zod`. Money is integer cents, never floats (`src/core/money.ts`). The service sends nothing and contacts nobody; Gavriel talks to Dvir.

Those constraints still apply. Dropshipping is a second line on the **same** Render service and the **same** repo, not a second paid host.

| Kind of work | Where it runs | Why |
|---|---|---|
| Public HTTPS that eBay must call (deletion webhook; later, maybe other Notification API topics) | The existing Render web service | Needs a stable HTTPS URL. A second Free service would share the same 750 hours/month and could make sleep worse. |
| Read APIs for bots (budget, catalog, ledger, freight, stock, action status) | Same Render service, Bearer token, GET only | Matches today's contract. |
| Recurring jobs (stock/price sync, order poll, tracking upload, execute an approved action) | GitHub Actions, like `prefilter` | Render Free has no scheduled jobs. |
| Secrets (eBay app keys, user refresh token, deletion verification token, CJ API key) | Render dashboard (`sync: false`) and GitHub Actions secrets | Never git, never logs, never API responses. The repo is public. |
| Durable non-PII state (listed SKUs, approvals as `{approved_on, ref}`, the dropshipping ledger) | A new `data/dropship-state.json` on `main`, append-only, CI-checked | Same pattern as `data/state.json`. |
| Buyer personal data (name, address, phone, email, raw eBay user ids) | **Not stored in this repo, not logged** | A public repo cannot hold PII. Phase 1 is pass-through: read the address from eBay, send it to CJ, drop it. |

CR-116 cancelled bot-callable write/spend routes and the `docs/requests/approvals/` idea for domain trading. This plan does **not** revive that pattern. Spend and listing writes happen only inside GitHub Actions jobs, after a recorded approval, never as an open HTTP write route.

---

## 3. Founder-rule exceptions (need Dvir's yes before any CR)

These are conflicts to flag, not silent breaks.

1. **Unauthenticated webhook.** Founder access rules say every route except `GET /health/ping` needs a Bearer token. eBay's deletion endpoint must be public HTTPS, with no auth and no redirect (`GET` challenge + `POST` notification). This would be a tightly scoped exception for one path only.
2. **The app still does not spend money from a bot request.** eBay Inventory writes, CJ order create, CJ `payBalanceV2`, and tracking upload exist only in jobs, and only after an approval row. This is a narrow exception to "the app never spends money," not a general write API.
3. **A second ledger and a second cap.** Dropshipping has its own **$1,000** lifetime cap (every cost: CJ payments, eBay fees we record, ads, AI, tools, samples, wallet top-ups). A sale does not add room. It does **not** share headroom with the domain **$1,500** cap, and domain rows stay in `data/state.json`.
4. **No auto top-up of a CJ wallet**, in the same spirit as founder rule 6 (never top up a registrar). A wallet top-up is its own money action and needs Dvir's yes.

Until he agrees to these, DOM should not start the work.

---

## 4. Components, in priority order

Each component has: one-sentence purpose, inputs/outputs, endpoints or jobs, data, tests as a pass/fail contract, and what stays with bots.

### 4.1 Marketplace account-deletion webhook — item #1, build first

**Purpose.** Host the official eBay endpoint that is required before any production API call, and delete any stored eBay personal data when eBay says a user closed their account.

**Why this is first.** Official rule: new third-party developers must subscribe to, or opt out of, marketplace account deletion/closure notifications **before their first production API call**. Production keys stay disabled until that is done. Opt-out is only for an app that is **not persisting any eBay data**. We will store a user refresh token and order identifiers, so opt-out would not be honest. We subscribe.

Source: [Marketplace User Account Deletion](https://developer.ebay.com/marketplace-account-deletion). Also: [Get started with eBay APIs](https://developer.ebay.com/develop/guides-v2/get-started-with-ebay-apis.md).

**Exact endpoint behavior** (all from that official page):

- Public URL, HTTPS only, no internal IP, no `localhost`, no redirect, no Bearer token. Proposed path, owned by this service:
  `https://domain-trading-api.onrender.com/webhooks/ebay/marketplace-account-deletion`
  The string hashed and the string saved in the Developer Portal must be **identical**, including scheme and trailing-slash.
- **Verification token:** 32–80 characters, only `A–Z`, `a–z`, `0–9`, `_`, `-`. Stored as `EBAY_VERIFICATION_TOKEN` in Render, never in git, never returned.
- **GET challenge** (eBay sends this immediately when the URL and token are saved in **Alerts and Notifications**):
  - Request: `GET <callback_URL>?challenge_code=<unique>`
  - Response: HTTP `200`, `Content-Type: application/json`, body `{"challengeResponse":"<hex>"}`.
  - `<hex>` is the SHA-256 of the UTF-8 concatenation, **in this order**: `challengeCode + verificationToken + endpoint`. Any other order fails.
  - Build the JSON with a JSON library, never a hand-written string (a BOM makes eBay reject the subscribe).
- **POST notification** (after the endpoint is subscribed):
  - Header: `X-EBAY-SIGNATURE` (ECC signature).
  - Body (official sample fields): `metadata.topic` = `MARKETPLACE_ACCOUNT_DELETION`, `metadata.schemaVersion`, `notification.notificationId`, `eventDate`, `publishDate`, `publishAttemptCount`, `notification.data.username` (sometimes withheld for US users), `notification.data.userId` (immutable), `notification.data.eiasToken`.
  - Acknowledge at once with `200`, `201`, `202`, or `204`. eBay resends until acknowledged. After **24 hours** of unacknowledged notifications the URL is marked down and eBay emails the alert address; the developer then has **30 days** to fix it or is marked non-compliant.
  - After the ack (or, if verification is fast, before it), verify the signature: decode `x-ebay-signature`, fetch the public key from the Notification API `getPublicKey`, cache the key about one hour, verify. Official SDKs exist (Java, Node.js, .NET, PHP, Go). Prefer Node `crypto` + a cached `getPublicKey` call so we do not add a third runtime dependency; an official SDK is acceptable only if it stays small and free. Failed signature: HTTP `412 Precondition Failed`.
  - Then delete, irreversibly, any personal data we hold for that `userId` / `eiasToken` / username (order addresses, cached buyer fields). Do not keep it except where a written legal duty requires it. Dedup on `notificationId` so a retry is safe. Never write the raw username, userId, or eiasToken into the public repo or into logs; a receipt may store only a hash of `notificationId` and a timestamp.
- Alert email in the Developer Portal is the developer-account mailbox, not Dvir's personal email, and is used only when the URL is down.

**Subscribe steps** (done after the route is live, not in code): wake the service with `GET /health/ping` and wait for 200 (up to 180 seconds, because of Free-plan sleep); then in the portal set the alert email, the exact endpoint URL, and the same verification token, and Save. eBay challenges at once. Do not change the URL later without repeating the challenge.

**Inputs / outputs.** Input: eBay GET or POST. Output: the challenge JSON or a 2xx/412. Side effect: irreversible deletion of matching PII we hold (often a no-op in Phase 1 if we never stored PII).

**Endpoints / jobs.** The one public route above. No job. A unit test and a sandbox-style fixture cover the challenge; a mocked POST covers signature pass/fail and idempotent delete.

**Data.** No public table of user ids. Optional in-memory or hashed receipt of processed `notificationId` values; loss on sleep is acceptable if delete is idempotent.

**Tests (pass/fail contract).**

- A GET with a known `challenge_code`, token, and exact endpoint URL returns `200` + JSON whose `challengeResponse` equals the official SHA-256 hex; a wrong concatenation or a wrong endpoint string does not match.
- The challenge response `Content-Type` is `application/json` and the body parses as JSON with no BOM.
- A POST with a valid mocked signature returns 2xx, and a second POST with the same `notificationId` also returns 2xx and does not error.
- A POST with a bad signature returns `412` and does not run deletion.
- After a valid notification, any fixture PII for that user is gone and cannot be read back.
- The route does not require a Bearer token; every other new dropshipping route does.
- Logs, test fixtures, and snapshots never contain a real token, a real verification token, or a real eBay user identifier.

**Stays with bots.** Pasting the URL and token into the Developer Portal (token typed from the vault, never into chat or git). Telling Dvir when the portal shows the keyset as active, or when an alert email says the URL is down.

---

### 4.2 Secure eBay and CJ token handling

**Purpose.** Keep app secrets and the seller's long-lived refresh token off the public repo, and mint short-lived access tokens in memory.

**eBay.** After production keys are enabled (component 4.1), Dvir taps **Agree once** on the Grant Application Access page. Prefer minting the first user token in the Developer Portal ("Get a User Token Here") so the app does not need a callback that writes secrets. Gavriel or DOM then places the refresh token into Render and GitHub secrets only. Official example `refresh_token_expires_in` is 47,304,000 seconds, about **18 months**. Access tokens last about **2 hours**. Refresh in memory; on Free-plan sleep the memory is gone, so the next job or request refreshes again. Do not log tokens. When the refresh token is near expiry or revoked, stop and ask Dvir to Agree again.

Scopes (copy the live URIs from Application Keys and from each method's docs at setup, do not guess): at least `sell.inventory`, `sell.fulfillment`, `sell.account`, and their `.readonly` forms if needed. Application (client-credentials) tokens are separate and are not a substitute for the seller user token on Sell APIs.

Sources: [Access token types](https://developer.ebay.com/api-docs/static/oauth-token-types.html), [Authorization](https://developer.ebay.com/api-docs/static/oauth-consent-request.html).

**CJ.** Official API 2.0: create an API key in MyCJ, then `POST /authentication/getAccessToken` and `refreshAccessToken`. Send `CJ-Access-Token` on business calls. Access and refresh tokens are each valid **180 days**. On expiry or error `1600003`, mint again from the API key. Official base: `https://developers.cjdropshipping.com/api2.0/`. Source: [Development Documentation](https://developers.cjdropshipping.com/en/api/start/development.html).

**Inputs / outputs.** Env: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, `EBAY_VERIFICATION_TOKEN`, `EBAY_DELETION_ENDPOINT_URL`, `CJ_API_KEY`. Output: a short-lived access token in process memory only.

**Endpoints / jobs.** No public token route. A small internal helper used by read routes and by jobs. `GET /health` may say whether each key is **set**, never whether it is valid in a way that leaks it.

**Data.** None in git.

**Tests.** A refresh uses a mocked token endpoint and never prints the secret; a missing env var is a clear `SOURCE_KEY_MISSING` / start-up or job failure, never a silent empty call; fixtures use fake values.

**Stays with bots.** The one-tap Agree link; putting secrets in Render and GitHub (not in chat); the separate CJ eBay-store OAuth (store name `dvbau_0`) if Dvir later wants CJ's own app connected — that is optional and is not required for *our* API path.

---

### 4.3 Break-even math, budget read, and hard filters

**Purpose.** Put the fixed price rule, the $1,000 cap math, and the mechanical product filters into code so a bot cannot "almost" undercut below cost or forget a banned category.

**Pricing rule** (integer cents, no floats), already locked by Dvir:

`be_cents = ceil_div((cost_cents + ship_cents + 40) * 1000, 864)`

That is `(cost + shipping + $0.40) / 0.864`, rounded **up** to the next cent. `ceil_div(n, d) = (n + d - 1) / d` on non-negative integers.

A candidate is listable only if there is a competitor price **strictly above** `be_cents`. The list price is the undercut of the cheapest eligible US offer, and is never below `be_cents`. If the cheapest is at or below break-even, the code returns `skip` (Dvir: we do not sell at a loss). Competitor price is an **input** until the Browse API is available in production (it is partner-only via EPN today; that application is slow and not guaranteed). Bots keep collecting the cheapest eBay price from the public site and pass it in.

**Hard filters in code** (drop, never "maybe"): keywords and CJ category/flags for electronics, batteries, kids/children, and an initial brand/VeRO denylist. Skin-contact and fragile: a conservative keyword denylist plus a bot review for borderline cases. US warehouse and a minimum stock (propose 10 units, already used in the research scripts) are code gates. Missing data is not a pass.

**Inputs / outputs.** Inputs: CJ cost, a real freight quote (or an explicit "freight unknown"), competitor price in cents or `unknown`, flags. Output: `be_cents`, suggested `list_cents` or `skip`, cap status (`within` / `over` / `unknown`), filter failures. `within` is not an approval.

**Endpoints / jobs.** `GET /dropship/quote` (Bearer): cost, freight, competitor, filters, cap. `GET /dropship/budget`: spent, committed, remaining against $1,000, including open approved-but-unexecuted actions and standing envelopes. Same conventions as `GET /budget`.

**Data.** Caps in code, e.g. `MAX_DROPSHIP_SPENT_CENTS = 100_000`. Filter lists in a repo file bots may propose edits to; DOM ships the change.

**Tests.**

- Worked example: cost $10.00 + ship $7.50 + $0.40, divided by 0.864, rounds up to the exact cent the formula produces; a one-cent-lower list is rejected.
- Cheapest competitor at or below BE → `skip`; one cent above BE → listable at BE or the undercut, never below BE.
- Freight or competitor `unknown` → status `unknown`, never `within`.
- A banned keyword or a non-US warehouse → dropped.
- A quote that would take committed dropshipping spend over $1,000 is `over`.
- Floats never appear in the money path; tests use integer cents only.

**Stays with bots.** Choosing which products to consider, brand/VeRO judgment beyond the denylist, fragile and skin-contact edge cases, reading the public eBay results until EPN exists, writing title and description copy.

---

### 4.4 Approval gate

**Purpose.** Make sure listing, buying from CJ, changing a price, topping up a CJ wallet, or recording a non-goods cost cannot run unless Dvir has said yes to that action, with the yes still valid.

**Model.** An action row, append-only:

- `id`, `type` (`list`, `reprice`, `delist`, `fulfill`, `cj_wallet_topup`, `cost`), `sku` (or null), amounts in cents, `created_on`, `expires_on`, `status` (`awaiting_dvir` / `approved` / `rejected` / `expired` / `executed` / `failed`), `approval` (`{approved_on, ref}` or null), a short public `note` (no private text).
- No approval wording, no tokens, no addresses in the file. `ref` points at a chat or CR id, the same way domain purchases do.
- Default expiry: **72 hours** from `approved_on` to execution for one-shot actions, matching the domain purchase rule.

**Recommended standing envelope (needs Dvir's explicit yes).** A `list` approval may also carry `fulfill_envelope_cents` and stays valid while the offer is live. Meaning: "if this SKU sells, buy it from the named CJ US warehouse, quantity as sold, as long as CJ cost + freight ≤ this envelope, the $1,000 cap still has room, and stock is sufficient." That is the only practical way to meet a **3-business-day** handling time without waking him for every sale. If freight, cost, stock, or the cap breaks the envelope, the job **stops** and opens a new `awaiting_dvir` action. If he prefers a fresh yes on every CJ buy, the job always stops at `awaiting_dvir`; late shipment risk is then on us, and that choice should be written on the first listing card.

**Flow.**

1. A bot or a job writes a proposed action (computed price, freight, envelope, budget effect).
2. Gavriel shows Dvir a one-tap card (the card is not this code).
3. On yes, DOM records `approved_on` + `ref` in `data/dropship-state.json` (a commit, CI, deploy), or, for time-critical `fulfill` stops, a `workflow_dispatch` input that still requires the same approval fields and is mirrored into the ledger on the next commit.
4. Job `dropship-execute` runs only that approved id. It is idempotent: a retry must not list twice, must not pay CJ twice, must not upload tracking twice.
5. On success, status becomes `executed` and a ledger row is appended. On failure, `failed` and no silent retry that spends again.

**Endpoints / jobs.** `GET /dropship/actions` and `GET /dropship/actions/:id` (read). No public POST to approve or execute. Job: `.github/workflows/dropship-execute.yml` (`workflow_dispatch`).

**Data.** `actions[]` inside `data/dropship-state.json`. CI (`npm run check-state` or a sibling check) refuses an `executed` money row without a valid approval, refuses a rewritten past row, and refuses execution after expiry unless it is a still-valid standing envelope.

**Tests.**

- Execute without approval, with an expired approval, or with a type/sku/amount that does not match the row → refused, no outside call.
- A standing envelope allows a fulfill at or under the cap; one cent over, or a cap breach, is refused.
- Idempotent execute: the second run does not call the spend endpoint again.
- Approval text and secrets never appear in the state file or in tests.

**Stays with bots.** The wording of the card; talking to Dvir; filing the request that adds the approval ref. Bots never mark an action approved on their own.

---

### 4.5 Dropshipping ledger and the $1,000 cap

**Purpose.** Keep an append-only record of every dropshipping cost and receipt, and refuse new spend that would pass $1,000.

**Types.** `cj_purchase`, `cj_wallet_topup`, `ebay_fee`, `payout`, `refund`, `ad`, `ai`, `tool`, `sample`, `cost`, `adjustment`. Negative cents = money out, positive = money in, same as the domain ledger. A `payout` or a sale receipt does **not** lower `spent` or raise the cap. Adjustments correct mistakes; rows are never edited or deleted.

**Inputs / outputs.** New rows from execute jobs and from bot-filed costs (AI usage, a tool Dvir approved). `GET /dropship/ledger` and `GET /dropship/report` (spent, remaining, sales, net).

**Data.** `ledger[]` in `data/dropship-state.json`. Public-safe notes only (SKU, order ids, amounts). No buyer names.

**Tests.** Caps, append-only, signed amounts, approval required for spend types, domain ledger unchanged by dropshipping rows, $1,000 and $1,500 independent.

**Stays with bots.** Telling Dvir the remaining budget in plain Hebrew, with the report as the source. Filing AI or ad costs so they are not forgotten (the $1,000 includes them).

---

### 4.6 CJ read APIs: freight, stock, and catalog snapshot

**Purpose.** Replace guessed $7.50 shipping and stale stock with official numbers, on request and on a schedule.

Official methods (https://developers.cjdropshipping.com/api2.0/):

- Freight: `POST /v1/logistic/freightCalculate` (and the more precise `freightCalculateTip` when we need it). For US-warehouse goods, send the variant id, quantity, and the destination country (and zip when we have a buyer). Source: [Logistics](https://developers.cjdropshipping.com/en/api/api2/api/logistic.html).
- Stock: `GET /v1/product/stock/queryByVid` and/or inventory-by-product, plus warehouse list/detail. Source: [API 2.0 list](https://developers.cjdropshipping.com/zh/api/api2/), [Development / product sync](https://developers.cjdropshipping.com/en/api/start/development.html).
- Tracking: `GET /v1/logistic/trackInfo`.
- Public search (no login), already used in `/workspace/dropshipping/cjs.py`: `POST https://us.cjdropshipping.com/elastic-api/product/v4/search`. Fine for discovery snapshots. Official product query is preferred once the API key exists.

**Endpoints / jobs.** `GET /dropship/freight` and `GET /dropship/stock` (Bearer, live, no cache that can look like a guarantee). Optional later job: a catalog snapshot for bots, written to a **non-`main`** branch or a private log, not to `data/state.json`, so it does not redeploy the API.

**Tests.** A mocked freight of $7.51 is what the quote uses, not the old flat $7.50; a CJ error or missing key is `SOURCE_ERROR` / `SOURCE_KEY_MISSING`, never a made-up ship cost; stock 0 or below the minimum is not listable.

**Stays with bots.** Which search terms to try; judging product quality from photos and reviews.

---

### 4.7 Listing publish (Inventory + Account APIs)

**Purpose.** After Dvir's yes, create the eBay inventory location, inventory item, offer, and published listing from the approved numbers, and never publish below break-even.

Official flow ([Inventory API](https://developer.ebay.com/api-docs/sell/inventory/overview.html), [From inventory item to offer](https://www.developer.ebay.com/api-docs/sell/static/inventory/inventory-item-to-offer.html)):

1. Account API: opt in to business policies; have payment, fulfillment (recommend **3 business days** handling, US shipping), and return (recommend 30 days, buyer pays return postage) policies. Source: [Business policies](https://www.developer.ebay.com/api-docs/sell/static/seller-accounts/business-policies.html).
2. `createInventoryLocation` — the **real** CJ US warehouse address, not a guessed one, and not an Israel address for a US-shipped item.
3. `createOrReplaceInventoryItem` for the SKU.
4. `createOffer` (marketplace `EBAY_US`, price, quantity, category, the three policy ids, location).
5. `publishOffer` — this is the moment it becomes live. This step is the money/listing action and needs the approval row.

Important official limits: a listing created with the Inventory API **cannot** be edited in Seller Hub; later changes go through the same API. Each listing may be revised **250** times per calendar day. `Content-Language` (e.g. `en-US`) is required on item writes.

A code flag `overseas_warehouse_approved` must be true before a US-location offer is published. Setting that flag is a human confirmation that eBay has approved overseas-warehouse fulfillment for this Israel-registered seller (policy since 15 Jul 2025). The request to eBay stays with bots and Dvir; it is not a form the API can submit.

**Job.** `dropship-execute` for `type=list` (and `reprice` / `delist`). Read route: `GET /dropship/products`.

**Tests.** Publish is not called if approval, BE, filters, cap, or the overseas-warehouse flag fail; price in the offer equals the approved `list_cents`; a mocked eBay error leaves the action `failed` and does not write a success ledger row.

**Stays with bots.** Title, description, photos (from CJ, checked), category choice when it is not mechanical, the overseas-warehouse customer-service request, Payoneer and seller-account setup.

---

### 4.8 Order flow: eBay order → CJ order → tracking upload

**Purpose.** Detect a paid eBay order, place the matching CJ US-warehouse order inside the approval envelope, and upload tracking inside the handling window.

Official eBay Fulfillment API ([overview](https://go.developer.ebay.com/api-docs/sell/fulfillment/overview.html), [getOrders](https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders)):

- `GET https://apiz.ebay.com/sell/fulfillment/v1/order` with `filter=orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}` (and a last-modified window). Default range is the last 90 days. This returns completed-checkout orders only.
- After CJ provides a tracking number: `createShippingFulfillment` on that order, with carrier and tracking, so eBay can start delivery estimates and, for a new seller, payout holds. Sources: [Managing fulfillments](https://developer.ebay.com/api-docs/sell/static/orders/managing-fulfillments.html).

Official CJ order path for **CJ logistics** (we do not upload our own label; CJ ships). Source: [Orders Synchronization Processing](https://developers.cjdropshipping.com/en/api/start/Orders-Synchronization-Processing.html), process 2:

1. Recheck stock and freight to the buyer's zip.
2. `createOrderV2` or `createOrderV3` with `shopLogisticsType=2`, `logisticName` from the quote, US warehouse variant ids. Use `isSandbox=1` in tests only, never in production.
3. Cart / parent order / payment: `payBalanceV2` only if the CJ wallet already has the funds **and** the amount is inside the envelope. Otherwise stop and ask. Do not auto-top-up. Paying on the MyCJ site is an allowed manual fallback for the first orders.
4. Poll `getOrderDetail` until shipped; poll `trackInfo` until there is a number; then call eBay `createShippingFulfillment`.
5. Append ledger rows for the CJ payment and any known eBay fee once amounts are certain.

**PII rule.** Addresses and names stay in memory for the CJ create call, then are dropped. Persist only: eBay order id, CJ order id, SKU, amounts, tracking number, status, timestamps. Logs must not print the address.

**Jobs.** `dropship-orders` (poll eBay, open or execute fulfill actions). `dropship-track` (poll CJ, upload to eBay). Schedule often (hourly is a start). GitHub can start scheduled workflows hours late in this repo already (see `prefilter.yml`); 3-business-day handling is the slack that makes that acceptable. `workflow_dispatch` lets Gavriel run a poll immediately after a sale is known. A later phase may add eBay Notification API order topics on the same Render service if those topics are available to this app; until then, polling is the path.

**Tests.**

- A mocked paid eBay order for a listed SKU with a valid envelope creates exactly one CJ order at an amount ≤ the envelope and does not pay twice on retry.
- Over-envelope freight, stock 0, or cap breach → no CJ pay, action `awaiting_dvir`.
- Tracking is uploaded once; a missing tracking number does not mark the eBay order fulfilled.
- Fixtures never include a real buyer address.

**Stays with bots.** The first paid order should still be watched by a person (already recommended in store research). Returns, INR cases, and "not as described" need judgment. Buyer messages stay on eBay, via Gavriel, not this service (the service still sends nothing).

---

### 4.9 Stock and price sync job

**Purpose.** Keep eBay quantity and price honest when CJ stock or cost changes, without a bot, and without selling below break-even.

**Job.** `.github/workflows/dropship-sync.yml`, several times a day (and `workflow_dispatch`). For every live SKU:

1. Read CJ stock and a fresh US freight quote (a fixed US mid-country zip is enough for a list-price check; the order path quotes the real zip later).
2. Recompute `be_cents`. If cost or freight rose so that the live price is below BE, **do not** silently raise the price (that is a money/listing change). Open a `reprice` or `delist` action and, if stock is already below the minimum, set eBay quantity to 0 (Out-of-Stock Control should be on so the listing can stay alive but hidden). Quantity-to-zero to avoid an oversell is rule enforcement, not a price change, and does not need a new yes.
3. If stock is healthy and BE is still under the live price, update eBay quantity with the Inventory API (`bulkUpdatePriceQuantity` when we have several SKUs). Do not change price here.
4. If CJ is down or the key is missing, do not report "ok"; skip the update and fail the job visibly.

Do not commit a high-frequency stock snapshot to `main` (each push redeploys). Persist last-sync status in the job log or a non-deploying branch; `data/dropship-state.json` only gains a row when money or an approval changes.

**Tests.** Stock below minimum → eBay qty 0, no price write; BE moved above list price → no auto price write, an action is opened; source error → job fails, quantities are not invented.

**Stays with bots.** Deciding the new list price when a reprice action is opened; deciding to drop the SKU.

---

## 5. Order flow, end to end

```text
Buyer pays on eBay
        ↓
dropship-orders job (or a later notification)
  getOrders: NOT_STARTED | IN_PROGRESS
        ↓
Match line item → our SKU in dropship-state
        ↓
Live CJ stock + freight to the buyer's zip
        ↓
    ┌── envelope, stock, and $1,000 cap OK ──► execute fulfill
    │         create CJ order + pay from existing wallet
    │         ledger: cj_purchase
    │         drop in-memory address
    └── otherwise ──► action awaiting_dvir, Gavriel is told, no pay
        ↓
dropship-track job
  CJ trackInfo has a number
        ↓
  eBay createShippingFulfillment (once)
        ↓
  status fulfilled; report / ledger show the actuals
```

Handling time starts at payment and ends at the **carrier's first scan**, not at delivery. Month-1 setting: 3 business days. Tracking must go up inside that window. No tracking can delay payouts for a new personal seller.

---

## 6. Approval gate (summary)

| Action | When Dvir says yes | What the code may then do |
|---|---|---|
| `list` | Per SKU, card shows BE, list price, freight, envelope, cap effect | `publishOffer` at the approved price only |
| `reprice` / `delist` | Per change | Inventory price or unpublished/ended offer |
| `fulfill` | Standing envelope on the list yes, **or** a fresh yes if he refuses the envelope | CJ order + wallet pay ≤ envelope |
| `cj_wallet_topup` | Per top-up, amount named | Manual or a single job payment into CJ; never a recurring auto-top-up |
| `cost` (AI, ads, tools, samples) | Per spend | Ledger row only; still counts toward $1,000 |

Gavriel never "approves" in Dvir's place. CI treats a missing, expired, or mismatched approval as a broken state.

---

## 7. Ledger and budget tracking

- File: `data/dropship-state.json` (products, actions, ledger). Schema strict, like `data/state.json`. No unlisted fields (so no floors, no approval text, no addresses).
- `spent` = all money-out rows, adjustments included. Sales and payouts do not increase the room under $1,000.
- `committed` = spent + approved-but-unexecuted money + standing envelopes that could still fire (define the reserve rule in the CR: either reserved per live listed unit, or reserved as one unit per live SKU for Phase 1's tiny catalog). If the reserve cannot be computed, status is `unknown`, never `within`.
- Tools stay **$0** unless Dvir says yes; a tools cost still needs a `cost` row so the cap cannot be bypassed.
- `npm run check-state` (or a sibling) validates both ledgers. Domain caps are unchanged.

---

## 8. Risks and Render Free constraints

| Risk | What we do |
|---|---|
| **Free-plan sleep** (~15 minutes). The deletion webhook must answer eBay. Cold start can take about a minute, and callers already wait up to 180 seconds for `/health/ping`. | Do **not** add a keep-warm ping (750 hours/month are shared by the whole Render workspace, and this is the same service as domain trading). Wake the service before saving the URL in the portal. Rely on eBay's retries. If an alert email says the URL is down, wake, fix, and tell eBay it is up (official 24-hour mark-down, then 30 days to repair). |
| **Public repo.** Buyer PII, tokens, and approval text must never be committed. | Pass-through PII; secrets only in Render/GitHub; state schema refuses unknown fields. Do not reuse the public `shadow-log` pattern for orders. A private data repo or a paid store would need Dvir's yes and is out of Phase 1. |
| **GitHub schedule delay** (this repo has seen 3–10 hour late starts). | 3-business-day handling; hourly cron plus `workflow_dispatch`; later, Notification API if available. |
| **A push to `main` redeploys.** | Do not write high-frequency stock or catalog dumps to `main`. Ledger and approval commits stay infrequent. |
| **Inventory API listings cannot be edited in Seller Hub.** | All later price and qty changes go through the API jobs. |
| **Browse API is partner-only** until an EPN application succeeds (~10 business days, no guarantee). | Competitor prices stay a bot/browser input. Do not call Browse in production and treat an error as a real price. |
| **Overseas-warehouse approval** is still an official gap (no public form). | Code refuses to publish a US-location offer until the flag is set from a confirmed eBay approval. |
| **CJ payment vs eBay payout hold.** New sellers using a third-party label can have payouts held about 7 days after delivery; we pay CJ up front. | Cash buffer inside the $1,000; no auto-top-up; first orders watched. |
| **New-seller unofficial limits** (~10 items or $500). | Do not list more than those limits until official limits are seen in the account. Not a substitute for the $1,000 cap. |
| **eBay defect rate** above 2% hurts the account. Late tracking and seller-cancelled out-of-stock orders are the usual causes. | Auto qty 0 before stock runs out; 3-day handling; no 1-day promise. |
| **Adding dependencies.** | Stay on `fastify` + `zod` if possible. No AI calls inside the service. No paid tool without Dvir's yes. |

---

## 9. Phased rollout

### Phase 1 — Minimal, enough for the first listing

Ship only what unlocks production keys and supports one approved listing:

1. Deletion webhook live, challenge passing, portal subscription done, production keyset active.
2. Secrets in Render and GitHub; user refresh token after Dvir's one Agree; access tokens minted in memory.
3. Break-even + cap + hard-filter read APIs; dropshipping ledger file and CI; approval rows and the execute job for `list` only.
4. One-time Account API / policy / inventory-location setup after OAuth (or the same done once in Seller Hub, then ids stored).
5. `overseas_warehouse_approved` flag, set only after eBay has actually approved it.
6. One SKU published by the execute job after his yes on that listing (price, envelope, cap shown on the card).
7. Freight and stock **reads** from CJ, so the card uses a real ship quote, not $7.50.

**Not in Phase 1:** automatic CJ pay, automatic tracking upload, the sync job as a required path, catalog crawl, Browse/EPN, a second Render service, any paid add-on. The first paid order is watched by hand (Gavriel + a manual or dispatch assist), as already recommended in store research.

**Phase 1 is not done until:** tests for 4.1–4.5 and the list-execute path pass; the webhook is verified in the portal; `check-state` accepts the new file; a tagged release can deploy to the existing Render service after Dvir's OK to ship. No live listing happens in the "ship the code" step itself.

### Phase 2 — Recurring operations without Grok tokens

Order poll, standing-envelope fulfill, CJ pay from a pre-funded wallet, tracking upload, stock/price sync, ledger of actuals, budget halt. This is when the line can run unattended inside the rules.

### Phase 3 — Scale, still $0 tools unless he says yes

Catalog snapshot job for discovery, more SKUs inside new-seller limits, Notification API for orders if the app can subscribe, returns/refund helpers behind the same approval gate, Browse API only after EPN is actually granted.

---

## 10. What stays with bots (standing)

- Talking to Dvir, one-tap cards, any outside email or eBay customer-service request (overseas warehouse, limit raises).
- Product discovery judgment, copy, and competitor-price gathering until Browse is allowed.
- Brand/VeRO, fragile, and skin-contact edge cases.
- Watching the first sale, and any dispute or return that is not a fixed rule.
- Filing AI and ad costs into the ledger.
- Requests in `docs/requests/`. Bots still do not add app code.

Existing research helpers (`cjs.py`, `crawl.py`, `scan.py`) are not production code. Official CJ API and DOM jobs replace them when Phase 1–2 ships.

---

## 11. Proposed env vars (Render + GitHub, `sync: false`, never in git)

`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, `EBAY_VERIFICATION_TOKEN`, `EBAY_DELETION_ENDPOINT_URL`, `CJ_API_KEY`.

Until a var is set, the related route or job says the key is missing and does not pretend success.

---

## 12. Sources

- DOM structure: `CLAUDE.md`, `docs/contract/`, `docs/DEPLOYMENT.md`, `docs/internal/code-map.md`, `render.yaml`, CR-116 / CR-117.
- Dropshipping research: `store-research-v1.md`, `ebay-signup-requirements.md` §8, `breakeven-candidates-v1.md`, `earnings-sourcing-research-v1.md`.
- [eBay Marketplace User Account Deletion](https://developer.ebay.com/marketplace-account-deletion)
- [Get started with eBay APIs](https://developer.ebay.com/develop/guides-v2/get-started-with-ebay-apis.md)
- [OAuth token types](https://developer.ebay.com/api-docs/static/oauth-token-types.html) and [Authorization](https://developer.ebay.com/api-docs/static/oauth-consent-request.html)
- [Inventory API overview](https://developer.ebay.com/api-docs/sell/inventory/overview.html) and [inventory item to offer](https://www.developer.ebay.com/api-docs/sell/static/inventory/inventory-item-to-offer.html)
- [Fulfillment API overview](https://go.developer.ebay.com/api-docs/sell/fulfillment/overview.html), [getOrders](https://developer.ebay.com/api-docs/sell/fulfillment/resources/order/methods/getOrders), [managing fulfillments](https://developer.ebay.com/api-docs/sell/static/orders/managing-fulfillments.html)
- [Account / business policies](https://www.developer.ebay.com/api-docs/sell/static/seller-accounts/business-policies.html)
- [CJ development and token flow](https://developers.cjdropshipping.com/en/api/start/development.html)
- [CJ order synchronization](https://developers.cjdropshipping.com/en/api/start/Orders-Synchronization-Processing.html)
- [CJ logistics / freight / tracking](https://developers.cjdropshipping.com/en/api/api2/api/logistic.html)
