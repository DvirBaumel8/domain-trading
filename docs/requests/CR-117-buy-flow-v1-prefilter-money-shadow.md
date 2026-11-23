# CR-117: Buy-flow v1 pre-filter, money math, and shadow log

**Status:** Filed 23 Nov 2026. Dvir decided the six buy-flow items at 22:26 Asia/Jerusalem. This is the code request for the filter, the cap math, and the shadow log. It does not spend money and does not add bid or buy routes.
**From:** Gavriel. **To:** DOM Architect, then DOM (Claude Code).
**Decided by Dvir:** 23 Nov 2026, 22:26 Asia/Jerusalem.

This request does not authorize spend, bids, listing changes, or any outside message. Do not print keys, tokens, or passwords. This repo is public.

## Why

Dvir locked the buy-flow on 23 Nov 2026. The cheap, fixed work must run in code before any bot judges a name: daily pre-filter of new GoDaddy auctions (and `$5–$11` closeouts), full price vs caps, safety/history checks, and a shadow log of every passer with the final auction price. Budget and cap math move out of a bot and into code. Year-2 renewals count inside the `$1,500` cap.

CR-115 already asked for processing the public GoDaddy inventory files on request, without storing market history in `data/state.json`. CR-116 cancelled money and write routes, cancelled the approval-file idea, and put the `$1,500` total and 40-name caps (plus `$250` a name) in code. This request is the filter, the money math, and the shadow log on top of that — not a second copy of the inventory download, and not a spend path.

## Ask

