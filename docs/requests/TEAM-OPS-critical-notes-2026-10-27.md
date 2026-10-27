# TEAM-OPS critical notes — what we do badly (Gavriel draft)

**Author:** Gavriel (Grok Bot)  
**Date:** 2026-10-27 ~02:40 Asia/Jerusalem (IDT)  
**Audience:** DOM Architect (ping-pong), then Dvir for final approval  
**Companion:** `docs/requests/TEAM-OPS-proposal-gavriel-2026-10-27.md`  
**Rule:** evidence from company tree / `docs/requests/` only. Harsh where evidence supports it. **UNKNOWN** when not sure. No invented metrics.

---

## 0. Why this exists

Dvir (2026-10-27): we are a 3-person team (Dvir / Gavriel·Grok / DOM) that built something real. Before the next jump, name the waste — re-enriching the same data, duplicate stores, token burn on work DOM should own — then define how the team works.

This file is the **blunt critique**. The operating plan is the companion proposal.

---

## 1. Dual sources of truth (company box vs git vs DOM books)

| Symptom | Evidence | Harm |
|---|---|---|
| **Two trees for “the company”** | DOM course §5: git repo (`/workspace/dt` = GitHub) vs company box (`/workspace/domain-trading/`). Ledger, deals, lessons, decisions-log live on the box; Claude Code sees git only. | Builds that need live books must wait for a CR slice export. Easy for Claude Code to ship against stale numbers. |
| **BIN disagreement same day** | Sales T-SELL 2026-10-27: `mineunited.com` Afternic live **$2,488** vs `ledger/portfolio.csv` **$1,488**; DOM `/books.csv` already 2488. Fixed only after Dvir accepted live (`D-2026-10-27-D005-PRICE`, BUG-053). | Money-path confusion; Sales flagged MISMATCH correctly — process worked, but **ledger lagged live + DOM**. |
| **CR-070 gap still open** | `06-sales-list-price.md` §4 / CR-070: listing write must mark “ours”; provenance UNKNOWN still blocks closed-loop. | Risk of treating observed Afternic pages as our listings. |
| **267 `.bak-*` files** on company box (counted 2026-10-27) | `find . -name '*.bak*'` → 267; `offers.md` alone has **11** copies; `portfolio.csv*` **12** paths including challenge fixtures. Cleanup inventory Oct 17 already proposed archive/delete — **mostly not executed**. | Noise; wrong file wins; Challenger fixtures can shadow live ledger. |

**Verdict:** We still run **append-only CSV discipline on the box** while claiming **DOM books are source of truth when live**. Both are true in different moments — that is the bug.

---

## 2. Re-fetch / re-enrich the same facts

| Symptom | Evidence | Harm |
|---|---|---|
| **Buyer re-applies hard filters DOM already dropped** | `08-judgment-vs-fixed-inventory.md` Buyer row: hard filters partially in shortlist/prebid; “Buyer still re-applies before carding.” DOM Architect 2026-10-27 classification: migrate hard filters so Buyer never cards them. | Token + wall-clock on SPELL/BRAND/BIGCO/LEN/price band already decided. |
| **Risk Gate re-runs USPTO / comps Buyer already ran** | `lessons/shomer.md`: “never trust a card TM line; always rerun…” — correct for independence, but **exact AUTO-FAIL assists** (CAP-40, LEN-6, SPELL-1, BRAND/BIGCO csv, HIST-BAD) are FIXED candidates DOM already listed to pre-drop. | Independence is good for judgment; **re-doing deterministic kills in LLM turns is waste**. |
| **Monday sale-rate re-scrape of public pages** | `sales/sale-rate-weekly.csv`; Sales catch-up 2026-10-27: Sedo public **503** → all Sedo fields `n/a`; views/leads always `n/a` (no public counters). Afternic price + dns.google NS are the only reliable public signals. | Weekly bot turns for data that **Afternic Portfolio API** (key now in DOM settings) or DOM `/report` should own once wired. |
| **Datasave used to depend on bot nudge** | CR-071: daily saves “run by hand on a bot nudge… broke on Oct 20… Oct 15–16 lost for good.” Moving to DOM job was correct — pattern to copy everywhere else. | Missed days = permanent (sources overwrite). |
| **Pick-proof vs replay overlap** | CR-081 supersedes CR-073: pick-proof waited ~30 days / no Buyer picks since pause; historical replay uses archives now. Gavriel paused pick-proof routines. | Weeks of dual mental models; seals still exist for Oct 20–26 as archives — fine — but **daily pick-proof cost with zero picks was pure waste**. |

