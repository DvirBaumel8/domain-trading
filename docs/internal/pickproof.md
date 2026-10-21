# Pick-proof mechanics (CR-073, v5.28.0)

Binding rules and test IDs. Interface: `docs/contract/endpoints.md` §Pick-proof, `jobs.md` row `datasave` (step `pickproofLabels`). Migration `1766000000000_v5-28-0.sql`. Everything the module reports is **a proxy, not profit**.

## Where
- Module `src/modules/pickproof/`: `pool.ts` (build and freeze the pool, `ensureDay`), `store.ts` (picks, seal, manifest, arm views), `draw.ts` (seeds, `drawArm`, `armSha`), `recipe.ts` (frozen rule texts and their sha256, arm constants), `labels.ts` (the datasave step), `report.ts`, `stats.ts` (pure: Fisher, CMH, Holm, permutation), `api/pickproof.ts`. Wired in `src/app.ts` (`registerPickproof`) and `ops/jobs/datasave/datasave.ts` (`pickproofLabels`, last step in `ops/jobs/runner.ts`). Imports `selection` (`closeoutNameChecker`, for the word split) and `src/core` (`mt19937.ts`, `rdap.ts`); reads the datasave tables through Kysely.
- Tables: `pickproof_days` (day PK, data_date, pool_sha256, seed, k, pool_n, sources, deadline, arms, sealed_at), `pickproof_pool` (day, domain, source, price_cents, passes_k1, is_two_word), `pickproof_arms` (day, arm, domain, rank, price_cents), `pickproof_picks_history` (append-only), `pickproof_labels` (domain, day, label, checked_at, attempts, created_at_rdap, created_unknown, reason). Settings columns (migration only): `pickproof_k`, `pickproof_deadline_hour_utc`, `pickproof_pool_max_price_cents`, `pickproof_labels_max_per_run`, `pickproof_pool_keep_days`. Triggers: `pickproof_k` can only be raised (and CHECK 1..300); a sealed day row and its arms cannot change.