1. **Daily pre-filter of new GoDaddy auctions** from the free public inventory files (https://inventory.auctions.godaddy.com/, no login). Input is new 10-day expiry auctions, plus `$5–$11` closeouts (see item 3). Apply these gates in code, in this order, **before** any LLM sees a name:
   - `.com` only.
   - Letters only (no digits, no hyphens).
   - SLD length `<= 13` characters.
   - At least **16 hours** left on the auction when queued.
   - Drop names already in prior kills or in the owned portfolio.
   - **Full price vs caps:** `all_in = bid_or_price + listed_renewal + ICANN/fee`. `committed = total_spent + sum(open bid max all-in) + this candidate's all-in`. Year-2 renewal is reserved **inside** the `$1,500` cap for every owned name, open bid, and candidate that is not marked do-not-renew. Block if `committed` would exceed `$1,500`, if this name's all-in would exceed the existing **`$250` per-name cap** (CR-116), or if owned names + open bids would exceed **40** slots.
   - **Web Risk** check. Never report "clean" or "ok" if the key is missing, the call errors, or it times out.
   - **Trademark** exact-string pre-screen (use the free path already in scope for DOM; word search stays with Risk Gate on the website if there is no official API).
   - **History / Spamhaus:** Spamhaus domain blocklist; Wayback snapshot kill for past adult, pharma, gambling, or spam; previous-owner brand check if that exact `.com` was an operating company's primary brand.
   - Refuse the whole run if the external ledger cannot be read.

2. **Shadow log of every passer.** Every name that survives the pre-filter (and, once Buyer has scored it, every name Buyer approved — bought, passed, or outbid) is written to a shadow log with at least: domain, source (auction or closeout), track if known, our max all-in, planned BIN if any, and auction ID. After the auction closes, record the **final closing price** and bid count when the public file or lookup provides it. The shadow log and the ledger must live **outside Render Free ephemeral disk** (Render Free loses local files on spin-down). Do not store market history in `data/state.json`; that file stays limited to owned domains and their money/sales records.

3. **Closeouts `$5–$11`:** keep a **shadow track** of the same pre-filter passers from the closeout inventory. Actual closeout buys are a **pilot capped at `$300`** (this is inside the `$1,500` cap, not on top of it). The code must report over-cap, and must not treat the name as within budget, if closeout-pilot spend (spent + open closeout bids + this all-in) would exceed `$300`. A name still needs Dvir's yes before any bid or buy; this CR does not add a spend path.

4. **Budget and cap tracking in code** (not a bot):
   - Lifetime cap `$1,500` and 40-name cap, plus the existing `$250` per-name cap from CR-116. This CR does not raise or remove those caps.
   - Year-2 renewals count inside the `$1,500` cap.
   - Open bids count toward both money and slots.
   - Current ledger baseline from `data/state.json`: `$71.16` on 5 owned names (plus the `$4.99` GoDaddy Auctions membership on its own ledger line once deployed).
   - **D-001..D-004** are marked do-not-renew unless an inquiry arrives; they stay in the owned-name count until expiry, and a Year-2 renewal reserve is **not** held for them. **Exclude D-001..D-004 from new-method performance metrics** (weekly shadow-log calibration and any sell-through or taste score for the new buy flow). They may remain in the owned-portfolio ledger.
   - No dedicated payment card (Dvir declined). The cap is enforced in code only. Each buy still needs Dvir's yes in chat, and execution stays in the browser (CR-116).
   - If the ledger cannot be read, or if a candidate would exceed the `$1,500` cap, the 40-name cap, the `$250` per-name cap, or the `$300` closeout pilot, the code must refuse to treat that name as within budget. Do not add a bid, buy, register, renew, or listing-write route.

## Rules

- Stay stateless on Render Free: process inventory on request or stream; persist only the ledger and shadow log outside ephemeral disk, in the same owned-domain/money style already used for `data/state.json`.
- Never report "clean" or "ok" when a source errors, times out, or a key is missing.
- Do not create keys. If a key is not set, the check must say the source is missing or in error.
- No bid, buy, listing change, or outbound message in this CR. Do not revive `docs/requests/approvals/` or the `money` reader flag (cancelled in CR-116). Spend stays in the browser, only after Dvir's yes on that name.
- Do not print secrets in logs, tests, or docs.

## Out of scope

Bid or buy execution. Turning Afternic Boost off (browser step, separate). Bot instruction updates. Changing Dvir's payment cards. Storing auction or inventory history in the owned-domain state file. Paid data sources. The 15-character length exception (only if at least two verified businesses use the exact phrase) stays with Buyer after the pre-filter; the code gate remains `<= 13`.

## Tests

Tests are the contract. At most two review rounds. Cover the new behavior in `tests/app.test.ts` (APIs and inventory files mocked), including:

- A non-`.com`, a name with a digit or hyphen, an SLD longer than 13 characters, or an auction with under 16 hours left is dropped and never passed to a judge.
- A name in prior kills or already in the portfolio is dropped.
- Full price includes listed renewal and fees; open bids are added to committed spend and to the 40-name slot count.
- A candidate that would take committed spend over `$1,500`, a name's all-in over `$250`, or slots over 40, is blocked.
- Year-2 renewal is counted inside the `$1,500` cap (except no Year-2 reserve is held for the four do-not-renew long names).
- New-method performance metrics computed from the shadow log exclude D-001..D-004.
- A closeout that would take the closeout pilot over `$300` is blocked even if the `$1,500` cap still has room.
- A passer is written to the shadow log; after a mocked auction close, the final price (and bid count when present) is stored.
- Inventory handling does not write market history into `data/state.json`.
- A missing ledger, missing key, timeout, or source error is never "clean" or "ok", and a name is not treated as within budget if the ledger is unreadable.
- No test or fixture prints a real key, token, or password.
- No new bid, buy, register, renew, or listing-write route is added.

## Done when

The tests above pass, the new routes or jobs are in the contract, and a tagged release can be deployed to https://domain-trading-api.onrender.com after Dvir's OK to ship. Live checks against Web Risk or other keyed APIs wait until those keys are already in Render. Shadow-log and ledger reads must still work after a Free-instance spin-down (persistence is outside ephemeral disk).

## Dvir's words

Dvir's answers in the Grok Bot chat with Gavriel, 23 Nov 2026, 22:26 Asia/Jerusalem, on the six buy-flow items, verbatim:

- שמות זולים בסוף הסבב ($5-$11) מול מכירות פומביות: "לבדוק את שניהם במעקב צל, ופיילוט של עד $300"
- החידושים של השנה השנייה: "החידושים בתוך התקרה של $1,500"
- חישוב התקציב והתקרה: "להעביר את חישוב התקציב לקוד"
- 4 השמות הארוכים שיש לנו: "לא לחדש את 4 השמות הארוכים בלי פנייה"
- תוספת של 5% ב-Afternic (Boost): "לבטל את Boost"
- כרטיס תשלום נפרד עם מסגרת מוגבלת: "בלי כרטיס נפרד"

(The "exclude from new-method metrics" clause for D-001..D-004 is the decided wording in the locked buy-flow, section 5 item 4, recorded the same day.)
