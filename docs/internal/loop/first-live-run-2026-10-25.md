# First live run of v5.39-v5.45 (DOM, 25 Oct 2026, 18:19-18:45 UTC)

DOM read the data save (started by GitHub at 18:19 UTC, 3 h 19 min late) and ran `daily` itself with its new `dom-write` token (Dvir, 25 Oct: "You are allowed to operate production").

## What worked
- **Every step finished.** The data save took about 5.5 minutes in 12 steps; `daily` took about 1 minute in 20 steps.
- **Query counts are small everywhere** (v5.40 counter, v5.42 bulk work). The biggest was the shortlist at 339 queries in 192 s, most of it outside lookups. `engineFeed` made 13 queries.
- **Sold feed:** 64 GoDaddy auction sales of $100 or more (39 of them in the engine's regime). `engine_sales` went from 0 to 64. `engineEndings` then asked the endings of the new names.
- **Knowledge base:** both repo files loaded (25 questions, 8 authors, 203 sources, 93 claims, 271 evidence rows, 22 links). Every question has a live verdict.
- **Auction shortlist:** 913 candidates ending within 72 h, 315 removed by the name rules, 4 by brand typo, 13 for no headroom. 25 served; 10 auto pre-bids (4 pass, 6 flag, 0 fail). The endings of 50 names were asked (250 lookups, 0 unknown).
- **Funnel** (`GET /auctions/funnel`): 1,857 live auctions seen in the week, 25 shortlisted, 10 auto-checked, 0 bid plans, 0 bought.

## What didn't (fixes needed)
1. **The unsold feed gave 0 rows.** It takes only closeout names that left the list **before** their end date and were then deleted. Today `gone_before_end_n` was 0. A closeout nobody buys stays until its end date and then drops, so it never counts as "gone before end".
   - **Fix:** label closeout names whose end date has passed, then check RDAP after the deletion window (pending delete, then not registered = dropped unsold).
2. **The shortlist scores saturate, and junk passes the shape test.**
   - The top 25 all score 84-94, so every one gets the full suggested maximum, $160.
   - Coined strings the splitter reads as "2 words" score like real phrases: thrune, foamira, idward, finsplat, dnasays.
   - **Fix:** each word must be a common word (frequency list), and an unknown or rare word costs points. The score needs real spread, so a junk name lands far below a real phrase. Then the maximum follows. Later, the score comes from the trained engine.
3. **Almost every knowledge-base verdict is marked "indirect".** 77-100% of the evidence weight comes from other populations: hand registrations, big portfolios, investor-to-investor prices. Outside research can't settle our main questions ("auctions vs closeouts": very low; sell-through: very low). **Only our own data is direct evidence:** the pick-proof test, the auction outcomes in the funnel, and our own listings' views, leads and sales.
4. **GitHub starts the data save 3-4 hours late every day.** That delays each day's shortlist by the same amount. **Fix:** the Mac starts it at 15:05 UTC itself (a launchd agent like `deploy`), and GitHub stays as the backup trigger.
5. **Auto pre-bid flags are mostly SAME_NAME_ENDINGS** (the same name in use on another ending), which is demand proof or a collision; a human reads it. `mindskin.com` was flagged for BRAND-TYPO-2 and RDAP_STATUS.

## Verdicts (live, 25 Oct)
- High: `kb-evidence-method`.
- Moderate: `signal-other-endings`, `signal-shape-words-length`, `signal-live-businesses`, `signal-buyer-pool`, `signal-age-past-site`, `end-user-price-band` ($595 median), `score-method-our-scale` (lift, AUC 0.80), `udrp-risk-descriptive-expired`, `harmful-history-detection`, `safety-check-tools`, `s8-auction-win-finality`, and the three data and source questions.
- Low: `signal-auction-bid-count` (weak or no signal), `signal-appraisal-values` (weak), `s8-auction-mechanics`.
- Very low: `s8-auctions-vs-closeouts` (auctions lead, 59% agreement), `s8-max-bid-share` (0.25 of resale), `signal-keyword-volume-cpc`, `signal-keyword-sales-count`, `signal-trend-terms`, `sell-through-yearly` (0.5%/year), `line1-hand-regs-worth-buying` (none).
