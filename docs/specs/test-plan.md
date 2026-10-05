# Test plan: domain-trading API v1

The per-endpoint test IDs live in each spec: `check.md` CK-*, `buy.md` B-*, `list.md` L-*, `export-csv.md` E-*, `sold.md` S-*, `report.md` R-*, `backup.md` BK-*. This file covers the **gates**, the cross-cutting tests, and the kill criteria.

**Rules:**
- Claude Code stops at the end of each gate and reports results to Dvir.
- **No gate starts until the previous one passes.**
- Gates G0–G2 never touch real money or real registrar accounts.

## Gates

| Gate | What | How measured | Pass | Fail → on-fail |
|---|---|---|---|---|
| **G0: Unit** | Selection logic, money math, `drop_date`, validation, CSV formatting, **pricing calculator (formula, rounding, minimums, schedule dates)** | `npx vitest run tests/unit` with no network (network blocked via MSW `onUnhandledRequest: 'error'`) | 100% green; selection tests CK-1–CK-10 and B-10; renewal tests RN-1–RN-6 below; E-1–E-5; export-per-mode tests LX-1–LX-7 (incl. LX-3b); **pricing calculator PR-1–PR-19 and PR-40–PR-44** below | Any red → fix before G1 |
| **G1: API + DB** | Every endpoint against a real Postgres (docker) with **mocked registrars** (MSW) | `npx vitest run tests/api`; the mock registrar logs every call | All of AU-*, CAP-*, ID-*, DR-*, AL-* below, plus B-1–B-25, B-28, L-1–L-9, L-11–L-17, E-6–E-8, S-1–S-15, R-1–R-15, **PO-1–PO-5**, **SL-1–SL-7**, ADM-1–ADM-4 (`cli.md`), IM-1–IM-3, IM-5–IM-17, **LS-1–LS-20, LG-1–LG-21, LH-1–LH-5** (`listing-strategy.md` §9), **PR-20–PR-39** and **OF-1–OF-20** below, E-10–E-13, BK-1–BK-4, BK-7, BK-8, **JOB-1–JOB-7** | Any red → fix. **Zero** real HTTP calls (asserted) |
| **G2: Porkbun contract + sandbox** | Adapter against Porkbun's official mock server, then the sandbox (`pk1_sb_…` keys) | `npm run test:contract:mock`, then `npm run test:contract:sandbox` (both set `VITEST_CONTRACT=1`; the sandbox project is skipped without sandbox keys and can request throwaway `pk1_sb_` keys) | Request shapes accepted; error codes mapped; B-26 E2E passes in the sandbox; idempotent replay confirmed | Contract mismatch → re-read https://porkbun.com/llms/domain, fix the adapter. Sandbox unavailable → note it; G3 dry run stands in |
| **G3: Deploy + live read-only** | Free deploy (Render + Neon + Cloudflare Worker, `00-architecture.md` §8); import D-001 (bought by hand, IM-4); live `/check` and a `/buy` with `dry_run:true` for a free test .com Dvir is willing to buy. **The Porkbun credit stays at $0 until G4, and every G3 `/buy` sends `dry_run: true` explicitly** | Run by Gavriel with the READ and WRITE tokens (Dvir never calls the API); Porkbun balance and invoices compared before and after | `/health` ok; CK-12 and IM-4 pass; dry run returns `wouldSucceed:true` (or a clear reason such as `VERIFICATION_REQUIRED` / `INSUFFICIENT_FUNDS`); **balance, invoices and spend all unchanged**; audit rows present; ledger holds only the imported D-001 registration row | Any charge → **stop everything**, contact Porkbun support, remove the WRITE token. Other failures → fix and repeat |
| **G4: Live acceptance (first real API buy: the next approved deal, D-002 or later)** | Gavriel calls `/buy` after Dvir's explicit chat approval (quoted in `approval_ref`) | Porkbun dashboard + `/report` + `/portfolio/<domain>` | B-27 passes; BK-5 restore drill done beforehand; a repeat `/buy` with a new key → 409 `ALREADY_OWNED_OR_PENDING` | Charge without rows → the reconciler must fix it within 10 min; else Dvir enters a manual ledger row via the admin command, and **no further buys** until fixed |
| **G5: Post-acquisition** | Lander, marketplaces, Fast Transfer (the PA tests in `system/post-acquisition.md`) | `dig`, browser, Afternic/Sedo dashboards | L-10, E-9, LX-8, LX-9, **PR-L1**, and PA-1–PA-8 by their deadlines | See each PA test's on-fail |

