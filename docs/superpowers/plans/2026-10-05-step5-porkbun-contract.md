# Step 5 (gate G2): Porkbun contract tests: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the Porkbun adapter matches Porkbun's real API, and fix any drift, before the service is deployed. Three layers:
1. **Offline contract tests (G0 level, run in the default suite, no network).** They run against a **pinned snapshot** of Porkbun's OpenAPI spec (v3.53, public, committed). Every path and method the adapter calls must exist; every request body must validate against the spec's request schema; every error code the adapter branches on must appear in the spec; and the adapter's parsers must accept the spec's example responses.
2. **`porkbun-mock` (opt-in, network).** The adapter's parsers run against Porkbun's credential-free mock server (`GET https://api.porkbun.com/api/json/v3/mock/<path>`, plus `?status=error`). This catches drift between the snapshot and the live API.
3. **`porkbun-sandbox` (opt-in, network).** It uses a `pk1_sb_` key: the env pair if set, otherwise a throwaway key from `POST /apikey/request {"sandbox": true}` (Porkbun: "no signup … $1000 fake credit"). It runs the adapter end to end, plus **B-26**: a full `/buy` through the service, against the test DB, of a random free `.com` in the sandbox, with the rows checked and a same-key replay. It also checks registrar-level idempotent replay.

**Sources (verified 5 Oct 2026):**
- https://porkbun.com/llms.txt: sandbox (`pk1_sb_`, fake credit, `POST /apikey/request {"sandbox":true}`), the mock server at `/mock/<path>`, and `Idempotency-Key` (24 h replay, 409 `IDEMPOTENCY_KEY_MISMATCH`/`IDEMPOTENCY_KEY_IN_USE`).
- https://porkbun.com/llms/sandbox: `/sandbox/topup` and `/sandbox/reset`.
- https://porkbun.com/llms/mock.
- https://porkbun.com/api/json/v3/spec (OpenAPI 3, v3.53).

All 9 paths the adapter uses exist in v3.53: checkDomain, account/apiSettings, account/balance, domain/create, domain/get, updateNs, getNs, updateAutoRenew, account/invoices, account/invoice.

**Spec:** `docs/specs/test-plan.md` G2 row; `docs/specs/buy.md` B-26; `docs/specs/00-architecture.md` §5 (Porkbun mapping); CLAUDE.md founder rules 6, 7 and 12 ("tests use mocks, Porkbun's mock server, or Porkbun's sandbox (`pk1_sb_` keys)").

## Global Constraints

- **The default `npx vitest run` makes no network call** (unchanged). The two network projects run **only** when named: `npx vitest run --project porkbun-mock` and `npx vitest run --project porkbun-sandbox`. Add the npm scripts `test:contract:mock` and `test:contract:sandbox`. The network block in `tests/setup/network.ts` stays for every other project. The contract projects use their own setup and allow only `api.porkbun.com` (any other host fails the test).
- **Sandbox safety guard (founder rule 12)**, enforced in a helper that every sandbox test goes through:
  - the public key must start with `pk1_sb_` and the secret with `sk1_sb_`, else the whole project **aborts** before any request;
  - every response body must carry `"sandbox": true` where the spec documents it, else the run aborts.
  - A real key (`pk1_` without `_sb_`) can never reach `domain/create`.
- **Never top up a real account** (founder rule 6). `POST /sandbox/topup` is allowed **only** through the sandbox guard. `/account/topup*` and `/account/autoTopup` stay banned (the existing no-topup static test keeps passing; whitelist the sandbox-only path by name in it, with a comment).
- **Keys** come only from env or the in-memory throwaway pair. They are never printed, logged, written to files or put in snapshots (assert this with the existing secret-leak helper on captured logs). The throwaway pair isn't persisted.
- **The OpenAPI snapshot is committed:** `tests/fixtures/porkbun-openapi-v3.53.json`, with a `.sha256` and a README line naming the source URL and fetch date. A refresh script `npm run contract:refresh-spec` re-downloads the spec and prints the diff summary (paths added or removed, versions); it never overwrites silently.
- **Validator:** `ajv` + `ajv-formats` as devDependencies (OpenAPI 3.0 → JSON Schema: convert `nullable` and resolve `$ref`s). If converting by hand is messy, use `@apidevtools/swagger-parser` to dereference (devDependency). No new runtime dependencies.

