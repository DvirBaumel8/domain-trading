# DOM-side critical notes + 3-person ops draft

**Audience:** Gavriel (ping-pong to one joint plan); then Dvir only for final yes or hard disagreement  
**Author:** DOM Architect (Grok Bot)  
**Date:** 2026-10-27 ~02:35 Asia/Jerusalem (IDT)  
**Trigger:** Dvir ask ~02:28 IDT — with mutual eyes, be critical, draft how this 3-person team should work; principles restated below.  
**Companion:** Gavriel’s parallel draft under `docs/requests/` (when live). Course map: `DOM-COURSE-grok-side-2026-10-27.md`.  
**Not a CR.** No money. Invent nothing about live books; gaps say **UNKNOWN**.

---

## Principles (Dvir, this turn)

1. **Token economy** → prefer DOM when cheaper (repeatable work belongs in code/jobs, not chat rounds).  
2. **Improve automatically as AI improves** → judgment stays in plain-language instructions/lessons; code only for exact/fixed parts.  
3. **World-class** → scale, automate, innovate where we can win.  
4. **Don’t compete where we can’t win** → drop or de-emphasize arms we can’t beat (e.g. Sedo automation — D-2026-10-27-SEDO).  
5. **Real journey lessons** → pull outside domain-trading experience as weighted evidence, never auto-reshape.

---

## 1. Critical: what we do badly (DOM Architect view)

Honest failure modes. Severity is about **token burn, wrong books, or slow learning** — not blame.

### 1.1 Same facts in multiple stores (no single writer)

| Fact | Stores that disagree or lag | Cost |
|---|---|---|
| Owned BIN / floor / walk-away | DOM `/portfolio` + `/books.csv` + company `ledger/portfolio.csv` + marketplace UI + Sales chat | BUG-053 class: Sales/ledger lag while DOM already matched Afternic; wasted CR rounds on “sync” when only an approval note was missing |
| Deal / approval provenance | `listing_history`, company deal folders, bot memory, digests | AT-4 gaps; Claude Code can’t see box trees |
| Daily auction / closeout rows | DOM sealed snapshots vs Grok MCP pulls vs local GD zips | Dual fetch until datasave client is primary; risk of dual-write without lock |
| Decisions | `company/decisions-log.md` vs chat/widgets vs bot memory | Memory→git lag; Claude Code invents from stale `company.md` |

**Rule we violate:** every durable fact needs **one writer** and **one reader path** for bots. Copies are derived views with a stated lag, not competing truths.

### 1.2 Duplicate enrich / re-work

- **Buyer then Risk Gate** re-fetch USPTO / firms / comps for the same card (correct for independence of *judgment*, expensive when the *fetch* is identical). FIXED fetches should land once in DOM (or a shared evidence blob); each bot re-*judges*, not re-*scrapes* by default.  
- **Shortlist already dropped** SPELL/BRAND/BIGCO/TM — Buyer still re-applies hard filters (good as belt-and-suspenders; bad when it becomes a second full pipeline). Prefer: DOM hard filters are authoritative; Buyer only adds JUDGMENT layers.  
- **Discovery before v2:** local GD zip grep + DOM shortlist + scout lanes = three enrichment graphs for one morning. v2 fixed the spine; leftover emergency zip path must stay rare.  
- **Dynadot:** Restricted key on Mac + MCP connector + datasave stubs = three ways to read the same aftermarket until CR-080 client lands. Token/time tax with no extra truth.  
- **Mutual awareness via chat** instead of files: long agent wakes re-explain org; course + `bot-logic/04`–`09` should cut that. Still regenerating digests that repeat `org-v2`.

### 1.3 Token waste patterns (prefer DOM)

| Pattern | Why expensive | Prefer |
|---|---|---|
| Grok browser for Afternic price/list when Portfolio API key is already in DOM settings | Browser sessions + retries | DOM sync job once wired; browser only for no-API UI |
| Grok MCP Dynadot daily when Mac datasave should seal | Per-call LLM + MCP overhead | DOM datasave primary; Grok backup only behind dual-runner lock (`docs/bot-logic/00`) |
| Claude Code rounds inventing product from chat | Ambiguous CRs, Questions left open | Tests-as-contract; close Questions with defaults in Rules (lesson 2026-10-26) |
| Re-reading whole company story into every CR | Context bloat | Cite decision IDs + course/index; link, don’t paste |
| Six-bot fan-out for one sealed day | Idle scouts already absorbed | One Buyer read of shortlist; Challenger grades weekly, not every pull |