## Cross-cutting tests (G1)

**Auth and scope (AU)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| AU-1 | No or a bad `Authorization` on every endpoint except `/health/ping` (`/health` and unknown routes included; Dvir, 6 Oct 2026: bots are the only customers) | 401 for all, and the `audit_log` and `idempotency_keys` row counts are unchanged | Any 2xx, or any DB write |
| AU-11 | 21st failed auth from one IP within 10 min (Dvir, 6 Oct 2026); the IP is the right-most `X-Forwarded-For` entry (one trusted hop) | 429 `RATE_LIMITED` with `Retry-After`, zero DB access (builders and executor spied); another IP unaffected; the window rolls | Lookup or write on a blocked IP, or the limiter keyed on a forgeable header entry |
| AU-12 | Blocked IP: a bot token verified in the last 10 min; a never-seen valid token; the correct and a wrong job token; a cached token revoked meanwhile; a revoked token on the normal path | Cached token passes only through the normal DB lookup; unseen → 429; correct job token → 200, wrong → 429; revoked while blocked → 429; revoked normal path → 401 at once | A cache hit that authenticates without the lookup (revocation bypass) |
| AU-13 | A valid token with the wrong scope (403) | Still audited (it is a bot) | No audit row |
| AU-2 | Malformed / unknown token | 401 | Other |
| AU-3 | READ token on `POST /buy`, `/list/x`, `/sold/x` | 403 `SCOPE_FORBIDDEN`, audit row written, **zero** registrar calls | Executed |
| AU-4 | READ token on every GET | 200 | Other |
| AU-5 | WRITE token on every GET | 200 | Other |
| AU-6 | Revoked token | 401 within 1 request of revocation | Accepted |
| AU-7 | No endpoint creates, lists or reveals tokens | Route-table test: no `/token*` route | Route exists |
| AU-8 | Secrets never leak | Responses, logs and audit rows for all tests are grepped for every env secret value and for `pk1_`/`sk1_` prefixes: 0 hits | Any hit |
| AU-10 | Bot permissions: Gavriel's WRITE token on `POST /sold` with `transaction_ref` + `evidence`, no `approval_ref`; the same token on `POST /buy` without `approval_ref` | `/sold` 200 (`confirmed: false`); `/buy` 422 (approval required), zero registrar calls | `/sold` refused, or `/buy` accepted |
| AU-9 | Rate limit | The 11th POST in 1 min → 429 | Accepted |

**Caps (CAP)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| CAP-1 | $1,500 POC cap (B-11) and its race (B-12) | As specified | Overshoot |
| CAP-2 | 50-domain cap (B-13); `pending_purchase` counts | 409 | Bought |
| CAP-3 | Per-call `max_price` (B-8, B-9, B-10) | As specified | Bought above the cap |
| CAP-4 | Approval age, future timestamp, domain mismatch (B-7) | 422 | Accepted |
| CAP-5 | Caps can't be changed via the API | No route writes `settings`; a body field `poc_cap` is ignored or rejected | Changed |
| CAP-6 | Sum invariant | After any test sequence: −Σ(registration+renewal+fee) ≤ `poc_cap_cents` (property test, 200 random sequences) | Violated |

**Idempotency (ID)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| ID-1 | Missing key on each POST | 400 | Accepted |
| ID-2 | Replay on each POST (B-3, L-8, S-5) | Same response, side effects once | Twice |
| ID-3 | Same key, different body | 409 | Executed |
| ID-4 | Registrar key derived from the purchase id; reused on retries (B-19) | Mock sees the same `Idempotency-Key` on all retries | Different keys |

**Dry run (DR)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| DR-1 | `/buy dry_run:true` (B-16) | No ledger/domain rows; audit row; registrar dry run called with the exact `cost` | Any money row |
| DR-2 | Dry run still enforces every check (cap, approval, `max_price`) | Same errors as a real call | Passes a check a real call would fail |
| DR-3 | Dry run with the same idempotency key as a later real call | The real call is a different request hash → 409; Gavriel must use a new key | Dry run response replayed as a real buy |

**Audit and append-only (AL)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| AL-1 | Every authenticated POST in the G1 suite (Dvir, 6 Oct 2026: unauthenticated requests write nothing) | Exactly one `audit_log` row per request, including a valid-token POST 4xx; framework errors (answered before auth) write nothing, token or not | Missing or duplicate |
| AL-2 | `UPDATE`/`DELETE` on `ledger_entries` and `audit_log` | DB error | Succeeds |
| AL-3 | Audit row content | Scope, token id, `approval_text`, `approval_at`, status code; no secrets | Missing field or secret |

