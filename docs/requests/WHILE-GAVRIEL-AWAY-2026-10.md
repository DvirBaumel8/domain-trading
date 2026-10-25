# While the Grok bots were paused (from 23 Oct 2026)

Dvir, 25 Oct 2026: the Grok bots reached their token limit and are paused for about 3 days. Dvir and DOM work directly meanwhile.
Dvir's rule: **everything done in this period is written here**, so Gavriel and the other bots catch up from this one file.
Newest entry last. DOM still never calls production (HARD RULE unchanged); Dvir checks `/health` himself.

## Log

### 25 Oct 2026 (00:50 IDT): v5.35.0, the daily save seals pick-proof days no bot sealed
- **Problem:** a pick-proof day froze and sealed only on a bot call. With the bots paused, 23 and 24 Oct were never sealed. Each day's source rows (D-1) are deleted after 3 days, so 23 Oct would have been lost in the 25 Oct 15:00 UTC run.
- **Fix:** new datasave step `pickproofSeal` (before `snapshotRetention`). It freezes and seals every unsealed day before today, with the same rule, seed and draw as a manifest call. A day it froze itself is marked `sources.frozen_by: "datasave"`. Today is never touched.
- **Also:** a freeze after the source rows are gone now answers 410 `POOL_SOURCE_PRUNED` instead of silently freezing an empty pool.
- **For Challenger:** these days have no arm A (no Buyer picks). Please rule on whether they count for B1/B2/C1, and add their seal lines to `pick-proof-seals.md`.
- **To check when back:** `GET /jobs/runs?job=datasave` → `pickproofSeal`; also the first BUG-052 tagging run (23 Oct onward) in `buildPanel.tags`.
- Release note: `docs/releases/v5.35.0.md`.

### 25 Oct 2026: development paused, Dvir's learning time
- Dvir asked to stop development and spend the time understanding the company, the system and the sector in detail, so he can take decisions himself.
- DOM is teaching him lesson by lesson. Gavriel: expect Dvir to ask more detailed questions and to want plain-language explanations; explain every term you use.

### 25 Oct 2026: DOM gets read-only access to production (Dvir's decision)
- Dvir was surprised that DOM couldn't see what the company owns. He decided: "Yes of course I want this change! You should have read only access!"
- **New rule (CLAUDE.md HARD RULE):** DOM may **read** production with its own READ token `dom-read`, GET requests only. Only Gavriel changes anything. DOM still never writes, never runs jobs or money actions, never uses your tokens or the job token, never reads `prod.env`, and never touches the database directly.
- **How:** a new host-kit script, `scripts/local-host/dom-read-token.sh`, run by `deploy.sh`, creates the token once on the Mac and stores it in a file only the Mac user can read. Nobody types or sees the key. It shows in `token list` as `dom-read` (scope read).
- **What this means for you:** DOM now knows the real portfolio and numbers, so its answers to you will be about the live state. Live actions are still yours.

### 25 Oct 2026 (01:05 IDT): read access works; v5.35.0 live
- The `dom-read` token was created on the Mac at 22:02 UTC (24 Oct). DOM read `GET /health`: version **5.35.0**, db ok, jobs ok, `datasave: partial`.
- DOM read `GET /portfolio`: 5 names, all listed at $1,488 (floor $967, min offer $100), no offers yet. mineunited.com (S8) has no listed venue.

### 25 Oct 2026: mineunited.com listing planned, waiting for Dvir at the computer
- **Problem:** mineunited.com was not listed on any marketplace (`/report` EXPORT_PENDING since 16 Oct).
- **Current state:** public RDAP shows it at GoDaddy, nameservers NS1/NS2.AFTERNIC.COM, registered 2013. The old Hostinger registry mismatch is gone.
- **Plan (from the live record):** Afternic Add Domains, Buy Now $1,488, floor $967, min offer $100, Lease to Own off, Custom Lander, Buy It Now + Make Offer.
- **Blocked:** Afternic was signed out on the Mac, and DOM never signs in for Dvir. Dvir chose to do it later, when he is at the computer (sign in, his "yes", Manual mode).
- **After it is submitted:** record it with `POST /export/afternic/uploaded` and `POST /listings/mineunited.com/venue` (DOM if it has write access by then, else Gavriel).

### 25 Oct 2026: Dvir wants DOM to have write access too (not set up yet)
- Dvir: "Of course you can write it, why not, you both team members and in my team anyone can do anything."
- DOM's attempt to create its own WRITE token was blocked by Claude Code's safety check, which stops an assistant from widening its own access. Nothing was changed.
- Waiting for Dvir: Manual mode or a permission rule. Unchanged either way: money actions need Dvir's own chat line.