## Decisions (Claude Code, under Dvir's delegation)

| # | Decision | Why |
|---|---|---|
| C1 | **The offline layer is the gate in CI and the default suite. The mock and sandbox layers are opt-in and run by hand at G2 and before every deploy** | Network tests must not make the normal suite flaky |
| C2 | **If the sandbox can't register** (an error, or a manual step the docs don't mention), record the response and mark B-26 failed in the gate report. test-plan.md:208 says to stop, and Dvir keeps buying by hand. It is never "fixed" by loosening the adapter | Spec kill criterion |
| C3 | **Drift found** (a renamed field or a new error code): fix the adapter and the MSW fixtures to the **live spec**, and add a regression unit test. Any change to money handling (`cost`, `charged`, invoice amounts) gets an Opus review before it's accepted | "Contract mismatch → re-read the docs, fix the adapter" |
| C4 | **The B-26 domain** is `dt-g2-<random 12 hex>.com`. It is checked available in the sandbox first. `/sandbox/reset` runs **before** the suite, not after, so the run can be inspected afterwards | Deterministic, inspectable |

---

### Task 1: Offline contract tests against the pinned OpenAPI snapshot

**Files:**
- Create: `tests/fixtures/porkbun-openapi-v3.53.json` (+ `.sha256`, README note), `tests/unit/porkbun-contract.test.ts`, `scripts/refresh-porkbun-spec.ts`
- Modify: `package.json` (devDeps, script `contract:refresh-spec`)

Tests:
1. **Paths and methods:** every `(method, path)` the adapter calls exists in the snapshot. Derive the list from a single exported table in `src/registrars/porkbun.ts` (refactor: export `PORKBUN_ENDPOINTS` as a const, used by the adapter's call sites, so the list can't drift from the code).
2. **Request bodies:** for each operation, build the body the adapter sends (call the adapter with a capturing fetch, in MSW or a stub) and validate it against the snapshot's `requestBody` schema. Cases: check, create (real and `dryRun`, with `cost`), updateNs, updateAutoRenew, getNs, invoices query. Auth stays in the headers, never in the body.
3. **Response parsing:** for each operation, feed the snapshot's documented example response (or one synthesised from its schema with all required fields) into the adapter's parser. It must parse without throwing, and the mapped values must match (`cost` cents, expiry, NS list, `whoisPrivacy`/`autoRenew`, the invoice line amount).
4. **Error codes:** every code in `AMBIGUOUS_CODES` plus every code the adapter branches on by name (`INSUFFICIENT_FUNDS`, `COST_MISMATCH`, `API_ACCESS_DISABLED`, `DOMAIN_NOT_FOUND`, `IDEMPOTENCY_KEY_MISMATCH`, `IDEMPOTENCY_KEY_IN_USE`, …) appears in the snapshot's error-code enum, or in its documented codes. List any that are missing in the report: each one is either a drift to fix or an adapter-local code (the `REGISTRAR_*` transport codes are ours).
5. **Idempotency header:** `domain/create` sends `Idempotency-Key`, and the header name matches the snapshot's parameter.
6. **Snapshot integrity:** the file's sha256 equals the `.sha256` file.

Commit: `test: offline Porkbun contract tests against the pinned OpenAPI v3.53 snapshot (paths, request schemas, response parsing, error codes, idempotency header)`

### Task 2: `porkbun-mock` project (opt-in, network)

