# CR-119: List price track for service-trade names

**Status:** Filed 24 Nov 2026. Floor decided by Dvir 09:56. The list price is still open (Sales comps, then Dvir's yes). The walk-away is open. **From:** DOM Architect, for Gavriel. **To:** DOM (Claude Code), for `docs/internal/pricing.md` only. No code.
**Decided by Dvir:** 24 Nov 2026, lesson from the service-names/closeouts run (section 6 item 2), approved through Gavriel. A service-trade name gets its own list price. The default $1,488 is too high for that track.

This request does not authorize spend, a listing, a price change, or any outside message. Every listing and price change is still done by hand by Gavriel, with Dvir's yes (CR-116, `06-sales-list-price.md`).

## Why

In our sales data, plumbing, roofing, moving and similar trade names mostly sold for $100 to $900 at Afternic, with only a few at $3,000 to $5,000 (run report, section 6). Today's rule ("Other, new registration": default $1,488) prices these names above where they actually sell.

## Ask

Add a row to the table in `docs/internal/pricing.md`:

| Name | Listing | Price | Drops |
|---|---|---|---|
| Service trade (a local trade service: plumbing, roofing, moving, towing and similar; Buyer tags the track at buy time) | Buy now + offers | **Open until Sales' comps and Dvir's yes.** Gavriel proposed starting around $499 to $799. On the existing price list that is the $499 or $788 rung | **Open:** same as "Other" unless Dvir says otherwise |

Rules for the edit:
- Keep the existing price list ($299 … $2,488). Don't add a $799 rung unless Dvir asks for it.
- Write "open" in the cells Dvir hasn't decided, and link this CR. Don't fill in a number on your own.
- **Floor (decided):** 65% of the price to the whole dollar, with **no $750 minimum**, never above the price. Write it under the table for the service-trade track.
- **Walk-away (open):** proposed 48% with no $500 minimum, never above the floor. It waits for Dvir's explicit yes. Until he gives it, write "open" and keep today's rule for this track (48%, never below $500, never above the floor). Every offer between the walk-away and the floor goes to Dvir anyway.

## Open question for Dvir (through Gavriel)

Today's rules say: **floor** is 65% of the price, never below $750 and never above the price; **walk-away** is 48%, never below $500 and never above the floor. At $499 or $788 those minimums push the floor to the price itself, so every offer below the list price is declined, and the track becomes buy-now only. Should service-trade names:
- (a) keep it that way (buy-now only, no discounts), or
- (b) use plain 65% / 48% without the $750 and $500 minimums (at $788: floor $512, walk-away $378; at $499: floor $324, walk-away $240)?

When Sales sends the comps number and Dvir answers, Gavriel files the numbers in this thread and DOM fills in the row.

## Done when

`docs/internal/pricing.md` has the service-trade row, with Dvir's number and floor rule once given (open cells until then). `docs/requests/bot-logic/06-sales-list-price.md` points to it (DOM Architect keeps that file).

## Dvir's decision (24 Nov 2026, 09:56 Asia/Jerusalem, through Gavriel)

Service-trade names accept offers from 65% of the price, without the $750 minimum (option b). He has not answered on the walk-away. The list price rung stays open until Sales sends comps and Dvir says yes.
