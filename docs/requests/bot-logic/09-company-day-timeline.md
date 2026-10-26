# Company-day timeline (after datasave → Dvir yes)

**Status:** draft for mutual-awareness gap (DOM Architect ask, 2026-10-27). Requests-only until a CR places it under `docs/bot-logic/`.  
**Rule for this file:** cite existing docs / memory only. Clock times not stated in those sources → **UNKNOWN**. Times below are Asia/Jerusalem (IDT, UTC+2 in late Oct 2026) unless marked UTC.

**Sources (primary):** `docs/requests/DISCOVERY-FLOW-V2-2026-10-27.md`; `docs/bot-logic/00`–`03`; `docs/requests/bot-logic/04-buyer-shortlist-to-card.md`; `docs/internal/{datasave,auctions,buy}.md`; `knowledge/handoffs/data-engineer.md`; `org/org-v2.md`; `company/reorg-org-design-2026-10-17.md` §8; CR-080 / CR-081; memory (Dvir discovery v2; pick-proof pause).

---

## 0. Day spine (one picture)

```
[Mac datasave ~15:05 UTC]
        │  seals GD + Dynadot (when client live) → score → shortlist → portfolioCheck
        ▼
[Morning / lean discovery — wall clock UNKNOWN under v2]
        │  Buyer: GET /health + GET /auctions/shortlist → filters → judgment → cards
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
| CLOSEOUTS | Buyer / Risk | Research-only while `CLOSEOUTS_PAUSED` | — | No money cards from closeouts | DISCOVERY-FLOW-V2; auctions.md |

**Who reads after datasave**
- **Buyer / Gavriel:** next morning discovery uses that day’s shortlist (`data_date`).
- **DOM Architect:** `/health`, datasave status, GAP reasons.
- **Challenger:** not on the datasave critical path (grades later / weekly).

---

## 2. Discovery v2 lean path (Buyer → Risk Gate → Gavriel → Dvir)

| Step | Who | Action | Depends on | Cap / timeout | Sources |
|---|---|---|---|---|---|
| 0a | Buyer (or Gavriel brief) | `GET /health` — note API version | DOM up | — | `04` §0 |
| 0b | Buyer | `GET /auctions/shortlist` newest `data_date`, limit as briefed (default ~25) | Datasave shortlist for that date | ~20 external tool calls per lean run unless Gavriel raises | DISCOVERY-FLOW-V2; `04` §0; buyer-first-plan “~20 calls/day” |
| 0c | Buyer | Optional closeouts research | CLOSEOUTS_PAUSED | Not a buy pool | DISCOVERY-FLOW-V2 |
| 1–5 | Buyer | Hard filters (shape, price, age/extensions, prior kills, live `.com` kill) | Shortlist rows | Free/local first | `04` §1 |
| 6–9 | Buyer | Judgment: meaning, USPTO, firm screen, R-PARENT | Survivors | Prefer cheapest phrases first | `04` |
| 10–11 | Buyer | B-01 warning math; draft card; **send each card to Risk Gate immediately** | Survivors | Zero cards = valid | `04`; buyer alignment ≤5 cards/week to Risk Gate |
| RG | Risk Gate | Independent CLEAR / FLAG / REJECT (+ Opinion) | Buyer card | ≤5 cards/week; ≤25 calls / 80k tokens per card (bot-team); FLAG incomplete at cap | `system/bot-team.md` §7.2; org-v2 |
| Legal path (if doubtful) | Risk Gate (absorbed Legal) | CLEAR / KILL / NEEDS A LAWYER | Doubtful card | **Within 4 hours** and before any deadline; silence = no buy | `knowledge/handoffs/legal.md` §1 |
| Card to Dvir | Gavriel | EU TMview line when required; pre-filled `Yes buy <domain> up to $X`; plain-language card | Risk Gate CLEAR (or CLEAR-with-conditions) | No EU line → card never reaches digest (buy runbook) | `company/runbooks/buy.md`; DISCOVERY-FLOW-V2 |
| Decision | **Dvir** | Verbatim yes / no | Gavriel card | Approval form exact; age rules in buy_guard (48h line / 72h auction approval in auctions.md) | buy.md; auctions.md Flow |
| Execute | Gavriel only | Re-check live price; `buy_guard`; `POST /auctions/plans` → bid → result | Verbatim yes | Money path; dual-runner money actions never dual-performed | buy.md; auctions.md; `00` |

### Wall-clock for “lean buy” / morning discovery

| Claim | Status | Sources |
|---|---|---|
| Exact cron / routine folder name for discovery v2 lean run | **UNKNOWN** | Not named as a live UpdateRoutine in cited docs after v2; Buyer runs on Gavriel brief / lean discovery |
| Historical “Buyer run ~09:00 IDT” / S8 scout 09:00 IDT | Superseded / paper-phase history | `company/alignment/buyer.md`; `system/bot-team.md` S8 note — **not** the v2 shortlist clock |
| Lean budget ~20 calls / day; ≤15 min in buyer-first-plan v1 | Soft budget; 15 min from older buyer-first-plan | `04`; `sourcing/buyer-first-plan.md` §9 |
| Paper-only buys until **2026-11-14** | Still in force unless Dvir lifts | buyer-first-plan STANDARD; org-v2; memory |

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

1. **No Buyer shortlist judgment before that day’s shortlist exists** (or emergency sealed zip path logged).  
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

- Pass: a new bot can see **who reads what after datasave**, the discovery v2 shortlist path, Risk Gate → Gavriel → Dvir, and what is UNKNOWN (lean wall-clock).  
- Fail: inventing a 09:00 routine name for v2; treating paused pick-proof or paused scout routines as live; skipping Risk Gate before Dvir.
