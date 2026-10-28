# Buyer: shortlist → card (current)

**Status:** current SOP (discovery flow **v3**, locked by Dvir via Gavriel 2026-10-28; supersedes v2 of 2026-10-27).  
**Owner:** Buyer. **Money:** Buyer never buys, bids, registers, lists, or messages Dvir. Cards go to Risk Gate; Gavriel asks Dvir.  
**Sources:** Dvir via Gavriel L&L AI3 (2026-10-28 t1067u: same-`data_date` prior kills before meaning; leave run pack complete for DOM commit); Dvir via Gavriel discovery v3 lock (2026-10-28; spec `sourcing/buyer-first/2026-10-28-fullfield/DISCOVERY-FLOW-RESEARCH.md`, cadence Option 1); Dvir via Gavriel discovery v2 (2026-10-27); post-fullfield standing (Gavriel 2026-10-28); sourcing-core-2026-10-20 recipe; lessons L-B1..L-B6; r-one §10 v2; ledger B-01/B-02/B-05.

This file is **current-only**. It does not document retired v1–v9 scout lanes, buyer-first-as-source, or local GoDaddy-zip grepping as the normal path.

**Score vs judgment (Gavriel 2026-10-28):** `auction-v4` ranks **auction attractiveness** only (price headroom, age, endings, bids, lift). Meaning, shape, and buyer-fit judgment stay with **Buyer** (+ Challenger). Do not treat shortlist rank as a service-phrase pass.

---

## 0. Pool (before any judgment) — discovery v3

**Cadence:** **1×/day**, after datasave + `auctionShortlist` seal for the newest `data_date`. Not a second intraday run.

Every run runs directions **A + B + D**. **C** is parked.

1. **Direction A — full auction field (required).** `GET /health` (note API version in the funnel), then `GET /auctions/shortlist` with the **newest** `data_date`. Paginate with `limit` ≤ **500** and `offset` (CR-088: `shortlist_size=0` stores all hard-filter passers). A is the only auction field; do not invent a parallel pool.
2. **Direction B — cheap other-TLD / Exact Match signals (required every run).** On A's **meaning survivors** only: read shortlist `exactMatchTlds` / `developedTlds` when present; otherwise ≤ **20** HTTPS peeks per run (DoH/RDAP/page fetch, never box DNS) on the best survivors. B is a signal layer on survivors — **not** a second full field and not a second LLM pass.
3. **Direction D — closeouts research scan (required every run, no money).** `GET /candidates/closeouts`; log the would-advance count + 0–3 paper examples. **No buy cards** while `CLOSEOUTS_PAUSED`.
4. **Direction C — geo grids: parked.** No city×trade grids. Tagging/killing geo-shaped names inside A (shape/meaning rules) is OK.
5. **Emergency only:** do **not** grep local GoDaddy inventory zips unless the shortlist is **empty** and that day is **sealed**. If you do, log **EMERGENCY** in that day's funnel and tell Gavriel + DOM Architect.
6. Cap ~20 external tool calls per lean run unless Gavriel raises it (B peeks and CR-083 calls count). Prefer cheapest / best service phrases first. Meaning/shape before CR-083 / USPTO / firm spend.

**Three report numbers (every discovery run):** (1) `field_n` stored at shortlist build, (2) GET `total` = live eligible served, (3) judged (+ unfinished). Served < `field_n` is **expected** (ended / prebid-fail left out of serve) — not a silent size cut. Example: 597 served of `field_n` 747 on 2026-10-28.

Held names (resumedesign.com and the prior USPTO-clean hold list) stay held until Gavriel reopens, **unless** one appears on the shortlist with a fresh shortlist reason — then re-screen **only** via this shortlist path.


### 0.0 Same-`data_date` re-runs + run pack (L&L AI3, Dvir via Gavriel 2026-10-28)

Normal cadence is **1×/day** after seal. When a **same-`data_date` re-run** is ordered (e.g. flow lock mid-day, finish OPEN deep work):

1. **Before any meaning LLM:** load that day's prior `kills.csv`, `prior-exclude.txt`, paper-log declines/rejects, holds, and already-escalated cards. Apply them as hard skips. Do **not** re-LLM salad / already-killed names.
2. Prefer finishing **deepable OPEN** firm/USPTO only (+ B/D directions). Never treat review survivors as `prior_exclude` unless they were actually killed/declined/held/escalated.
3. **Leave the run folder complete** under `sourcing/buyer-first/<date>-v3/` (funnel, REVIEW/PASSERS, kills, evidence, cards if any, MERGED-AIs when present) before you exit. **DOM → Claude Code** commits that pack off-box (Buyer does not need to git-push the pack). Seal → complete folder → exit; do not leave a half-written pack.

### 0.1 Passers + report (v3)

- **Full-stack passer** = cheap survivor (shape/price/meaning) + USPTO not exact-kill + firm §10 screen passed + time gate OK + card sent → Risk Gate not REJECT.
- Deliver **all** full-stack passers to Gavriel. If **zero**, send top-5-with-cons labeled **FALLBACK (zero passers)** only. Never send cheap survivors as passers.
- **Report skeleton:** directions run (A/B/D; C parked) · three numbers · passers (or zero-fallback) · B signals · D would-advance (+0–3 examples) · C parked · blockers. Buyer writes funnel + REVIEW/PASSERS files; Gavriel surfaces the L&L pack to Dvir after every run.

