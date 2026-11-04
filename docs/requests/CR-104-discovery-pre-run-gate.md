# CR-104: Discovery pre-run gate (standing check suite)

- **Type:** maintenance / bug-prevention. **Path:** Claude Code only.
- **Approved:** Dvir via Gavriel (t1098u, 2026-11-04). Filed by DOM Architect.
- **Depends on:** CR-103 (`ended_n`, `prebid_dropped_n`), CR-101 (`auction_kills`), BUG-063 (closeouts scoring).
- **Contract:** additive only; no existing field or route changes.

## What
A standing check suite DOM runs before every discovery run and that blocks the run when any check fails.
- New READ route `GET /auctions/preflight`. It returns `{as_of, run_id?, pass: bool, checks: [{id, name, pass, reason_code|null, details}]}`.
- The discovery run (and any bot-run pack build) must call it first and stop on `pass:false`.
- The server-side daily discovery job runs the same suite itself.
- Each result is logged per run (`/jobs/runs` step `preflight`, plus a `preflight_runs` row) and copied into the run pack (`preflight.json`).

## Checks (append-only list; ids never reused)
| id | check | fail reason code |
|---|---|---|
| PF-01 | Every served shortlist and closeouts row (GoDaddy and Dynadot) has a score, or a documented by-design `score_null_reason` (BUG-063 class) | `UNSCORED_ROWS` (details: source, n, sample) |
| PF-02 | Counts reconcile: `total + prior_kill_excluded_n + ended_n + prebid_dropped_n = field_n` | `COUNTS_DONT_RECONCILE` (details: each term, diff) |
| PF-03 | No junk in the top 50 served: no all-digit, hex-like (`^[0-9a-f]+$` with a digit), or more-than-N-digit SLDs (N configurable, default 4) | `JUNK_AT_TOP` (details: names, ranks) |
| PF-04 | No served name has an active (not revoked) `auction_kills` row | `PRIOR_KILL_SERVED` (details: names) |
| PF-05 | Each source's coverage is complete or explicitly flagged: when Dynadot pages fail (500), `dynadot_low_coverage` (or a flag) is present and coverage is at least 0.9 | `COVERAGE_UNFLAGGED` / `COVERAGE_BELOW_MIN` (details: source, pages_failed, coverage) |
| PF-06 | The shortlist `as_of` is fresh: within X h (default 6) of the latest sealed GoDaddy/Dynadot save | `STALE_AS_OF` (details: as_of, seal_at, age_h) |

**Standing rule:** each new BUG adds a check here, with the next PF id, in the same release that fixes it. Checks are never removed. They may only be marked `retired` with a reason.

## Tests (one pass case and one fail case per check)
- CR104-T1 to T12: PF-01 to PF-06, a pass fixture and a fail fixture each. Each fail case asserts its reason code.
- CR104-T13: the run aborts on any failure, and the pack carries `preflight.json`.
- CR104-T14: a READ token can call `/auctions/preflight`, and it writes nothing besides the log row.

## Done when
`/auctions/preflight` is live and documented in docs/contract/endpoints.md. The next 02:05 run logs a preflight row, and the pack includes it. A release note lists PF-01 to PF-06.

## DOM response (2026-11-04): accepted with two changes; building as v6.7.0
**Verdict:** accepted. `GET /auctions/preflight` (READ or bots) runs PF-01..PF-06 and returns `{as_of, data_date, pass, checks: [{id, name, pass, reason_code, details}]}`.

**Pushbacks (DOM's resolution):**
1. **The GET writes nothing: no `preflight_runs` table and no log row.**
   - Every READ route here writes zero rows. It is a rule since 6 Oct, and T14 would break it.
   - The DB is also the scarce resource (CR-100).
   - The record of a run is the pack's `preflight.json` (the bots' side). The answer carries `as_of` and a `checks_sha256`, so a pack shows which result it used.
2. **No server-side discovery job.** The server has none: the 02:05 discovery run is Buyer's. Buyer calls the route first and stops on `pass: false`.
   - The datasave job also runs the suite as its last step `preflight` (read-only), so `/jobs/runs` shows the daily result without a new table.
   - CR104-T13 is therefore split: the route's `pass: false` is server-tested; "the run aborts" is the bots' SOP (DOM adds it to `docs/bot-logic/04`).

**Check notes:**
- **PF-01:** a null score passes only with a by-design reason. `NO_ACTIVE_MODEL` (GoDaddy closeouts, CC526-10) is one. `NOT_SCORED_YET` on a sealed day is the BUG-063 class and fails.
- **PF-02:** uses 6.6.0's identity, including `not_stored_n`.
- **PF-03:** the digit limit N is `settings.preflight_max_digits` (default 4, migration only).
- **PF-05:** reads the newest manifest's `coverage` per source.
- **PF-06:** X is `settings.preflight_max_age_hours` (default 6).

**Standing rule:** accepted. Each BUG that a pre-run check could have caught adds the next PF id in its own fix release. Checks are only ever marked `retired`, with a reason, never removed. It is written into `docs/internal/auctions.md`.
