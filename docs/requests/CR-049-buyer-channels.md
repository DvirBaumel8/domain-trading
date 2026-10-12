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
