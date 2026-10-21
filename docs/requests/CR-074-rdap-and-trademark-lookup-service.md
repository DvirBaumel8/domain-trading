---
id: CR-074
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel)"
priority: P1
build_order: 5
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-074: one RDAP and trademark lookup service with cache and a midnight-safe daily limit (move 5 of 5)

**Approval:** Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel), top-5 move 5. Build right away, no ship date. No step for Dvir.

## Why
Buyer, Sales and Risk Gate each fetch RDAP and USPTO data ad hoc, repeat the same lookups, and keep a fragile daily-cap counter that breaks around midnight.

## What already exists (reference)
Verisign RDAP inside /check, sibling-scan, engineEndings, dropWatch and cohortOutcomes; IANA bootstrap refresh; /data/rdap and /data/tm-kills loaded tables (live 0 rows).

## Rules
- R-1 `GET /rdap/{domain}` (READ/bots): `{registered: true|false|null, created, expires, registrar, status[], checked_at, cache_age_s, source:"rdap", reason_code?}`. Cache TTL setting (default 24 h); `?fresh=true` forces a lookup within the limit.
- R-2 `POST /rdap/batch` (bots, read-only, 1..500 names): same rows; cached first, live lookups for the rest.
- R-3 `GET /tm/{term}` (READ/bots): the free no-key USPTO route only (bulk data or search); not TSDR, which answers 401 without a key; stores raw JSON, timestamp and query, returns `{term, hits_n, live_marks[], raw_ref, checked_at}`. Risk Gate judges conflicts; DOM never says "clear".
- R-4 **Daily limit** per source (settings; RDAP default 200 live lookups/day for bot calls, outside the internal daily steps): a rolling 24-hour window keyed on UTC timestamps, so no reset jump at midnight IDT; `GET /lookups/usage` shows `used, limit, window_start, resets_gradually:true`.
- R-5 Over the limit: cached answers still served; a needed live lookup returns 429 `LOOKUP_LIMIT` with `retry_after_s`. Never a guessed answer.
- R-6 **Errors are not zeros:** timeout or source error → `registered:null` / `hits_n:null` with `reason_code` (`TIMEOUT`, `SOURCE_ERROR`, `RATE_LIMITED`).
- R-7 No paid data, no keys from Dvir, no scraping of web pages.

## Acceptance tests (via the API)
- AT-1 `GET /rdap/google.com` → `registered:true`, `created` set; a second call within TTL has `cache_age_s > 0` and uses no limit.
- AT-2 (negative) Given the limit is used up (fixture limit 2), When a 3rd uncached name is asked, Then 429 `LOOKUP_LIMIT`; a cached name still 200.
- AT-3 Given 150 lookups at 23:50 IDT and 60 at 00:10 IDT with limit 200, Then the 201st within 24 h is refused (no midnight reset).
- AT-4 (negative) RDAP mock timeout → `registered:null`, `reason_code:"TIMEOUT"`, never `false`.
- AT-5 `GET /tm/apple` returns `hits_n > 0` with `raw_ref`; a mock USPTO 500 gives `hits_n:null` + `SOURCE_ERROR`.
- AT-6 `POST /rdap/batch` with 501 names → 400 `VALIDATION_ERROR`.

## Out of scope
- Legal judgment; feeding results into /check or /buy gates (separate CR); non-.com TLD bulk scans beyond the existing sibling scan.

## Questions (max 3)
1. **Answered (Gavriel):** use the free no-key USPTO route (bulk data or search), not TSDR (401 without a key). If there is truly no other way, say so in your response; no key gets created.
2. Can the internal steps share this cache (one cache), and should they count against the limit?

## DVIR items
None.

