# CR-103 — Shortlist: explain the field (ended_n, prebid_dropped_n) + generated_at/as_of for packs

Filed by DOM Architect (Grok Bot), 2026-11-04, approved by Gavriel (chief of staff). Additive only; no contract break.

## Why
Discovery pack 2026-11-04-v3 (commit 56ec018d): `field_n` 667, served `total` 110, `prior_kill_excluded_n` 92 → **465 rows unexplained**. The contract comment on `prior_kill_excluded_n` says "total + prior_kill_excluded_n + ended / prebid-dropped = field_n", but ended and prebid-dropped are not exposed, so bots cannot check the no-artificial-cuts rule, and cannot tell whether the run starts too late (ended) or the auto pre-bid drops too much.

## Change
1. `GET /auctions/shortlist` adds top-level integers:
   - `ended_n` — rows stored for the data date whose `end_time` is before the read time (not counted in `total`).
   - `prebid_dropped_n` — rows dropped by a failed auto pre-bid (not ended, not prior-killed).
   - `field_n` (top-level copy of the build-time field size, same value as rows[].field_n) so the identity can be checked even with an empty page.
   - Precedence so each row is counted once: prior kill → ended → prebid-dropped (or document another fixed order).
   - Identity for a same-day read: **`total + prior_kill_excluded_n + ended_n + prebid_dropped_n = field_n`**.
2. `generated_at` (build time) and `as_of` (read time) stay on the response (already present); document both as required non-null when `data_date` is set.
3. `GET /auctions/funnel` `shortlisted` adds `ended` and `prebid_dropped` with the same meaning.
4. Docs: endpoints.md + docs/internal/auctions.md.

## Pack logging (bots side, from now on)
Discovery packs will log `as_of` vs `generated_at` (and the lag in hours) plus the four counts in funnel.md.

## Tests
- CR103-T1: identity holds on a fixture with rows in each bucket.
- CR103-T2: a prior-killed row that has also ended counts only in `prior_kill_excluded_n`.
- CR103-T3: an ended row that also failed pre-bid counts only in `ended_n`.
- CR103-T4: read before any end time: `ended_n` 0.
- CR103-T5: read after all end times: `total` 0, `ended_n` = field minus kills/prebid.
- CR103-T6: no shortlist stored: all counts 0, `data_date`/`generated_at` null, 200.
- CR103-T7: pagination (limit/offset) does not change the counts.
- CR103-T8: funnel `shortlisted.ended` / `prebid_dropped` match the shortlist for a one-day range.
- CR103-T9: existing response keys and types unchanged (contract snapshot).
- CR103-T10: `generated_at` and `as_of` are ISO with offset and `as_of >= generated_at`.
