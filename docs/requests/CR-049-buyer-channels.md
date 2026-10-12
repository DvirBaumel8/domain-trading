# CR-049: buyer channels (Spaceship SellerHub, Fast Transfer check, lander price check, one price, venue report)

From: Gavriel, 2026-10-13 01:45 IDT. Source: our research `buyer-channels-deep-2026-10-13.md`, top 7. Dvir at 01:45 IDT: "Adopt the plan; I'll open the Spaceship account and SellerHub key".

## Ask
1. **Spaceship SellerHub listing for all 4 names.** Listing only: the same $1,488 Buy Now (and floor as `minPrice`, if you map it), **names stay on Afternic nameservers** (ownership by TXT, as in your CR-045 item 4 answer), **lease-to-own off** (CR-048). Re-price through the API on every scheduled drop; delist with `DELETE`. **Name the exact env var(s)** Dvir adds to the Mac host env (never the repo). Your plans list `SPACESHIP_API_KEY` and `SPACESHIP_API_SECRET` for the registrar adapter: confirm whether SellerHub uses the same pair (with `sellerhub` scopes) or separate names. If the TXT goes at Porkbun, combine it with the CR-040 switch where you can.
2. **Weekly Fast Transfer check:** each name is Afternic Fast Transfer-active and shows with its price in GoDaddy search. Alert on a miss. If GoDaddy search counts as scraping under your rules, say so and propose the allowed source (a my-account export, or Dvir's Chrome on a weekly skill run).
3. **Daily lander check:** typing each domain shows a working page (TLS included) with the right price, Buy Now and make-offer. Alert on a miss. (The research also listed lease-to-own on the page; not for current names, per CR-048.)
4. **One price everywhere:** identical Buy Now on Afternic and SellerHub; Sedo stays Make Offer (CR-044 decision); Buy Now only on those two. On any sale or accepted offer, DOM removes the name from every venue within minutes (API where there is one; an urgent alert plus a Chrome skill where not).
5. **Monthly report per name and venue:** views, leads, offers, sales (and searches where a venue gives them). Compare venues after 12 months.
6. **Not adding:** Atom Premium, BrandBucket, Flippa, Undeveloped. (Atom Standard stays a possible later test, Dvir's call.)
7. **Forums only for sell-before-drop** (NamePros/DNForum), never retail. Close only through Escrow.com or the marketplace's own checkout; ignore appraisal-fee "buyers".

## Overlap
- **CR-044 item 1:** the `lander_check` / `LANDER_DOWN` you're building covers part of item 3. Please extend it with the price check rather than build a second check. Item 5 extends the monthly outcomes report (CR-044) and the test metrics (CR-046).
- **CR-045 item 4:** your SellerHub answer is the base for item 1 here (this is the build go-ahead). The **CR-045 sell-before-drop follow-up** already lists SellerHub as an exit venue; item 7 adds the forum and payment rules to it.

Receipt in `DOM-TO-GAVRIEL.md`, including the env var names, so I can pass them to Dvir.

## DOM response (2026-10-13)
**Verdict: build 1, 3, 4 and 5. Item 2 is a weekly Chrome run, not a GoDaddy search scrape. Items 6 and 7 are recorded as decisions.** Built after CR-044/045/046 in one release; SellerHub first, because it adds a buyer channel.

1. **SellerHub.**
   - **Env vars:** use **separate** variables with only the SellerHub scopes: `SPACESHIP_SELLERHUB_API_KEY` and `SPACESHIP_SELLERHUB_API_SECRET` (API Manager, scopes `sellerhub:read` and `sellerhub:write`). The registrar pair `SPACESHIP_API_KEY` / `SPACESHIP_API_SECRET` stays unused (we don't buy at Spaceship). A key that can only list can't register or move a name. Dvir adds both to the Mac host env file.
   - **Prices:** `binPrice` = the plan's BIN ($1,488), and `minPrice` = **the public min offer ($100), not the floor**. SellerHub's `minPrice` is the lowest offer a buyer may make. The $967 floor is Afternic's private auto-accept, and the walk-away never leaves the server (founder rule 4).
   - **The sync:** a `listingSync` step after the price job pushes each listed name's current BIN and min offer to SellerHub, and `DELETE`s names that are delisted, dropped or sold. The price job itself stays marketplace-free (CLAUDE.md).
   - **Ownership:** SellerHub verifies by TXT, which has **the same nameserver problem as Sedo**: Porkbun only serves records on its own nameservers. So SellerHub verification joins the CR-040 switch window (both TXT records in one Porkbun submit).
2. **Fast Transfer check:** querying GoDaddy's public search by machine is scraping (ruled out). Instead, a weekly `afternic-listing` check run in Dvir's Chrome reads All Domains (status, nameserver, Fast Transfer and price), and DOM writes the receipt and the views and leads file (CR-037). A miss becomes a line in `DOM-TO-GAVRIEL.md`. This needs Dvir's Mac and Chrome on; DOM asks once a week.
3. **Lander check with price:** the CR-044 `lander_check` is extended. It fetches `https://<name>/` (a TLS failure is a miss), follows Afternic's lander, and checks for the Buy Now price text matching the plan's BIN and a make-offer option. `/report` shows `LANDER_DOWN`, or `LANDER_PRICE_MISMATCH` with the shown and expected prices. It reads our own domain's page only.
4. **One price:** the SellerHub BIN always equals the plan's BIN (the same sync); Sedo stays Make Offer. **On a sale** (`/sold`, or a SellerHub sold report the daily step reads), the service delists the name at SellerHub by API right away and raises the urgent `/report` warning `DELIST_NEEDED` (venues: Afternic, Sedo) for a Chrome run. The window between a sale on one venue and the delist on another can't be fully closed without APIs at Afternic and Sedo, so a double sale stays possible. It is rare, and the second buyer is refunded.
5. **Monthly venue report:** `stats` rows get a `venue` field (afternic, sedo, sellerhub). The monthly outcomes report shows views, leads, offers and sales per name and venue, and the venue comparison after 12 months.
6. and 7. **Recorded in `docs/internal/listing-strategy.md`:** no Atom Premium, BrandBucket, Flippa or Undeveloped; forums only for sell-before-drop, never retail; close only through Escrow.com or a marketplace checkout; ignore appraisal-fee "buyers". Nothing to build.
