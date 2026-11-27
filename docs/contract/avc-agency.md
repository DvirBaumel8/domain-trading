# AI Visibility Check: agency report bundles (CR-133)

Contract for the bots. Behind the env flag **`AIVIS_AGENCY`**: only the exact value `1` turns it on (read at request time; unset or anything else = off). **Nothing is for sale** until the product variables below are set and the flag is on. With the flag off every route below answers 404 and `agency.html` is unchanged. This does not touch the domain-trading API (`endpoints.md`): the contract version stays 7.3.1.

## Product map
`ai-visibility-check/site/products.py`: `AGENCY_BUNDLE_PRICES_USD` = {1: 59, 5: 245, 10: 475, 25: 1075} (proposed list prices, whole USD) (the one place prices live). Product ids and checkout links are not in the repo: they are read from the environment at request time (see Environment). A size with no valid id is not for sale. The product id decides how many reports a bundle holds; nothing in the payload (quantity, amount above the price) can raise it. The site's pricing section reads the prices from this map. Buy buttons appear only for a valid link, with the flag on (config.js keys `payLinkAgency1|5|10|25`).

## Payments (`site/polar_adapter.py`, `site/agency.py`)
- Only the adapter knows Polar's shape (`verify`, `parse`): the rest sees `{kind, ref, email, product_ids, paid_cents, one_time}`. A second provider later = one new adapter file.
- `order.paid` for exactly one bundle product id, one-time purchase, paid at list price or more, with a purchase email: one bundle, created once per Polar order id (create-only `bundles/<BND-id>.json`). Anything else: status `held` + alert, no bundle. Two product ids: `unknown_product`.
- `order.refunded`: unreserved reports are voided and the bundle frozen; reserved and delivered reports stay. No bundle for that order: ignored. Alerts carry ids, counts and amounts only.

## Counting
A run takes the next free slot (`bundle_runs/<bundle>/<n>`, create-only, server-chosen). The report is "used" when its slot is reserved. A run that fails for good returns its slot. Validation (US city `Austin, TX`, niche, public website, not a person's name) happens before any slot is reserved. The same client within 30 days needs `confirm_rerun`. Bulk CSV (at most 25 rows, 32 KB): whole upload or nothing. Runs use the one gated delivery path (`delivery.on_paid`: `AIVIS_AUTORUN`, `AIVIS_ALLOW_PAID`, `AIVIS_ORDER_CAP_USD`) plus the daily pack cap `AIVIS_PACK_DAILY_CAP_USD` (default 60; **Dvir confirms the default before the flag is turned on**): at the cap a report waits as `queued`, keeps its slot, and starts when the day rolls.

## Routes (all 404 with the flag off; every response is private, `noindex`, `no-store`)
| Route | What |
|---|---|
| `POST /agency/claim` `{email}` or `{email, order_id}` | Only the purchase email is required; an order id is optional and only narrows (a given id must match). One bundle: `{"portal": "/agency/p/<token>"}`. Several: `{"portals": [{reports, left, portal}]}`, newest first. A refunded bundle is still listed. Unknown email, wrong email and wrong order id give the same 404. 5 attempts a minute per address and 10 an hour per purchase email, then 429 (same body for known and unknown emails; nothing changes on a 429). Lookup uses `bundle_emails/<email_key>.json` (bundle ids, written when the bundle is created; bundles from before it are found by one scan of `bundles/`, which fills it). **Claiming by email alone is weaker: anyone who knows a purchase email can open that bundle's portal, which shows client business names and reports; the rate limits slow guessing but do not remove this.** |
| `GET /agency/p/<token>` | Portal page. `GET .../state` JSON, `GET .../preview?mode=branded|unbranded` labelled SAMPLE |
| `POST /agency/p/<token>/run` `{business, city, niche, website, competitors, prepared_for, mode, confirm_rerun}` | One report. 409 "No reports left in this bundle." when none |
| `POST .../bulk` `{csv, confirm_rerun, mode}` | Up to 25 rows |
| `POST .../brand` `{name, accent, contact_line}` | Name up to 80 characters, accent `#rrggbb` only |
| `POST .../logo` (raw PNG or JPEG, up to 300 KB, 2,000 x 2,000) | Checked by magic bytes and a real decode, re-encoded to PNG, never served on its own URL |
| `POST .../rebrand` `{order_id, mode, name, accent, contact_line}` | Regenerates from the stored result: no engine call, no slot, at most 5 per report |
| `GET /r/<report-token>` and `/r/<report-token>.pdf` | The report (HTML or PDF) in the chosen brand |
| `GET /agency-terms.html` | Neutral terms page |
| `GET /agency-thanks` and `/agency-thanks.html` | Order confirmation page (`noindex`), the checkout success URL: the bundle wording and a form (purchase email required, order id optional) that posts to `/agency/claim` and then opens the returned portal link, or lists several as plain links ("5 reports, 3 left"). A query string (for example `checkout_id`) is ignored, never echoed or logged. 404 while the flag is off. The extensionless alias exists for this page only |

Limits: 30 bad portal tokens a minute per address, 20 run submissions a minute per token (429, nothing consumed). The existing `MAX_BODY` (4,096) holds for every other route.

## Branding
Two modes. **Agency-branded**: name, logo, colour, contact line, optional "Prepared for". **Unbranded**: "AI Visibility Report" and nothing else. Neither shows "AI Visibility Check", our host name or our contact email. Both carry the fixed method footer (engines used, answers counted, run date, "Results vary from run to run; no ranking is promised."; health niches add "This report measures how AI assistants name businesses. It is not medical advice."). Without the new arguments `report_pro.render` output is byte-identical to before.

## Environment
`AIVIS_AGENCY`, `AIVIS_PACK_DAILY_CAP_USD`; the existing `AIVIS_AUTORUN`, `AIVIS_ALLOW_PAID`, `AIVIS_ORDER_CAP_USD`, `POLAR_WEBHOOK_SECRET`. The agency feature needs `pillow` and `fpdf2` (`ai-visibility-check/requirements.txt`) installed by the build.
The build installs `requirements.txt` (Pillow, fpdf2; pypdf is only for tests).

| Variable | Meaning | Unset or invalid |
|---|---|---|
| `AIVIS_AGENCY_PRODUCT_1`, `_5`, `_10`, `_25` | Polar product id of that bundle size: a UUID (case-insensitive, trimmed) | that size is not for sale: the webhook ignores it, no buy button |
| `AIVIS_AGENCY_LINK_1`, `_5`, `_10`, `_25` | Hosted checkout link: `https://buy.polar.sh/polar_cl_...` only | no buy button for that size |

The webhook matches on the product id only; the amount check (one-time purchase, list price or more) stays. An id repeated for a later size, or equal to an existing product id, is ignored and only a count is logged. Ids and links are never logged or alerted; alerts carry the size only. "Checkout is not connected yet" shows while no product variable is valid.