**Max-one-renewal (RN)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| RN-1 | Two-year cost = first year + one renewal (CK-9) | Exact | Off |
| RN-2 | `drop_date` = expiry + 1 yr (B-21), with the leap-year case (B-22) | Exact | Off |
| RN-3 | DB CHECK: `renewals_used = 2` | Insert fails | Succeeds |
| RN-4 | `committed_forward` counts ≤ 1 renewal (R-3) | Exact | Over |
| RN-5 | Final-expiry alert (R-5) | No renew option offered | Offered |
| RN-6 | `register` is always called with years = 1 | Mock assertion | Any other term |

## Pricing calculator, drop schedule and settings versioning (PR; adopted 5 Oct 2026, 00:46 IDT; **settings v2 since 09:17 IDT**; rules in `listing-strategy.md` §10)

All amounts are USD. The code works in integer cents. Settings are **v2** unless stated (v1 is superseded; every PR-* vector below is v2 and stays valid for v2 plans such as D-001). **v3 vectors (selection v9.1, 6 Oct 2026) are PR3-* below.** Vectors were generated with the reference calculator `system/tools/pricing_calc.py` (outside the repo). **If the code disagrees with a vector, stop and ask Dvir; never edit the vector to match the code.**

**Formula and minimums (G0 unit)**

| ID | Input | Pass | Fail |
|---|---|---|---|
| PR-1 | hybrid BIN 1995 | floor 1295, walkaway 960, min_offer 100 (`hybrid_min_offer`), `pricing_source=formula` | Any other value |
| PR-2 | hybrid BIN 2495 | 1620 / 1200 | Other |
| PR-3 | hybrid BIN 4995 | 3245 / 2400 | Other |
| PR-4 | hybrid BIN 1195 | 775 / 575 | Other |
| PR-5 | hybrid BIN 795 (the minimum) | floor 750 + `FLOOR_RAISED_TO_MIN`; walkaway **500** (raised to `walkaway_min`); no `WALKAWAY_BELOW_500` (retired) | Other, or warning missing/extra |
| PR-6 | geo `strong` / `weaker` | 499/499/499 / 399/399/399 (bin = floor = walkaway = min_offer) | Other |
| PR-7 | Rounding vectors (cents in → cents out) | `nice95`: 159600→159500; 127600→129500; 154500→149500 (tie down); 95600→99500. `nice99`: 39920→39900; 31920→29900. `ceil95`: 83000→89500; 75000→79500; 103500→109500; 129500→129500. `round5`: 129675→129500; 95760→96000; 95750→96000 (tie up); 82800→83000 | Any differs |
| PR-8 | BIN validation | 1990 → `BIN_NOT_NICE`; 695 → `BIN_BELOW_FLOOR_MIN`; 795 → ok; 1995 → ok | Other |
| PR-9 | Property test: every BIN ending in 95 from $795 to $100,000 | Always 20 ≤ min_offer (= 100) ≤ **500 ≤ walkaway** ≤ floor ≤ BIN and floor ≥ 750, **at listing and after every scheduled event** (M6, M18, final push). Floor within $2.50 of 65% of BIN unless raised to 750. Walk-away within $2.50 of 48% unless raised to 500 | Any violation |
| PR-10 | No floats | Static check: the pricing module has no float literal, `float(`, or `/` on money (only `//`); TypeScript types money as integer cents (`Cents`) | Found |

**Schedule (G0 unit; dates in IDT)**

