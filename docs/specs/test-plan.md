# Test plan: domain-trading API v1

The per-endpoint test IDs live in each spec: `check.md` CK-*, `buy.md` B-*, `list.md` L-*, `export-csv.md` E-*, `sold.md` S-*, `report.md` R-*, `backup.md` BK-*. This file covers the **gates**, the cross-cutting tests, and the kill criteria.

**Rules:**
- Claude Code stops at the end of each gate and reports results to Dvir.
- **No gate starts until the previous one passes.**
- Gates G0–G2 never touch real money or real registrar accounts.

## Gates

| Gate | What | How measured | Pass | Fail → on-fail |
|---|---|---|---|---|
| **G0: Unit** | Selection logic, money math, `drop_date`, validation, CSV formatting | `npx vitest run tests/unit` with no network (network blocked via MSW `onUnhandledRequest: 'error'`) | 100% green; selection tests CK-1–CK-10 and B-10; renewal tests RN-1–RN-6 below; E-1–E-5; export-per-mode tests LX-1–LX-7 | Any red → fix before G1 |
| **G1: API + DB** | Every endpoint against a real Postgres (docker) with **mocked registrars** (MSW) | `npx vitest run tests/api`; the mock registrar logs every call | All of AU-*, CAP-*, ID-*, DR-*, AL-* below, plus B-1–B-25, L-1–L-9, L-11–L-13, E-6–E-8, S-1–S-8, R-1–R-12, IM-1–IM-3, IM-5–IM-11, **LS-1–LS-14, LG-1–LG-17, LH-1–LH-4** (`listing-strategy.md` §9), BK-1–BK-4 | Any red → fix. **Zero** real HTTP calls (asserted) |
| **G2: Porkbun contract + sandbox** | Adapter against Porkbun's official mock server, then the sandbox (`pk1_sb_…` keys) | `npx vitest run --project porkbun-mock`, then `npx vitest run --project porkbun-sandbox` (skipped without sandbox keys) | Request shapes accepted; error codes mapped; B-26 E2E passes in the sandbox; idempotent replay confirmed | Contract mismatch → re-read https://porkbun.com/llms/domain, fix the adapter. Sandbox unavailable → note it; G3 dry run stands in |
| **G3: Deploy + live read-only** | Render deploy; import D-001 (bought by hand, IM-4); live `/check` and a `/buy` with `dry_run:true` for a free test .com Dvir is willing to buy | Run by Dvir with the READ and WRITE tokens; Porkbun balance and invoices compared before and after | `/health` ok; CK-12 and IM-4 pass; dry run returns `wouldSucceed:true` (or a clear reason such as `VERIFICATION_REQUIRED` / `INSUFFICIENT_FUNDS`); **balance, invoices and spend all unchanged**; audit rows present; ledger holds only the imported D-001 registration row | Any charge → **stop everything**, contact Porkbun support, remove the WRITE token. Other failures → fix and repeat |
| **G4: Live acceptance (first real API buy: the next approved deal, D-002 or later)** | Gavriel calls `/buy` after Dvir's explicit chat approval (quoted in `approval_ref`) | Porkbun dashboard + `/report` + `/portfolio/<domain>` | B-27 passes; BK-5 restore drill done beforehand; a repeat `/buy` with a new key → 409 `ALREADY_OWNED_OR_PENDING` | Charge without rows → the reconciler must fix it within 10 min; else Dvir enters a manual ledger row via the admin command, and **no further buys** until fixed |
| **G5: Post-acquisition** | Lander, marketplaces, Fast Transfer (the PA tests in `system/post-acquisition.md`) | `dig`, browser, Afternic/Sedo dashboards | L-10, E-9, LX-8, LX-9, and PA-1–PA-8 by their deadlines | See each PA test's on-fail |

## Cross-cutting tests (G1)

**Auth and scope (AU)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| AU-1 | No `Authorization` on every endpoint except `/health` | 401 for all | Any 2xx |
| AU-2 | Malformed / unknown token | 401 | Other |
| AU-3 | READ token on `POST /buy`, `/list/x`, `/sold/x` | 403 `SCOPE_FORBIDDEN`, audit row written, **zero** registrar calls | Executed |
| AU-4 | READ token on every GET | 200 | Other |
| AU-5 | WRITE token on every GET | 200 | Other |
| AU-6 | Revoked token | 401 within 1 request of revocation | Accepted |
| AU-7 | No endpoint creates, lists or reveals tokens | Route-table test: no `/token*` route | Route exists |
| AU-8 | Secrets never leak | Responses, logs and audit rows for all tests are grepped for every env secret value and for `pk1_`/`sk1_` prefixes: 0 hits | Any hit |
| AU-9 | Rate limit | The 11th POST in 1 min → 429 | Accepted |

**Caps (CAP)**

| ID | Case | Pass | Fail |
|---|---|---|---|
| CAP-1 | $500 POC cap (B-11) and its race (B-12) | As specified | Overshoot |
| CAP-2 | 10-domain cap (B-13); `pending_purchase` counts | 409 | Bought |
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
| AL-1 | Every POST in the G1 suite | Exactly one `audit_log` row per request, including 4xx | Missing or duplicate |
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
