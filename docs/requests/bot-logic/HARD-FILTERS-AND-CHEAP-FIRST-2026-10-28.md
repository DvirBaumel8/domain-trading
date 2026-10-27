# Hard filters + cheap-first process (draft for Dvir)

**Status:** draft — DOM Architect checked Layer A against live 5.71.0 (2026-10-28 ~01:21 IDT). Waiting Dvir lock.  
**Why now:** CR-088 removes artificial size cuts, so filters and order must carry the load.  
**One-line purpose:** Kill junk for free first; spend money/API only on names that already cleared free gates.

---

## Two layers (do not mix)

### Layer A — machine hard filters (DOM, free/offline)
These decide who enters the daily auction **field** (`field_n`, lately ~500–750). No outside calls.

**Band (before filters):** `.com` one label · price ≤ ~$250 · ≥1 bid · ending within ~72h.

**Hard filters (fail = out of field):**
| Code | What |
|---|---|
| OWNED | already in portfolio |
| open/won bid plan | already committed |
| SPELL-1 | bad shape / unexplained parts |
| BRAND-1 | active brand list |
| BIGCO-1 | big-company list |
| TM_KILL | loaded kill terms only (**not** live USPTO) |
| ADULT_TERM / FORBIDDEN_TERM | adult + forbidden stems |
| PERSON_NAME | Census first+last (first name not a common word) |
| BRAND-TYPO-2 | typo/lookalike/combosquat vs top brands |
| no_headroom | suggested max bid ≤ current price |

**CR-088:** store and serve **every** Layer A passer. BRAND-TYPO must run on **every** candidate (no early stop that reintroduces a cut). Endings RDAP + auto-prebid may stay top-slice for *speed* only — must not hide the rest from Buyer.

Yesterday (illustrative): 1,378 in band → SPELL ~529, no_headroom ~103, person ~10, brand typo ~6, BRAND ~6, adult ~1 → **field 732**.

**Not Layer A:** live USPTO, SURBL, live RDAP, firm search, Wayback.

### Layer B — Buyer hard kills (automatic kill — never a buy card)
Free / local first:
1. Shape — easy to spell when heard; two plain words (or one clear dictionary word); not fragment / salad
2. Price band — prefer ≤$5; never above $40 without a written case
3. Prior kills — already declined / rejected / logged kill
4. Meaning (cheap batch) — named paid service; not coinage / inverted junk / pure brand
5. Demand hints already on the row (other endings taken, age, bids) — **no new call**

Needs a call (only after free gates):
6. Live `.com` is a same-name local business → kill (parking OK)
7. Exact live USPTO mark → kill
8. Zero firms selling that exact service phrase → kill

### Layer C — judgment (not automatic kill)
USPTO near-marks, firm count 1–2+, comps, sale-rate warning, sell plan. Shapes the card and Risk Gate; does not silently delete from the review list.

---

## Process order (save resources)

1. Free local across the **full** field: shape → price → prior kills → row demand hints → meaning batch  
2. Cheap reuse: CR-083 evidence cache (survivors only)  
3. Paid / rate-limited: live `.com` → USPTO → firm pages → parent → comps  
4. Every run: **top 5 review report with disadvantages**; **buy cards** only after Risk Gate  
5. Log counts: field → after free → after paid → cards. If budget runs out, log how many were not fully judged — never pretend they don’t exist.

Cap expensive steps by **survivor count**, not by shrinking the DOM field.

---

## Optional tighten (DOM — only if Dvir wants)
- Apply **DIGITS_OR_HYPHEN** on auctions too (already on closeouts).  
- Do **not** add paid checks into Layer A.  
- Do **not** tighten headroom / SPELL further until one full-field Buyer run.

## What is *not* a hard filter
- Auction-v4 score — ranking only  
- “List feels big” — forbidden (Dvir 2026-10-28)  
- Portfolio ~40-name POC cap and ~$250/name — budget rules  

## Open for Dvir
1. Lock Layer A + B as written?  
2. Add DIGITS_OR_HYPHEN on auctions?  
3. Price band (prefer ≤$5 / never >$40) still stands?
