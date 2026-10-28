# Company-day timeline (after datasave → Dvir yes)

**Status:** discovery cadence **LOCKED** (Dvir via Gavriel, 2026-10-28 ~20:50 IDT) — Option 1. Placed under `docs/bot-logic/` by CR-091 (28 Oct 2026).  
**Rule for this file:** cite existing docs / memory / Dvir locks only. Clock times not stated in those sources → **UNKNOWN**. Times below are Asia/Jerusalem (IDT, UTC+2 in late Oct 2026) unless marked UTC.

**Sources (primary):** `sourcing/buyer-first/2026-10-28-fullfield/DISCOVERY-FLOW-RESEARCH.md` (v3 proposal; cadence/directions locked); `docs/requests/bot-logic/04-buyer-shortlist-to-card.md`; `docs/bot-logic/00`–`03`; `docs/internal/{datasave,auctions,buy}.md`; CR-080 / CR-081 / CR-088; memory (Dvir discovery v3 Option 1; pick-proof pause).

---

## 0. Day spine (one picture)

```
[Mac datasave ~15:05 UTC]
        │  seals GD + Dynadot (when client live) → score → shortlist → portfolioCheck
        ▼
[One full discovery — after shortlist seal for data_date]  ← Option 1 LOCKED
        │  A required (shortlist) + B cheap signal + D closeouts research
        │  C geo parked · Dynadot aftermarket GAP = blocker note only
        │  Buyer → full-stack passers (or top-5-with-cons if zero) → Risk Gate
        │  L&L pack to Dvir every run (mandatory)
        ▼
[Risk Gate]  CLEAR / FLAG / REJECT
        ▼
[Gavriel] formats card + EU line (when required) → asks Dvir
        ▼
[Dvir] verbatim yes / no
        ▼
[Gavriel money path] plans → bid/result  (or stop)
```

Parallel / other tracks (not the buy spine): Sales owned-name sell-chance work; Challenger weekly golden / Sunday why-we-fail; dual-runner **backup** seals if DOM missed; retail sales ingest (CR-082) when batches land.

---

## 1. Night / evening — datasave (DOM primary)

| When | Who | Reads / does | Depends on | Timeout / notes | Sources |
|---|---|---|---|---|---|
| GoDaddy public zips rebuild ~17:40 IDT (~14:40 UTC) | Source (GoDaddy) | New inventory files | — | Overwrites daily; missed day → GAP, no invented backfill | `01-godaddy-dynadot-daily-seal.md`; data-engineer handoff |
| **~15:05 UTC** Mac launchd (`com.domaintrading.datasave`) ≈ **17:05 IDT** | DOM | Full datasave: inventory freeze, Dynadot closeouts/aftermarket (when client built), auctions endingToday → outcomes, `scorePool`, **`auctionShortlist`**, `portfolioCheck` (CR-079), episodes, … | GoDaddy files present; Dynadot keys nonempty for Dynadot half | Per-step budgets in datasave.md (e.g. auctionShortlist 15 min, buildPanel 25 min, whole job soft ~90 min) | `docs/internal/datasave.md`; `01`; CR-080 |
| After seals | Dual-runner lock | Winner writes `docs/locks/<action>-<YYYY-MM-DD>.json`; loser skips | Same Idempotency-Key per day+action | Backup bot: **only if DOM missed**, typically **~19:00 UTC** (CR-080) | `00-dual-runner-lock-rule.md`; CR-080 |
| Dynadot half until client ships | DOM Architect / bots | Bot-upload `POST /snapshots/dynadot` still allowed; stubs may return `not_configured` | Restricted Aftermarkets-Read key on Mac | Do **not** enable registrar `dynadot` for Restricted key | CR-080; memory 2026-10-27 |
| Pick-proof daily seal / labels | — | **Paused** (Dvir yes → CR-081) | — | Archives of Oct 20–26 kept; historical replay replaces pick-proof | CR-081; memory |
| CLOSEOUTS | Buyer / Risk | Research-only while `CLOSEOUTS_PAUSED` | — | No money cards from closeouts | discovery v3; auctions.md |

**Who reads after datasave**
- **Buyer / Gavriel:** **one full discovery after that day’s shortlist seal** (`data_date`) — Option 1 locked; not “next morning only”.
- **DOM Architect:** `/health`, datasave status, GAP reasons.
- **Challenger:** not on the datasave critical path (grades later / weekly).

