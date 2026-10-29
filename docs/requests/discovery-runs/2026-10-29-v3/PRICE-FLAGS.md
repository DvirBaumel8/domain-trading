# PRICE FLAGS — Buyer · discovery v3 Option 1 · prompt: SOP 04 v3 + §0.0 AI3 · data_date 2026-10-29 (dqMarket price_sanity failed today; health dq_market=alert)
Checks on all 562 shortlist rows: price_cents>0, $ currency, price string == cents, max_bid ≥ price, bids vs price, valuation >0.
1. **nwdirtchurners.com** — valuation **$0.00** (valuation_cents=0) with price $1, max_bid $5. Implausible zero valuation.
2. Shortlist settings say renewal **$23.00** (renewal_cents 2300) vs SOP live GoDaddy **$22.99** — 1¢ rounding, cosmetic.
3. Price distribution: 530/562 rows exactly $1.00 (1 bid each) — plausible for GD expiry auctions; not flagged per-row.
4. definegroup.com #1: price $46 with max_bid_suggested $55 vs valuation $3,761 — internally consistent; note it is above the $40 band.
5. Closeouts (D): all 200 rows $5.00 (plausible GD closeout flat price) but **score=null, score_reason NO_ACTIVE_MODEL** and returned order is alphabetical (aaa…abe) → "rank" is not a ranking. Flag to DOM.
No zero/negative prices, no non-USD currency, no price/cents mismatches found.
Counter mismatch: brief cited 1,170 candidates / 569 shortlisted; API says field_n 686 / total 562.
