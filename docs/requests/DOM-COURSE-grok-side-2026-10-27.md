# DOM course: eyes on the Grok / bot side

**Audience:** DOM Architect (and Claude Code when building from bot process)  
**Author:** Gavriel (Grok Bot)  
**Date:** 2026-10-27 ~02:15 Asia/Jerusalem (IDT)  
**Why Dvir asked:** he wants DOM to have **eyes on the Grok/bot side** the same way Grok already has eyes on DOM’s GitHub (code, contract, CRs). This is an onboarding course — not a CR and not a migration order.

**Rule for this file:** only what is already written in the company tree or `docs/requests/`. Invent nothing. Gaps say **UNKNOWN**.

**Companion deep SOPs (read after this map):** `docs/requests/bot-logic/04`–`09` (+ `docs/bot-logic/00`–`03` for mechanical stubs already on main). Short TOC: `docs/requests/DOM-COURSE-index.md`.

---

## 0. Why this exists

Gavriel can read DOM’s repo, contract, `/health`, and API. DOM historically saw only thin request files and what bots put in CRs — not the full picture of **who the bots are, what they do each day, which algorithms live in chat/instructions vs code, and what we have already achieved**.

Dvir’s ask (2026-10-27): give DOM a **course** of what we achieved in Grok Bot and what we do with the bots, so awareness is mutual.

Standing rule that already supports this: both sides should know and be able to edit each other’s **process** docs (Oct 26 team rule; see `docs/requests/NOTE-2026-10-26-requests-only-guard-bot-logic.md`). Until the git guard allows bots under `docs/bot-logic/`, new process drafts stay under `docs/requests/` (and `docs/requests/bot-logic/`).

---

## 1. What we’ve achieved so far (Grok-side, verifiable)

Facts below come from `ledger/portfolio.csv`, `org/org-v2.md`, `docs/requests/*`, and recent digests. Do not treat older `company/company.md` “current state” sections as live (they lag).

### 1.1 Portfolio (live books)

Five owned names (`ledger/portfolio.csv` as of 2026-10-27):

| Deal | Domain | Buy date | Cost USD | BIN / floor / walk-away | Status note |
|---|---|---|---|---|---|
| D-001 | promptinjectionaudit.com | 2026-10-04 | 13.73 | 1488 / 967 / 950 | listed |
| D-002 | ukcbamcompliance.com | 2026-10-09 | 11.08 | 1488 / 967 / 715 | listed |
| D-003 | aievalsconsulting.com | 2026-10-09 | 11.08 | 1488 / 967 / 715 | listed |
| D-004 | roofingvoiceagent.com | 2026-10-10 | 11.08 | 1488 / 967 / 715 | listed |
| D-005 | mineunited.com | 2026-10-16 | 24.19 | 2488 / 1617 / 1195 | transferred; BIN accepted to match live Afternic (D-2026-10-27-D005-PRICE) |

- **Spend on those five buys:** about **$71.16** (sum of `cost_usd` in portfolio). POC caps remain **40 names / $1,500** (`org/org-v2.md` rule 4; `company/company.md` §1).
- Deal folders: `deals/D-001-…` through `deals/D-005-…` under the company tree (`/workspace/domain-trading/deals/` on the Grok box).

### 1.2 Org reorg (2026-10-20)

Dvir approved lean **six bots** (decision recorded as D-2026-10-20-REORG in `company/decisions-log.md`; chart in `org/org-v2.md`). Scouts, Scoring Scientist, Legal, CFO, Data Engineer were absorbed via `knowledge/handoffs/*.md` and are not active day-to-day roles.

### 1.3 Discovery v2 (2026-10-27)

Adopted: morning discovery reads DOM **`GET /auctions/shortlist`** (datasave `auctionShortlist`). Local GoDaddy zip grep is emergency-only if shortlist empty and that day is sealed. Closeouts via `GET /candidates/closeouts` are **research-only** while `CLOSEOUTS_PAUSED`. Source: `docs/requests/DISCOVERY-FLOW-V2-2026-10-27.md`.