---

## 1. Step order after shortlist

Apply in this order. Stop early on a hard fail. Do not spend firm-page or history budget on names that already fail a free/local step.

| # | Step | Kind | Pass means |
|---|---|---|---|
| 1 | Shape | Hard filter | `.com` only; letters; two plain words (or one clear dictionary word if brief allows); easy to spell when heard; not a fragment/salad. |
| 2 | Price | Hard filter | Prefer ≤$5 (B-05). Never above $40 without a clear, written case. Prefer lowest current bid / buy price on the shortlist first. |
| 3 | Age / extensions | Hard filter | Prefer aged (≈5+ years). Same string on **2+ other extensions** (shortlist / GD fields `exactMatchTlds` / `developedTlds` when present; else DoH/RDAP over HTTPS — never box DNS). |
| 4 | Prior kills | Hard filter | Drop anything already killed, declined, or rejected in `paper-log.md` / prior run folders (and held names unless shortlist reopens them). **Same-`data_date` re-runs:** load that day's kill/exclude/hold/escalated lists **before** step 6 meaning LLM (L&L AI3). |
| 5 | Live `.com` probe | Hard filter | If the `.com` itself hosts a live same-name local business, **kill** (value rests on one firm / local-business match). Parking landers are OK. |
| 6 | Meaning batch | Judgment | In cheap batches, classify as a sold service / category phrase vs brand, geo+generic, inverted phrase, or coinage. Keep only names that could be a **named paid service**. |
| 7 | USPTO | Judgment → hard on kill | Exact / joined / plural forms. One OR query + a known live control mark (e.g. ISLAND BABY). **Live exact mark = KILL.** Near-marks = FLAG for Risk Gate (Buyer does not settle containment). |
| 8 | Firm screen (§10 v2) | Screen + judgment | Need **fetchable** pages with the **exact phrase** as a service line. Save HTML under `evidence/`. Count unrelated operators (different owners). See Tier A / firm rules below. |
| 9 | R-PARENT | Judgment | Parent/owner URLs or legal names for counted firms when writing a card. Shared parent → recount as one. |
| 10 | Comps / P2 / B-01 | Warning math | Rule 3b P2 (length/age band) × planning sale rate; never quote P2 alone. True 3-year cost = price + GoDaddy first-year renewal (live ~$22.99) + 2×$11.81. B-01 ≤1%/yr is a **WARNING label**, not a reject (Dvir 2026-10-22). |
| 11 | Card + Risk Gate | Output | Full card (cost, demand evidence + sources, comps, strongest reason not to buy, risk checks table, sell plan, budget left). List USPTO, EU TMview, history, RDAP, comps, §10 as **DONE** or **OPEN**. Send **each** drafted card to Risk Gate **immediately**. Unknown ≠ 0. Failed fetch = **ERROR**, never 0. |

EU TMview / UK IPO / Common Crawl history often stay OPEN at first submit; close them when Risk Gate asks before CLEAR. Wayback is off. Common Crawl only via `system/tools/cc_cdx.py`.


### CR-083 evidence cache (standing, Gavriel 2026-10-27; POST shape 2026-10-28)

After shape/price/prior-kills/live-`.com`/meaning (steps 1–6), **only then** call `GET /data/card-evidence` for names that will USPTO or firm-screen. Do **not** evidence-GET names you will kill for coinage, fragment, salad, or nonsense. POST new `uspto_check` / `firm_screen` rows after those checks. Every POST must send **`Idempotency-Key`** and a JSON body with **`rows: []`** (array of row objects). A 429 then retry-with-key is the known OK path. Count CR-083 GETs/POSTs inside the ~20-call lean budget. Closeouts stay research-only while `CLOSEOUTS_PAUSED`.

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
- **USPTO FLAG** may appear in a top-5 **review** list for transparency. **Never propose firm-screen / Risk Gate paper** for FLAG names (Gavriel 2026-10-28).

### Time gate (<12h) — review only (Gavriel 2026-10-28)

If the auction ends in **under 12 hours** and the firm screen is still **OPEN**, the name is **review-only**. Do **not** offer firm-screen or Risk Gate paper for it (no overnight firm work on names that end tonight). Still log it in the top-N review with cons when useful.

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
- Report to Gavriel each run: directions (A/B/D; C parked) · the **three numbers** (`field_n`, GET `total`/served, judged + unfinished) · `data_date` · B signals · D would-advance · cards sent to Risk Gate (or none / review-only + reason) · call count · blockers (Dynadot aftermarket GAP = note only). Call out time-gate and USPTO-FLAG names as review-only skips, not firm-screen candidates.
- **Passers (locked):** full-stack only — see §0.1. All full-stack passers; top-5-with-cons **only when zero**. Cheap survivors are not Dvir cards.
- **L&L:** Buyer writes funnel + REVIEW/PASSERS; Gavriel surfaces the L&L pack to Dvir **every run**.

---

## Pass / fail for this doc

- Pass: a new Buyer run can follow only this file + ledger IDs + `lessons/buyer.md`: Option 1 after seal, A+B+D, full-stack passers, L&L path.
- Fail: inventing a parallel auction pool from local zips; skipping B/D; treating geo grids as live; dumping cheap survivors as passers; forcing top-5 when passers exist; treating B-01 as a hard reject; buying/bidding.
