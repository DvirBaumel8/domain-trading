# Card evidence cache (CR-083, v5.64.0)

Buyer and Risk Gate re-scraped the same USPTO and firm-screen facts on one card (JOINT-OPS sin #3). Independence of judgment stays; independence of fetch does not. A bot fetches once and POSTs the result; the others read it with a `fresh` flag and still re-judge. The contract text is `docs/contract/endpoints.md` section "Card evidence cache".

## Files
- `src/modules/data/card-evidence.ts`: `USPTO_TTL_HOURS` (24, a constant, CR-083 Q2), `CARD_EVIDENCE_KINDS` (the extensible enum; add a value here and in the table CHECK by a migration), `loadCardEvidence` (row parser, duplicate and `supersedes` checks, one transaction through `bulkLoad`), `freshness`, `readCardEvidence`, `getCardEvidence`.
- `src/modules/data/api/card-evidence.ts`: `registerCardEvidence` (called from `registerData`): `POST /data/card-evidence` (`registerBulkRoute` with `maxRows: 500`, a new option of `engine/bulk.ts`), `GET /data/card-evidence`, `GET /data/card-evidence/:id`.
- Table `card_evidence` (migration `1768400000000_v5-64-0.sql`): append-only (`reject_mutation` triggers for UPDATE, DELETE, TRUNCATE), `supersedes` self-reference. Not in the backup (`backup-coverage.test.ts`, same as `tm_kills`): bot evidence the bots post again, and a USPTO row is stale after a day. Never pruned.
- Scope: `POST /data/card-evidence` is `allowed` in `BOTS_ROUTES` (`http/auth.ts`), and the `data` token's `/data/` prefix covers it. GETs: READ, bots, WRITE; a data token is 403 on GET.

## Rules
1. **Bot-posted only.** The service never calls USPTO, TSDR, EUIPO, TMview or a firm page, and no route queries one (CR-074 park stands). CR083-AT6 scans the two source files for outside calls.
2. **No judgment, no money.** Nothing reads `card_evidence` to approve, reject, price, list, bid or buy; no route here touches `domains`, the ledger, listings, `price_schedule`, bid plans or exports. A `clear` row is information, never an approval.
3. **Row:** `domain` and/or `term` (one is required; term lowercased, 1..200), `kind` in `uspto_check|firm_screen|other`, `verdict` in `kill|clear|flag|error|unknown`, `checked_at` ISO with an offset, a real date, at most 60 s ahead of the server clock; `note` <= 500; `evidence_ref` <= 500; `raw` object <= 8,192 bytes of JSON; `supersedes` an existing id. **No `@` in `term`, `note`, `evidence_ref` or `raw`** (no personal data; the DB also CHECKs `evidence_ref`). The first failing rule rejects the row with its own reason; the rest of the batch is stored.
4. **Append-only.** A correction is a new row with `supersedes`. The old row stays readable and shows `superseded_by` (the highest id that names it; two rows may supersede the same row, the later one wins). `supersedes` is checked against stored rows only (not a row of the same batch).
5. **Duplicate** = same `(domain, term, kind, verdict, checked_at, note, evidence_ref, supersedes)`; `raw` is not compared. A duplicate is counted, not stored.
6. **Freshness (`freshness()`):** only `uspto_check` has a clock. Fresh = not superseded AND age <= 24 h AND no `tm_kills` row with `created_at` after `checked_at`. Stale reasons: `superseded`, `expired`, `tm_kills_changed`. **The kill-list rule is an approximation (CR-083 Q3):** any new `tm_kills` row counts, whatever its term. Other kinds: `fresh: null`; `stale_reason: superseded` when replaced. `fresh_only=true` hides superseded rows and stale `uspto_check` rows.
7. **Size:** 1..500 rows a call (422 above), the common 8 MB body limit and `DB_SIZE_HIGH` guard of the bulk loads.

## Tests
`tests/modules/data/card-evidence.test.ts`; scope rows also in CEC-5.
| ID | What |
|---|---|
| CR083-AT1 | bots/WRITE posts a uspto_check by domain or term -> 201; GET shows `fresh: true` within 24 h |
| CR083-AT2 | older than 24 h -> `fresh: false` (expired); nothing deleted; exactly 24 h is fresh |
| CR083-AT3 | firm_screen with operator count -> 201, GET returns it (`fresh: null`), money tables unchanged |
| CR083-AT4 | supersede keeps the old row readable with `superseded_by`; UPDATE, DELETE, TRUNCATE refused |
| CR083-AT5 | no money effect of any verdict; no buy/list/bid/sold/export route under `/data/card-evidence`; bots still 403 on `/buy` |
| CR083-AT6 | no outside call and no trademark site in the card evidence source |
| CEC-1 | `SUPERSEDES_NOT_FOUND`, `SUPERSEDES_INVALID` |
| CEC-2 | tm_kills row after `checked_at` -> `tm_kills_changed`; before it -> still fresh; firm_screen unaffected; `fresh_only` |
| CEC-3 | `@` refused in evidence_ref, note, term, raw |
| CEC-4 | raw object only, <= 8 KB |
| CEC-5 | scopes: READ 403 on POST, data token POST ok and GET 403, bots/WRITE both, no token 401 |
| CEC-6 | `fresh_only=true` hides superseded and stale uspto rows |
| CEC-7 | duplicates, `dry_run`, Idempotency-Key required and replayed |
| CEC-8 | row validation (subject, enums, `checked_at` forms, future, 1..500 rows) |
| CEC-9 | GET filters, paging, GET by id 404 and 422 |
| CEC-10 | superseded firm_screen (`fresh: null`), audit row with token name and scope |