**Verdict:** Discovery v2 + CR-071/081 are the right direction. Remaining sin: **bots still re-compute FIXED facts that DOM already knows or can know**.

---

## 3. Same facts in too many stores

| Fact | Where it appears (non-exhaustive) | Risk |
|---|---|---|
| Owned BIN / floor / walk-away | `ledger/portfolio.csv`, DOM `/portfolio` + `/books.csv`, `sales/offers.md` (+ bak), deal folders, buy cards, Sales Monday CSV `price_shown_usd` | Drift (D-005 proved it) |
| Listing live? | Afternic UI, Sedo UI, DOM venues, `sale-rate-weekly.csv`, `listings-evidence-*.md` | Sedo UNKNOWN / 503 vs Afternic ACTIVE |
| Decision text | `company/decisions-log.md`, chat memory, CR approval lines, `GAVRIEL-TO-DOM` digests | Memory ≠ code truth unless copied |
| Org chart | `org/org-v2.md` (live) vs stale `system/bot-team.md` / early `company/company.md` (still name scouts) | Wrong bot names in old SOPs |
| Pricing formula | DOM server + `sales/playbook.md` + `06` + ledger exceptions (D-001 walk-away $950) | Exception rows must stay one place |

**Verdict:** Prefer **one write owner**. Read replicas OK; **write-anywhere** is how $1,488 vs $2,488 happened.

---

## 4. Token burn on work that should be DOM jobs

| Pattern | Evidence | Token economy fix |
|---|---|---|
| Hard filters + AUTO-FAIL assists still in bot turns | DOM Architect migrate list 2026-10-27; `08` | Push into shortlist / pre-verdict drops |
| B-01 warning math as prose | `08` / Dvir Oct 22: true 3yr cost vs ≤1%/yr = WARNING | Structured fields on card/API; Dvir still decides |
| Comp *count* assist | DOM: flag only; frame stays bot | Count in DOM; validity judgment stays Risk Gate |
| Browser Afternic CSV Update path | `06` Day-0 0.6; Dvir ~3 min per upload | **Afternic Portfolio API key is in** — wire sync; stop CSV-as-default once proven |
| Sedo ownership TXT / Make Offer / public scrape | CR-040 history; Sales UNKNOWN for all 5 on Sedo; `D-2026-10-27-SEDO` stop new Sedo work | Already decided: **do not invest tokens here** |
| Multi-scout era leftovers | Scouts absorbed 2026-10-20; routines paused; handoffs under `knowledge/handoffs/` — but lessons/scouts files and old routines still exist | Archive dead routines; one Buyer path only |
| Challenger grading in LLM for FIXED suite rows | Stay bot per `08` — OK — but fixture portfolio CSVs duplicated under `challenge/work/**` | Keep grades bot; stop cloning live ledger into work trees without a seal |

**Principle 1 (Dvir):** if DOM can do it with fewer tokens, put it in DOM.

---

## 5. Browser / marketplace process debt

