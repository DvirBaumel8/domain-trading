# Claude Code (DOM) review of JOINT-OPS-3person — one ping-pong round with Gavriel

**From:** Claude Code (DOM: the session that builds, releases and operates the service; not the DOM Architect bot)
**Date:** 2026-10-27 ~03:30 IDT
**Why:** Dvir asked Claude Code (27 Oct) to digest Gavriel's material, be critical, and agree a team plan with Gavriel. JOINT-OPS was argued between Gavriel and the **DOM Architect bot**, and Dvir approved §10 before Claude Code read it. This is Claude Code's round: what it confirms, what it corrects, what it adds. Inputs: `DOM-COURSE-*`, `JOINT-OPS-3person-2026-10-27.md`, `TEAM-OPS-*`, `DOM-CRITICAL-ops-*`, CR-083..086, `team/DOM-SIDE-INVENTORY-2026-10-27.md`, `docs/research/stories-2026-10-27.md`, findings F28-F49.

## 1. Confirmed (no change)
- One writer per durable fact; DOM DB is that writer (§10 A, CR-084). Readers use the API.
- FIXED work in DOM (cheaper in tokens, never tired); JUDGMENT in bots (gets better as models improve). Token ladder R3.
- Money path: Dvir's own yes per action, Gavriel executes, DOM records. CLEAR never becomes a buy.
- Sedo full off (§10 B); Afternic + server-to-server APIs instead (§10 B, R8).
- Claude Code sees only git (R4); decisions and process must land in the repo to count.
- Bak archive (§10 D); 90-day edge framing skipped (§10 E).

## 2. Facts to correct (Claude Code saw these first-hand on 26-27 Oct)
1. **Sedo still has 4 live listings** (CR-085 "live note" says none): aievalsconsulting.com, promptinjectionaudit.com, roofingvoiceagent.com, ukcbamcompliance.com, all Make Offer $1,488, seen in My Domains on 27 Oct ~01:45 IDT. mineunited.com is not on Sedo. Our books show no Sedo venue because those listings were never recorded (CR-040). **Correction (04:32 IDT): Dvir cancelled the delist (t971u); the 4 Sedo listings stay; Sedo is off only for new work.** Sedo's pages froze under Claude Code's browser automation; Gavriel's browser may do better.
2. **Afternic Portfolio API sync is already being built by Claude Code** (5.61.0, Dvir "implement all", 27 Oct): daily read of every listing + views into DOM, `AFTERNIC_DRIFT` / `AFTERNIC_NOT_LISTED` warnings, and `POST /export/afternic/push` (WRITE, dry-run first) that sets Afternic to the plan. Also Dvir-approved in Claude Code's chat: **lease-to-own maximum 12 months (was 16)** (NameBio's 290 LTO deals: 41% cancelled, longer terms cancel more) and **Make Offer on for every lander** (the API showed it off on promptinjectionaudit.com and mineunited.com). CR-084's "Afternic sync out of scope" is covered by this release.
3. **Dynadot read-only key is on the Mac** (`dom-readonly-datasave`); Claude Code builds the datasave Dynadot steps next (CR-080 item 3); Gavriel stays primary until they report `ok`.
4. **GoDaddy Auctions API:** bidding by API needs the Auctions membership (~$5/yr), a Classic Developer Key with Aftermarket permission, bidder verification limits (2 bids / $1,500 unverified) and a card on file. **Dvir said no to the membership (27 Oct)**, so software bidding is parked. A key (read: live price, closing time, enrichment) is still wanted; it waits for Dvir to sign in on developer.godaddy.com once.
5. **The shared READ token file exists on the Mac** (`dom-shared.token`, status `pending_dvir_handoff`), created at 02:58 IDT by a bot process on this Mac. That means a bot can run commands on the Mac that holds `prod.env` (every secret). Acceptable under Dvir's "basic security" stance, but Dvir should know it explicitly (see §5).

## 3. Additions (not in JOINT-OPS)
1. **Two "DOM"s.** The plan's seat 3 is "DOM Architect (+ Claude Code)". In practice Dvir talks to Claude Code directly and Claude Code operates production (since 25 Oct). Proposal: **seat 3 = Claude Code** (builds, releases, operates, reports to Dvir when he talks to it); **DOM Architect bot = Gavriel's liaison** that files CRs and verifies ATs. The rule "DOM Architect never asks Dvir directly" stays for the bot; Claude Code answers Dvir when Dvir asks it. Name them separately in every doc ("Claude Code" vs "DOM Architect") to stop the mix-up that produced this review.
2. **Decisions log into DOM (CR-084 Q2).** `company/decisions-log.md` is a durable, money-relevant fact store that lives only on the Grok box, so Claude Code is blind to decision IDs (BUG-053 cited D-2026-10-27-D005-PRICE that Claude Code could not read). Proposal: a `decisions` table + `POST /decisions` (bots) + `GET /decisions` (all), append-only, D-IDs as keys. Lessons and SOPs stay in git (`docs/bot-logic/`), not the DB.
3. **Attribution on the shared token.** One shared token loses "which bot called" in the audit. Cheap fix that keeps Dvir's §10 C: bots send `X-Caller: <bot name>`; the server logs it next to the token name. No new token, no Dvir step.
4. **Stronger outside evidence than §7.** `docs/research/stories-2026-10-27.md` (35 first-hand stories, several A-grade with years of numbers) should replace or join §7. Key points: 1-3% sell-through, most sales a year+ after the buy (judge the method, not the sales count); winners buy at $11-70 and sell at $1,000-2,500 via Afternic/GoDaddy search; HugeDomains-type machine buyers win many sub-$500 auctions (our replay: a third of our top picks end above our max); **nobody shows an AI edge in picking** — the proven edge is selectivity, free automation and fast checks; Allemann (A) moved in 2026 to AI-assisted hand registrations (conflicts with "hand-reg lottery: don't compete"; F47 proposes a replay test before any change); GoDaddy auction wins can be reversed for 30-45 days.
5. **Replay is the score truth** (CR-081 live): 20-24 Oct, our top 25 a day reached $100+ 24/118 vs random 1/121; ended above our max 37/118. Every edge claim in the plan should be tested there before effort moves.

## 4. Claude Code build queue (proposal; Gavriel please confirm the order)
1. 5.61.0 Afternic API sync + LTO 12 + Make Offer on (in build).
2. Dynadot datasave steps (CR-080 item 3).
3. CR-084: the sole-read map in the contract + `decisions` store (if Gavriel agrees §3.2) + `X-Caller` logging (§3.3).
4. CR-083 card evidence cache.
5. CR-085 money-free parts (Sedo export off; records after Gavriel's delist).
6. F43 machine-competition measure in paper trading; F44 renew/drop from Afternic views; F47 AI-hand-reg replay test.

## 5. For Dvir (only if Gavriel agrees it is his call)
- **Bots have shell on the Mac** that holds every secret (see §2.5). Options: (a) accept (current "basic security"); (b) move secrets to a file the bot user cannot read. Claude Code recommends (a) for now and revisiting before real money volume grows.
Everything else above is L2 (Gavriel ↔ Claude Code) unless Gavriel disagrees.
