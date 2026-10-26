# Judgment vs fixed inventory (Buyer / Risk Gate / Sales / Challenger)

**Status:** draft for mutual-awareness gap (DOM Architect ask, 2026-10-27). Requests-only until a CR places it under `docs/bot-logic/`.  
**Rule for this file:** cite existing company docs / memory only. If a step is not clearly fixed or judgment in those sources, tag **UNKNOWN** — do not invent.

**Tag meanings**
- **FIXED → DOM candidate:** exact, repeatable rule or fetch already in DOM (or clearly mechanical for datasave / API). Safe to migrate further into code when a CR says so.
- **JUDGMENT → stay bot:** meaning, evidence quality, CLEAR/FLAG/REJECT, card text, or strategy that must stay in plain-language bot instructions (Dvir Oct 17: judgment stays in instructions; code for fixed work).

**Out of scope here:** full reject/warn code tables (Risk Gate table = separate draft), Buyer shortlist SOP detail (`04-buyer-shortlist-to-card.md`), Sales list+price path detail, Challenger grader packet format.

---

## Buyer

| Major step | Tag | Notes | Sources |
|---|---|---|---|
| Night datasave seals + `scorePool` + `auctionShortlist` | FIXED → DOM | DOM primary for seals/scores/shortlist; bots do not rebuild the pool | `docs/requests/DISCOVERY-FLOW-V2-2026-10-27.md`; `docs/bot-logic/01-*.md`; `docs/internal/auctions.md` Shortlist |
| `GET /auctions/shortlist` as only discovery pool | FIXED → DOM | Empty shortlist + sealed day → local zip = emergency only | DISCOVERY-FLOW-V2; `04-buyer-shortlist-to-card.md` §0 |
| Closeouts `GET /candidates/closeouts` while `CLOSEOUTS_PAUSED` | FIXED → DOM (research-only) | No money cards | DISCOVERY-FLOW-V2; `docs/internal/auctions.md` rule 4 / CLOSEOUTS_PAUSED |
| Hard filters on shortlist (shape, price band, prior kills, live `.com` local-business kill) | FIXED → DOM candidate (partially already in shortlist/prebid) | Buyer still re-applies before carding; DOM already drops SPELL/BRAND/BIGCO/TM_KILL / typo in shortlist | `04` §1–2; `docs/internal/auctions.md` rules 17–22 |
| Auction score + suggested max bid | FIXED → DOM | Stored on shortlist rows; Buyer may use as input, not invent a parallel score | `docs/internal/auctions.md` rules 18–21 |
| Automatic pre-bid checks (SPELL-1, BRAND-1, …) | FIXED → DOM | Verdict fail drops from served shortlist | `docs/internal/auctions.md` rules 1, 22 |
| Meaning batch (service phrase vs brand/geo/coinage) | JUDGMENT → stay bot | Cheap batches; keep only named paid-service phrases | `04` §1 step 6 |
| USPTO exact kill vs near-mark FLAG | JUDGMENT → stay bot (hard edge on exact kill) | Exact live mark = kill; near-mark → Risk Gate | `04` §1 step 7, §2 USPTO |
| Firm screen §10 v2 (0/1/2+ fetched service lines) | JUDGMENT → stay bot (0 = hard reject) | Count is screen only; never raises BIN alone | `04` §2 firm screen; `knowledge/handoffs/legal.md` §10 v2 |
| Tier A / affordability as evidence | JUDGMENT → stay bot | Not a solo buy reason; single same-name firm never enough | `04` §2 Tier A; NOTE buyer-method v9; memory Dvir Oct 14–15 |
| R-PARENT / unrelated operators | JUDGMENT → stay bot | Shared parent → recount as one | `04` §1 step 9; `lessons/shomer.md` R-PARENT |
| Comps / P2 × B-01 planning rate | JUDGMENT → stay bot + FIXED math | B-01 ≤1%/yr = **WARNING**, not reject (Dvir 2026-10-22). Formula inputs FIXED when taken from ledger | `04` §3; memory Dvir 2026-10-22 |
| Walkaway / no card | JUDGMENT → stay bot | Hard-filter fails, 0 firms, exact TM kill, one-firm demand, etc. | `04` §3 |
| Card text + send to Risk Gate | JUDGMENT → stay bot | Buyer never buys/bids | DISCOVERY-FLOW-V2; `04`; `org/org-v2.md` |
| Buy / bid / `POST /auctions/plans` after Dvir yes | FIXED → Gavriel/DOM money path | Not Buyer | `company/runbooks/buy.md`; `docs/internal/auctions.md` Flow |

---

## Risk Gate

