# POST /list/{domain}  (WRITE)

**Goal:** point the domain at the for-sale lander through the registrar's API, so it never sits idle, returns a 404, or shows registrar ads. Also record the sale prices that the export files use.

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
`Idempotency-Key` header required.
```json
{ "lander": "afternic", "ns": null,
  "bin": 1995, "floor": 950, "min_offer": 950, "lto_max_months": 24, "display_name": "PromptInjectionAudit.com",
  "approval_ref": { "text": "...", "approved_at": "..." } }
```
- Every price field is optional; omitted fields keep their current value.
- The pricing rules come from the Afternic template:
  - `min_offer` ≥ 20;
  - LTO requires a BIN of 495 or more, and `lto_max_months` must be 2–60;
  - `floor` ≤ `bin`.
- `approval_ref` is optional: changing nameservers and prices costs nothing. Gavriel still includes it when Dvir approved prices.

## Behaviour
1. The domain must be in `domains` with status `owned` or `listed`. Otherwise **404** `NOT_IN_PORTFOLIO`.
2. Call `adapter.set_nameservers` with the lander's nameservers, then `get_nameservers`, and **compare the two as sets**.
   - Porkbun supports `dryRun` on `updateNs`. The service doesn't expose a dry-run flag on `/list`; the dry run is used only in tests.
3. Save `lander`, `lander_ns`, `lander_set_at` and the prices. Set `status=listed` if a BIN is set, otherwise keep `owned` and add a warning that the lander will show no price.
4. Return the checklist of manual marketplace steps (no marketplace API is used):
   - "Add/update at Afternic: download `/export/afternic.csv`, upload at afternic.com/domains/add with **Update**";
   - "Sedo: `/export/sedo.csv` → Bulk Uploader";
   - "Day 60 (`buy_date + 60`): enable Afternic Fast Transfer opt-in at the registrar".

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| L-1 | Default lander | Mock registrar receives exactly `{ns1.afternic.com, ns2.afternic.com}`; DB row updated; `get_nameservers` compared as a set (a mock returning reversed order still passes) | Wrong NS, or a false mismatch on order |
| L-2 | `lander:"dan"` | 422 `LANDER_RETIRED` | Accepted |
| L-3 | `custom` with 1 NS / 5 NS / an invalid hostname | 422 | Accepted |
| L-4 | Domain not in the portfolio | 404, no registrar call | Registrar called |
| L-5 | Price validation: `min_offer` 10, `floor > bin`, LTO with BIN 300 | 422 for each | Accepted |
| L-6 | Registrar `API_ACCESS_DISABLED` | 409, with the hint to enable "Opt In All Domains" | 500 |
| L-7 | READ token | 403 | Executed |
| L-8 | Idempotency replay | Second call replayed, 1 registrar call | 2 calls |
| L-9 | Audit | One audit row per call, including refusals | Missing |
| L-10 | Live (gate G5) | After D-001 is imported and `POST /list/promptinjectionaudit.com` is called (it was bought by hand, so `/buy` didn't set NS): `dig NS promptinjectionaudit.com @a.gtld-servers.net` shows the afternic.com pair **within 24 h**. The lander at `https://promptinjectionaudit.com` loads and shows the **exact BIN** within **48 h** of the Afternic upload | Not by 24 h / 48 h (then Dvir checks the Afternic listing; at 96 h, Afternic support) |
