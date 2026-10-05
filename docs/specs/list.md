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
  "replan": false,                       // true = recompute with the CURRENT pricing_settings version (needs approval_ref)
  "pricing_hold": null, "pricing_hold_reason": null,   // true/false pauses/resumes the drop schedule (needs approval_ref)
  "lto_max_months": null,                // override only (public LTO is off)
  "category": null,                      // only to change it (needs approval_ref; see V9)
  "override": false, "override_reason": null,
  "lander": "afternic", "ns": null, "display_name": "PromptInjectionAudit.com",
  "dry_run": false,
  "approval_ref": { "text": "...", "approved_at": "..." } }   // required if mode/price/category changes
```
- The schema is strict: unknown fields → 422.
- Omitting every price field means "NS/lander only". If any price is sent, `mode` and `bin` must be sent (offer mode: `min_offer`). In hybrid, `min_offer` is never sent; the server sets it to `hybrid_min_offer` ($100). The walk-away is private and is never exported.

## Behaviour
1. The domain must be in `domains` with status `owned` or `listed`. Otherwise **404** `NOT_IN_PORTFOLIO`.
2. Validate the listing (`listing-strategy.md` §5, V1–V10). On failure → 422 with no changes.
3. If `dry_run`, stop and return the validation result, the computed prices, the **full drop schedule** and a preview of the Afternic and Sedo export rows. Only an audit row is written.
4. **Nameservers**, depending on the registrar adapter's capability (`registrar_api` on the domain):
   - `full` / `manage` (Porkbun; GoDaddy management-only with a PAT): call `adapter.set_nameservers`, then `get_nameservers`, and **compare the two as sets**.
     - GoDaddy v3 `PUT /v3/domains/domain-names/{domain}/nameservers` returns **202** plus an operation to poll. Poll for up to 5 min, then return `ns_status: "pending"`.
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
| L-15 | `pricing_hold:true` without / with `approval_ref` | 422 `APPROVAL_REQUIRED` / 200, `listing_history` row, schedule rows stay planned past their due date (PR-23) | Other |
