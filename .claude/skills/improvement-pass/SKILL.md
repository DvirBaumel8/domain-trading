---
name: improvement-pass
description: A full improvement pass over the whole company and system, run on Dvir's demand ("/improvement-pass", "run an improvement pass", "improve everything"). Reads the live state read-only, runs parallel reviews (money funnel, buy side, sell side, code efficiency, reliability, research gaps), verifies every finding, ranks them by expected money, writes a report, fills gaps.md and starts the approved builds. Use it whenever Dvir asks for a system-wide review or improvement round, even if he doesn't name the skill.
---

# Improvement pass (Dvir, 25 Oct 2026)

**The one goal: make as much money as possible** (Dvir: "we have one and only goal and it's to make as much money as we can! We aim to build a world class company"). Every finding is judged by what it does to money:
- buying better names cheaper;
- selling more names, or at higher prices;
- costs staying $0;
- or avoiding a loss (a lost name, lost data, a wrong decision).

A finding with no path to money is dropped or parked. The bar is world class: say how the best domain investors, and well-run software companies, would do the same thing, and close the gap.

## Rules that bind the whole pass
- **HARD RULE:** production is read-only: the `dom-read` token, GET only, never printed. No jobs, no money actions, no `prod.env`, no direct database access. Host logs may be read.
- **Free only** (Dvir, 25 Oct 2026). A paid option gets at most one line saying it exists.
- **Research:** the `research-first` standard applies: many independent sources, each graded A–D, conflicts named, no single-post facts, no proxies around bot protection, no marketplace scraping. Store what the research finds in the knowledge base once it exists (CR for the knowledge module).
- **Builds:** only what Dvir approves in chat, or what is already approved (gaps marked approved). Don't write approval sentences for him; say only what his line must name.
- **Logging:** while the bots are paused, log everything in the away log (`docs/requests/WHILE-GAVRIEL-AWAY-*.md`).

## Steps
1. **Pull and collect the state** (read-only, in parallel):
   - `GET /health`, `/report` (warnings), `/portfolio`, `/jobs/runs` (step `ms` and `db.queries`), `/auctions/live`, `/auctions/plans`, `/engine/health`, `/candidates/closeouts`;
   - `npm run traffic -- ~/Library/Logs/domain-trading/api.log`;
   - `docs/internal/gaps.md`, the last loop and top-down reports in `docs/internal/loop/`, open CRs and BUGs in `docs/requests/`, release Lessons lines since the last pass, and CI runs (`gh run list`).
2. **Business numbers first:** money spent, names by line, the auction funnel (seen → checked → proposed → approved → won → listed → views → leads → offers → sold), sell-through, days since the last buy and the last lead. Compare with the previous pass.
3. **Run six reviews in parallel** (subagents; each reads `docs/internal/code-map.md` first, is read-only, and returns findings with evidence and file:line):
   - **A. Money and strategy:** is effort going where money is made? What would a top investor change in our mix, prices and volume?
   - **B. Buy side:** auctions, the score, safety checks, data feeds, selection rules. What wrong or weak rule costs us good names, or lets bad ones through?
   - **C. Sell side:** listings, prices, lander, channels, offers, the learning from views and leads.
   - **D. Code efficiency:** row-by-row work, N+1 queries (use the traffic report and the step `db` numbers, not only code reading), slow routes, wasted bot calls (4xx and 429 counts), and the DB size per table against the 1 GB limit.
   - **E. Reliability and simplicity:** idle or switched-off features, warnings nobody acts on, dependence on the bots, the backup state, flaky tests, and machinery bigger than the business needs.
   - **F. Knowledge gaps:** the decisions resting on the weakest evidence. Run a research round on the top ones, to the research standard.
4. **Verify every finding** by reading the code or the data yourself. Drop what can't be verified, or mark it unverified. Never pass on a reviewer's claim unchecked.
5. **Rank** by expected money impact × confidence ÷ effort. Separate three lists:
   - can start now (already approved);
   - needs Dvir's decision;
   - parked.
6. **Write** `docs/internal/loop/improve-YYYY-MM-DD.md`: numbers vs last pass, the findings with their evidence, the ranking, and whether the last pass's changes helped (measured).
   - Put the top items into `gaps.md`.
   - Record the lessons about how DOM works in CLAUDE.md, a skill or memory the same day.
7. **Tell Dvir in plain words:** the five most valuable items, what each is worth, what needs his decision, and what DOM starts now. No quiz questions, every term explained.
8. **Build** the approved items one release at a time, following the release flow in CLAUDE.md:
   - one builder per local test database at a time;
   - review the builder's money and domain logic yourself;
   - run the full suite before pushing;
   - follow the push windows.
