# CR-120: Pre-filter runs the site-history check on every logged row (batched, no pool cuts)

**Status:** Filed 24 Nov 2026. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** 24 Nov 2026, 19:40 IST, through Gavriel. This is not a money action.

This request does not authorize spend, bids, listing changes, or any outside message. CR-116 and CR-117 money rules are unchanged. Do not print keys or tokens. This repo is public.

## Why

In the first real run, 24 Nov (run 45442228938, shadow-log `b26c8dbb`, 649 rows logged), the site-history (Wayback) check gave:
- Closeouts: `not_checked` on all 403.
- Auctions: `not_checked` on 128 of 246, `error` on 22, `suspect` on 3, `no_hits` on 92, `no_snapshots` on 1.

So most logged names still have history open, and bots must check them by hand. CR-118 will add many more 0-bid auctions.

## Ask

1. Every logged row (auctions and closeouts) gets a history result: `no_hits`, `no_snapshots`, `suspect` with evidence, or `killed`. `not_checked` and `error` become rare exceptions, each with a `reason`.
2. Scale; don't cut (Dvir's rule). Use batching, careful concurrency within Wayback's public limits (back off on 429 or 5xx, then retry), and, if needed, split the work across Actions matrix shards or a follow-up workflow run that fills in history for that day's rows on `shadow-log`. Never shrink the pool or drop a row to save time.
3. **Stay free.** Use only free public Wayback endpoints (CDX), with no paid service.
4. **Retry errors.** Retry an `error` result at least twice with backoff before it stays `error`. A row whose check is still open keeps `history` in `open_checks`, is never dropped, and is never called clean.
5. In `runs/DATE.json`, add history counts per source: checked, no_hits, no_snapshots, suspect, killed, error, not_checked, and the run time.

## Tests (the contract, at most two review rounds)

- With 400+ rows, every row gets a history result or a named reason. Use a mocked Wayback with rate limits.
- A 429 or 5xx gets backoff and a retry, and isn't recorded as `no_hits`.
- If the time budget runs out, the rows left over stay logged with `history` open, and any second pass or shard fills them in.
- Closeout rows get a history check, not only auctions.
- No bid, buy, register, renew or listing-write route is added.

## Done when

The tests pass, `docs/contract/prefilter.md` is updated, a hand run's real history counts are in `DOM-TO-GAVRIEL.md`, and the change ships after Dvir's OK through Gavriel. It can ship together with CR-118.