**Files:** create `tests/contract/porkbun-mock.test.ts` and `tests/contract/setup.ts` (network allowed to `api.porkbun.com` only); modify `vitest.config.ts` (the project is defined, but excluded unless it's named: e.g. `projects` include `porkbun-mock`/`porkbun-sandbox` only when `process.env.VITEST_CONTRACT` is set, and the npm scripts set it); modify `package.json` (scripts).

Tests:
1. `GET /mock` lists every endpoint the adapter uses.
2. For each, `GET /mock/<path>`: the adapter's parser accepts it and the mapped values are well-typed.
3. For each, `GET /mock/<path>?status=error`: the adapter's error mapping yields a `RegistrarError` with a `code`, and `ambiguous` is false for 4xx coded errors.
4. The responses carry the header `X-Porkbun-Mock: true`. If it's missing, abort (we're not talking to the mock).
5. Drift report: compare the live `/mock` directory and `info.version` (from `GET /spec`) against the snapshot, and print added or removed paths. A version that differs from 3.53 is a **warning** (logged), not a failure. Removing a path the adapter uses **fails**.

Commit: `test: porkbun-mock contract project (adapter parsers and error mapping against Porkbun's mock server; drift report)`

### Task 3: `porkbun-sandbox` project + B-26 (opt-in, network)

**Files:** create `tests/contract/porkbun-sandbox.test.ts` and `tests/contract/sandbox-guard.ts`; modify the setup (DB: reuse the api project's global DB setup so `/buy` runs against the test DB with the real Porkbun adapter pointed at the sandbox).

**Guard** (`sandbox-guard.ts`):
- `getSandboxKeys()` → the env `PORKBUN_SANDBOX_API_KEY`/`PORKBUN_SANDBOX_SECRET_API_KEY` if set, else `POST /apikey/request {"sandbox": true}`. Assert both prefixes, otherwise throw and abort.
- `assertSandboxResponse(body)`: assert `body.sandbox === true` for the endpoints that document it.
- Wrap fetch for the sandbox adapter so every response passes `assertSandboxResponse` where applicable.

Tests (sequential):
1. **Setup:** keys, `/sandbox/reset`, then `/account/balance`. The balance must be > 0 and `sandbox: true`.
2. **Adapter, end to end:**
   - `quote` on `dt-g2-<hex>.com`: available, with prices;
   - `accountState`: balance and `autoTopup` false (if the sandbox reports it on);
   - `dryRun` create with the exact cost → `wouldSucceed`;
   - a `COST_MISMATCH` dry run (cost − 1) → the coded error mapped as definite.
3. **Registrar-level idempotency** (the documented 24 h replay):
   - a real sandbox `create` with `Idempotency-Key K`, then the same request with K → the same response, no second order, balance down only once;
   - the same K with a different body → 409 `IDEMPOTENCY_KEY_MISMATCH`, mapped by the adapter.

   Use a second random domain so B-26 stays clean.
4. **B-26 through the service:**
   - build the app with the real Porkbun adapter, base URL `https://api.porkbun.com/api/json/v3`, sandbox keys, and the test DB;
   - `POST /buy` (geo weaker, comps, a fixed approval, `max_price` from the quote, `auto_list: true`) → 201;
   - rows: ledger `registration` = −charged; domain `owned`/`listed`, `renewals_used 0`, `drop_date` = expiry + 1 y; a receipt (or the reconciler fetches it); purchase `succeeded`; evidence; schedule;
   - **the same `Idempotency-Key` again → replayed** (`Idempotent-Replayed: true`, no second sandbox order: the invoice count is unchanged);
   - `/list` re-point → `updateNs` + `getNs` set-compare in the sandbox;
   - `setAutoRenew(false)` verified via `domain/get`.
5. **Secrets:** the captured logs and every response body contain neither key (secret-leak helper).

The report must include the exact sandbox responses for create and the replay, with keys stripped. If the sandbox refuses at any step, record it and apply C2.

Commit: `test: porkbun-sandbox contract project (sandbox guard, adapter E2E, registrar idempotent replay, B-26 through the service)`

### Task 4 (Opus): G2 gate report

- [ ] Run all three layers. Record the outputs: versions, drift, sandbox responses with keys stripped.
- [ ] Fix any drift per C3. Final review.
- [ ] Write the runbook section (`docs/runbook.md` §G2: how to run, what a pass looks like, how to refresh the snapshot).
- [ ] Report to Dvir: G2 pass or fail. Next is step 6 (Render cost for his OK).