| ID | Input | Pass | Fail |
|---|---|---|---|
| PR-11 | **D-001**: exception 1995/1295/950, listed 2026-10-12, `drop_date` 2028-10-04 | M6 2027-04-12 1595/1035/760; M18 2028-04-12 1295/830/610; final push 2028-07-06 **895/830/610**; delist 2028-09-27 | Any cell differs |
| PR-12 | Formula 1995, same dates | M6 1595/1035/770; M18 1295/830/615; final **895/830/615** | Differs |
| PR-13 | Formula 2495 | M6 1995/1295/960; M18 1595/1035/770; final **1095/1035/770** | Differs |
| PR-14 | Formula 1195 | M6 995/750/**500**; M18 795/750/**500**; final `skipped_no_change` (795/750/500) | Differs |
| PR-15 | Formula 795 | M6 and M18 `skipped_at_minimum` (values stay 795/750/500); final push `skipped_no_change` | A drop applied, or floor/walk-away lowered while BIN can't drop |
| PR-16 | *(v2 settings vectors only; the "$399 never drops" rule itself was replaced on 6 Oct 2026, 01:01, see PR3-6)* Geo strong, listed 2026-11-01, drop 2028-11-01 / geo weaker / `geo_drops_enabled=false` | Strong: **one** row `geo_drop_m12` 2027-11-01 499 → 399, then delist 2028-10-25; **no M6, M18 or final push rows**. Weaker: only the delist row (never drops). Disabled: `geo_drop_m12` `skipped_disabled` | Any $299, any M6/M18/final-push row for geo, or a weaker drop |
| PR-17 | The same inputs through `GET /pricing/preview`, `/buy` dry run, `/list` dry run and `import-domain --dry-run` | Identical plan and schedule fields in all four | Any drift |
| PR-18 | Month ends | Listed 2026-08-31 → M6 2027-02-28, M18 2028-02-29; listed 2027-08-31 → M6 2028-02-29 | Other dates |
| PR-19 | M-event after the final push: listed 2027-06-01, drop 2028-10-04 | M18 (2028-12-01) = `superseded_by_final_push`; the final push is computed from the M6 values | M18 planned |

**Job, holds and regeneration (G1, real Postgres, mocked registrars and marketplaces)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| PR-20 | Job runs on the M6 due date (`--today`) | Domain prices = M6 values; one `listing_history` row (`source=schedule`, `schedule_event_id`, `plan_audit_id`, settings version); row `applied`; `export_pending_since` set; audit row scope `job`; **0 registrar and 0 marketplace HTTP calls** | Any missing, or any outbound call |
| PR-21 | Job runs the day before the due date | No change | Applied early |
| PR-22 | Job runs twice on the same day / two workers at once | Exactly one history row and one price change | Double drop |
| PR-23 | Hold set before M6; lifted after M18 is also due | While held: rows stay `planned`, prices unchanged. After the lift: only M18 applied (its cumulative values), M6 `superseded` | Two cuts applied, or held rows applied |
| PR-24 | Manual price change at month 3 (`POST /list`, no `approval_ref` needed) | Future rows `superseded`; new rows computed from the new values with the original anchor dates | Old rows still planned |
| PR-25 | `drop_date` moved to 2027-10-04 (drop at first expiry) | Final push 2027-07-06, delist 2027-09-27, M18 `superseded_by_final_push`, M6 kept | Old dates kept |
| PR-26 | Domain sold (`POST /sold`) | Open rows `cancelled`; later job runs change nothing | A price change after the sale |
| PR-27 | Delist event | Status `delisted`; the domain is in `X-Manual-Delist` of both exports; `/report` shows the removal task; a hold doesn't stop it | Not delisted |
| PR-28 | A corrupted row (floor > BIN) | Row `failed`, `/report` warning, domain unchanged | Applied |
| PR-29 | Approvals | The job's change needs no `approval_ref`; neither does the same change by `POST /list` within the rules (200, `approval_text` null). An exception or override without one → 422 `APPROVAL_REQUIRED` / `OVERRIDE_NEEDS_APPROVAL`; an invalid `approval_ref` when sent → its code | Other |

**Settings versioning (G1)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| PR-30 | `UPDATE`/`DELETE` on `pricing_settings` | DB error | Succeeds |
| PR-31 | `npm run admin -- pricing-settings new --set floor_bps=6000 --approval-text … --approval-at …` | Version N+1 created (N = current; *renamed 6 Oct: "v3" is now the real selection v9.1 version, so PR-31–PR-35 use a test-only N+1*) with the approval; without approval text → refused. Route-table test: no API route writes `pricing_settings` | Created without approval, or an API route exists |
| PR-32 | After N+1 exists (fixture from v2, `floor_bps=6000`) | Existing plans and schedules unchanged (still N); a new preview uses N+1 (1995 → floor 1195); `listing_history` records the version | Existing plan re-priced |
| PR-33 | `/buy` with `expected_settings_version: N` after N+1 | 409 `SETTINGS_VERSION_CHANGED`, 0 registrar calls (= LG-21) | Bought |
| PR-34 | `POST /list` `replan:true` (no `approval_ref`) on a version-N domain | Schedule regenerated with N+1 numbers; old rows `superseded` | Not regenerated |
| PR-35 | N+1 (from v2) with `floor_min_cents` 90000 | `hybrid_bin_min` becomes 995 (derived); preview BIN 795 → `BIN_BELOW_FLOOR_MIN` | 795 accepted |

**Export flags and reports (G1)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| PR-36 | After PR-20: `GET /export/afternic.csv`, then `POST /export/afternic/uploaded` with that `X-Export-Id` | The full file (all listed rows, the dropped name with the M6 values); `X-Pending-Changes: 1`. After the POST: `X-Pending-Changes: 0`, `export_pending_since` cleared | Wrong rows or counts |
| PR-37 | Pending upload 3 days / 8 days | `/report` `EXPORT_PENDING` warning / error level after 7 days | Silent |
| PR-38 | `/report` with an event due in 5 days and one applied 2 days ago | `upcoming` lists the event with its exact values (heads-up); `applied_7d` lists the applied one | Missing |
| PR-39 | `GET /report/pricing-review` fixture: sales at 1995 (M0), 1295 (Afternic, at the floor), 1595 (at M6, BIN 1595) | Ratios 1.00 / 0.65 / 1.00, stage and venue per sale, `at_floor` true for the second. With 2 sales: `insufficient_data: true` | Other |
| PR-40 | Walk-away floor (v2): BIN 795 / 995 / 1095 / 1495 | walkaway 500 / 500 / 525 / 720; exception walkaway 450 → 422 `WALKAWAY_BELOW_MIN` (= LS-20) | Any walk-away < 500 accepted |
| PR-41 | Walk-away floor after drops: formula 1495 and 1195, listed 2026-10-12, drop 2028-10-04 | 1495: M6 1195/775/575, M18 995/750/**500**, final 795/750/500. 1195: M6 995/750/**500** (48%×0.8 would give 460), M18 795/750/500 | A scheduled walk-away < 500 |
| PR-42 | Final push follows operating-model §3a ("BIN drops to the floor"): M18 values 1295/830/x, 1595/1035/x, 995/750/x, 795/750/x | BIN 895 / 1095 / 795 / unchanged (`skipped_no_change`); floor and walk-away unchanged; BIN ≥ floor always | 795 for all, BIN < floor, or floor set = BIN |
| PR-43 | *(v2 plans; v3: PR3-6)* Geo property: every geo plan (strong, weaker) over any listing date | No scheduled BIN other than 499 and 399; at most one geo row; a 399 plan has no price rows | $299, or two geo drops |
| PR-44 | Settings version label | Every `GET /pricing/preview`, `sell_plan_line` and `listing_history` row under these rules says version **2** (v3 rules: version **3**). The PR vector file is keyed by settings version: changing any output rule or vector without adding a new `pricing_settings` version fails the test | A rule change still labelled v1/v2 unchanged |
| PR-L1 | **Live (G5):** the first scheduled drop on a real name | The bot uploads the full file; within 48 h the lander shows the new BIN (Gavriel's headless capture) | Old price after 48 h → Dvir checks the Afternic listing |

**Pricing settings v3: price list and step-down drops (PR3; selection v9.1, Dvir approved 6 Oct 2026; rules in `listing-strategy.md` §10.13).** Vectors computed by hand from §10.13 (the reference calculator `pricing_calc.py` doesn't have v3 yet). Same rule: if the code disagrees, stop and ask Dvir. Dates: listed 2026-10-12, `drop_date` 2028-10-04 → M6 2027-04-12, M18 2028-04-12, final push 2028-07-06.

| ID | Input | Pass | Fail |
|---|---|---|---|
| PR3-1 | hybrid 1488 / 1988 / 2488 / 1088 / 788 | floor/walk-away 967/715 · 1292/955 · 1617/1195 · 750/520 (+`FLOOR_RAISED_TO_MIN`) · 750/500; min offer 100 | Other (e.g. floor 965 from `round5`) |
| PR3-2 | BIN validation (v3) | 1495, 995, 1999, 950, 699, 1990 → `BIN_NOT_IN_PRICE_LIST`; 788, 1088, 1488 ok; 1988/2488 without LANDER-1 evidence → `LANDER_EXCEPTION_REQUIRED`, with it ok | Other |
| PR3-3 | Formula 1488 (= SEL9-9) | M6 **1088**/750/520; M18 **788**/750/500; final `skipped_no_change` | 1190/952 (−20%), or any off-list BIN |
| PR3-4 | Formula 2488 / 1988 | 2488: M6 1988/1292/955, M18 1488/967/715, final 1088/967/715. 1988: M6 1488/967/715, M18 1088/750/520, final 788/750/520 | Differs |
| PR3-5 | Formula 1088 / 788 | 1088: M6 788/750/500, M18 `skipped_at_minimum`, final `skipped_no_change`. 788: M6 and M18 `skipped_at_minimum`, final `skipped_no_change` | A BIN below 788 |
| PR3-6 | Geo strong / weaker, listed 2026-11-01, drop 2028-11-01 | Strong: `geo_drop_m12` 2027-11-01 499 → 399; weaker: `geo_drop_m12` 399 → 299; then delist 2028-10-25; no M6/M18/final push | A second geo drop, or a geo price off {299,399,499} |
| PR3-7 | Property: every v3 plan (all list BINs, any listing date) | Every scheduled BIN ∈ `allowed_bins_cents`; 500 ≤ walk-away ≤ floor ≤ BIN; floor ≥ 750 for non-geo; floor = recomputed 65% (whole dollar) of the current BIN unless raised | Any violation |
| PR3-8 | Version isolation | A v2 fixture plan (exception 1995/1295/950) keeps PR-11 after v3 is created; a new 1488 preview says version 3 *(the real D-001 was repriced by Dvir on 6 Oct 00:32, see PR3-9)* | Fixture re-priced |
| PR3-9 | **D-001 reprice** (Dvir, 6 Oct 2026, 00:32): `POST /list` `replan:true` with `pricing_exception` (walk-away 950) + `approval_ref`, then `drop-at-first-expiry` | Stored 1488 / 967 / 950 (private) / min offer 100, `approved_exception`; `drop_date` 2027-10-04; final push 2027-07-06 and delist 2027-09-27 rows; Afternic row `PromptInjectionAudit.com,1488,967,100,N,,Custom Lander,Y,N,Y,N`. Values of any M6 row: **open for Dvir** (see `listing-strategy.md` §8) | Other stored values or drop date |