### 1.4 Recent DOM work bots drove / verified (highlights only)

| Item | What it is | Where |
|---|---|---|
| CR-079 | Daily missing-name / portfolioCheck warn codes (registrar × venues × ledger) | `docs/requests/CR-079-daily-missing-name-check.md` |
| CR-080 | Bot-logic stubs home + dual-runner lock + DOM-primary daily seals | `docs/requests/CR-080-bot-logic-and-dual-runner-locks.md`; live stubs `docs/bot-logic/00`–`03` |
| CR-081 | Historical replay replaces pick-proof (test scoring on archived days) | `docs/requests/CR-081-historical-replay.md` |
| CR-082 | Public retail-sales ingest path into `POST /data/sales` for replay retail labels | `docs/requests/CR-082-retail-sales-ingest.md` |
| Mutual-awareness pack | Buyer / Risk Gate / Sales / Challenger SOPs + FIXED vs JUDGMENT + day timeline | `docs/requests/bot-logic/04`–`09` (commit set around `e8d5420`) |
| Replay signal (20–24 Oct pooled) | Ours vs random on investor-demand label: reached $100 much more often for our picks; ~⅓ of our top picks still finished above our max bid | Gavriel note in `docs/requests/GAVRIEL-TO-DOM.md` (2026-10-27 ~01:35 IDT). Retail label still `no_data` until CR-082 fills sales |

### 1.5 Listing / marketplace direction (as of late Oct 2026)

- **Afternic** is the primary marketplace path; Portfolio API key is in DOM server settings so listing/price changes can stop needing a browser once DOM wires sync (see Gavriel digest in `GAVRIEL-TO-DOM.md` / DOM digest — **no secrets in this course**).
- **Sedo:** automation is weak; recent direction is keep current Sedo listings, **add nothing more**, put effort into Afternic (+ Spaceship SellerHub when keys land). Exact Dvir line wording: see DOM/Gavriel digests — treat “stop investing new work in Sedo” as the working plan unless a later decision overrides.
- **Outreach:** outbound business outreach is Grok-bot work when active; Sales lessons and digests also mark outreach **paused** in places — treat status as **check `lessons/sochen.md` + latest digest** before assuming live sends.
- **Money path unchanged:** every buy / bid / list price change / renew spend needs **Dvir’s own yes**, then **Gavriel** executes (never another bot).

### 1.6 What this is *not* yet

- Not “we are profitable” — sales count in live books is still early-POC (verify via DOM `/report`, not this file).
- Not a claim that bot judgment has moved into DOM code — see §4 and `08-judgment-vs-fixed-inventory.md`.
- **Paper vs live (do not confuse):** Dvir ended the company-wide paper-only period early on **2026-10-22** — **real buy cards are live** now (his yes per buy + $1,500 / 40-name caps still apply; D-005 etc. are real). Separately, **Challenger’s cheap-name / closeout search arm** stays paper-only until **~2026-11-14** (`org/org-v2.md` / buyer-first-plan). Do **not** treat all auctions or Buyer shortlist cards as paper.

---

## 2. Org: who the bots are and what each does

**Authoritative chart:** `org/org-v2.md` (approved 2026-10-20). Older files (`system/bot-team.md`, early `company/company.md`) still name scouts (Tzofeh-*), Shomer, Sochen, Gizbar — those roles were **absorbed**; use org-v2 names for current work.

```
                    Dvir (approves every buy, price, listing, outreach)
                      |
                   Gavriel — coordinator; ONLY bot doing money actions
      ________________|____________________________________
     |            |            |             |             |
   Buyer      Risk Gate      Sales      DOM Architect   Challenger
```