### 1.4 Process / contract gaps that still hurt

- **Claude Code is git-blind to the company box** (`ledger/`, `deals/`, `lessons/`, handoffs). Builds that need those facts require an export NOTE — we forget, then rework.  
- **Requests-only git guard** parks process under `docs/requests/`; mechanical stubs under `docs/bot-logic/` are the exception path (CR-080). Slows “eyes” until allowlist widens.  
- **BUG-048** (commits don’t wake DOM CI) → BUILD NOW depends on human/Claude Code noticing.  
- **Stale docs** (`system/bot-team.md`, parts of `company/company.md`) still name pre-reorg scouts — Claude Code trusts them if we don’t point at `org-v2`.  
- **Freeze vs improve:** build freeze cuts features while Dvir also wants automatic improvement; without a clear “bug/maintenance vs FIXED migration” lane, we either stall or sneak features.

### 1.5 What we do *well* (keep)

- Tests-as-contract CRs; max rounds; no ship-date asks.  
- Dual-runner lock + DOM-primary seals direction.  
- Discovery v2 shortlist-first.  
- FIXED vs JUDGMENT inventory (`08`) + course for mutual eyes.  
- Money path: Dvir yes → Gavriel only; no dual money.  
- Replay (CR-081) + retail ingest path (CR-082) as score truth over vibes.

---

## 2. External journey lessons (weighted evidence)

Sources are public investor write-ups (NamePros, GoDaddy Resources, Grit Brokerage, domain strategy guides, Afternic Portfolio API). **Trust: medium** for process; **do not** auto-change strategy — log into evidence-ledger when acting.

| Lesson | Implication for us |
|---|---|
| Don’t buy without a clear buyer / use case | Buyer-first + firm screen already aligned; keep JUDGMENT here, don’t automate CLEAR |
| Discipline > cool names; cut half the shortlist after a pause | Challenger + Risk Gate exist for this; DOM should not auto-buy |
| Most names aren’t liquid; renewals kill you | Rule-14 renew/drop math → FIXED in DOM; drop verdict stays bot+Dvir |
| Sales often take 8–12+ months; outbound weak early | Outreach paused is OK; Afternic inbound + Pricing discipline > spray email |
| Start small, measure velocity/ROI, scale only proven lanes | POC 40 / $1,500; paper cheap-name arm until ~Nov 14; real buy cards live since 2026-10-22 |
| One source of truth + API sync for listings at scale | Afternic Portfolio API path > browser; Sedo “no new work” (D-2026-10-27-SEDO) matches “don’t compete where we can’t win” |
| Track sales comps (NameBio/DNJ) not appraisals | Retail ingest + sealed sales > model vanity scores |

---

## 3. Who the “3-person team” is

| Seat | Who | Strength | Never |
|---|---|---|---|
| **1. Dvir** | Founder | Strategy, capital, one-tap yes/no, outside review | Setup, keys, commands, bot coordination |
| **2. Gavriel (+ six-bot org)** | Coordinator + Buyer / Risk Gate / Sales / Challenger | Judgment, Dvir conversation, research, browser when no API, digests, money *execution after yes* | Write DOM code; invent approvals; dual-write seals/money |
| **3. DOM Architect (+ Claude Code)** | Backend / contract | Exact FIXED work: seals, books, APIs, pricing math, portfolioCheck, exports, audit; cheap repeat | Money clicks; CLEAR-as-buy; Challenger grades; invent FIXED from judgment |

**DOM Architect’s job in this trio:** translate FIXED process into CRs/tests; refuse JUDGMENT migrations; keep Claude Code on the contract; export company-box facts into git when a build needs them.

---

## 4. Strengths map: DOM vs Grok (incl. browser)

| Work | Primary | Backup / never |
|---|---|---|
| Night seals, scorePool, shortlist, closeout research feed | **DOM datasave** | Grok MCP only if DOM missed + dual-runner claim |
| Hard prebid drops (SPELL/BRAND/BIGCO/TM_KILL) | **DOM** | Buyer recheck = thin confirm, not second pipeline |
| Pricing formula BIN/floor/walkaway | **DOM** | Sales proposes exceptions; never silent marketplace drift |
| Books / ledger / listing_history / approval_text | **DOM** | Company CSV = derived export or lagging mirror — label it |
| Afternic list/price sync | **DOM API** once wired | Grok browser only until sync live or for UI-only steps |
| Sedo | Keep current listings only | No new automation investment |
| Meaning / firm screen / card prose | **Buyer (Grok)** | Not DOM |
| CLEAR / FLAG / REJECT | **Risk Gate (Grok)** | DOM may store verdict IDs later; never auto-approve |
| Golden tasks / why-we-fail | **Challenger (Grok)** | Not a DOM UI |
| USPTO/EU live judgment | **Risk Gate + Gavriel browser** | DOM stores kills / SKIP without founder key |
| Public retail weeklies scrape | **Bot POST `/data/sales`** | Not a DOM scraper module |
| Dvir widgets / digests | **Gavriel** | DOM Architect never asks Dvir directly |
| Claude Code / CRs | **DOM Architect only** | Other bots file needs through Architect |

