> Status: DOM: accepted, v3.3.0. Sent by Gavriel under Dvir's standing rule of 2026-10-08 16:42 IDT (the customer may send DOM fix and feature requests without asking Dvir each time; buying, selling, spending and rule changes still go to Dvir).

# CR-023: lane-aware demand tier (firm count), per-name fail reasons on the daily list, /openapi.json, quieter DROP_FEED_STALE
| Field | Value |
|---|---|
| CR id | CR-023 |
| From | Gavriel (acceptance tester / customer), on behalf of Dvir |
| Date | 2026-10-09 08:25 IDT |
| Authority to send | Dvir's standing rule, 2026-10-08 16:42 IDT. Activating any new settings (v11.2) needs Dvir's own approval line; this CR asks only for the capability. |
| Priority | P1 for A-D (no S3/S4/S6 name can reach the daily list today). P2 for E-G. |
| Based on | Live API v3.2.2 only (`GET /screening/runs/run_e321135b-c4e9-4e85-8e5a-0865265fcb09`, `GET /selection/settings`, `GET /candidates/daily`, `GET /jobs/runs`). No src/ or tests/ read. |
| Related | CR-020 (lanes, who_chases), CR-022 (intake word split), CR-007 / v2.8.0 (drop lists, DROP_FEED_STALE). |

**Kind of change:** behavior we expect, with pass/fail tests. How to build it is DOM's choice. Route and field names are suggestions.

## 1. Business need
The 2026-10-09 daily run screened 6 scout names (lanes S3, S4, S6; intake ids 17-19, 22-24). All 6 failed `tier` (G8, `DEMAND2_FAIL`), and so all 6 also failed `price` (`EV_NOT_POSITIVE`), because with no tier DOM falls back to the lane prior.

| Name | Lane | words / chars | registered_share (A needs >= 0.55) | alt_tld_before_n (I needs >= 1) |
|---|---|---|---|---|
| aiactauditor.com | S6 | 3 / 12 | 0.00 | 0 |
| deforestationaudit.com | S6 | 2 / 18 | 0.50 | 0 |
| paytransparencyreporting.com | S6 | 3 / 24 | 0.00 | 0 |
| contextengineeringconsulting.com | S3 | 3 / 28 | 0.05 | 0 |
| constructioncomputervision.com | S4 | 3 / 26 | 0.05 | 0 |
| roofingdroneinspection.com | S4 | 3 / 22 | 0.00 | 0 |

The two demand signals (tier A: share of one-word-swapped siblings already registered; tier I: same name already held in another extension) both measure "others already registered lookalikes". S3, S4 and S6 names are fresh phrases picked **before** others do, so both signals are about zero by design. A 3-word sibling keeps two new words (e.g. `paytransparencyairlines.com`), so nobody owns it. The demand proof these lanes use is a count of named firms already selling or deploying the exact service (S3 >= 5, S4 >= 2, S6 >= 3). Tier rules have no input for it: the only tier inputs are short, is_geo, n_words, sld_chars, gform1_pass, prior_history, alt_tld_before_n and registered_share.

The two names over 25 characters failing is correct, and we are not asking to change that.

Finding the per-name reason also took digging. The daily list says only "6 failed the demand check", and the screening run id is reachable only through `GET /jobs/runs` -> `steps.intakeScreening.summary.run_id`.

## 2. Rules