## Selection (SEL; selection v9.1, Dvir approved 6 Oct 2026)
The selection tests are defined in `selection.md` §7 (SEL-1–SEL-4, SEL3-*, SEL4-*, SEL5-*, SEL6-*, SEL7-*, SEL8-*, SEL9-1–SEL9-15, SEL10-1, SEL-T) and run in G0/G1 when the selection backend is built (`CLAUDE.md` build step 9; `selection.md` §8 order). Any fail → no live Gate A until fixed or Dvir waives it. The `/buy` side is also covered by B-29–B-32 (`buy.md`) and LS-16b / LG-20 (`listing-strategy.md`). **FT-1 amendment (Dvir, 6 Oct 2026, 01:01):** B-32 and SEL9-6 count the 7 days from `ft_eligible_on` (the Fast Transfer eligibility date, e.g. buy + 60 days at GoDaddy), not from the buy.

## Offers log and minimum offer (OF; Dvir, 5 Oct 2026, 01:03 IDT, decision #2; rules in `listing-strategy.md` §10.11)
Fixtures: D-001 imported as hybrid 1995 / 1295 / walk-away 950 / min offer 100, listed 2026-10-12 *(test fixture values from the 5 Oct plan; the real D-001 is repriced to 1488 / 967 / 950 since 6 Oct 00:32, PR3-9)*; a geo name at $399; a second trend name at the formula 2495 / 1620 / 1200. G1 (real Postgres; no network) unless marked.

