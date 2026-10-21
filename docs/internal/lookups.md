# RDAP lookup service (CR-074, v5.29.0)

Binding rules and test IDs. Interface: `docs/contract/endpoints.md` §RDAP lookup service. Migration `1766100000000_v5-29-0.sql`. The trademark part (R-3, `GET /tm/{term}`) is not built: no official no-key USPTO source is known.

## Where
- `src/core/rdap-cache.ts`: `cacheGetMany`, `cachePut`, `cachedRdapLookup` (an internal step's lookup through the cache), `cacheTtlMs`, `reserveSlots`, `readUsage`. Core, so every module may use it.
- `src/modules/ops/api/lookups.ts` (`registerLookups`, called from `src/app.ts`): `GET /rdap/:domain`, `POST /rdap/batch`, `GET /lookups/usage`. `POST /rdap/batch` is in `READ_ONLY_POSTS` (`src/http/methods.ts`) because it changes nothing a caller owns (cache and usage log only): READ scope or higher, no `Idempotency-Key`, no audit row, like `POST /score`. A bots token passes (every non-mutating route does), so it is not listed in `BOTS_ROUTES`.
- Tables `rdap_cache` (domain PK; `registered`, `created`, `expires`, `registrar`, `statuses`, `nameservers`, `updated_at`, `checked_at`, `reason_code` always null) and `lookup_usage` (id, source `rdap`, at, by_token). Settings columns (migration only): `lookups_rdap_ttl_hours` (24), `lookups_rdap_daily_limit` (200). Neither table is in the backup.

## Rules
1. **One cache.** Only a definite answer (`registered` or `not_registered`) is stored. An error answer (`TIMEOUT`, `SOURCE_ERROR`, `RATE_LIMITED`) is never stored: not as a result and not briefly, so the next call asks again. `registered: null` in a row is "could not be asked", never "no".
2. **Bot limit.** Live lookups of the three bot routes only. A slot is inserted in `lookup_usage` (at = the app clock, UTC instant) in a short transaction under `pg_advisory_xact_lock` before the lookup runs; the limit counts rows with `at` in (now - 24 h, now]. No midnight reset. A slot is spent even when the lookup then fails (the registry was asked). Rows older than 7 days are deleted in the same transaction.
3. **Cached answers are free** and served even with the limit used up. `fresh=true` always asks and counts.
4. **Batch:** names deduplicated, cached first, then up to the free slots are looked up (4 at a time); the rest are `LOOKUP_LIMIT` rows with `limit_hit: true` and `retry_after_s`. Whole-call 429 only when no cached row and no slot at all. 501 names: 400 `VALIDATION_ERROR`.
5. **Internal steps share the cache and never count:**
   - `selection/rdap-batch.ts` `lookupCached` (screening checks availability, census, ext-dates, lookalikes, sibling scan, and `freshLookups` for the drop-list watch and the cohort outcomes): keeps its own `rdap_lookups` reuse rules (as_of, notBefore, per-run freshness) and **fills** `rdap_cache` with every definite live `.com` answer. It does not read `rdap_cache`: those steps need their own freshness and evidence rows.
   - `pickproof/labels.ts` (T30 labels): **reads and fills** through `cachedRdapLookup` with the TTL (a label needs only a status at least 30 days after the pick).
   - `ops/jobs/portfolio-check.ts` (owned names): `cachedRdapLookup` with TTL 0: always asks (a registry check must be fresh) and fills.
   - Not changed: `engine/endings.ts` (about 160,000 asks by design, writes `engine_endings`, would flood the cache) and `/check`, the reconciler and `/buy` availability (they need the answer now; the coarse `rdapStatus`).
6. No key, no scraping, no AI, no email; the only outside call is the public Verisign RDAP host.

## Tests
`tests/modules/ops/rdap-lookups.test.ts`, `tests/modules/http/bots-scope-order.test.ts`.
| ID | What |
|---|---|
| RL529-1 | AT-1: google.com registered with created; the second call has cache_age_s > 0 and uses no limit; past the TTL it asks again |
| RL529-2 | AT-2: limit 2 used up: the 3rd uncached name is 429 LOOKUP_LIMIT with retry_after_s; a cached name is still 200 |
| RL529-3 | AT-3: 150 lookups at 23:50 IDT and 60 at 00:10 IDT, limit 200: 50 run, 10 cut off (LOOKUP_LIMIT rows), the 201st is refused, slots return gradually |
| RL529-4 | AT-4: TIMEOUT, SOURCE_ERROR and RATE_LIMITED give registered null (never false), in GET and batch, and are not cached |
| RL529-4b | a real slow Verisign mock through the default lookup gives TIMEOUT |
| RL529-5 | fresh=true forces a live lookup and counts against the limit; a bad value is 400 |
| RL529-6 | internal lookups fill and read the cache without counting; with limit 0 the bot is refused but the internal step still asks |
| RL529-7 | AT-6: 501 names, an empty list and an unknown field are 400 VALIDATION_ERROR; 500 names work |
| RL529-8 | batch order, duplicates, cache first, partial limit, whole-call 429 only when nothing could be answered |
| RL529-9 | concurrent calls never pass the limit |
| RL529-10 | bots, READ and WRITE tokens pass, no token is 401, no audit row, usage shape, non-.com is 422 |
| BS529-1 | a bots token on a money route is 403 SCOPE_FORBIDDEN whatever the body (invalid, unparseable) unless dry_run is true (then the route's own 422); a WRITE token still gets 422 |
