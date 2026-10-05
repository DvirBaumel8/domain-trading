# POST /list/{domain}  (WRITE)

**Goal:** point the domain at the for-sale lander through the registrar's API, so it never sits idle, returns a 404, or shows registrar ads. Also record the listing mode and prices that the export files use.

**Dan.com status (verified):** Dan.com was retired on **27 Jun 2025**, after merging into Afternic, which GoDaddy owns. Its lander and features now live in Afternic (`docs/research/marketplaces.md` M1). So the default lander is **Afternic**, and `"dan"` is rejected with a pointer to Afternic.

## Lander config
Set in `settings.lander_target`; can be overridden per call.

| Target | Nameservers | Notes |
|---|---|---|
| `afternic` (**default**) | `ns1.afternic.com`, `ns2.afternic.com` | Keeps Afternic's **15%** Basic rate (25% without) |
| `sedo` | `ns1.sedoparking.com`, `ns2.sedoparking.com` | 10% on Sedo when parked or using a Sedo lander. Afternic sales then cost 25% |
| `custom` | `ns` array from the request (2–4 hostnames) | For anything else |
| `dan` | — | 422 `LANDER_RETIRED` ("Dan.com retired 2025-06-27; use afternic") |

One domain can have **only one** nameserver set, so it shows one lander. It can still be listed on both Afternic and Sedo.

## Request
`Idempotency-Key` header required. Modes, guards and the mapping from Dvir's `dt list … --bin/--offer` wording are in **`listing-strategy.md`** (the source of truth for pricing).
```json
{ "mode": "hybrid",                      // bin | hybrid | offer (offer = override only); required when any price is sent
  "bin": 1995,                           // hybrid: floor and walkaway are COMPUTED; min_offer = hybrid_min_offer ($100) (listing-strategy.md §10)
  "floor": null, "walkaway": null,       // only with "pricing_exception": true + reason + approval_ref (e.g. D-001: 1295 / 950)
  "pricing_exception": false, "pricing_exception_reason": null,
  "replan": false,                       // true = recompute with the CURRENT pricing_settings version (no approval_ref)
  "pricing_hold": null, "pricing_hold_reason": null,   // true/false pauses/resumes the drop schedule (reason required; no approval_ref)
  "lto_max_months": null,                // override only (public LTO is off)
  "category": null,                      // only to change it (approval_ref only when relabelling to geo, an override; V9)
  "override": false, "override_reason": null,
  "lander": "afternic", "ns": null, "display_name": "PromptInjectionAudit.com",
  "dry_run": false,
  "approval_ref": { "text": "...", "approved_at": "..." } }   // required only for exceptions and overrides
```
- The schema is strict: unknown fields → 422.
- Omitting every price field means "NS/lander only". If any price is sent, `mode` and `bin` must be sent (offer mode: `min_offer`). In hybrid, `min_offer` is never sent; the server sets it to `hybrid_min_offer` ($100). The walk-away is private and is never exported.