| ID | Case | Pass | Fail |
|---|---|---|---|
| OF-1 | `POST /offers` D-001 $450, source `afternic` | 201; band `below_walkaway`, routing `auto_decline`, outcome `declined_auto`, `next_step` says decline with no Gate D; snapshot 1995/1295/950/100 | Other band or outcome |
| OF-2 | D-001 $1,000 (`afternic`) | band `mid_range`, routing `dvir`, outcome `open` | Other |
| OF-3 | D-001 $1,295 / $1,995 (`afternic`) | `at_or_above_floor` + routing `auto_accept` + warning `OFFER_AT_OR_ABOVE_FLOOR` / `at_or_above_bin` | Other |
| OF-4 | Boundaries on D-001: $99, $100, $949, $950, $1,294 | `below_min`, `below_walkaway`, `below_walkaway`, `mid_range`, `mid_range` (walk-away and floor are inclusive lower bounds) | Any off-by-one |
| OF-5 | D-001 $1,200 with source `email_inbound` / $600 `email_inbound` | routing `dvir` (every email offer ≥ walk-away goes to Dvir) / `auto_decline` | Other |
| OF-6 | Geo $399 name: offer $350 / $399 | `geo_below_bin` + `auto_decline` / `at_or_above_bin` | Other |
| OF-7 | Band uses the prices **in force at `received_at`**: D-001 offer $1,100 received 2027-04-11 vs 2027-04-13 (M6 applied 04-12: floor 1035) | `mid_range` vs `at_or_above_floor` | Current prices used |
| OF-8 | Same `source` + `external_ref` twice; and no `external_ref` but same domain/amount/source/time | 200 with `duplicate: true`, existing row returned; one row in the table | Two rows |
| OF-9 | READ token / unknown domain / amount 0 or "12.345" / source `ebay` / `received_at` 1 h in the future / `buyer_ref` "a@b.com" | 403 / 404 / 422 `AMOUNT_INVALID` / `SOURCE_INVALID` / `RECEIVED_AT_IN_FUTURE` / `NO_PII` | Accepted |
| OF-10 | Offer on a domain that is `owned` but not listed | 201 + `OFFER_ON_UNLISTED`; band against the plan prices (or `unpriced`) | Refused, or no warning |
| OF-11 | Immutability: raw SQL `UPDATE offers SET amount_cents=…` (and `band`, `received_at`) | DB trigger error | Update succeeds |
| OF-12 | `POST /offers/{id}/outcome`: `countered` on a mid-range offer without / with `approval_ref`; `declined` on an `auto_decline` offer without | 422 `APPROVAL_REQUIRED` / 200 / 200; each change writes one `audit_log` row | Other |
| OF-13 | Removed 6 Oct 2026 (Dvir): offers CSV import dry run | n/a | n/a |
| OF-14 | **Walk-away never leaks:** export Afternic + Sedo (`make_offer`) for D-001, `GET /pricing/preview`, lander-check output | Afternic row `PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N`; Sedo minimum 100; the value 950 appears in no export, no `afternic_row` and no buyer-facing field | 950 (or any walk-away) exported |
| OF-15 | Removed 6 Oct 2026 (Dvir): offers CSV import | n/a | n/a |
| OF-16 | Min offer setting: hybrid `POST /list` with `min_offer` 950; then settings v2 `hybrid_min_offer_cents=15000`, new plan vs existing D-001 | 422 `MIN_OFFER_FIXED`; new plan min 150, D-001 keeps 100 until a `replan` | Other |
| OF-17 | The price job applies M6, M18 and the final push to D-001 | `min_offer` stays 100 in `domains`, `listing_history` and the export each time; geo M6 sets min offer = new BIN | Min offer changed for hybrid |
| OF-18 | `/report` per domain: D-001 offers at −5 d ($450), −40 d ($1,000), −200 d ($1,500) | `count_30d 1, highest_30d $450; count_90d 2, highest_90d $1,000; count_all 3, highest_all $1,500, highest_all_pct_of_bin` = 1500/1995; a domain without offers shows 0 / null (keys present) | Wrong counts or missing keys |
| OF-19 | `/report` `offers_by_strategy`: two trend names (3 and 0 offers in 90 d), one geo (1) | trend: `names_listed 2`, `names_with_offers 1`, `offers_90d 3`, `offers_per_listed_name_per_month 0.50`, median and max pct of BIN, band shares sum to 1.00; geo row separate. `GET /report/offers?group_by=source` matches the same rows | Other |
| OF-20 | No side effects: `POST /offers`, and `/outcome` with the registrar and marketplace mocks armed; plus a mid-range offer open for 49 h | Zero outbound calls, no price or `pricing_hold` change (unless the request asks for a hold, with a reason); `/report` shows `OFFER_NEEDS_DVIR` after 48 h | Any call or price change; no warning |

