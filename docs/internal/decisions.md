# Decisions store and X-Caller (CR-084, v5.63.0)

DOM is the one durable store (Dvir, 27 Oct 2026, D-2026-10-27 §10 A). This file holds the rules of the two additions that make that true for decisions and for who-called attribution. The per-fact map of writers and read endpoints is `docs/contract/sources-of-truth.md`.

## Files
- `src/modules/reporting/decisions.ts`: `DecisionsBody`, `DecisionsQuery`, `postDecisions`, `listDecisions`, `getDecision`. Routes in `reporting/api/decisions.ts` (`registerDecisions`, called from `src/app.ts`). The module stays `reporting` (no new module, so the module graph and `module-boundaries` are unchanged).
- Table `decisions` (migration `1768300000000_v5-63-0.sql`, which also adds `audit_log.caller`): append-only (triggers refuse UPDATE, DELETE and TRUNCATE), in the nightly backup (`TABLE_FILES` and the restore `ORDER`; the self reference `supersedes` is `DEFERRABLE INITIALLY DEFERRED` so a restore does not depend on row order). Lock key `decisions_write`.
- `src/http/audit.ts`: `callerOf` (the X-Caller header), the log child in `registerAuditId`, the `caller` column in `registerAuditWrite`. `GET /audit` shows `caller` (`reporting/report/portfolio.ts` `auditRows`).
- Scope: `POST /decisions` is `allowed` in `BOTS_ROUTES` (`http/auth.ts`); data, intake and visits tokens are refused as for any other route. GETs: READ, bots, WRITE.

## Rules
1. A decision is a record. **Nothing reads it to act**: no job, price, listing or money path reads the table. It is not an approval and cannot stand in for an `approval_ref`.
2. One row per id. Same id and same content (decided_at as an instant, decided_by, summary, scope, domains, source_ref, supersedes) = duplicate, nothing written. Same id and other content = 409 `DECISION_EXISTS` for the whole batch. A correction is a new id with `supersedes`; the old row is shown with `superseded_by`.
3. `supersedes` must name a stored decision or an earlier row of the same batch, and never the row itself (422 `VALIDATION_ERROR`).
4. No personal data: an `@` in `id`, `decided_by`, `summary`, `scope`, `source_ref` or `domains` is 422 `NO_PII` (the rule of `/offers`, `core/validation.ts`).
5. `summary` is at most 1,000 characters; a batch is 1..500 rows; the route body limit is 2 MB. Domains are stored lowercase.
6. The audit row keeps the request, but an array of more than 50 items is stored as its count and sha256 (`elideArrays` in `http/audit.ts`); the rows live in `decisions`.
7. `X-Caller`: optional, 1..40 characters of `a-z 0-9 _ -` after trimming; anything else is ignored, never an error. Stored in `audit_log.caller` next to the token (`token_id`, `scope`) and put on the request's log lines (`req.log` and `reply.log` children, so the "request completed" line has it). Attribution only, not a check. `bot_name` (X-Bot-Name, CR-069) stays as it was.

## Sedo (CR-085, money-free part)
`pendingDomains(db, 'sedo')` returns an empty list: a new listing or a plan change never makes a name pending for Sedo, so `X-Pending-Changes` on `GET /export/sedo.csv` is 0 and `export.sedo.pending` is false unless a hand listing no longer matches the plan. `POST /list/{domain}` has no Sedo step in its checklist. Existing Sedo records (`venue_listings`, `export_uploads`, `manualDelist`) are untouched.

## Tests
| ID | What |
|---|---|
| DEC-1 | POST then GET list and GET by id round-trip a D-id; domains table untouched (CR084-AT6) |
| DEC-2 | duplicate vs 409 `DECISION_EXISTS`; nothing stored on a clash |
| DEC-3 | `supersedes`, `superseded_by`, unknown and self references, same-batch reference |
| DEC-4 | field validation, 501 rows, `NO_PII` |
| DEC-5 | dry run; 500 rows |
| DEC-6 | `q`, `scope`, `domain`, `since`, paging, `total_n`, bad queries |
| DEC-7 | `DECISION_NOT_FOUND` |
| DEC-8 | scopes |
| DEC-9 | append-only; no PUT, PATCH or DELETE |
| DEC-10 | idempotency and audit |
| XC-1 | X-Caller stored in the audit row and shown by `GET /audit` (CR084-AT7) |
| XC-2 | a missing header never breaks a READ or a write |
| XC-3 | invalid values are ignored |
| XC-4 | the caller is in the request log line |
| CR084-AT1 | `/books.csv` equals `/portfolio/{d}` for BIN, floor, walk-away and min offer of every owned name (`tests/modules/reporting/sole-store.test.ts`) |
| CR084-AT2 | `sources-of-truth.md` exists, is linked and lists the facts and read endpoints |
| CR084-AT3 | no company-box route; money routes stay money for bots |
| CR084-AT4 | `/books.csv` is GET-only and called an export, not a write path |
| CR084-AT5 | approval gates unchanged |
| CR085-AT4 | no Sedo pending for a new listing; no Sedo step in the `/list` checklist (`tests/modules/listing/export-state.test.ts`, `export-v2.test.ts`, `list.test.ts`) |