## Rules
1. **Pool of pick day D** = rows of data date D-1: GoDaddy `datasave_pool` (needs a sealed `complete` manifest of `closeout_listings.json.zip`, else 409 `SNAPSHOT_MISSING`) plus `dynadot_rows` kind `closeouts` when the day's `bot_upload` manifest is sealed (otherwise `sources.dynadot.status` is `missing` and the pool is GoDaddy only); `.com`; `price_cents <= pickproof_pool_max_price_cents` (4000); minus names with an `engine_sales` row or a sold `market_names` episode (SALES_GRADED, computed here, not read from `filter_code`); sorted by domain in byte order; one row per domain (lowest price, then `godaddy` before `dynadot`). `pool_sha256` = SHA-256 of `JSON.stringify([[domain, source, price_cents], ...])`. Seed = first 8 hex digits as uint32.
2. **Frozen** when first materialised (first pick, manifest or arms-after-seal call). Stored in `pickproof_pool`; the datasave rows may change or be pruned afterwards. `pickproof_pool` rows are deleted after `pickproof_pool_keep_days` (45) by the `pickproofLabels` step; `pickproof_days` stays for good.
3. **K1-passing** = the stored closeouts `filter_code IS NULL` on a processed row (`scored_at` set) of the row that was kept for the name. **Two-word** = the SLD matches `^[a-z]+$`, has at most 10 letters and `closeoutNameChecker.check` returns exactly 2 words and not `SPELL-1` (the form check's token split with the current lists).
4. **Arms**, `k` = the setting at the time the pool was frozen (stored in `pickproof_days.k`): A as submitted (rank = list order), B1 = all pool names, B2 = K1-passing, C1 = two-word. C2 = `not_built`. **Draw (`pickproof-v1`):** arm seed = `(seed XOR constant) >>> 0` with B1 `0xB1B1B1B1`, B2 `0xB2B2B2B2`, C1 `0xC1C1C1C1`; `MT19937` initialised by array `[armSeed]` (`src/core/mt19937.ts`, the CR-008 Appendix B recipe); the sub-pool sorted by byte order; full Fisher-Yates (i from n-1 down to 1, j = `below(i+1)` by rejection); the arm is the first k names, rank = position from 1; fewer than k: all, `short: true`. Arm `sha256` = SHA-256 of `JSON.stringify(names in rank order)`. The texts of the draw, pool and label rules are in `recipe.ts`; their SHA-256 are in every manifest (`recipe.*`), so a rule change is visible.
5. **Seal (choice):** the first `GET /pickproof/{date}/manifest` at or after the deadline (16:00 UTC of D, `pickproof_deadline_hour_utc`) draws B1, B2, C1, stores them, stores the per-arm `{n, sha256, short}` in `pickproof_days.arms` and sets `sealed_at`, in one transaction under an advisory lock. The daily job does **not** seal (it runs at 15:00 UTC, before the deadline). Picks close at the deadline whether or not sealed (409 `PICKPROOF_SEALED`). The arms are readable only after the seal (409 `PICKPROOF_NOT_SEALED`), so the first manifest call is the point of no return and the bots publish it before the arms are looked at.
6. **Picks:** WRITE or bots (`BOTS_ROUTES` `allowed`: a list of names, no money, no listing); at most k names, no duplicates, each in the frozen pool (else 422 `NOT_IN_POOL`, nothing stored); replace allowed until closed; every call is appended to `pickproof_picks_history`.
7. **Labels (`pickproofLabels`)**: for each (name, D) of a sealed arm with D at least 30 days old and no label, or an `unknown` label with D within the last 40 days: Verisign `.com` RDAP (`rdapLookup`), one lookup at a time with 250 ms between, at most `pickproof_labels_max_per_run` (300) lookups per run (a name on several days is looked up once per run), unlabelled names before retries, oldest day first; a 429 ends the run. Result: `taken` = RDAP registered and its status list has neither `redemption period` nor `pending delete` (any case or spacing, e.g. `redemptionPeriod`, `pendingDelete`), whatever the creation date (the creation date and `created_after_d` are stored for the Challenger and do not decide: a bought closeout keeps its old creation date); `not_taken` = registered in redemption period or pending delete (an unsold closeout lingers there, then disappears) or not registered (404); `unknown` = error or timeout (with the reason code). `statuses`, `created_at_rdap`, `created_after_d` and `created_unknown` are stored. Labels belong to the (name, day) pair, never to an arm. **Why status, not creation date (DOM lead, 21 Oct 2026):** a closeout someone buys keeps its old creation date; an unsold one stays registered for a while in redemption period and pending delete, then disappears.
8. **Report:** unit = a (day, name) entry of an arm. Rates use labelled entries (`taken` or `not_taken`); `unknown` is excluded and counted in `unknown_n`; entries without a label yet are `pending_n`. Comparisons A vs C1 (primary), A vs B1, A vs B2 (secondary): one-sided (A higher); `UNPOWERED` when events_a + events_b < 10 or an arm has no labelled entry (no p, no result). `overlap_pct` = share of A's entries (all days) that are also in the other arm on the same day. Above 5%: `method: "permutation"`: per day the labelled entries of A and the other arm are pooled, the A slots are re-drawn 10,000 times with `MT19937` seeded from SHA-256 of the range's `day:pool_sha256:A sha:arm sha` strings, p = (1 + #{perm >= observed}) / (1 + 10,000). Otherwise `fisher` (hypergeometric, log-space). The Fisher p is always shown as `fisher_p`; CMH over the bands $0-9.99, $10-19.99, $20-40 (z, chi2, one-sided normal p, MH odds ratio) is shown beside it. Holm over the powered secondaries. alpha 0.05.
9. No money action, no LLM, no email, no marketplace call; the only outside call is the public RDAP host in step `pickproofLabels`.

## Tests
`tests/modules/pickproof/unit/stats.test.ts`, `tests/modules/pickproof/pickproof.test.ts`.
| ID | What |
|---|---|
| PP528-1 | Fisher exact one-sided against exact hypergeometric values (tea-tasting 17/70 and others) |
| PP528-2 | the normal tail used by CMH |
| PP528-3 | CMH z, chi2, p, MH odds ratio on hand-computed strata |
| PP528-4 | Holm adjustment |
| PP528-5 | permutation test reproducible per seed |
| PP528-6 | `src/core/mt19937.ts` is the reference generator (mt19937ar test vector) |
| PP528-10 | AT-1: manifest twice identical (seed, hashes, draws); A open before the deadline |
| PP528-11 | AT-2: B1 100 distinct pool names; B2 K1-passing; C1 two-word |
| PP528-12 | AT-3: 409 `PICKPROOF_SEALED` after the seal and after the deadline |
| PP528-13 | AT-4: 422 `NOT_IN_POOL`; replace before the deadline; limits |
| PP528-14 | 409 `SNAPSHOT_MISSING` |
| PP528-15 | the pool is frozen (datasave changes or pruning change nothing) |
| PP528-16 | arms hidden until the seal |
| PP528-17 | pool rules (price, .net, sales-graded, Dynadot, duplicates, flags), short sub-pools |
| PP528-18 | k raise-only, at most 300, applies to the next day |
| PP528-19 | scopes, Idempotency-Key, replay, audit |
| PP528-20 | a sealed day cannot be changed in the database |
| PP528-30 | labels only for arm names of days 30 days old and more; taken / not_taken rules; once per name |
| PP528-31 | AT-7: unknown on error, excluded from rates, retried until D+40 |
| PP528-32 | run cap, 429 stops the run, old pool rows pruned |
| PP528-33 | the datasave job has `pickproofLabels` as its ninth, last step |
| PP528-40 | AT-5: 4 events in total is `UNPOWERED`; "proxy, not profit" |
| PP528-41 | AT-6: 12% overlap uses the permutation test, reproducible |
| PP528-42 | 2% overlap uses Fisher; CMH strata; date filter |
| PP528-43 | Holm over the secondaries; unknown excluded |
