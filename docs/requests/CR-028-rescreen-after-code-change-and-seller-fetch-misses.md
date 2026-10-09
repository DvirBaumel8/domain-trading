> Status: open. Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT.

# CR-028: re-screen after a DOM code fix; seller pages blocked or too big count as "not verified"
| Field | Value |
|---|---|
| CR id | CR-028 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-09 IDT |
| Priority | P2 |
| Based on | Live API v3.4.0: queue runs `run_b2c2d3c7-...` (screening `run_a45ce007-...`) and `run_a972e14a-...` (screening `run_3d6aa1b9-...`). No src/ or tests/ read. |

## A. `NOT_CHANGED` blocks the re-screen DOM-TO-GAVRIEL asked for
- **What happened:** `POST /candidates/screen {"domains": [... 8 names]}` skipped ukcbamcompliance.com and aievalsconsulting.com with `NOT_CHANGED`. The v3.4.0 note says to re-screen exactly these two after the CR-027 fix, but a code fix isn't one of the triggers (settings version, new record, new intake row).
- **The workaround I used:** I re-recorded the same `sellers` list for both (records 28, 29). They then re-screened and both pass.
- **Ask:** let a re-screen through when the code version of a gating check changed since the name's last screening, for example a `check_versions` comparison. Or add an explicit `force: true` that still counts against the allowance and is audited.

## B. Seller pages that block bots or are large count as not verified
`fields.sellers.entries` in `run_a45ce007-...`:

| Name | Verified | Unverified hosts (reason) |
|---|---|---|
| aiactauditor.com | 2 of 4 | sgs.com, zertia.ai (HTTP_4XX) |
| deforestationaudit.com | 1 of 4 | sgs.com, scsglobalservices.com, intertek.com (HTTP_4XX) |
| paytransparencyreporting.com | 2 of 4 | justparity.com, job-e.ai (TRUNCATED) |
| roofingdroneinspection.com | 3 of 5 | desertdronesllc.com, roofingfirstsolutions.com (HTTP_4XX) |

- **Why this is a problem:** our scout fetched these pages and found each firm selling the service. `same_name` itself treats 401/403/429 and TRUNCATED as **unknown**, never as "no operator".
- **Ask:**
  1. Show which 4xx it was.
  2. Treat 401/403/429 and TRUNCATED as `unknown`, not `not verified`. Option: let the tier read verified + unknown up to a setting, so it is Dvir's call.
  3. For TRUNCATED, read only the first `max_bytes` and judge that (the parked-page test needs only the top of the page).

A real 404 or a parked page should still count as not verified.
