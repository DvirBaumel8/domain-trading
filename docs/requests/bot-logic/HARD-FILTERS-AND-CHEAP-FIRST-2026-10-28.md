# Hard filters + cheap-first process (draft for Dvir)

**Status:** draft — waiting Dvir confirm + DOM Architect check.  
**Why now:** CR-088 removes artificial size cuts, so filters and order must carry the load.  
**One-line purpose:** Kill junk for free first; spend money/API only on names that already cleared free gates.

---

## Two layers (do not mix)

### Layer A — machine hard filters (DOM, free/offline)
These decide who enters the daily auction **field** (the ~500–750 names). No outside calls.

A name must be:
1. `.com`, one label (no hyphens/digits rules as coded)
2. Live GoDaddy auction in our buy band (price ≤ S8 cap ~$250, ≥1 bid, ending within ~72h)
3. Not already owned / not an open or won bid plan
4. Pass name rules: spelling / brand / big-co / TM kill lists (SPELL-1, BRAND-1, BIGCO-1, TM_KILL)
5. Not a brand typo / look-alike / combosquat of a top brand (BRAND-TYPO-2), when the popularity list is on
6. Suggested max bid still above current price (headroom)

**CR-088:** every name that passes Layer A is stored and served. No top-25 cut.

### Layer B — Buyer hard filters (automatic kill — never a buy card)
Applied **after** Layer A, on the full field. Stop on first fail.

Free / local first:
1. Shape — easy to spell when heard; two plain words (or one clear dictionary word); not fragment / salad / nonsense
2. Price band for *this* buy style — prefer ≤$5; never above $40 without a written case
3. Prior kills — already declined, rejected, or logged kill
4. Meaning (cheap batch) — must read as a **named paid service** people buy; not coinage / inverted junk / pure brand

Needs a call (only after free gates):
5. Live `.com` is a same-name local business → kill (parking OK)
6. Exact live USPTO mark → kill
7. Zero firms selling that exact service phrase → kill

### Layer C — judgment (not automatic kill)
USPTO near-marks, firm count 1–2+, comps, sale-rate warning, sell plan. These shape the card and Risk Gate; they do not silently delete the name from the review list.

---

## Process order (save resources)

Run **every** Layer A name through this ladder. Never spend an expensive call on a name already dead.

1. Free local: shape → price band → prior kills → meaning batch  
2. Cheap reuse: CR-083 evidence cache (only for survivors of step 1)  
3. Paid / rate-limited: live `.com` probe → USPTO → firm pages → parent check → comps  
4. Output every run:
   - **Top 5 review report** with disadvantages (always)
   - **Buy cards** only for names that clear Risk Gate (not forced to 5)
5. Log counts: field size → after free filters → after paid filters → cards. Never silently drop unread names — if budget runs out, say how many were not fully judged.

**Batches:** meaning and free filters in batches across hundreds. Indexes / queues / retention = DOM infra (CR-088), not “make the list smaller.”

---

## What is *not* a hard filter
- Auction attractiveness score (auction-v4) — ranking only  
- “List feels big” — forbidden (Dvir 2026-10-28)  
- Portfolio 40-name POC cap and ~$250 S8 cap — budget rules, not discovery cuts  

---

## Open for Dvir
1. Confirm Layer A + B lists (add/remove any kill rule).  
2. Confirm $40 / prefer ≤$5 still stand for auction buys.  
3. Confirm top-5-with-cons report every run (already yes).