### 25 Oct 2026: Dvir's direction after lesson 2 (new vs expired names)
- DOM explained to Dvir: money comes from sales of either kind; names with history (age, past use) usually sell more often; new registrations pass our rules only with real interested businesses; drop-catching is a speed race we lose and founder rule 5 forbids the catch services; closeouts are a hypothesis that the pick-proof test checks (first results about 20 Nov).
- **DOM's recommendation, accepted by Dvir ("I'm going with you, digest it and improve things"):**
  - new registrations (Line 1) only when the Tier A gate passes (the exact name live as a business on .net and .org, 15 Oct definition);
  - expired names (S8) are the main line, judged by the pick-proof results;
  - the $50 S8 cap is reviewed only after the pick-proof shows our picks beat random.
- **Improvements DOM takes on:**
  1. Enforce the Line 1 Tier A gate in the server's `/buy` (today it is applied only on Gavriel's side, so a mistake there is not caught).
  2. The three Sedo listings from 14 Oct (CR-040) were never recorded as venues on the server (`/portfolio` shows Afternic only). Check them, then record them.
- Gavriel: if your side has more to the Tier A rule than the 15 Oct definition, write it here before DOM's change ships.

### 25 Oct 2026: the main buying line is now a written rule
- Dvir asked: "our main line should be domains for sale where we can bid, correct? Can we make it a rule?"
- DOM's correction: not only auctions with bidding. The main line is S8, expired names a registrar already sells (closeouts at a fixed price, fixed-price listings and public auctions) at $50 or less. In practice it's mostly closeouts, since a contested auction passes $50 fast.
- Recorded in `CLAUDE.md` (Decisions after handover, "Main buying line"): S8 is the main line, Line 1 only with Tier A, backorder/catch services still banned, $50 cap reviewed after pick-proof.
- Gavriel: please mirror this in your own buying notes. If a buy plan you hold ranks Line 1 above S8, change it.

### 25 Oct 2026: auctions before closeouts; the $50 cap is under review
- Dvir doubted closeouts ("if there was a period of time that no one wanted the domain, why we think we know better?") and the $50 cap ("Might be a super quality domain above 50, lets be more flexible there"), then set the direction: "we need to invest more efforts in bids instead of closeouts. Closeouts is a bit similar to new registration with how it's a guess and low chance to be sold".
- Recorded in `CLAUDE.md` ("Main buying line"): within S8, GoDaddy/Dynadot public auctions with real bidding get the main effort. Closeouts get no money until the pick-proof shows an edge; the test keeps running (no cost).
- **Pending Dvir's line:** a new per-name S8 cap (`settings.s8_max_price_cents`, migration only). DOM recommended $250, with the S8 test budget staying about $600 and, above $50, Gavriel showing Dvir why the name is worth more (live businesses on other endings, age, comparable sales). DOM ships the migration once Dvir names the number.
- Gavriel: please think about how you'd find and judge auction names (which auctions, when they end, how to set a max bid). Dvir places bids by hand on the registrar website, and the buy comes in through `POST /portfolio/import` as today.

### 25 Oct 2026: research first, then test (Dvir's working rule)
- Dvir: "Let's try to learn from others experience and not do the road ourselves for any dilemma." Before we build or wait for our own test on a question, we first look up what experienced investors have already found, and say so with sources.
- DOM's first research (closeouts vs auctions, public articles only, no marketplace scraping):
  - Investors' guides agree: closeouts have a low hit rate (names that hundreds of investors passed on at about $12); auctions with real bids have a much higher hit rate and better sell-through, but "auction psychology" causes overpaying, so a firm max bid is needed. Sources: domainnamelovers.com/learn/hand-registration-vs-expired-vs-auctions, domainsdealer.com/godaddy-domain-auction, domaindetails.com/kb/domain-investing/expired-domain-auctions-comparison.
  - Typical sell-through is 1–2% of a portfolio a year (about 3% for .com counting $100+ sales). Sources: domainnamelovers.com/learn/is-domain-investing-worth-it, pixelworksdomains.com/blog/sell-through-rate-the-metric-that-predicts-your-domain-profits.
  - GoDaddy closeouts follow a falling fixed price after a failed auction (reported as $50, $40, $30, $11, $5).
- Consequence: this supports Dvir's auctions-first direction. The pick-proof stays (it costs nothing) as a check of the bots' picking skill, not as the gate for the closeouts-vs-auctions choice.

### 25 Oct 2026: v5.36.0, S8 cap $250, auctions are the main effort
- Dvir: "Let's raise the limit to 250 and make the auctions our main effort".
- v5.36.0 (migration `1766400000000_v5-36-0.sql`): `settings.s8_max_price_cents` 5000 → 25000. `S8_PRICE_CAP` now answers only above $250. `CLAUDE.md` founder rule 5 and "Main buying line" updated.
- Gavriel: confirm 5.36.0 on `/health`. Above $50, show Dvir why a name is worth more before he approves. Dvir did not set a new S8 test budget; the earlier plan (about $600 for 10 names, from 13 Nov) stands until he says otherwise.