---

## 2. Discovery v3 — Option 1 locked (Buyer → Risk Gate → Gavriel → Dvir)

**Cadence (Dvir 2026-10-28):** **one full discovery per day after shortlist seal** for that `data_date`. No second evening deep-pass unless Dvir reopens Option 2. Watch alerts (T−24h) and optional `min_hours_to_end` stay **parked** under freeze.

**Directions (every run):**

| Dir | What | Every run? | Money |
|---|---|---|---|
| **A** | Live GD expired auctions via `GET /auctions/shortlist` (CR-088 full hard-filter field) | **Required** | Paper → bid only after Dvir yes |
| **B** | Cheap other-TLD / Exact Match / Developed signal on A survivors (`parts.demand` + ≤20 HTTPS peeks) | **Required (cheap)** | Paper only |
| **C** | Geo city×trade grids | **Parked** | No hand-reg; geo-shape tag inside A OK |
| **D** | `GET /candidates/closeouts` research scan + would-advance count | **Research-only** while `CLOSEOUTS_PAUSED` | No |

**Passers:** only **full-stack** (cheap + USPTO not exact-kill + firm screen §10 + time gate OK + card → Risk Gate not REJECT) go to Dvir. **Top-5-with-cons only if zero** full-stack passers. Cheap survivors are backlog/kills, not Dvir cards.

**L&L:** every run ends with a Dvir-facing L&L summary (Buyer funnel/REVIEW + Gavriel notes + DOM notes when infra mattered + shared AIs). Bot-only L&L is a miss.

| Step | Who | Action | Depends on | Cap / timeout | Sources |
|---|---|---|---|---|---|
| 0a | Buyer (or Gavriel brief) | `GET /health` — note API version | DOM up | — | `04` §0 |
| 0b | Buyer | **A:** `GET /auctions/shortlist` newest `data_date`, paginate `limit`≤500 until `offset ≥ total` | Datasave shortlist for that date | Full field under CR-088; lean ~20 HTTP still soft unless raised | `04`; DISCOVERY-FLOW-RESEARCH; CR-088 |
| 0c | Buyer | **B:** on meaning survivors, use shortlist `exactMatchTlds` / `developedTlds` / endings; ≤20 HTTPS other-TLD peeks | A survivors | No new WRITE / live-biz join under freeze | `04`; DOM §6 answers 2026-10-28 |
| 0d | Buyer | **D:** `GET /candidates/closeouts` — log would-advance + 0–3 paper examples; note PARTIAL seal in blockers if any | CLOSEOUTS_PAUSED | Not a buy pool | `04`; research file §2 D |
| 1–5 | Buyer | Hard filters (shape, price, age/extensions, prior kills, live `.com` kill) | Shortlist rows | Free/local first | `04` §1 |
| 6–9 | Buyer | Judgment: meaning, USPTO, firm screen, R-PARENT | Survivors | Prefer cheapest phrases first; time gate &lt;12h = review-only | `04` |
| 10–11 | Buyer | B-01 warning math; draft card; **send each card to Risk Gate immediately** | Full-stack survivors | Zero cards = valid → top-5-with-cons fallback | `04` |
| RG | Risk Gate | Independent CLEAR / FLAG / REJECT (+ Opinion) | Buyer card | ≤5 cards/week; ≤25 calls / 80k tokens per card (bot-team); FLAG incomplete at cap | `system/bot-team.md` §7.2; org-v2 |
| Legal path (if doubtful) | Risk Gate (absorbed Legal) | CLEAR / KILL / NEEDS A LAWYER | Doubtful card | **Within 4 hours** and before any deadline; silence = no buy | `knowledge/handoffs/legal.md` §1 |
| Card to Dvir | Gavriel | EU TMview line when required; pre-filled `Yes buy <domain> up to $X`; plain-language card | Risk Gate CLEAR (or CLEAR-with-conditions) | No EU line → card never reaches digest (buy runbook) | `company/runbooks/buy.md` |
| L&L to Dvir | Gavriel (+ Buyer / DOM notes) | Fixed skeleton: directions · three field numbers · passers or zero-fallback top-5 · B/D footnotes · blockers · ≤15-line L&L | End of discovery | **Mandatory every run** | DISCOVERY-FLOW-RESEARCH §4 |
| Decision | **Dvir** | Verbatim yes / no | Gavriel card | Approval form exact; age rules in buy_guard (48h line / 72h auction approval in auctions.md) | buy.md; auctions.md Flow |
| Execute | Gavriel only | Re-check live price; `buy_guard`; `POST /auctions/plans` → bid → result | Verbatim yes | Money path; dual-runner money actions never dual-performed | buy.md; auctions.md; `00` |