| Bot | Job (one paragraph) | Never | Reports |
|---|---|---|---|
| **Gavriel** | Dvir’s only contact. Coordinates the six, keeps `company/decisions-log.md` / digests, formats buy cards after Risk Gate, runs dual-runner **backup** seals if DOM missed, holds DOM API tokens, executes money **after** Dvir’s verbatim yes. | Grade own work; invent approvals | Dvir |
| **Buyer** | Discovers from DOM shortlist (v2): hard filters + meaning / USPTO / firm screen / Tier A evidence → draft cards → send to Risk Gate. Absorbed Geo / Signals / Rules / Drops scouts + Scoring Scientist (`knowledge/handoffs/*`). | Buy, bid, list; grade own test | Gavriel |
| **Risk Gate** | Independent recheck of every card (TM, BIGCO, history, comps, value, legal/compliance). Verdicts CLEAR / FLAG / REJECT (+ Opinion). CLEAR ≠ approval. Absorbed Legal. Weekly card cap. | Approve a buy; exceed weekly cap | Gavriel |
| **Sales** | List+price proposals, offer routing advice, renew/drop recommendations, ledger/cost hygiene (absorbed CFO). Drafts only for outreach when not paused. | Change live prices or send outreach without Dvir; pay/renew | Gavriel |
| **Challenger** | Independent reviewer. Weekly golden-task grading (~25 from real past failures), money-card checks, pick-proof/replay critique, Sunday “why we fail”. | Do the work it grades; buy/list/send | Dvir + Gavriel |
| **DOM Architect** | **Only** bot that writes CRs / talks to Claude Code for DOM. Data pipelines, pools, labels (absorbed Data Engineer). Tests = contract, max rounds per CR. | Let other bots message Claude Code directly; treat bot judgment as auto-CLEAR | Gavriel / Dvir for product asks |

**Retired / absorbed (not day-to-day):** Geo Scout, Signals Scout, Rules Scout, Drops Scout, Scoring Scientist, Legal, CFO, Data Engineer — handoffs under `knowledge/handoffs/`. Scout daily routines paused since 2026-10-20 (`09` §3).

---

## 3. Day / week flow

Spine (detail: `docs/requests/bot-logic/09-company-day-timeline.md` + `DISCOVERY-FLOW-V2-2026-10-27.md`):

```
[Night Mac datasave ~15:05 UTC]
   seals → scorePool → auctionShortlist → portfolioCheck
        ▼
[Discovery — wall clock under v2 still UNKNOWN]
   Buyer: GET /health + GET /auctions/shortlist → filters → judgment → cards
        ▼
[Risk Gate] CLEAR / FLAG / REJECT
        ▼
[Gavriel] card (+ EU line when required) → Dvir yes/no
        ▼
[Gavriel money] plans / bid / buy / list path  — or stop
```

**Parallel tracks:** Sales owned-name sell-chance + Monday sale-rate snapshots; Challenger weekly golden + Sunday why-we-fail; dual-runner backup seals (~19:00 UTC only if DOM missed); retail ingest (CR-082) when batches land.

**Dependencies that must not invert** (`09` §4): no shortlist judgment before that day’s shortlist (or logged emergency zip); no Dvir card without Risk Gate path; no money without Dvir’s exact line; no dual write of the same seal/money action (`docs/bot-logic/00-dual-runner-lock-rule.md`).

---

## 4. Logic & algorithms (where the deep process lives)

Do **not** paste whole SOPs here — learn the **map**, then open the files.

