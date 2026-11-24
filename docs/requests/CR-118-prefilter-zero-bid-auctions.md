# CR-118: Pre-filter also logs 0-bid auctions (bid count is a label, not a gate)

**Status:** Filed 24 Nov 2026. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** 24 Nov 2026, lesson from the service-names/closeouts run (`/workspace/research/run-2026-11-24-service-closeouts.md` on the bots' box, section 6 item 7), approved through Gavriel.

This request does not authorize spend, bids, listing changes, or any outside message. CR-116 and CR-117 money rules are unchanged. Do not print keys or tokens. This repo is public.

## Why

`docs/contract/prefilter.md` gate 2 passes an auction only with **at least one bid**. On 24 Nov the best find was plumbhelp.com at $1 with 0 bids (ends 29 Nov). The daily job would never have shown it. A 0-bid auction is cheap, so it is often the best value, and having no investor bids is a signal, not a reason to drop the name.

## Ask

1. In gate 2 (auctions), **remove "at least one bid"**. Keep "at least 16 hours left" and "seen once, the day before it ends". Every other gate stays as it is: `.com`, letters only, 13 letters or fewer, adult mark, our names, `kills.txt`, 14-day repeat, price-alone cap check, Web Risk, Wayback. Closeout gates don't change.
2. Keep `bids` on every shadow line (it is already there). Add `zero_bid: true|false` so bots can sort and label without extra parsing. In `runs/DATE.json`, split the counts into names with 0 bids and names with 1 or more.
3. **No size cuts** (Dvir's rule). Many more names will now pass the cheap gates. Scale the job instead of shrinking the pool: batching, concurrency, and splitting the job across several Actions runs or matrix shards if one run gets near GitHub's time limit. Today, names that miss the 40-minute Wayback budget go to `not_checked`, auctions with the most bids first. Keep that, but they stay **logged with the check open**, never dropped. Tie-break among 0-bid names by soonest end, then lowest price.
4. **Stay free.** Web Risk Lookup has a free monthly quota. If 0-bid volume would push calls over it, do not start paying and do not skip names. Either use a free approach (for example Web Risk's Update API with local hash lists, if its free terms cover our volume), or leave `web_risk` in `open_checks` for the names over quota. Say which in the contract. Never call a name clean when it wasn't checked.
5. Before the first full run, do one dry run by hand (`workflow_dispatch`) and put the real counts (read, passed, 0-bid passed, Web Risk calls, Wayback checked or not_checked, run time) in `DOM-TO-GAVRIEL.md`. Don't estimate.

## Tests (the contract, at most two review rounds)

- A 0-bid auction that passes every other gate is logged, with `bids: 0` and `zero_bid: true`.
- A 0-bid auction with under 16 hours left, a digit or hyphen, more than 13 letters, in `kills.txt`, or ours is still dropped.
- `runs/DATE.json` counts 0-bid and 1+-bid names separately.
- A name past the Wayback budget or the Web Risk quota is logged with that check in `open_checks`, never dropped and never clean.
- Closeout gates are unchanged.
- No bid, buy, register, renew or listing-write route is added. The budget math in `/budget` is unchanged.

## Done when

The tests pass, `docs/contract/prefilter.md` is updated, the dry-run counts are in `DOM-TO-GAVRIEL.md`, and the change ships after Dvir's OK through Gavriel.