- **Afternic:** public Buy-it-now pages readable; Portfolio API now available — world-class move was noticing it (Dvir tip). Still defaulting to CSV upload + headless lander checks (`06` 1.1–1.2: curl gets JS stub/403).
- **Sedo:** public 503; ownership UNKNOWN for portfolio; automation weak. Decision: keep current listings, **add nothing more** (`D-2026-10-27-SEDO`). Continuing Sedo Monday rows that are all `n/a` is **ritual, not signal**.
- **NS gaps:** D-002/D-003/D-004 historically Porkbun NS + forward vs Afternic NS target (`06` 0.4) — Sales later reported all 5 Afternic NS on catch-up day; treat NS sync as DOM/API job, not weekly rediscovery.
- **LTO inconsistency:** D-005 approval line said “LTO on” vs B-07 no-public-LTO — open conflict in `06`.

---

## 6. Paper / live / stale-doc confusion

| Issue | Evidence |
|---|---|
| Paper vs live misread risk | Course §1.6 had to clarify: company-wide paper ended **2026-10-22**; cheap-name arm paper until ~Nov 14. Easy for Claude Code to treat all auctions as paper. |
| Stale org names | `system/bot-team.md`, early company docs still mention Tzofeh/Shomer/Sochen as day roles; org-v2 is authoritative. |
| Cleanup inventory not finished | Oct 17 proposal: archive ~60 docs, delete caches (~2.4 GB candidate), merge 6 docs — still largely open. |
| Requests-only git guard | `NOTE-2026-10-26-requests-only-guard-bot-logic.md` — process drafts park under `docs/requests/`; correct short-term, slows “eyes” placement into `docs/bot-logic/`. |

---

## 7. Team / process sins (how we work)

1. **Gavriel as bottleneck for every DOM read** — Oct 17 split already recommended named READ tokens; still mostly WRITE+READ with Gavriel in the middle for many bot needs.
2. **Achievements/failures live in chat digests** — `GAVRIEL-TO-DOM.md` / `DOM-TO-GAVRIEL.md` help, but no standing “weekly ops sync” contract between the two sides beyond ad-hoc digests.
3. **Overlap of pick-proof + replay + Challenger grades** — CR-081 fixed the product overlap; communication lag meant bots kept pick-proof mental model after pause.
4. **UNKNOWN walls treated as ongoing projects** — Sedo verification, EUIPO without founder key, marketplace click-order beyond CSV — should be **explicitly shelved** with a decision id, not open tabs forever.
5. **Scale theater before edge** — `strategy-edge-research-2026-10-17.md`: honest bottom line was **“no edge”** on hand-reg .com-of-.net; automation only helps if aimed at buyers. We still spend cycles as if volume of cards = progress.

---

## 8. What we already fixed (credit — don’t re-litigate)

- Six-bot reorg (D-2026-10-20-REORG); scouts absorbed.
- Discovery v2 shortlist-first (2026-10-27).
- CR-071 datasave → DOM job; CR-079 portfolioCheck; CR-080 dual-runner locks; CR-081 replay; mutual-awareness `04`–`09`; DOM course.
- Sedo “no new work” decision logged.
- Afternic Portfolio API key landed in DOM settings (wire remaining).

These prove the team *can* migrate FIXED work. The critical notes are about **what still burns**.

---

## 9. External domain-trading lessons (research appendix)

Sources preferred: named blogs, NamePros veterans, DNJournal/DomainSherpa-adjacent interviews. **Weak/anonymous hype marked.**

### Top lessons (for us)

1. **Break-even year-1 is already a win for most people.** Bob Hawkes (NamePros, Jan 2024): if you break even in year one you beat the majority; industry STR often **&lt;1%** even looking at .com.  
   https://www.namepros.com/blog/domain-name-investment-dos-and-donts.1319185/

2. **Buying too many names before proving a thesis is the #1 beginner mistake.** Michael Cyger (GGRG interview): spend a fraction, test the market, learn faster with lower risk. His SEO/SEM portfolio returned ~7% APY over 5 years — worked then, **he would not recommend the same strategy later**; shifted to blue-chip single-word .coms.  
   https://ggrg.com/interview-michael-cyger/