| Topic | Read first | Notes |
|---|---|---|
| Buyer shortlist → card | `docs/requests/bot-logic/04-buyer-shortlist-to-card.md` | Discovery v2; hard filters vs judgment |
| Risk Gate codes | `docs/requests/bot-logic/05-risk-gate-codes.md` | REJECT / FLAG / CLEAR; AUTO-FAIL vs warn; cheap check order |
| Sales list + price | `docs/requests/bot-logic/06-sales-list-price.md` | After-buy path; BIN ladder; Afternic/Sedo; UNKNOWN UI gaps |
| Challenger grader | `docs/requests/bot-logic/07-challenger-grader.md` | T-GOLDEN, money-check, suites, why-we-fail |
| FIXED vs JUDGMENT | `docs/requests/bot-logic/08-judgment-vs-fixed-inventory.md` | What may migrate to DOM vs must stay bot |
| Day timeline | `docs/requests/bot-logic/09-company-day-timeline.md` | Clocks + dependencies |
| Mechanical dual-runner / seals / portfolioCheck | `docs/bot-logic/00`–`03` | Already on main from CR-080 |
| Org + money caps | `org/org-v2.md` | Six bots; 40 / $1,500 |
| Decision IDs | `company/decisions-log.md` | One source of truth per decision |
| Evidence / change discipline | `knowledge/evidence-ledger.md`, `knowledge/change-rule.md`, `knowledge/system-vs-evidence.md` | Beliefs change only with stronger evidence |
| Handoffs from retired roles | `knowledge/handoffs/*.md` | Duties absorbed by Buyer / Risk Gate / Sales / DOM Architect |
| Rulebook / playbooks | `rules/`, `company/runbooks/`, `sales/` | Prefer citing decision IDs over copying stale numbers |
| Scoring / lanes history | `scoring/`, `lanes/`, `sourcing/`, CRs 054–063, 072–075 | Much is research + DOM engine now; Buyer still owns judgment on cards |
| Challenger / QA suites | `knowledge/test-suite.md`, `challenge/`, `qa/` | Grades stay bot-owned (CR-081 out of scope for Challenger UI) |

### FIXED vs JUDGMENT (summary from `08`)

- **FIXED → DOM candidate / already DOM:** seals, shortlist, hard prebid drops, pricing formula math, portfolioCheck, dual-runner locks, books “ours” provenance rules.
- **JUDGMENT → stay bot:** Buyer meaning / firm screen / card prose; Risk Gate CLEAR/FLAG/REJECT and TM/comp recheck; Sales which BIN rung / Sedo yes-no / counters; **all of Challenger**; every money click after Dvir yes → Gavriel only.
- DOM Architect’s 2026-10-27 classification of `04`–`09` (migrate next vs stay) lives in bot memory / chat digest — treat `08` + that classification as the migration filter, not this course inventing new FIXED rows.

---

## 5. Where truth lives on the Grok side

Two trees matter:

| Tree | What it is | How DOM sees it |
|---|---|---|
| **DOM git repo** (`/workspace/dt` on bots = GitHub `DvirBaumel8/domain-trading`) | Code, contract, `docs/requests/`, `docs/bot-logic/`, `docs/internal/`, deploy | Native — DOM writes here; Gavriel reads/commits requests |
| **Company box tree** (`/workspace/domain-trading/` on the Grok box) | Live ops: `company/`, `ledger/`, `deals/`, `sales/`, `knowledge/`, `org/`, `system/`, `scouts/`, lessons, batches | **Not the same as DOM src.** DOM sees pieces when bots copy facts into CRs, books API, or request docs. Full tree is Grok-box filesystem |

### Grok-side paths (company tree)

| Path | Role |
|---|---|
| `company/` | Mission, decisions-log, story-log, runbooks, research notes |
| `org/org-v2.md` | Current six-bot chart |
| `ledger/` | portfolio, costs, approvals CSV (append-only discipline) |
| `deals/` | Per-deal folders D-001… |
| `sales/` | Offers, listing evidence, sale-rate weekly CSV |
| `knowledge/` | evidence-ledger, change-rule, handoffs, test-suite |
| `rules/`, `lessons/`, `risk/`, `legal/` | Operating rules and bot lessons |
| `docs/requests/` **in DOM repo** | CRs, BUGS, GAVRIEL-TO-DOM, DOM-TO-GAVRIEL, bot-logic drafts, **this course** |

### Things that are *not* in git (or not fully)

