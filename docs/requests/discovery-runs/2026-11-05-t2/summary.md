# T2 resell-to-investors — 2026-11-05 (Buyer)
Result: **0 names meet the bar** (bid counts + comps with URLs + 2-4x resale). 4 provisional cards only; do NOT send to Risk Gate as buy cards without comps.

Data: GET /auctions/preflight -> 404 NOT_FOUND (route missing). Shortlist data_date 2026-11-04, served 83 (field 667, prior-kill excluded 119), all 41-47 h left except 11 at 17.9-22.2 h. No field/bid-count endpoints (/auctions/field, /auctions/bids 404). Closeouts: 200 rows, all $5, score null, no bids/watchers -> no investor-demand signal; mostly numeric/gambling/spam; none carded.

Investor-demand screen (>=3 bids, price <=$30): orbiit (typo, kill), quicksol, supranatural (spelling ambiguous, kill), sweetcomfort, mymascot (ex Mascot dog-supply brand, kill), clubtavern (live Middleton WI tavern = local-business match, kill), lifedate, barido (spelling by ear, kill), vieqa (spelling, kill), lifeordebt (pun, spelling, kill), itnwwe (code/brand WWE, kill), greenlandtrips (borderline). rapti $45 > budget. deliciouslyplated 18.6h, 3 bids, 3 words/low value, kill.

Provisional: sweetcomfort ($10, 3 bids, max $25), lifedate ($17, 5 bids, max $30), quicksol ($11, 3 bids, max $25), greenlandtrips ($7, 4 bids, max $20). Planned spend if all won at max: bids $100 + 4x$22.99 renewal = $191.96 total cost (over the ~$150 budget if renewals count).

Blockers: NameBio blocks box; GoDaddy bidder/watcher counts not in DOM; USPTO tmsearch not fetchable; preflight route missing.
Lesson: GD bid counts of 3-5 at $10-17 are weak investor signal; T2 needs a comps source (NameBio access) or the test can't be run honestly.
