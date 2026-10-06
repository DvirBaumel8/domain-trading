# POST /list/{domain} (WRITE)

Points the domain at the for-sale lander through the registrar's API (so it never sits idle or shows registrar ads) and records the listing mode and prices the exports use. Rules for modes and prices: `listing-strategy.md`. Shape: `docs/contract/endpoints.md`.

**Landers** (`settings.lander_target`, overridable per call). Dan.com was retired on 27 Jun 2025 (merged into Afternic, `../research/marketplaces.md` M1), so Afternic is the default.

| Target | Nameservers | Notes |
|---|---|---|
| `afternic` (default) | `ns1.afternic.com`, `ns2.afternic.com` | Keeps Afternic's 15% rate (25% without) |
| `sedo` | `ns1.sedoparking.com`, `ns2.sedoparking.com` | Sedo 10% when parked; Afternic sales then 25% |
| `custom` | `ns` from the request (2–4 hostnames) | Else 422 `NS_INVALID` (also `ns` with a non-custom lander) |
| `dan` | — | 422 `LANDER_RETIRED` ("Dan.com retired 2025-06-27; use afternic"); anything else 422 `LANDER_INVALID` |
One NS set per domain = one lander; a name can still be listed on Afternic and Sedo.

## Behaviour
1. Status `owned` or `listed`, else 404 `NOT_IN_PORTFOLIO` (`delisted`, `sold`, `dropped` too).
2. **Classification:** any of `mode`, a price, `walkaway`, `lto_max_months`, `pricing_exception`, a different `category` or `price_grade`, a `pricing_hold` change or `replan: true` is a change (a history row, re-validated). Only an exception or an override needs `approval_ref` (bot autonomy, 5 Oct 2026, 20:07). Unknown body fields → 422 `VALIDATION_ERROR` (LS-14).
3. **Order:** `display_name` (`DISPLAY_NAME_MISMATCH`: ASCII letters, digits, dots, hyphens, same name other capitalisation; exports fall back to the domain with `DISPLAY_NAME_IGNORED:<domain>`) → `MODE_INVALID` → field checks (`CATEGORY_REQUIRED`, `GRADE_NOT_GEO`, `HOLD_REASON_REQUIRED`, `REPLAN_NOTHING_LISTED`, the relabel-to-geo override, `GEO_GRADE_REQUIRED`) → V1–V8 → an invalid `approval_ref` if one was sent (V9/V10) → `DROP_DATE_UNKNOWN` (no `drop_date` to schedule against) → lander/NS.
4. **Values:** a category or grade change without a price change keeps every stored value (BIN, floor, walk-away, min offer, LTO, `pricing_source`) and re-validates structurally; LTO then needs the override again. `replan: true` recomputes from the stored BIN with the current settings (an earlier exception is dropped unless re-sent; LTO carried). A first listing and `replan` use the current settings version; other changes keep the plan's version. `price_grade` is geo only; moving to a non-geo category clears it. Prices are whole dollars (`LISTING_PRICE_INVALID`).
5. `dry_run` (outside the lock): the validation result, computed prices, the **full schedule** and the Afternic and Sedo row previews; only an audit row.
6. **Lock:** the rest runs under the per-domain lock shared with `/buy` (`hashtext(domain)`); waiting > 30 s → 503 `DOMAIN_BUSY`; a change that slips past it → 409 `LISTING_CHANGED_CONCURRENTLY` (retry with a new key).
7. **Nameservers** (set **before** the listing is saved; a refusal saves nothing):
   - `full`/`manage`: `setNameservers`, then `getNameservers`, compared **as sets** → `set` / `mismatch` / `unverified`. `API_ACCESS_DISABLED` → 409 with a per-registrar hint (Porkbun: "Opt In All Domains" at porkbun.com/account/api); other definite errors → 409 `REGISTRAR_REJECTED` (`registrar_code`). Ambiguous (timeout, 5xx, bad response) → read back: match → continue with `NS_SET_AFTER_AMBIGUOUS`; else 503 `REGISTRAR_UNAVAILABLE`, nothing saved, key released.
   - GoDaddy v3: `PUT …/nameservers` → 202 + an operation polled up to **60 s**; still running, no trackable id, or **any** poll error → `ns_status: "pending"` + `NS_PENDING: <registrar> is still applying the change; the daily DNS check will confirm it`, no read-back, listing **still saved**. FAILED → its code as a definite error, else `GODADDY_OPERATION_FAILED`.
   - `none` (no API, or an adapter without NS management): no registrar call; `ns_status: "manual"` with the exact steps (menu names UNVERIFIED: follow the registrar's UI).
   - Always: an immediate public-DNS NS query (`192.5.6.30` = a.gtld-servers.net, `DNS_NS_SERVER` overrides, 3 s timeout) → `ns_public: match | pending | unknown` (an empty answer = mismatch). `ns_verified_at` is set only on a match and cleared when the NS target changes. The daily job (`tick`, ≤ every 24 h) re-checks every domain with a lander target; `/report` warns `NS_UNVERIFIED` until it matches.
8. **Save:** mode, computed or exception prices, category, `lander`, `lander_ns`, `lander_set_at`; a `listing_history` row; `status = listed` when a mode is set. First listing (no `first_listed_at`) → anchor = today (IDT) and create the `price_schedule` rows. An approved price, category, grade or replan change on a listed domain supersedes the `planned` rows and creates new ones with the same anchor (events already due aren't recreated, except `delist`). A hold change never regenerates; `pricing_hold: true` needs a reason. Set `export_pending_since`.
9. **Checklist** (no marketplace API is used): upload `/export/afternic.csv` at afternic.com/domains/add with **Update** (GoDaddy names: GoDaddy's *List for Sale* is an alternative); Sedo bulk uploader; day 60 (registry creation + 60): Afternic Fast Transfer opt-in (automatic at GoDaddy; approve it at Porkbun); then `POST /export/{venue}/uploaded` with the `X-Export-Id`.

## Tests
| ID | Case | Pass |
|---|---|---|
| L-1 | Default lander | Mock gets exactly {ns1, ns2}.afternic.com; row updated; set comparison (reversed order still passes) |
| L-2 | `lander:"dan"` | 422 `LANDER_RETIRED` |
| L-3 | `custom` with 1 / 5 NS / an invalid hostname | 422 |
| L-4 | Not in the portfolio | 404, no registrar call |
| L-5 | Validation | All LS-*, LG-*, LH-* (`test-plan.md` §Listing) |
| L-6 | Registrar `API_ACCESS_DISABLED` | 409 with the "Opt In All Domains" hint |
| L-7 | READ token | 403 |
| L-8 | Replay | Replayed, 1 registrar call |
| L-9 | Audit | One audit row per call, refusals included |
| L-10 | Live (G5): D-001 imported, then `POST /list` | `dig NS promptinjectionaudit.com @a.gtld-servers.net` shows the afternic pair within 24 h; the lander shows the exact BIN within 48 h of the Afternic upload (headless browser; curl only gets a JS redirect stub). Else Dvir checks Afternic; at 96 h, Afternic support |
| L-11 | `registrar_api=none` | 200 `ns_status:"manual"` with steps; 0 registrar calls; prices saved; `/report` warns until DNS shows the lander |
| L-12 | GoDaddy mock: 202 + polling | Polled to completion; `ns_status:"set"`; set compared |
| L-13 | DNS job: mock returns afternic NS | `ns_verified_at` set; warning cleared |
| L-14 | First listing hybrid 1995 on an owned domain | 1995/1295/960; `first_listed_at` today; 4 schedule rows (PR-12); `export_pending_since` set |
| L-15 | `pricing_hold:true` without approval / without reason | 200, history row with null approval, rows stay planned past due (PR-23) / 422 `HOLD_REASON_REQUIRED` |
| L-16 | GoDaddy operation still running past the poll timeout | 200 `ns_status:"pending"` + `NS_PENDING`; no compare; prices, `lander_ns`, history saved; `/report` NS warning |
| L-17 | GoDaddy: PUT accepted, then the poll errors / FAILED with `X_CODE` / FAILED without a code | 200 pending + `NS_PENDING`, saved / 409 `REGISTRAR_REJECTED` with `X_CODE` / `GODADDY_OPERATION_FAILED` |