## Behaviour
1. The domain must be in `domains` with status `owned` or `listed`. Otherwise **404** `NOT_IN_PORTFOLIO`.
2. Validate the listing (`listing-strategy.md` §5, V1–V10). On failure → 422 with no changes.
3. If `dry_run`, stop and return the validation result, the computed prices, the **full drop schedule** and a preview of the Afternic and Sedo export rows. Only an audit row is written.
4. **Nameservers**, depending on the registrar adapter's capability (`registrar_api` on the domain):
   - `full` / `manage` (Porkbun; GoDaddy management-only with a PAT): call `adapter.set_nameservers`, then `get_nameservers`, and **compare the two as sets**.
     - GoDaddy v3 `PUT /v3/domains/domain-names/{domain}/nameservers` returns **202** plus an operation to poll. Poll for up to 5 min. If the operation is still running, return `ns_status: "pending"` with the warning `NS_PENDING` (GoDaddy is still applying the change; the daily DNS check confirms it), skip the read-back compare, and **still save the listing** (the NS target is recorded). A FAILED operation → a definite registrar error.
   - `none` (no API, or an ineligible account): skip the registrar call. Return `ns_status: "manual"` with the exact steps (e.g. "GoDaddy → domain → DNS → Nameservers → use my own → ns1.afternic.com, ns2.afternic.com"; the menu path is UNVERIFIED, so Dvir follows GoDaddy's current UI).
   - **In all cases**, the service then verifies **via public DNS** (an NS query to `a.gtld-servers.net`). A daily job re-checks, sets `ns_verified_at`, and warns in `/report` until the NS matches.
5. Save the mode, the computed (or approved-exception) prices and the category on `domains`, plus `lander`, `lander_ns` and `lander_set_at`. Append a `listing_history` row. Set `status=listed` when a mode is set. On the **first** listing, set `first_listed_at` and create the `price_schedule` rows. On an approved price change or `replan`, supersede the open rows and create new ones (`listing-strategy.md` §10.4). Set `export_pending_since`.
6. Return the checklist of manual marketplace steps (no marketplace API is used):
   - "Add/update at Afternic: download `/export/afternic.csv`, upload at afternic.com/domains/add with **Update**". For GoDaddy-registered names, GoDaddy's own *List for Sale* is an alternative.
   - "Sedo: `/export/sedo.csv` → Bulk Uploader";
   - "Day 60 (registry creation date + 60): Afternic Fast Transfer opt-in (automatic for GoDaddy names; approve it at Porkbun)";
   - after Dvir confirms the upload: `POST /export/{venue}/uploaded` with the `X-Export-Id`.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| L-1 | Default lander | Mock registrar receives exactly `{ns1.afternic.com, ns2.afternic.com}`; DB row updated; `get_nameservers` compared as a set (a mock returning reversed order still passes) | Wrong NS, or a false mismatch on order |
| L-2 | `lander:"dan"` | 422 `LANDER_RETIRED` | Accepted |
| L-3 | `custom` with 1 NS / 5 NS / an invalid hostname | 422 | Accepted |
| L-4 | Domain not in the portfolio | 404, no registrar call | Registrar called |
| L-5 | Price, mode and guard validation | All LS-*, LG-*, LH-* tests in `listing-strategy.md` §9 | Any fails |
| L-6 | Registrar `API_ACCESS_DISABLED` | 409, with the hint to enable "Opt In All Domains" | 500 |
| L-7 | READ token | 403 | Executed |
| L-8 | Idempotency replay | Second call replayed, 1 registrar call | 2 calls |
| L-9 | Audit | One audit row per call, including refusals | Missing |
| L-11 | Registrar without NS API (`registrar_api=none`, e.g. GoDaddy without a PAT) | 200, `ns_status:"manual"` with steps; 0 registrar calls; prices saved; `/report` warns until DNS shows the lander | 500, or prices not saved |
| L-12 | GoDaddy NS via mock: 202 + operation polling | Operation polled to completion; `ns_status:"set"`; set compared | Treated as failure, or no polling |
| L-13 | DNS verification job: mock DNS returns afternic NS | `ns_verified_at` set; warning cleared | Not set |
| L-10 | Live (gate G5) | After D-001 is imported and `POST /list/promptinjectionaudit.com` is called (bought by hand at GoDaddy, so `/buy` didn't set NS; the NS change comes via the GoDaddy PAT or Dvir's manual change): `dig NS promptinjectionaudit.com @a.gtld-servers.net` shows the afternic.com pair **within 24 h**. The lander at `https://promptinjectionaudit.com` loads and shows the **exact BIN ($1,995)** within **48 h** of the Afternic upload (checked with a headless browser: plain curl only gets a JavaScript redirect stub) | Not by 24 h / 48 h (then Dvir checks the Afternic listing; at 96 h, Afternic support) |
| L-14 | First `POST /list` with hybrid bin 1995 on an owned domain | 200; stored 1995/1295/960; `first_listed_at` = today; 4 `price_schedule` rows (PR-12 values); `export_pending_since` set | Missing schedule |
| L-15 | `pricing_hold:true` without `approval_ref` / without a reason | 200, `listing_history` row (`approval_text` null), schedule rows stay planned past their due date (PR-23) / 422 `HOLD_REASON_REQUIRED` | Other |
| L-16 | GoDaddy NS via mock: the operation stays running past the (injected, short) poll timeout | 200, `ns_status:"pending"` + `NS_PENDING`; no read-back compare; prices, `lander_ns` and `listing_history` saved; `/report` NS warning until the DNS check matches | Error, or listing not saved |

## Decisions (Dvir, 5 Oct 2026, steps 4a–4b-2; confirmed "Confirm all")
- **Change classification:** any of `mode`, a price, `walkaway`, `lto_max_months`, `pricing_exception`, a different `category` or `price_grade`, a `pricing_hold` change or `replan: true` is a change (a history row, re-validated). **Superseded 5 Oct 2026, 20:07 (bot autonomy):** a change needs `approval_ref` only for a pricing exception or an override; anything else, including NS-only fields, needs none. Unknown body fields → 422 `VALIDATION_ERROR` (LS-14).
- **Order:** an invalid `mode` → `MODE_INVALID` first; then the field checks (`CATEGORY_REQUIRED`, `GRADE_NOT_GEO` (grade on a non-geo name), `GEO_GRADE_REQUIRED` (becoming geo without a grade), `HOLD_REASON_REQUIRED`, `REPLAN_NOTHING_LISTED`, the relabel-to-geo override); then V1–V8; then V9/V10.
- **`price_grade`** is accepted in the body (geo only). Moving to a non-geo category clears it.
- **A category or grade change without a price change** keeps every stored value (BIN, floor, walk-away, min offer, LTO, `pricing_source`) and re-validates them structurally under the new category; nothing is recomputed. If the listing has LTO, the call needs the override again. `replan: true` recomputes from the stored BIN with the current settings (an earlier exception is dropped unless re-sent) and also carries LTO.
- **Settings version:** a first listing and `replan` use the current `pricing_settings` version; any other manual change keeps the plan's version.
- **Schedule:** the first listing (no `first_listed_at`) creates the rows, anchored on today (IDT). An approved price, category, grade or replan change on a listed domain supersedes the `planned` rows and creates new ones with the same anchor; events already due are not recreated, **except `delist`, which is always kept**. A hold change never regenerates.
- **Hold:** `pricing_hold: true` needs a non-empty `pricing_hold_reason`; a hold change appends a `listing_history` row with the unchanged prices.
- **Status:** only `owned` and `listed` can be listed; `delisted`, `sold` and `dropped` → 404 `NOT_IN_PORTFOLIO`.
- **Concurrency:** the whole call (except `dry_run`) runs under the per-domain lock shared with `/buy` (`hashtext(domain)`); waiting more than 30 s → 503 `DOMAIN_BUSY`. A change that slips past it anyway → 409 `LISTING_CHANGED_CONCURRENTLY` (retry with a **new** `Idempotency-Key`).
- **Nameservers:**
  - NS are set before the listing is saved; a refusal saves nothing. `API_ACCESS_DISABLED` → 409 with a per-registrar hint; other definite errors → 409 `REGISTRAR_REJECTED` with `registrar_code`.
  - An **ambiguous** registrar answer (timeout, 5xx, bad response) is checked by reading the NS back: a match continues with warning `NS_SET_AFTER_AMBIGUOUS`; otherwise 503 `REGISTRAR_UNAVAILABLE` and nothing is saved (the key is released, so a same-key retry runs again).
  - The immediate public-DNS check returns `ns_public: match | pending | unknown`; an empty DNS answer counts as a mismatch. `ns_verified_at` is set only on a match and cleared when the NS target changes. The daily job re-checks every domain with a lander target (DNS server `192.5.6.30`, `DNS_NS_SERVER` overrides it; 3 s timeout).
- **`display_name`** must be ASCII letters, digits, dots and hyphens and differ from the domain only in capitalisation, else 422 `DISPLAY_NAME_MISMATCH`. The exports re-check it and fall back to the domain with warning `DISPLAY_NAME_IGNORED:<domain>`.
- **Prices are whole dollars** (`LISTING_PRICE_INVALID` otherwise); this replaces the 4a interim rule that kept cents.
- **Response:** `listing` uses the plan view (`*_cents` + display strings, walk-away "(private)", `pricing_source`, `settings_version`, `schedule`, `sell_plan_line`), plus `pricing_hold`. A dry run with no plan change shows the current schedule.
- GoDaddy NS (L-12) arrives with the GoDaddy adapter in step 4d; until then a `manage` domain without that adapter is handled as `manual`.