## Payouts (PO-1 to PO-5): removed

Removed 6 Oct 2026 (Dvir): the `payouts` table, `POST /payouts/{id}/received`, `PAYOUT_MISMATCH`, `PAYOUT_OVERDUE` and `payouts_pending`. PO-1 to PO-5 are deleted. `/sold` keeps booking the `payout_fee` ledger row (S-12).

## System-triggered sales (SL; Dvir, 5 Oct 2026, 19:47 IDT; rules in `sold.md`, `report.md`, `00-architecture.md` §4/§6)

| ID | Case | Pass | Fail |
|---|---|---|---|
| SL-1 | `/sold` without `approval_ref`: no `evidence`; `evidence` but no `transaction_ref`; `evidence.source` not in the list | 422 `EVIDENCE_REQUIRED` (422 `VALIDATION_ERROR` for the bad source); nothing written | Accepted |
| SL-2 | `/sold` with `transaction_ref` AFN-1 + `evidence {afternic_email, "<x@mail.afternic.com>"}`, no approval, Gavriel's WRITE token | 200; `sale.confirmed: false`; one `sales` row with `recorded_by` = the token name, the evidence and `sale_ledger_id` = the `sale` ledger row; ledger and profit as S-1 | Refused, or wrong row |
| SL-3 | Same sale with `approval_ref` (and no evidence) | 200; `confirmed: true`; `approval_text` stored | `confirmed` false |
| SL-4 | SL-2 again with a **new** key (same domain, and once on another domain) / with the same key | 409 `SALE_ALREADY_RECORDED`, nothing written / stored response replayed | Second sale, or replay refused |
| SL-5 | `/report` after SL-2 and SL-3 | `SALE_UNCONFIRMED` lists only the SL-2 sale (domain, venue, ref, evidence, `recorded_by`); `sales`, `profit`, `roi` count both | Missing, or the confirmed sale listed |
| SL-6 | Daily registrar check (mock `find_domain`; `registrar_presence` row `absent` with `first_absent_at`, kept on the next run, cleared when present again): a listed domain → `None`, no sale; a sold domain → `None`; a registrar timeout; a `registrar_api=none` name | `DOMAIN_LEFT_ACCOUNT` only for the first; no status change; zero registrar writes | Warning for a sold, errored or manual name, or a status change |
| SL-7 | `sales` immutability (SQL) | UPDATE of any column, DELETE and TRUNCATE → error; duplicate (`venue`, `transaction_ref`) → error; an unconfirmed row without evidence → CHECK error | Any accepted |