| Store | What | Implication for DOM |
|---|---|---|
| **Bot memory / journal** | Profile + journal facts Gavriel recalls | Not a source of truth for code; if it matters, it should land in `decisions-log` or a request doc |
| **Routines** | Scheduled jobs on the Grok Bot host (e.g. Monday sale-rate ~09:00 Asia/Jerusalem) | Concept: recurring bot work outside DOM datasave. Exact routine IDs/folders: cite Sales notes / `09`; do not invent cron names |
| **Chat history** | Dvir widgets, agent-to-agent SendToAgent | Decisions must be copied into `decisions-log.md` or a CR to count |
| **Secrets / tokens** | Registrar, marketplace, DOM API keys | Live in DOM server settings / vault — **never** in course docs or bot commits |

### Contrast: where DOM’s truth lives

Code + `docs/contract/` + API (`/health`, `/report`, `/portfolio`, `/auctions/shortlist`, `/books.csv`, jobs). Gavriel already treats the API as the live books when DOM is up. This course is the missing reverse mirror: **process and org**, not another copy of Postgres.

---

## 6. What DOM should treat as readable “eyes”

**Standing habit for DOM Architect:**

1. Pull / read `docs/requests/` regularly (especially `GAVRIEL-TO-DOM.md`, new CR/BUG/NOTE, `bot-logic/`).
2. Re-read this course + `DOM-COURSE-index.md` when onboarding a new Claude Code session or before migrating process into `src/`.
3. Treat `docs/requests/bot-logic/04`–`09` as the deep process pack; `docs/bot-logic/00`–`03` as mechanical shared stores.
4. When a migration is blocked by a missing bot rule, **ask Gavriel for a file** (or write a NOTE under requests) — do not invent FIXED behavior.
5. Prefer **decision IDs** in `company/decisions-log.md` over paraphrases in chat.
6. Keep writing CRs only from DOM Architect; keep tests as the contract; max rounds as in each CR.

**What “eyes” does *not* mean:** DOM does not need the raw Grok box mounted. It needs durable docs in git under `docs/requests/` (and later `docs/bot-logic/` when the guard allows). Gavriel’s job is to keep exporting process here.

---

## 7. Open gaps / UNKNOWN

Honest list of what still is **not** fully documented for DOM:

1. **Requests-only git guard** — bots still blocked from committing directly under `docs/bot-logic/` / `docs/locks/` except via the CR-080 placement path; NOTE asks to widen the allowlist (`NOTE-2026-10-26-requests-only-guard-bot-logic.md`).
2. **Lean discovery wall-clock** — exact routine name / cron for discovery v2 morning run is **UNKNOWN** (`09` §2).
3. **Marketplace UI click order** beyond CSV export — Afternic/Sedo dashboard steps still partly UNKNOWN (`06`, `08` Sales row).
4. **Challenger grading UI in DOM** — explicitly out of CR-081; stays bot.
5. **Full company tree sync** — `ledger/`, `deals/`, `lessons/`, handoffs are on the Grok box; only slices appear in git/API. No automated “mirror whole `/workspace/domain-trading` into DOM repo” exists.
6. **Stale docs** — `system/bot-team.md` and parts of `company/company.md` still describe pre-reorg scouts; always prefer `org/org-v2.md` + dated decisions.
7. **Sedo long-term** — working plan is de-emphasize; formal decision ID for “no new Sedo work” may still need a clean `decisions-log` row (**UNKNOWN** if already logged under another ID).
8. **Retail replay labels** — CR-082 path approved; ingest completeness and first retail-scored replay day still pending at course time.
9. **Memory → git lag** — some Dvir widgets land in memory/chat before `decisions-log`; DOM should not treat memory as durable.
10. **This course itself** — first cut 2026-10-27; expect revisions when org or discovery clocks firm up.

---

## Pass / fail for this course

- **Pass:** a DOM Architect session can explain who the six bots are, the buy spine, where FIXED vs JUDGMENT is written, and which paths to open next — without inventing rules.
- **Fail:** treating CLEAR as auto-buy; migrating Challenger grades into DOM without a CR; copying secrets; treating `company/company.md` §5 “current state” as live portfolio.

