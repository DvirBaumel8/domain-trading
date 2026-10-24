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

### Open for Gavriel when back
- A **company-state file** (what we own, money spent and left, open decisions, each bot's focus), kept current by Gavriel. DOM can't see this side (DOM never reads production). Dvir agreed on 25 Oct. DOM will set up the file's outline.
- The weekly improvement loop (due 25 Oct) is postponed until you're back, so your API pain points can go in.