### Wall-clock for Option 1 discovery

| Claim | Status | Sources |
|---|---|---|
| Start after datasave + `auctionShortlist` seal for `data_date` | **LOCKED** | Dvir Option 1 via Gavriel 2026-10-28; research §3 Option 1 |
| Exact routine folder / cron name | **UNKNOWN** (Buyer runs on Gavriel brief after seal) | No live UpdateRoutine named for discovery in cited docs |
| Historical “Buyer run ~09:00 IDT” / S8 scout 09:00 IDT | Superseded | Not the v3 clock |
| Soft HTTP budget ~20 on thin days; raise when unfinished would stay &gt;0 on full-field days | Soft | `04`; research §7 Q6 open to Dvir |
| Paper-only buys until **2026-11-14** | Still in force unless Dvir lifts | buyer-first-plan STANDARD; org-v2; memory |
| Keyword expose / shape features / watch alerts / min_hours_to_end | **Held** under freeze | DOM §6; Gavriel ack 2026-10-28 |

---

## 3. Same-day / weekly satellites

| Cadence | Who | What | Sources |
|---|---|---|---|
| After any CLEAR + Dvir yes | Sales | List at card BIN on agreed venue when listing approved; ledger from receipt | buy.md after paying; org-v2 |
| Owned-name sell-chance | Sales (+ Challenger critique) | Ranked steps for Dvir | memory Dvir Oct 20 |
| Dual-runner backup seals | Grok / DOM Architect | Only if DOM missed (~19:00 UTC) | CR-080; `00` |
| Sundays | Challenger | “Why we fail” report | reorg-org-design §8 |
| Sundays | Org | Strategy changes only at Sunday review | org-v2 |
| Daily (Challenger) | Challenger | ≤2 challenges to bots; answer ≤2 days | reorg-org-design §8 |
| Weekly | Challenger | Golden-task set (~25) graded fresh | org-v2 |
| Weekly / on demand | Sales (CFO duties) | P&L / renewals advice — recurring routines were **never started** pending improvement rounds | cfo handoff §5 |
| Scout daily routines (geo/drops/rules ~19:00–19:25 IDT) | — | **PAUSED** since 2026-10-20 | knowledge/handoffs/*-scout.md |

---

## 4. Dependencies (must not invert)

1. **No Buyer discovery before that day’s shortlist exists** (or emergency sealed zip path logged). One Option 1 run after seal — do not invent a second full field.  
2. **No Gavriel Dvir card without Risk Gate path** (CLEAR / conditions). Legal silence on doubtful = no buy.  
3. **No money without Dvir’s exact line** + buy_guard.  
4. **No dual write** of the same seal/money action the same day (`00`).  
5. **Judgment stay bot** for Buyer firm/TM meaning, Risk Gate verdict, Sales outreach/price conflict, Challenger grades (`08-judgment-vs-fixed-inventory.md`).

---

## 5. Timeout / staleness cheat sheet (cited only)

| Item | Bound | Source |
|---|---|---|
| Datasave `auctionShortlist` step | 15 min | datasave.md |
| Datasave `buildPanel` | 25 min | datasave.md |
| Datasave soft whole-job | ~90 min | datasave.md |
| Pre-bid check / auction approval age | 72 h | auctions.md |
| Availability check at buy | ≤24 h | buy.md / bot-team |
| Approval line freshness (buy_guard) | 48 h (cited in buy.md) | buy.md |
| Legal doubtful response | 4 h | legal handoff |
| Challenger bot answer | 2 days | reorg-org-design §8 |
| Buyer lean external calls | ~20 / run (unless raised) | `04`; buyer-first-plan |

---

## Pass / fail for this draft

- Pass: a new bot can see **who reads what after datasave**, Option 1 cadence (A+B+D after seal), full-stack passers + L&L to Dvir, Risk Gate → Gavriel → Dvir, and what is UNKNOWN (exact cron name).  
- Fail: inventing a second daily deep-pass without Dvir; treating paused geo/pick-proof/scouts as live; skipping Risk Gate or L&L before Dvir; dumping cheap survivors as “passers”.
