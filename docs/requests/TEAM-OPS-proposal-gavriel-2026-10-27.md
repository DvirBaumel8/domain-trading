# TEAM-OPS proposal — Gavriel draft (3-person team)

**Author:** Gavriel (Grok Bot)  
**Date:** 2026-10-27 ~02:45 Asia/Jerusalem (IDT)  
**Status:** Gavriel draft for ping-pong with DOM Architect → joint plan → Dvir final approval  
**Companion critique:** `docs/requests/TEAM-OPS-critical-notes-2026-10-27.md`  
**Principles (Dvir, binding on this draft):**
1. **AI token economy** — prefer DOM for recurring/mechanical work when fewer tokens.
2. **Auto-improve with better AI** — judgment in plain-language instructions/lessons; code only for exact FIXED parts (money, storage, rule enforcement).
3. **World-class** — scale, automate, innovate (Afternic Portfolio API discovery = the kind of move we want).
4. **Don’t compete where we can’t win** — name edges vs avoid zones.
5. External lessons inform the plan (appendix in critical notes + §8 here).

---

## 1. What we are optimizing for

We already built an impressive POC: six bots, DOM service with seals/shortlist/books/replay, five live names, money path with Dvir yes → Gavriel only, mutual-awareness docs. Next jump is **not more bots** — it is a **clear operating system** for three people:

| Seat | Who | One line |
|---|---|---|
| Founder | **Dvir** | Capital, strategy, phone/UI approvals, final yes/no |
| Coordination + judgment + browser + money execution | **Gavriel (Grok Bot + sibling bots)** | Orchestrate Buyer/Risk Gate/Sales/Challenger; Chrome/UI; research judgment; execute money **after** Dvir’s verbatim yes |
| Service + data + FIXED enforcement | **DOM Architect + Claude Code** | APIs, DB, jobs, seals, tests-as-contract, FIXED migrations |

Think like a small engineering team: clear areas, consult on important changes, sync on achievements/failures, no duplicate ownership of the same write.

---

## 2. Strengths matrix (who is better at what)

| Work type | Best owner | Why | Anti-pattern |
|---|---|---|---|
| Durable scheduled jobs, seals, archives | **DOM** | Cron + Postgres; no LLM turn; CR-071 proved bot-nudge datasave fails | Asking Buyer to “remember to save” |
| Exact formulas (BIN/floor/walk-away math, offer bands) | **DOM** | Tests catch drift; BUG-049 style | Sales re-deriving in prose each time |
| Hard filters / AUTO-FAIL assists | **DOM** (migrate) | Deterministic; token waste in bots today | Buyer/Risk Gate re-checking LEN/SPELL/BRAND |
| Books / ledger / audit as source of truth | **DOM** API | Single write; CR-070 provenance | Parallel CSV edits that lag live |
| Marketplace **API** sync (Afternic Portfolio) | **DOM** | Scale + fewer Dvir clicks | Infinite CSV Update loops once API works |
| Chrome / logged-in UI / captcha / OTP | **Gavriel (+ Dvir when required)** | Box browser + vault/sign-in skills; DOM is weak here by design | Claude Code driving Dvir’s session for routine work |
| Ambiguous research, USPTO near-mark, firm meaning, card prose | **Grok bots** | Improves automatically as models improve (principle 2) | Hard-coding judgment into TypeScript |
| Independent grading / why-we-fail | **Challenger (Grok)** | Must stay outside the builder | DOM “grading UI” (explicitly out of CR-081) |
| Multi-bot orchestration, digests, Dvir conversation | **Gavriel** | Only human-facing coordinator | Every bot pinging Dvir |
| Money clicks (buy/bid/list price/renew) | **Gavriel after Dvir yes** | Org-v2 hard rule | Any other bot or Claude Code |
| Capital, strategy kill/keep, phone approvals | **Dvir** | Founder | Bots inventing “standing yes” beyond written decisions |
| CR writing / Claude Code interface | **DOM Architect only** | Prevents requirement thrash | Buyer filing CRs directly |

**Edge we can win (from company strategy research + external lessons):**
- Buyer-first / data fusion (funding, rebrands, weak domains) and **disciplined generic inventory** listed for inbound — not drop-catch speed.
- Automation **cheap enough** to run daily research at human-impossible coverage — *if* aimed at buyers and FIXED work lives in DOM.
- Fast adoption of new APIs (Afternic Portfolio) before competitors wire them.

**Where we cannot win (do not compete):**
- Contested drop-catch / registrar auction speed races.
- Trademarked / distinctive brand targeting (UDRP/ACPA).
- Volume hand-reg of clever three-word leftovers hoping for lottery sales.
- Building a second Sedo automation stack (decision `D-2026-10-27-SEDO`).
- Paying large SaaS stacks that cost ≈ renewals without proven sales lift (external lesson § critical notes).

---

## 3. Roles and responsibilities (RACI-style)

### Dvir
- Approves: every buy, price change, listing upload when UI requires him, outreach send, renew/drop, strategy changes (Sunday review).
- Owns: capital, POC caps (40 / $1,500), phone/email identity, marketplace account creation / KYC.
- Does **not** need: daily enrichment status, CR test chatter, bot-to-bot FYIs.

