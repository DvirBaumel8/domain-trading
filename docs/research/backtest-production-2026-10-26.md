# Backtest on our own production labels (DOM, 26 Oct 2026)

**Data:** `GET /engine/rows` (v5.50.0): 148 sold (GoDaddy auctions whose last snapshot price was $100 or more, 21-25 Oct) and 553 unsold (GoDaddy closeouts that dropped, 23 Oct). The free GoDaddy fields (`domainAge`, `developedTlds`, `exactMatchTlds`, `semrushSearchVolume`) were joined from the local inventory snapshots (all 701 found). The lift table is the live seed model (lift-v1, length and words; endings unknown here). Measure: AUC (0.5 = a coin toss). Script: scratchpad `pass1026/bt.mts`.

| Method | AUC, all 701 | AUC, names aged 5+ (126 / 164) |
|---|---|---|
| Shorter name | 0.52 | |
| Fewer words | 0.60 | |
| v1 shape (length + words) | 0.57 | |
| Word quality alone | 0.48 | 0.47 |
| v2 name part (quality x shape) | 0.43 | |
| Lift, length + words (seed) | 0.57 | 0.60 |
| v3 name part (quality x lift) | 0.47 | |
| Search volume (GoDaddy file) | 0.65 | |
| Exact-match endings registered (`exactMatchTlds`) | 0.73 | 0.75 |
| **Other endings with a live site (`developedTlds`)** | **0.78** | **0.80** |
| Domain age | 0.86 | 0.72 |
| **Age + developed + exact-match (equal weights)** | **0.88** | **0.84** |

Medians: sold names are 13 years old with 1 developed and 2 exact-match endings; unsold names 3 years with 0 and 1. Half of the unsold names are 2 years old or younger.

## What it means
- **On our own population, the free demand fields and age predict which expired names draw $100+ at auction; our name-quality part does not.** The sold side includes foreign and brand words (locanda.com) that the common-word check marks down, and short or long length barely matters.
- Age is partly a population effect (young unsold names are often one-year registrations), but it still reaches 0.72 among names aged 5+. Developed endings hold up best (0.80 there).
- **The labels are wholesale demand** (investors bidding $100+ at auction) against names nobody took at $5, not end-user sales. They answer "will this name be contested and hold value", which is what a maximum bid needs, but not directly "will an end user buy it". The CR-002 seed (reported sales vs dropped, 25 Oct backtest) still favours shape and lift (0.73-0.80). Both are indirect for our final goal; the paper trading (v5.49.0) and our own listings are the direct test.
- Small sample (148 sold, 5 days). Re-run weekly as rows grow; `engine_auction_ends` (v5.50.0) adds the $1-$99 middle.

## Action taken (v5.51.0)
- Auction score v4 weights: name 70 -> 30, demand 15 -> 40, age 10 -> 25, bids 5. No v4 shortlist was stored before the change.
- The uncommon-word cap is skipped when another ending of the exact name has a live site.
- Not changed: SPELL-1 and the other hard filters (they remove junk, not ranking).
