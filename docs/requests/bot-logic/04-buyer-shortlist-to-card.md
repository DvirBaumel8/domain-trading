# Buyer: shortlist → card (current)

**Status:** current SOP (discovery flow v2). Draft for Gavriel / Dvir awareness gap close, 2026-10-27.  
**Owner:** Buyer. **Money:** Buyer never buys, bids, registers, lists, or messages Dvir. Cards go to Risk Gate; Gavriel asks Dvir.  
**Sources:** Dvir via Gavriel discovery v2 (2026-10-27); sourcing-core-2026-10-20 recipe; lessons L-B1..L-B6; r-one §10 v2; ledger B-01/B-02/B-05.

This file is **current-only**. It does not document retired v1–v9 scout lanes, buyer-first-as-source, or local GoDaddy-zip grepping as the normal path.

---

## 0. Pool (before any judgment)

1. `GET /health` — note API version in the run funnel.
2. `GET /auctions/shortlist` with the **newest** `data_date`, `limit` as briefed (default 25). **That response is the only discovery pool.**
**Score vs judgment (2026-10-27 joint):** `auction-v4` on the shortlist ranks **auction attractiveness** only. Meaning, shape, and buyer fit stay with Buyer (+ Challenger). Do not treat a high shortlist score as buyer-ready.

3. Do **not** grep local GoDaddy inventory zips unless the shortlist is **empty** and that day is **sealed**. If you do, log **EMERGENCY** in that day's funnel and tell Gavriel + DOM Architect.
4. Optional `GET /candidates/closeouts` = **research only**. No closeout money cards while `CLOSEOUTS_PAUSED`.
5. Cap ~20 external tool calls per lean run unless Gavriel raises it. Prefer cheapest / best service phrases first.

Held names (resumedesign.com and the prior USPTO-clean hold list) stay held until Gavriel reopens, **unless** one appears on the shortlist with a fresh shortlist reason — then re-screen **only** via this shortlist path.

---

## 1. Step order after shortlist

Apply in this order. Stop early on a hard fail. Do not spend firm-page or history budget on names that already fail a free/local step.

| # | Step | Kind | Pass means |
|---|---|---|---|
| 1 | Shape | Hard filter | `.com` only; letters; two plain words (or one clear dictionary word if brief allows); easy to spell when heard; not a fragment/salad. |
| 2 | Price | Hard filter | Prefer ≤$5 (B-05). Never above $40 without a clear, written case. Prefer lowest current bid / buy price on the shortlist first. |
| 3 | Age / extensions | Hard filter | Prefer aged (≈5+ years). Same string on **2+ other extensions** (shortlist / GD fields `exactMatchTlds` / `developedTlds` when present; else DoH/RDAP over HTTPS — never box DNS). |
| 4 | Prior kills | Hard filter | Drop anything already killed, declined, or rejected in `paper-log.md` / prior run folders (and held names unless shortlist reopens them). |
| 5 | Live `.com` probe | Hard filter | If the `.com` itself hosts a live same-name local business, **kill** (value rests on one firm / local-business match). Parking landers are OK. |
| 6 | Meaning batch | Judgment | In cheap batches, classify as a sold service / category phrase vs brand, geo+generic, inverted phrase, or coinage. Keep only names that could be a **named paid service**. |
| 7 | USPTO | Judgment → hard on kill | Exact / joined / plural forms. One OR query + a known live control mark (e.g. ISLAND BABY). **Live exact mark = KILL.** Near-marks = FLAG for Risk Gate (Buyer does not settle containment). |
| 8 | Firm screen (§10 v2) | Screen + judgment | Need **fetchable** pages with the **exact phrase** as a service line. Save HTML under `evidence/`. Count unrelated operators (different owners). See Tier A / firm rules below. |
| 9 | R-PARENT | Judgment | Parent/owner URLs or legal names for counted firms when writing a card. Shared parent → recount as one. |
| 10 | Comps / P2 / B-01 | Warning math | Rule 3b P2 (length/age band) × planning sale rate; never quote P2 alone. True 3-year cost = price + GoDaddy first-year renewal (live ~$22.99) + 2×$11.81. B-01 ≤1%/yr is a **WARNING label**, not a reject (Dvir 2026-10-22). |
| 11 | Card + Risk Gate | Output | Full card (cost, demand evidence + sources, comps, strongest reason not to buy, risk checks table, sell plan, budget left). List USPTO, EU TMview, history, RDAP, comps, §10 as **DONE** or **OPEN**. Send **each** drafted card to Risk Gate **immediately**. Unknown ≠ 0. Failed fetch = **ERROR**, never 0. |

EU TMview / UK IPO / Common Crawl history often stay OPEN at first submit; close them when Risk Gate asks before CLEAR. Wayback is off. Common Crawl only via `system/tools/cc_cdx.py`.