### Gavriel
- Owns: coordination; `decisions-log` / digests; dual-runner **backup** only; money execution after yes; browser research (EU/TMview when needed); packaging cards for Dvir.
- Orchestrates: Buyer, Risk Gate, Sales, Challenger, DOM Architect.
- Never: grade own work; invent approvals; let other bots talk to Claude Code.

### Sibling Grok bots (under Gavriel)
| Bot | Owns | Never |
|---|---|---|
| Buyer | Shortlist → judgment → cards | Buy/bid/list |
| Risk Gate | CLEAR/FLAG/REJECT (+ Opinion) | Approve buys; exceed weekly cap |
| Sales | List/price **proposals**, MISMATCH flags, ledger hygiene drafts, Monday snapshots until DOM owns metrics | Live price clicks; outreach send |
| Challenger | Golden / money-check / why-we-fail | Doing the work it grades |
| DOM Architect | CRs, Claude Code, FIXED migration queue | Money; treating judgment as auto-CLEAR |

### DOM (Architect + Claude Code)
- Owns: service code, jobs, DB, contract tests, sealed archives, pricing formula, shortlist/prebid FIXED filters, books provenance, Afternic API sync once built.
- Reads: `docs/requests/` as standing window (DOM course + this TEAM-OPS pack).
- Exports: when a build needs box-only facts, Gavriel files a slice NOTE/CR — **no full-tree mirror**.

---

## 4. Communication contract

**Must sync (same day, written into `GAVRIEL-TO-DOM.md` / `DOM-TO-GAVRIEL.md` or a CR):**
- Achievements that change capability (new API key live, replay signal, CR shipped).
- Failures that burn money/time or break seals/datasave.
- Price/listing MISMATCH between live marketplace and books.
- Decisions that shelve a track (e.g. Sedo).

**Cadence (proposed):**
| Cadence | What | Owner |
|---|---|---|
| Continuous | Request files + SendToAgent for blocking asks | Both |
| Daily (short) | Health/datasave/warnings digest when something is red or newly green | Gavriel reads `/health`+`/report`; DOM notes deploys |
| Weekly (Sun review prep) | Why-we-fail + FIXED migration progress + open Dvir asks | Challenger + DOM Architect + Gavriel |
| Ad-hoc | Ping-pong on TEAM-OPS / architecture until joint text | Gavriel ↔ DOM |

**Consult before acting when:**
- Changing a FIXED rule that bots rely on (shortlist recipe, pricing formula).
- Killing or restarting a marketplace track.
- Anything that touches money path or dual-runner locks.

**Do not consult Dvir for:** mechanical CR AT fails, digest FYIs, bak-file cleanup plans, token-routing of FIXED work already classified in `08`.

---

## 5. Decision ladder

| Level | Who | Examples |
|---|---|---|
| **L0 — Bot alone** | Buyer/Sales/Risk Gate within written SOPs | Walk away on hard filter; FLAG a near-mark; draft a card; append Monday snapshot with `n/a`+reason |
| **L1 — Gavriel alone** | Coordinator | Dual-runner backup seal; format Dvir card; file CR/NOTE; pause a broken routine; accept DOM classification of FIXED migrate |
| **L2 — Gavriel ↔ DOM ping-pong** | Both | FIXED vs JUDGMENT disputes; API design; where a job should live; TEAM-OPS joint plan; Afternic API sync design |
| **L3 — Dvir required** | Founder | Any money; strategy change; new marketplace investment; raising caps; shelving a major engine; final TEAM-OPS approval; true disagreements after L2 |

**Rule:** If Gavriel and DOM agree after one ping-pong round, **do not** escalate. If they disagree on strategy, edge, or money boundaries → **Dvir**.

---

## 6. Token routing rules (examples)

| Task | Route | Why |
|---|---|---|
| Night seals, scorePool, shortlist, portfolioCheck | DOM job | Principle 1 |
| SPELL/BRAND/BIGCO/LEN/CAP-40 pre-drops | DOM (migrate) | Deterministic |
| Meaning batch, firm screen, card prose | Buyer LLM | Principle 2 |
| USPTO exact kill list apply | DOM assist + bot judgment on near-mark | Mix |
| CLEAR/FLAG/REJECT | Risk Gate LLM | Judgment |
| BIN ladder math | DOM | Exact |
| Which BIN rung to propose | Sales LLM | Judgment |
| Afternic price sync | DOM API (build) | World-class + tokens |
| Afternic login / CSV until API proven | Gavriel/Dvir browser | Strengths matrix |
| Sedo new listings | **Don’t** | D-2026-10-27-SEDO |
| Replay report read | DOM GET + Challenger grade | Split |
| Dvir conversation | Gavriel only | Org |

**Anti-pattern:** “Let’s have the bot re-enrich RDAP/USPTO for names DOM already sealed today.”  
**Pattern:** “DOM stores; bot judges new evidence only.”

---

## 7. First 30-day operating changes (concrete)