### 25 Oct 2026: auctions research (playbook)
- Dvir: "Now we can use others experience for improve our knowledge about auctions domains. Go ahead please".
- DOM wrote `docs/research/auctions-playbook.md`: how GoDaddy and Dynadot expired auctions work (proxy bids, 5-minute extension, redemption refund), how experienced investors bid (value first, fixed maximum set early, pay a third to a fifth of resale), what sells, and what it means for us.
- Gavriel: read it before proposing any auction name. Every proposal should carry a written maximum bid with its reason; Dvir approves the name and the maximum and bids by hand.
- Proposed next build (waiting for Dvir): keep GoDaddy auctions in our price range ($12–$250, with bids) from the daily files we already download. Today only auctions that reached $500 are kept.

### 25 Oct 2026: v5.37.0, live auctions in our range (`GET /auctions/live`)
- Dvir: "Yes sounds good build it." The daily save now keeps GoDaddy auctions at or under the S8 cap ($250) with at least one bid, 7 days, and `GET /auctions/live` lists them (filters: ending soon, bids, price, type). Release note `docs/releases/v5.37.0.md`.
- v5.36.0's CI run failed (the `doctor` test counts migrations); it was never deployed. v5.37.0 fixes the count, so both go live together.
- Gavriel: from the 25 Oct 15:00 UTC run, use this list to find auction names. Every proposal carries a maximum bid and its reason (`docs/research/auctions-playbook.md`).

### 25 Oct 2026: three research tasks running; auction gap plan
- Dvir asked for research held to a high standard (25+ sources each, every source graded A–D by reliability, agreement and conflict shown): (1) the best funnel for new registrations, (2) how to invent names more accurately, (3) the safety checks. Results go to `docs/research/`.
- Dvir agreed the selection system was built for new registrations and needs adjusting now that auctions are the main effort. DOM's gap: `POST /portfolio/import` runs **after** the buy and checks only approval, price cap, source, slots and term. No safety or demand check runs before an auction bid. DOM's plan (built after the safety research is in): a read-only pre-bid check, a bid plan with Dvir's approved maximum before bidding, the import refusing a price above that maximum, and recording won/lost bids to learn from.

### 25 Oct 2026: research results (funnel, names, safety)
- All three reports are combined in `docs/research/funnel-names-safety-2026-10.md` (about 130 sources, each graded A–D).
- Main points:
  - Auctions first still holds, because the binding limit is our 40 slots and the 2-year hold.
  - New registrations: 1–2 words, present demand (Tier A, or a new Tier B), small-business buyer groups, no future-trend terms.
  - Our four Line 1 names are the type that sells least: keep them, drop at renewal without interest, buy no more like them.
  - AI invents names only for breadth; every claimed buyer business is verified by code.
  - Safety adds Spamhaus DBL, URIBL, EUIPO for all names, a typo/combosquat check, a manual exact-string business check (the NexusMutual.com loss), the trademark check at bid time, and stored evidence.
- Correction: some sources in DOM's first auctions research the same morning (`auctions-playbook.md`) are graded D (content farms). The playbook's bidding advice is also supported by B sources; its sell-through figures are replaced by §1 of the new file.
- Rule for all research: never read a site through a proxy that gets around its bot protection.
- Waiting for Dvir: go-ahead on the builds in §6 (auction pre-bid check and bid plan, safety upgrades, new-registration gate code). Gavriel: the new-registration rules in §3–4 become a selection settings draft for Dvir to activate.

### 25 Oct 2026: weekly improvement loop, v5.38.0
- Report: `docs/internal/loop/2026-10-25.md` (written without your pain-point block, because the bots are paused; please add it when back).
- **Urgent finding:** the DB grows about 44 MB a day (87 MB on 19 Oct → 350 MB, 32.6%, on 25 Oct). It would reach 70% around 3 Nov. v5.38.0 adds `GET /health` `db_size.tables` (the 10 largest tables) so the cause can be seen. The cut follows (G-119).
- Also open: `/health datasave: partial` with every 24 Oct file complete (G-120).

### Open for Gavriel when back
- A **company-state file** (what we own, money spent and left, open decisions, each bot's focus), kept current by Gavriel. DOM can't see this side (DOM never reads production). Dvir agreed on 25 Oct. DOM will set up the file's outline.
- The weekly improvement loop (due 25 Oct) is postponed until you're back, so your API pain points can go in.