### A. Lane as a tier input
- **R-A1:** each screened name exposes `lane` (the intake lane, or DOM's lane for drop-list names) as a tier clause input.
- **R-A2:** clauses support `op: "in"` with a list value (e.g. `{"f":"lane","op":"in","v":["S3","S4","S6"]}`). Per-lane clause sets are an acceptable alternative; DOM's choice.

### B. Verified firm count (sellers) with links
- **R-B1:** intake accepts an optional `sellers` list per name: `[{ "name": "...", "url": "https://..." }]`, max 10 entries. Each entry needs a name (<= 100 characters) and an http(s) URL. No emails or phone numbers (the same `NO_PII` rule as `who_chases`).
- **R-B2:** the same list can also come as a Shomer record, `POST /candidates/{domain}/records` with kind `sellers` (same shape, `checked_by`, `checked_at`), fresh for 30 days (a setting, `freshness_hours.sellers`, default 720). If both exist, the newer one wins.
- **R-B3:** during screening DOM fetches each URL politely (existing fetch limits and pacing) and counts an entry as verified only if the page loads (2xx after at most 3 redirects) and is not parked or for sale. Entries on the same registrable domain count once.
- **R-B4:** new tier input `sellers_verified_n` (integer; 0 when no list). The check result shows each entry with its verified/not-verified status and reason.
- **R-B5:** a missing or empty list is not a failure by itself. It only means tier L can't fire.

### C. Per-lane minimums
- **R-C1:** thresholds may be per-lane maps, e.g. `thresholds.lane_sellers_min: {"S3":5,"S4":2,"S6":3}`. A `$lane_sellers_min` reference resolves to the value for the name's lane.
- **R-C2:** a lane missing from the map means the clause is false for that lane (never a silent pass).

### D. Tier L (capability only; NOT activated)
- **R-D1:** settings must be able to express the tier below. DOM ships the capability and leaves the active settings (v11.1) untouched. Gavriel will create **v11.2** as a draft, and it becomes active only with Dvir's own approval line.
- **R-D2:** placeholder settings for v11.2 (for DOM's tests; values may change before Dvir approves):
  - `tier.order`: `["A","I","G","L"]`
  - `tier.clauses.L.all`:
    - `{"f":"lane","op":"in","v":["S3","S4","S6"]}`
    - `{"f":"sellers_verified_n","op":">=","v":"$lane_sellers_min"}`
    - `{"f":"n_words","op":">=","v":"$v11_min_words"}`
    - `{"f":"n_words","op":"<=","v":"$v11_max_words"}`
    - `{"f":"sld_chars","op":"<=","v":"$v11_max_chars"}`
    - `{"f":"is_geo","op":"==","v":0}`
  - `thresholds.lane_sellers_min`: `{"S3":5,"S4":2,"S6":3}`
  - `tier.demand2_pass_tiers`: `["A","I","G","L"]`
  - `tier.p_passive.L`: `0.01`
- **R-D3:** for a name that passes tier L, pricing uses `tier.p_passive.L` exactly as it does for the other tiers.
- **R-D4:** the A, I and G rules and the S2/S7 results don't change. Running the 2026-10-09 S2 holdouts under v11.2 gives the same tiers as under v11.1.

### E. Per-name fail reason and run id on the daily list
- **R-E1:** `GET /candidates/daily` `summary` carries `screening_run_id` (the intake screening run of that build).
- **R-E2:** `summary.rejected` lists every name screened in that build that didn't make the list, up to 30 entries. Each entry has `domain`, `lane`, `origin`, `first_fail: {check, gate, reason_code, reason}` and `key_inputs`. For `tier`, `key_inputs` holds the tier inputs and each clause's true/false. For `price`, it holds `ev_cents`, `P_sale` and `p_passive`.
- **R-E3:** the summary's plain-words `why` names the failing check per lane, e.g. "6 failed the demand check (S6: 3, S3: 1, S4: 2)".

### F. /openapi.json
- **R-F1:** `GET /openapi.json` returns 200 with a machine-readable OpenAPI 3 description of the public routes. Today it returns 404 `NOT_FOUND`. The same auth rules as other read routes apply (or it's public, your choice; it holds no secrets).

### G. Quieter DROP_FEED_STALE
Drop lists are now used only for idea mining and to catch uncaught leftovers at the normal price (lanes v11.1, CR-020). A missing upload is no longer a fault worth a warning every day.
- **R-G1:** the stale age is a setting, `intake.drop_feed_stale_days`, default 7 (today it's fixed at 2).
- **R-G2:** the level is a setting, `intake.drop_feed_stale_level`: `warn` | `info`, default `info`. At `info` it never counts toward warning totals and never triggers a warning notice.
- **R-G3:** the existing fields (`newest_list`, `newest_list_date`) stay unchanged.

## 3. Acceptance criteria
- **AC-1 (A):** a settings draft with clause `{"f":"lane","op":"in","v":["S6"]}` is accepted by validation. A screening replay shows `inputs.lane` per name, and the clause is true only for S6 names.
- **AC-2 (B intake):** intake with `sellers` of 3 valid entries → 200, stored, shown on the intake/list row. An entry with an email → 422 `NO_PII`. 11 entries → 422 `VALIDATION_ERROR`. A non-http URL → 422 `VALIDATION_ERROR`.
- **AC-3 (B record):** `POST /candidates/{domain}/records` kind `sellers` → 201. A record older than `freshness_hours.sellers` is ignored, with an unknown reason shown.
- **AC-4 (B verify):** 3 entries: one live page, one parked page, one 404 → `sellers_verified_n` = 1, each with its reason. Two entries on the same registrable domain → counted once.
- **AC-5 (C):** with `lane_sellers_min {"S3":5,"S4":2,"S6":3}`, an S4 name with 2 verified sellers passes the clause. An S3 name with 4 fails it. An S2 name makes the clause false.
- **AC-6 (D):** activating the R-D2 draft in a test environment: roofingdroneinspection.com (S4, 22 characters, 2+ verified sellers) gets tier L with `p_passive` 0.01, and price EV = P_sale x net - cost (at BIN $1,488: about +$3.01). constructioncomputervision.com (26 characters) still fails tier. **Production stays on v11.1.**
- **AC-7 (D, no change elsewhere):** the BT10 holdout suites give identical tiers and verdicts under v11.1 and under v11.2 for every non-S3/S4/S6 name.
- **AC-8 (E):** after a build where names fail, `GET /candidates/daily` shows `summary.screening_run_id` matching `GET /jobs/runs` `steps.intakeScreening.summary.run_id`, and one `summary.rejected` entry per failed name with `first_fail` and `key_inputs`.
- **AC-9 (F):** `GET /openapi.json` → 200, `openapi` starts with "3.", and every route in docs/contract is listed.
- **AC-10 (G):** with no new drop list for 3 days and defaults, `/report` shows no `DROP_FEED_STALE` warning. At 8 days it shows `DROP_FEED_STALE` at level `info`. Setting `drop_feed_stale_level: warn` and `drop_feed_stale_days: 2` restores today's behavior.

## 4. Open questions for DOM
- **Q1:** is fetching seller URLs (R-B3) fine within your fetch rules and budget (max 10 per name x 30 names a day)? If not, propose a lower cap (e.g. verify the first 5).
- **Q2:** would you rather put `lane` and `sellers_verified_n` into the generic tier inputs, or add a dedicated `lane_evidence` check before `tier`? Either is fine if AC-1 to AC-6 pass.
- **Q3:** should drop-list names ever get tier L (they have no seller list unless a scout adds one)? Our default: only if a `sellers` record exists.
- **Q4:** the S2 lead check (`lead`) is off (`gate_enabled: false`). Can B reuse its page-fetch code?

<!-- DOM writes below this line -->

## DOM response (2026-10-09)
**Accepted. Release v3.3.0, capability only; the active settings don't change.**
- **A:** `lane` becomes a tier input (the intake lane, or the lane a drop-list name fit), and clauses get `op: "in"` with a list value (Q2: generic tier inputs, no separate check).
- **B, `sellers`:**
  - **Where they come from:**
    - an optional `sellers` list on intake (at most 10 of `{name ≤ 100, url http(s)}`, under the `NO_PII` rule);
    - a `sellers` record kind on `POST /candidates/{domain}/records`, fresh for `freshness_hours.sellers` (default 720).
  - **Which list counts:** the newer of the two.
  - **Verification:** during screening DOM fetches each URL through its existing safe fetcher (public addresses only, at most 3 redirects, a timeout, paced). An entry counts as verified when the page answers 2xx and isn't parked or for sale (the parked-page detection from `lead`, Q4: yes). One registrable domain counts once.
  - **Q1:** fine. That's at most 10 fetches a name and 300 a day, read-only, at no cost.
  - **The result:** tier input `sellers_verified_n` (0 without a list), with each entry's verified/not-verified status and reason shown on the check.
  - **Q3:** agreed. A drop-list name gets tier L only if a `sellers` record exists.
- **C:** `thresholds.lane_sellers_min` (a per-lane map) and `$lane_sellers_min` resolve to the name's lane. A lane missing from the map makes the clause false.
- **D:** the R-D2 draft is expressible and tested (AC-6, AC-7), and `p_passive.L` prices exactly like the other tiers. **The active settings stay as they are;** v11.2 becomes active only with Dvir's line.
- **E:** `summary.screening_run_id` and `summary.rejected` (up to 30, `{domain, lane, origin, run_id, first_fail: {check, gate, reason_code, reason}, key_inputs}`). `why` names the failing check per lane, for example "6 failed the demand check (S6: 3, S4: 2, S3: 1)".
- **F:** `GET /openapi.json` (READ token, like other reads) gives an OpenAPI 3.1 description of every route in the contract: method, path, scope and summary, with the request body where the code has a schema. A test keeps it equal to the route table.
- **G:** `intake.drop_feed_stale_days` (default 7) and `intake.drop_feed_stale_level` (`info` | `warn`, default `info`). At `info` it is listed with level `info` and counts toward no warning total. The fields stay as they are.

## Activation record (2026-10-09, Gavriel)
- **Drafts:** `v11.2` (tier L at `p_passive` 0.01) was drafted and never activated. At 0.01 the price check fails RATIO-1 at the floor ($967 x 0.85 x 0.01 / $11.08 = 0.74), so `v11.3` was drafted: v11.1 plus tier L exactly as in v11.2, with `p_passive.L` 0.015. Under v11.3, evaluate gives aievalsconsulting.com and roofingdroneinspection.com tier L, EV +$15.50, ratio 1.71 at the BIN and 1.11 at the floor, price check passes.
- **Dvir's approval, verbatim (2026-10-09 12:12 IDT):** "I approve selection settings v11.3 (only adds tier L for lanes S3/S4/S6 at 0.015); the buy hold stays on"
- **Activated:** `POST /selection/settings/v11.3/activate` with that line as `approval_ref` → 200, active `v11.3`, `activated_at` 2026-10-09T12:12:22+03:00. `buy_hold` stays `true`.

## Activation record: v11.4 (2026-10-09, Gavriel)
- **What it is:** v11.4 = v11.3 plus the `same_name` check in `run.gates` (default after `ext_dates`, S2 after `tm_us`), so screening packs can be complete (`pack.require_checks` has `same_name`).
- **Dvir's approval, verbatim (2026-10-09 13:57 IDT):** "I approve selection settings v11.4 (only adds the same_name check to the gates); the buy hold stays on"
- **Activated:** `POST /selection/settings/v11.4/activate` with that line as `approval_ref` → 200, active `v11.4`, `activated_at` 2026-10-09T13:57:16+03:00. `buy_hold` stays `true`.
- **Also drafted, not active:** `v12` = v11.4 with `buy_hold: false`, the target for future hold-suite replays.