## Job trigger and health (JOB; step 6 free hosting, Dvir, 5 Oct 2026; rules in `00-architecture.md` §6–§8)

| ID | Case | Pass | Fail |
|---|---|---|---|
| JOB-1 | `POST /jobs/run` with a READ token / a WRITE token / no token / a wrong job token; `JOB_TRIGGER_TOKEN` unset | 401 / 401 / 401 / 401; 503 `JOBS_DISABLED`; no job step runs | Any step runs |
| JOB-2 | The job token on any other route (e.g. `GET /report`, `POST /list/x`) | 401 | Accepted |
| JOB-3 | `{"job":"tick"}` twice with the same `Idempotency-Key`; a concurrent second `tick`; a body other than `tick`/`daily` | Replayed response, the reconciler runs once / `skipped: true` / 400 | Double run |
| JOB-4 | `tick`: NS verifier ran 2 h ago / 25 h ago | Reconciler runs; NS verifier `skipped` / runs | Other |
| JOB-5 | `daily` with the backup step throwing | Steps run in order price → drop → registrar check → backup; the backup step `ok:false` with a redacted error; the others `ok`; one `audit_log` row with scope `job` | Order wrong, a failure stops later steps, or a secret in the error |
| JOB-7 | `npm run job -- tick` and `daily` (shared `JobRunner`, no server) | JSON result with the same steps as `POST /jobs/run`; backup step skipped (ok) without a token; exit 1 if a step failed, 2 on bad arguments | A different step list |
| JOB-6 | `GET /health/ping` with the DB down; `GET /health` (valid token) with the DB down | 200 `{status:"ok"}`, zero DB queries / 503 `degraded`, `db: down` | Ping touches the DB, or health hides the outage |

## Kill criteria (stop building; return to Dvir)
- G2 shows Porkbun's API **can't** register without a manual step that the docs don't mention, and the sandbox can't settle it → stop. Dvir keeps buying by hand (as with D-001) and records each buy with `npm run admin -- import-domain`.
- The build takes **more than 2 evenings** of Dvir's time to reach G3 → cut scope to `/check`, `/buy`, `/report` and the Afternic CSV; defer the rest.
- Render cost isn't approved → run the same app locally (docker compose); Gavriel's calls stop until hosting is approved.
- Any real-money surprise at G3/G4 (an unplanned charge, or a double charge) → revoke the WRITE token immediately; no further buys until the root cause is fixed and tested.

## Cost and token guards
- The service uses **zero LLM tokens**.
- Claude Code build cost is Dvir's own subscription; no bot spends tokens on code.
- Gavriel's API calls are plain HTTPS; reading `/report?format=md` instead of raw tables keeps chat tokens low.
- Live registrar spend in testing: **$0** before G4 (dry runs only). G4 spends one domain's price (the approved `max_price`).