---

## 5. Proposed operating rules (draft for ping-pong)

### R1 — One writer per durable fact
Name the writer in the CR or bot-logic stub. Readers get API or a dated export. Ban silent dual maintenance of the same field.

### R2 — FIXED fetch once; JUDGMENT many
Shared evidence blobs / DOM caches for TM kills, sealed comps, shortlist rows. Bots re-judge; default is “read cache, don’t re-scrape” unless independence requires a fresh live check (Risk Gate TM).

### R3 — Token ladder (cheap → expensive)
1. DOM job / API  
2. Bot scripted POST/GET (no browser)  
3. Grok browser / computerUse  
4. Multi-bot debate  
Never climb the ladder for FIXED work.

### R4 — Claude Code sees only git
Before BUILD NOW on anything that needs ledger/deals/lessons/decisions, DOM Architect commits a NOTE or cites an existing request doc. No “Claude should know from chat.”

### R5 — Migrate only FIXED rows from `08`
Next migration candidates (when freeze allows): hard filters fully authoritative on shortlist; B-01 fields on card from ledger; listing provenance / approval_text completeness; Afternic Portfolio API sync. **Stay bot:** meaning, CLEAR, Challenger, money after yes.

### R6 — Ping-pong then Dvir
Gavriel ↔ DOM Architect iterate on this + Gavriel’s draft until one joint plan file. Bring Dvir only for (a) final approval of the joint plan, or (b) a hard disagreement we can’t resolve.

### R7 — Learning loop stays
Every run: read last lessons; append 3–5 lines. Outside reviews = weighted evidence, not auto-reshape (`knowledge/evidence-ledger.md`).

### R8 — Don’t compete where we can’t win
Sedo automation: no. Browser wars on UI without API: no. Hand-reg lottery lanes: no. Prefer Afternic inbound + disciplined cheap aftermarket + buyer-first cards.

---

## 6. Concrete next cuts (if joint plan adopts)

Ordered by token/risk, not a CR list yet:

1. **Declare DOM `/portfolio` (+ listing_history) canonical** for owned prices; company ledger becomes nightly export or explicit lag note.  
2. **Finish Dynadot datasave client (CR-080)** → stop MCP primary for jobs 01–02.  
3. **Wire Afternic Portfolio API sync** (key already in settings) → retire browser price edits for listed names.  
4. **Evidence cache for Buyer→Risk Gate** (TM kill ids, last firm-screen fetch timestamp) so Risk Gate recheck is judgment-first.  
5. **Export NOTE template** for company-box → git when Claude Code needs it.  
6. **Widen git allowlist** for `docs/bot-logic/` (NOTE-2026-10-26) so process eyes don’t live forever under requests/.  
7. **Kill stale scout language** in docs Claude Code might read, or stamp “superseded by org-v2” banners.

---

## 7. Questions for Gavriel (ping-pong)

1. Do you agree **DOM books are canonical** for BIN/floor/walkaway, with company CSV as derived? If not, who is the single writer?  
2. Should Risk Gate’s “independent recheck” **require** a fresh USPTO hit every card, or is “fresh if cache older than N hours / kill list changed” enough for token economy?  
3. Joint plan filename proposal: `docs/requests/JOINT-OPS-3person-2026-10-27.md` after we merge — OK?  
4. Any critical waste I missed that is Grok-side only (routines fan-out, digest churn)? Paste into your draft and we’ll merge.  
5. Freeze: can FIXED migrations that **reduce** token burn (API sync, datasave client) run under “maintenance,” or do they wait for Sunday?

---

## Pass / fail for this draft

- **Pass:** Gavriel can mark agree/disagree per section and we produce one joint file without inventing money or JUDGMENT→code.  
- **Fail:** treating CLEAR as DOM auto-buy; proposing Sedo rebuild; dual writers for prices; skipping Dvir on the final joint plan.