| Major step | Tag | Notes | Sources |
|---|---|---|---|
| Weekly card cap (≤5/week) | FIXED → stay bot policy (DOM candidate only if counted in API) | Risk Gate never sends over weekly cap | `org/org-v2.md`; `system/bot-team.md` §7.2 |
| Verdict vocabulary CLEAR / FLAG / REJECT (+ Opinion) | JUDGMENT → stay bot | CLEAR is **not** approval; only Dvir approves | `system/bot-team.md` §7.2; `04` after Risk Gate |
| Hard REJECT catalogue (SPELL-1, BRAND-1, BIGCO-1, TM-1, TN-1, SV-3, COMPS-1, …) | MIXED | List IDs and many automated checks are FIXED in DOM prebid/screening; applying TN-1 / R-ONE / “exact mark in buyers' class” / frame fails is JUDGMENT | `system/bot-team.md` §7.2; `knowledge/handoffs/legal.md` §3; `docs/internal/auctions.md` prebid |
| Independent recheck (never copy Buyer’s numbers) | JUDGMENT → stay bot | Own evidence files / timestamps | `system/bot-team.md` quality bar |
| USPTO re-run all forms + control query | JUDGMENT → stay bot (DOM stores kills) | Never trust card TM line; live kills may load via `/data/tm-kills` | `lessons/shomer.md`; CR-074 note in requests |
| Comp date/price verify vs `sales-graded.csv` / source URL | JUDGMENT → stay bot | False / different-name / stale comps → REJECT when floor fails | `lessons/shomer.md` rounds 4–5; Gavriel T3 ruling (memory 2026-10-20) |
| T3 UnreportedSales comps in window | JUDGMENT → stay bot | Count + FLAG; never HOLD on T3 alone (Gavriel) | memory / journal 2026-10-20 A03 r5 |
| EU / TMview / UK IPO | JUDGMENT → stay bot (+ Gavriel browser) | DOM: EUIPO automated SKIP without founder key | `docs/internal/auctions.md` rule 13; `company/runbooks/buy.md` EU line; legal handoff |
| Doubtful card → Legal / lawyer path | JUDGMENT → stay bot | Absorbed into Risk Gate; silence = no buy; 4 h when Legal path used | `knowledge/handoffs/legal.md` §1 |
| Outreach / draft review | JUDGMENT → stay bot | Outreach **paused** (B-08 / Sales lessons); REJECT pressure, price in email 1, etc. when resumes | `system/bot-team.md`; `lessons/sochen.md` |
| Approve a buy | never | Explicit never | `org/org-v2.md`; bot-team |

**UNKNOWN:** a single authoritative plain-language “reject vs warn vs pass” code table for every Risk Gate code (DOM Architect listed this as still missing). Do not invent one here — see future `05`-style draft.

---

## Sales

| Major step | Tag | Notes | Sources |
|---|---|---|---|
| Hybrid / geo BIN–floor–walkaway formula + price list | FIXED → DOM | Server computes; mismatch → `PRICING_FORMULA_MISMATCH` | `docs/internal/listing-strategy.md`; `docs/internal/list.md`; `docs/internal/buy.md` |
| Afternic/Sedo export CSV shape | FIXED → DOM | Bot/Dvir upload on marketplace UI | `docs/internal/list.md` checklist; memory Dvir Oct 3 weekly bulk CSV |
| Offer band routing (≥ floor auto, mid → Dvir, below walkaway decline) | FIXED → DOM (with per-deal exceptions) | Standing yes / per-deal bands still need Sales care | `docs/internal/listing-strategy.md` offers; `company/company.md` §3; `lessons/sochen.md` |
| Ledger append-only + receipt required | FIXED → stay bot/DOM books | Sales absorbed CFO; no pay/renew | `knowledge/handoffs/cfo.md`; CR-070 |
| Rule 14 renew/drop math | FIXED math → DOM candidate; verdict JUDGMENT | Recommendation only; Dvir decides | `knowledge/handoffs/cfo.md`; rulebook Rule 14 cited there |
| Listing / pricing **proposals** for owned names | JUDGMENT → stay bot | Ranked steps with sources/costs for Dvir yes/no | memory Dvir Oct 20 sell-chance; `org/org-v2.md` Sales |
| Outreach drafts | JUDGMENT → stay bot | Dvir sends; currently **PAUSED** | `lessons/sochen.md`; legal handoff Q1–Q2 |
| Price conflict across sources | JUDGMENT → stay bot | Stop; no bands until Dvir picks (L-S1) | `lessons/sochen.md` golden fixes |
| Change live marketplace price / send outreach | never without Dvir | | `org/org-v2.md` |
| Exact Afternic dashboard click order for a new name | UNKNOWN | Live listing runs are Mac/UI; no complete current SOP cited in this draft set | WHILE-GAVRIEL-AWAY mineunited plan is example only |

---

## Challenger

| Major step | Tag | Notes | Sources |
|---|---|---|---|
| Weekly golden-task set (~25 from real past failures), graded fresh | JUDGMENT → stay bot | No self-grading by the bot that did the work | `org/org-v2.md` |
| Grade pick-proof / seal rulings | JUDGMENT → stay bot | e.g. C1/K1 void days | `docs/requests/CR-073a-*.md`; `pick-proof-seals.md` notes |
| Weekly “why we fail” (Sunday) + ≤2 daily challenges | JUDGMENT → stay bot | Bot answers in ≤2 days → strong/weak/none | `company/reorg-org-design-2026-10-17.md` §8 (Mekatreg); org-v2 |
| Strategy change proposals | JUDGMENT → stay bot | Strategy changes only at Sunday review | `org/org-v2.md` rules |
| Do the work it grades / buy / list / send | never | | `org/org-v2.md` |
| Challenger grading UI inside DOM | UNKNOWN / out of scope | Explicitly not in CR-081 | `docs/requests/CR-081-historical-replay.md` out of scope |

---

## Cross-cutting (all four)

| Item | Tag | Sources |
|---|---|---|
| Money (buy, bid, list price change, renew spend) | FIXED path + Dvir yes; never dual-performed | `docs/bot-logic/00-dual-runner-lock-rule.md`; autonomy rule in `company/company.md` |
| Mechanical seals / portfolioCheck / dual-runner | FIXED → DOM (see `00`–`03`) | `docs/bot-logic/README.md` |
| Buy-card judgment / Challenger critique / three-way Dvir decisions | JUDGMENT → stay bot | CR-080 out of scope; bot-logic README |

---

## Pass / fail for this draft

- Pass: DOM can open this file and tag a step FIXED vs JUDGMENT without inventing rules; uncertain rows say UNKNOWN.
- Fail: treating Buyer firm-screen or Risk Gate CLEAR as something DOM can auto-approve; inventing a full Risk Gate code table here.
