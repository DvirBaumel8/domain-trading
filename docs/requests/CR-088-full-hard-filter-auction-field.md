---
id: CR-088
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir standing rule 2026-10-28 ~01:17 IDT via Gavriel: no artificial size cuts on buy/discovery/data; store+serve every hard-filter GoDaddy auction that day; endings/prebid may stay top-slice for speed only; audit other cuts in a brief — do not implement all tonight."
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-088: full hard-filter auction field (no shortlist_size cut)

**Approval:** Dvir standing rule 2026-10-28 ~01:17 IDT via Gavriel. **No money.** Build now; report when live on `/health`.

## Why
Discovery only saw the top 25 of ~500–750 hard-filter passers/day (`field_n`), so Buyer judged a tip sheet, not the real auction field. Artificial size cuts hide buyable names. Scale is handled with batches/indexes/queues/retention — not by shrinking the pool.

## Rules
- R-1 **Store every hard-filter passer.** For each datasave `auctionShortlist` day, persist **all** GoDaddy live auctions that pass the existing hard filters (same filters as today that produce `field_n`). Rank by current auction score (`auction-v4`). Do **not** cut to `shortlist_size` 25.
- R-2 **Talk threshold only above 10k.** If hard-filter passers that day exceed **10,000**, store none silently: set step status/warning that names the count and stop or cap only after logging that warning (Dvir wants to talk). Under 10k: store all.
- R-3 **Serve the full stored field.** `GET /auctions/shortlist` must expose every stored non-dropped, not-yet-ended row for the date (pagination OK: `limit` + `offset`). Raise or remove today's **max 100** so a client can walk the whole field. Default may stay small for old callers; `limit` must allow the full set (or page until exhausted). Response still includes `field_n` / totals so bots know the size.
- R-4 **Expensive steps stay top-slice; must not hide the rest.** `shortlist_endings_n` (RDAP other endings) and `shortlist_prebid_n` (auto pre-bid) may remain capped for **step time only**. Names beyond that slice are still **stored and served** (prebid may be `null`; endings may stay unknown / unscored-parts rescaled as today). Buyer must see them on GET.
- R-5 **`shortlist_size`.** Retire as a hard cut, or set/default it to mean “all passers (subject to R-2)”. Document the new meaning in contract + `auctions.md`. Migration-only settings change is fine.
- R-6 **No Dvir setup.** No keys, no Mac commands, no per-setting OK beyond this approved CR.
- R-7 **Other cuts — plan only tonight.** Do **not** remove closeouts max 200, daily candidates 25, intake 30, etc. in this release. DOM Architect will add a short **follow-up brief** (same CR Changes or `docs/requests/NOTE-…`) listing each cut + recommended batch/index approach. Separate CRs after Gavriel/Dvir pick order.

## Acceptance tests
- AT-1 After a datasave day with `field_n` = N (N ≤ 10000), `auction_shortlist` (or successor) holds **N** ranked rows for that `data_date` (not 25). Given a fixture/test day with N=40 hard-filter passers → stored count 40.
- AT-2 `GET /auctions/shortlist?date=<that>&limit=…` (with paging if needed) returns all non-dropped, not-ended rows; `total` (or equivalent) equals served count available; a client can retrieve row 26+ when N>25.
- AT-3 Negative: with N=25 and old-style caller `limit=25`, still works (backward compatible default); requesting beyond stored returns only what exists (no pad).
- AT-4 Endings/prebid caps: with `shortlist_prebid_n=10` and N=40, at most 10 non-fail auto-prebids are attempted; rows 11–40 still appear on GET with `prebid: null` (or equivalent), not omitted.
- AT-5 Negative: a name that fails a hard filter (e.g. SPELL-1 / no headroom) is still **not** stored (filters unchanged); only the size cut is removed.
- AT-6 Contract/docs: `endpoints.md` §`GET /auctions/shortlist` and `auctions.md` Shortlist no longer say “best `shortlist_size` (25)” as a hard keep; they state full field + R-2 / R-4.

## Out of scope
Raising endings/prebid to cover the whole field; closeouts `limit` max 200; `GET /candidates/daily` max 25; intake 30/day; Dynadot page caps; portfolio domain cap; money/buy routes; Buyer SOP text (Gavriel owns).

## Questions (≤3)
1. Prefer pagination (`limit`+`offset`, like `/auctions/live`) vs a single high `limit` max (e.g. 10000)? **Default: pagination + max limit ≥ 10000.**
2. Keep setting name `shortlist_size` as “0 = all” or rename in docs only? **Default: 0 or null = all (R-1), migration sets that.**

## DVIR items
None (standing rule already yes). Follow-up cut removals need their own briefs/CRs.

## Follow-up brief (plan only — not this release)
Audit and propose removal/raise under the same standing rule (batches / indexes / queues / retention, not shrink):
- `GET /candidates/closeouts` max **200** (default 50)
- `GET /candidates/daily` max **25**
- Intake screening **30**/day
- `closeout_expiry_collect_max` **1000** sample
- Dynadot aftermarket **500** pages
- Disappearance lookups **1500**/run
- Bots RDAP **200**/day
- Buyer lean ~**20** calls (SOP — Gavriel)
Order and CR split TBD with Gavriel after this ships.

## Changes
- 2026-10-28 ~01:18 IDT (DOM Architect): filed CR-088 from Dvir standing rule via Gavriel; BUILD NOW.