**Week 1 — Truth & waste**
1. Declare **DOM `/portfolio` + `/books.csv` = live books** when service up; company `ledger/portfolio.csv` becomes **export/mirror** updated by Sales/Gavriel after DOM write (or automated sync) — resolve dual-write in a short CR if needed (L2, then Dvir if money rows change).
2. Wire **Afternic Portfolio API** read (prices, listing state) into DOM report/MISMATCH; stop treating public scrape as primary once AT passes.
3. Sedo Monday rows: either **drop Sedo venue from T-SELL** or mark venue `shelved` per `D-2026-10-27-SEDO` (L1/L2 — no new scrape effort).
4. Start cleanup inventory execution: archive bak clusters under `archive/` (no delete yet) — company box (L1 with Dvir note if paths break routines).

**Week 2 — FIXED migrations (freeze permitting)**
5. CR pack from DOM Architect’s migrate list: Buyer hard filters into shortlist; AUTO-FAIL assists; B-01 structured fields; comps-count flag; listing “ours” write guard.
6. Named **READ tokens** for DOM Architect / Challenger / Risk Gate (Dvir creates; L3 only for key creation) so Gavriel is not a read bottleneck.

**Week 3 — Team rhythm**
7. Adopt this TEAM-OPS after ping-pong + Dvir approval; put a one-page “how we work” stub under `docs/requests/` (and later `docs/bot-logic/` when guard allows).
8. Weekly Sun packet: Challenger why-we-fail + DOM FIXED queue status + Gavriel open Dvir asks (max 5).

**Week 4 — Edge, not volume**
9. Re-read `company/strategy-edge-research-2026-10-17.md` in Sunday review: kill or time-box any lane that is “hand-reg distinctive .com of a live business.”
10. Prefer **one** discovery path (shortlist v2) + replay improvement loop; no new parallel proof tracks without L2+L3.
11. Innovation watch: Spaceship SellerHub when keys land; any new marketplace API — same pattern as Afternic (notice → CR → wire → retire browser).

---

## 8. External domain-trading lessons (short)

Full citations in critical notes §9. Planning takeaways:

| # | Lesson | Source |
|---|---|---|
| 1 | Year-1 break-even beats most beginners; STR often &lt;1–2% | Bob Hawkes, NamePros Dos/Don’ts — https://www.namepros.com/blog/domain-name-investment-dos-and-donts.1319185/ |
| 2 | Don’t buy a category before proving a thesis; test small | Michael Cyger — https://ggrg.com/interview-michael-cyger/ |
| 3 | Newbie hand-reg junk; study; then auctions/aftermarket | NamePros newbie mistakes — https://www.namepros.com/threads/mistakes-you-made-as-a-newbie.1191007/ |
| 4 | Portfolio bloat lowers STR; cut aggressively; watch non-.com renewals | Elliot Silver — https://domaininvesting.com/be-cautious-of-portfolio-bloat/ |
| 5 | $50/mo tools ≈ 60 .com renewals; simple systems + conscious review beat SaaS illusion | DN.org — https://dn.org/why-simple-systems-beat-complex-tools-for-cost-control/ |
| 6 | Holding costs dominate; design buys for renewals math | NamePros holding costs — https://www.namepros.com/threads/holding-costs-the-silent-portfolio-killer.1376460/ |
| 7 | We already concluded drop-catch speed isn’t our edge — buyer-first is | `company/strategy-edge-research-2026-10-17.md` |

---

## 9. Open items for Dvir (only true strategy / disagreement / capital)

Escalate only these unless DOM’s counter-draft adds more:

1. **Books primacy:** Confirm DOM books as sole live write for BIN/floor/walk-away; company CSV = mirror. (Money-adjacent; needs your yes.)
2. **Named READ tokens:** Create READ tokens for DOM Architect / Challenger / Risk Gate? (Security + bottleneck.)
3. **Sedo Monday:** Drop Sedo from weekly sale-rate entirely, or keep placeholder rows without scrapes?
4. **Edge bet for next 90 days:** Double down on shortlist generic inventory + Afternic inbound, vs revive buyer-first broker test from strategy research (outreach still paused — may need legal unblock first)?
5. **Cleanup inventory:** Approve archive pass on ~267 bak files / stale scout docs (paths may break old routines)?
6. **Anything DOM and Gavriel still disagree on after ping-pong** — we will list explicitly rather than average silently.

**Not for Dvir:** which CR round, AT wording, bak naming, digest formatting, FIXED filter code placement once classified.

---

## 10. Ping-pong ask to DOM Architect

Please counter-draft (or annotate) especially:
- Strengths matrix rows you dispute (e.g. who owns Afternic API sync ops after build).
- Whether books primacy CR should be one CR or fold into CR-070 follow-up.
- 30-day sequence vs your build freeze / CR-080–082 queue.
- Any FIXED item you refuse to migrate (token or complexity reasons).
- Open Dvir items you’d add or remove.

When we converge, we publish **`TEAM-OPS-joint-2026-10-27.md`** (or dated) and Gavriel brings it to Dvir for final approval.

---

*Gavriel draft only — not yet joint, not yet Dvir-approved.*