### CR-083 evidence cache (standing, Gavriel 2026-10-27)

After shape/price/prior-kills/live-`.com`/meaning (steps 1–6), **only then** call `GET /data/card-evidence` for names that will USPTO or firm-screen. Do **not** evidence-GET names you will kill for coinage, fragment, salad, or nonsense. POST new `uspto_check` / `firm_screen` rows after those checks. Count CR-083 GETs/POSTs inside the ~20-call lean budget. Closeouts stay research-only while `CLOSEOUTS_PAUSED`.

---

## 2. Hard filters vs judgment

### Hard filters (automatic kill — do not card)

- Not `.com`; brand, product name, brand typo, or code name.
- Match to a **local business** on the `.com` itself, or value that depends on **one** existing company with no other plausible buyers.
- Price above $40 without a clear case; above preferred band when the brief says lean/cheap.
- Already declined by Dvir / rejected by Gavriel / logged kill (don't resubmit).
- Zero firms selling the named service (§10: 0 = hard reject).
- Live **exact** USPTO kill (Buyer); EU/UK exact kills once confirmed.

### Tier A (buyer-strength signal — judgment, not a solo buy reason)

- **Classic Tier A:** a live unrelated business using the **exact** name on `.net` / `.org` (or funded `.ai`/`.io` upgrade case when that variant is in force). Affordability judged from the page (staff, pricing, funding) — not a hard score.
- Tier A is **evidence**, not a pass by itself. A single same-name firm is never enough (R-ONE / TN-1). Card must still clear firm screen / unrelated demand and hard filters.
- Missing live `.net`/`.org` is **not** a full blocker (Dvir Oct 16): treat as extra evidence only; v10-style / model rank tags do not override judgment.

### Firm screen (§10 v2) — screen only

- **0** firms with exact phrase on a fetched page → hard reject.
- **1** → FLAG; check it isn't the registrant / sole buyer.
- **2+** → pass the *screen*; judge demand on other evidence (comps, exact-match sale, keyword/volume if trusted, Tier A). Count never raises BIN or confidence by itself.
- Every counted firm: URL + quoted service line + saved page. Unrelated = different operators (R-PARENT when carding).

### USPTO — judgment with hard kill edge

- Run on the short top-N only (after shape/price/extensions/meaning).
- Exact live mark → kill. Near-mark → FLAG on the card; Risk Gate declares classes / containment.
- Always run a control query so a broken API isn't mistaken for "clear".

---

## 3. Walkaway and B-01 warning

### Walkaway (stop the name; no card)

Walk away when any hard filter fails, when firm screen is 0, when USPTO exact-kills, when the only demand is one local/same-name firm, when price needs an unrealistic sale rate with no offsetting evidence, or when OPEN checks required by Risk Gate cannot be closed before auction end and the brief does not allow a conditional card.

Log every screened name in `sourcing/buyer-first/paper-log.md` with price and verdict. Empty survivor days are fine ("none survived" + one-line reason to Gavriel).

### B-01 warning (still may card)

- Planning sale rate = ledger **B-01** (≤1%/yr). Show 2% only as a **labelled optimistic** case (L-B1).
- True 3-year cost with GoDaddy first-year renewal often sits **above** 1%/yr break-even (e.g. $1 + $22.99 + 2×$11.81 = $47.61 → ~1.33%/yr). That is a **WARNING on the card**, not an automatic reject (Dvir 2026-10-22).
- BIN from B-02 (e.g. Afternic $1,488); P2 × rate is expected value only — never quote P2 alone.
- Budget context on every card: spent vs $1,500 POC cap and names owned. Buyer still never spends.

### After Risk Gate

- CLEAR / CLEAR-with-conditions → Gavriel formats for Dvir. Buyer does not bid.
- FLAG / need-more → close OPEN items, update the card, re-ping Risk Gate.
- REJECT / Dvir decline / Gavriel reject → status line on the card + paper-log; do not resubmit unless Gavriel reopens.

---

## 4. Auth and reporting (non-money)

- DOM: token from `~/.config/grok-bots/bots.token`; header `X-Bot-Name: Buyer`; proxy `https://domain-trading-api-proxy.dvirbaumel9.workers.dev` with `Authorization: Bearer`. Never print the secret.
- Dynadot connector: read-only; auctions blocked until API access. Closeouts research-only while paused.
- Every answer file / card: model + prompt version at top.
- Report to Gavriel each run: shortlist count + `data_date`, how many judged, cards sent to Risk Gate (or none survived + reason), call count, blockers.

---

## Pass / fail for this doc

- Pass: a new Buyer run can follow only this file + ledger IDs + `lessons/buyer.md` standing lessons without reading retired scout recipes.
- Fail: inventing a parallel pool from local zips, treating B-01 as a hard reject again, or buying/bidding.