## Changes
- 2026-10-20 23:55 IDT: R-3, Q1: USPTO via the free no-key route (bulk data or search), not TSDR; no key gets created (Gavriel's answers, 2026-10-20 ~23:53 IDT).
- 2026-10-20 23:55 IDT: build_order 5: follows CR-071 (P0, built first) (Gavriel's answers, 2026-10-20 ~23:53 IDT).
- 2026-10-21 00:00 IDT (Gavriel): RDAP part accepted. R-3 blocked accepted: no USPTO key will be made. Trademark checks stay with Risk Gate (manual USPTO/WIPO search), with kills loaded through `/data/tm-kills`. If Risk Gate finds an official no-key source, Gavriel sends it here.
- 2026-10-21 00:00 IDT: RDAP part accepted. R-3 accepted as not built: no official no-key USPTO API known; Risk Gate keeps doing trademark checks on the bot side and loads kills through `/data/tm-kills` (Gavriel).
- 2026-10-20 (Gavriel): the trademark part (R-3, `GET /tm/{term}`) is PARKED until Gavriel finds a no-Dvir-step key route. Ship the RDAP part now. Trademark kills keep loading through `/data/tm-kills`.

<!-- DOM writes below this line -->

## DOM response (2026-10-21): RDAP part accepted, building now (v5.21.0, with CR-070); trademark part (R-3) blocked

- **R-1, R-2, R-4, R-5, R-6 (RDAP): as written.**
  - Endpoints: `GET /rdap/{domain}`, `POST /rdap/batch` (1..500 names) and `GET /lookups/usage`.
  - Rolling 24 h window on UTC timestamps (no midnight jump), 429 `LOOKUP_LIMIT` with `retry_after_s`, and `registered: null` with a `reason_code` on errors.
  - It uses the existing Verisign RDAP code (`src/core/rdap.ts`).
- **Q2:** yes, one cache. The internal daily steps read and fill it but don't count against the bot limit, which counts only bot calls (R-4).
- **Q1 and R-3 (USPTO):** every official USPTO API we know of (TSDR, the Open Data Portal) needs an API key. The trademark search website has no documented API, and CLAUDE.md forbids automating undocumented website endpoints. Dvir creates no keys, so `GET /tm/{term}` is **not built**. If you find an official no-key source, send it and DOM builds R-3 on it. Until then, `/data/tm-kills` stays the way to load trademark kills (CR-072 uses them).

## DOM release (2026-10-22): v5.29.0 tagged (RDAP part)
- **Routes:**
  - `GET /rdap/{domain}` (`?fresh=true` forces a live lookup).
  - `POST /rdap/batch`, 1..500 names. It is a read-only POST like `/score`: no `Idempotency-Key` and no audit row. Over the limit, the remaining rows come back `registered: null, reason_code: "LOOKUP_LIMIT"` with `limit_hit` and `retry_after_s`.
  - `GET /lookups/usage`.
- **Cache:** 24 h. A cached answer costs nothing against the limit.
- **Limit:** 200 live bot lookups in a rolling 24 h window on UTC, with no midnight reset. Over it, a needed live lookup is 429 `LOOKUP_LIMIT` with `retry_after_s`, and cached answers are still served.
- **Errors:** `registered: null` with `TIMEOUT`, `SOURCE_ERROR` or `RATE_LIMITED`. They are never cached, and never `false`.
- **Internal steps** share the cache (pick-proof labels and the portfolio check read and fill it; screening fills it) and never count against the bot limit.
- **R-3 (`/tm/{term}`):** not built (no keyless official USPTO API).
- **Also in this release (CR-076 note):** a bots token on a money route now gets 403 `SCOPE_FORBIDDEN` before any body check, including a body that isn't valid JSON, unless the body has `dry_run: true`.
- **Please verify** AT-1..AT-4 and AT-6 once `/health` shows 5.29.0.

## Gavriel (2026-10-21 04:08 IDT): v5.29.0 live check, pass
- `/health` showed 5.29.0 at 04:07 IDT (5.27.0 at 04:06; the Mac host's 10-min deploy picked it up after CI).
- **AT-1 pass:** `GET /rdap/google.com` gave `registered: true`, `created` 1997-09-15; a second call 3 s later gave `cache_age_s: 3`, and `/lookups/usage` stayed at `used: 1`.
- **AT-6 pass:** `POST /rdap/batch` with 501 names gave 400 `VALIDATION_ERROR` ("<=500 items").
- **Batch:** 2 names (google.com cached, mineunited.com live) gave 200, `cached_n: 1, live_n: 1`, usage went to 2/200. Pass.
- **AT-2, AT-3, AT-4:** need a fixture limit, a clock and a mock timeout, so not run live (it would burn the real limit); accepted on `tests/modules/ops/rdap-lookups.test.ts`.
- **Scope before body (CR-076 note):** bots token, `POST /buy` with a body that isn't JSON gave 403 `SCOPE_FORBIDDEN` (before: 400 `INVALID_BODY`). Pass.
- **NIT:** the release note says "1..500 names", but the body field is `domains` (`{"names": [...]}` gives 400 "Unrecognized key"). The contract is right; only the note's wording. No change needed.
