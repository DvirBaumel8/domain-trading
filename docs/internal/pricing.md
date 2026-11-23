# Pricing rules (applied by hand; no code reads them)

Dvir's rules of 5, 6 and 16 Oct 2026. Full history: `git show archive-2026-11-23:docs/internal/listing-strategy.md`.

**Price list:** $299, 399, 499, 788, 1,088, 1,488, 1,988, 2,488. Afternic is the only sales venue.

| Name | Listing | Price | Drops |
|---|---|---|---|
| Geo | Buy now only, no offers, no negotiation | $499 strong, $399 weaker | One rung down (499 → 399 → 299) at month 12 |
| Other, new registration | Buy now + offers | Default $1,488; $788 at least; $1,988 and $2,488 need strong lead evidence | One rung down at month 6 and month 18, then the final push |
| S8 (aftermarket) | Buy now + offers | Dvir's approved price, else by length before .com: up to 8 letters $4,888, 9–12 $3,488, 13+ $2,488 | Final push only |

- **Floor** = 65% of the price to the whole dollar, never below $750 and never above the price. **Min offer** on the marketplace is $100.
- **Walk-away** = 48% of the price, never below $500 and never above the floor. It is private: never exported, shown or told to a buyer.
- After a drop, floor and walk-away are computed again. Months count from the first listing.
- **Final push** at `drop_date` − 90 days: the lowest list price at or above the floor. **Delist** at `drop_date` − 7 days.
- Drops are pre-approved by the buy approval; Dvir gets a heads-up. Any other price or mode change needs his line.
- **Offers:** at or above the floor: accept. Between walk-away and floor: Dvir decides. Below: decline. Every offer is recorded.
- Geo has no floor below its price. Offer-only or plain buy-now on a non-geo name needs Dvir's line.

## Today (Afternic, checked 27 Oct 2026)
| Name | Price |
|---|---|
| promptinjectionaudit.com, ukcbamcompliance.com, aievalsconsulting.com, roofingvoiceagent.com | $1,488 |
| mineunited.com (S8) | $2,488 |

promptinjectionaudit.com drops at its first expiry (2027-10-04).