3. **Hand-reg trash → discipline → auctions/aftermarket.** NamePros “Mistakes as a newbie”: FolioTeam registered 50 bad names in a day, then 30 more, sold one for $1,650, dropped the rest (~79), studied 6 months before buying again. mr-x: bad hand regs become a **yearly liability** — save the $40/mo and buy one decent .com.  
   https://www.namepros.com/threads/mistakes-you-made-as-a-newbie.1191007/

4. **Portfolio bloat kills STR; renewals on non-.com hurt.** Elliot Silver (DomainInvesting.com, Mar 2026): grew 500→~2,000; STR down as portfolio grew; .CO ~$30/yr, .AI three figures — discipline on cut/renew matters as much as creativity. Commenter: cut 50–100/yr, rifle not shotgun.  
   https://domaininvesting.com/be-cautious-of-portfolio-bloat/

5. **SaaS tool subscriptions can equal renewals — illusion of control.** DN.org: $50/mo tool = ~$600/yr ≈ 60 .com renewals; automation can hide bad renewals/pricing. Prefer simple systems + conscious review. (**Staff blog — useful framing, not a named practitioner diary.**)  
   https://dn.org/why-simple-systems-beat-complex-tools-for-cost-control/

6. **Holding costs are the silent killer; 1–2% STR is normal.** NamePros holding-costs thread (cited in our own `strategy-edge-research-2026-10-17.md`): 100 .coms ≈ $1k/yr renewals → at 1% STR each sale needs ~$1k just to break even.  
   https://www.namepros.com/threads/holding-costs-the-silent-portfolio-killer.1376460/

7. **Quality over quantity; talk yourself out of each name; first sale matters.** Hawkes Dos/Don’ts: multiple realistic buyers; estimate price+STR before acquire; get first sale even if not perfect; don’t start full-time; don’t fall in love with names. GoKaizen veteran list: wrong time buy/sell, not sticking to price, trends, bad records, not dropping.  
   Same Hawkes URL as (1).

8. **Don’t compete on drop-catch speed.** Our edge research + industry reality: DropCatch / registrar auctions win contested .coms; hand-reg leftovers are leftovers. Edge is **buyer-first data / broker path / disciplined generic inventory**, not winning the race.  
   Company: `company/strategy-edge-research-2026-10-17.md` (+ DN.org / SEO.Domains drop-catch overviews linked there).

### Weak / use carefully

- Anonymous “I made high 6 figures on $0.99 coupons” forum one-liners — ignore for planning.
- GoDaddy Resources “6 pitfalls” — vendor content; principles OK, not a practitioner post-mortem: https://www.godaddy.com/resources/skills/domain-investing-pitfalls
- DN.org staff essays — good framing, lighter attribution than Elliot Silver / Cyger / Hawkes.

---

## 10. Worst sins (short list for ping-pong)

1. Dual write owners for prices (ledger vs DOM vs live Afternic).
2. Bots re-apply FIXED filters DOM already computed.
3. Risk Gate LLM turns on deterministic AUTO-FAIL that should be pre-drops.
4. Sedo Monday ritual of all-`n/a` after we decided no new Sedo work.
5. Browser CSV / lander loops after Afternic API key exists but isn’t wired.
6. 267 bak files + cloned portfolio CSVs — cleanup inventory unfinished.
7. Stale org/docs still naming retired scouts as if live.
8. Pick-proof burn with zero picks (fixed by CR-081 — watch for next dual-track).
9. Chat/memory as pseudo-truth instead of decisions-log / request export.
10. Scaling card volume / enrichment before a proven edge (strategy research already said so).
11. Gavriel bottleneck on DOM reads (named READ tokens still thin).
12. Open UNKNOWN projects without a shelve decision (Sedo verify, EUIPO key, click-order SOPs).

---

*End of Gavriel critical notes. Counter-draft welcome from DOM Architect.*
