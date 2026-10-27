---
id: BUG-056
kind: BUG
status: approved
owner_bot: dom-architect
approval: "none-needed (parser false positive vs contract jobs.md lander price; no money / no listing change)"
priority: P1
depends_on: [BUG-054]
supersedes: []
max_rounds: 2
repro_test: "Given live ukcbamcompliance.com lander HTML (or fixture) that shows buyer-visible Buy Now $1,488 and any $100,000 / 100000 amount elsewhere, When lander price parse runs for plan BIN $1,488 on 5.67.0+, Then shown matches $1,488 (or unknown), never $100,000, and LANDER_PRICE_MISMATCH is not raised."
---
> Status: Approved — BUILD NOW (maintenance; parser false positive)

# BUG-056: LANDER_PRICE_MISMATCH shows $100,000 on ukcbamcompliance (not buyer BIN)

| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot), after BUG-054 AT-4 recheck |
| Date | 2026-10-27 ~16:28 IDT |
| Type | Bug / maintenance (allowed under freeze) |
| Build | Fix parser; clear stale warning on next `portfolioCheck`. No marketplace writes. |

## Call made / expected / got
- **Call:** daily `portfolioCheck` lander price parse on `https://ukcbamcompliance.com/` (contract `docs/contract/jobs.md` §portfolioCheck; 5.66.0+ BUG-054 rules).
- **Expected:** buyer-visible Buy Now = plan BIN **$1,488** → no `LANDER_PRICE_MISMATCH` (BUG-054 AT-4).
- **Got:** after WRITE-token daily run `run_8e42f9b5-…` (portfolioCheck done, web ok) on **5.67.0**, `GET /report`:
  - `ukcbamcompliance.com` `LANDER_PRICE_MISMATCH` shown **$100,000.00** (`shown_cents` 10000000) vs expected **$1,488.00**, `checked_at` **2026-10-27T16:21:00+02:00**.
  - This replaced the prior BUG-054 `$49,999,999` warning for this name (that ceiling is no longer shown here). Sibling names aievalsconsulting / roofingvoiceagent still show stale `$49,999,999` @02:06 IDT (tracked on BUG-054 AT-4).

## Why (working hypothesis — confirm in DOM response)
Separate from the Afternic offer-limit `$49,999,999` string. After BUG-054 skips amounts ≥ $10,000,000 and limit-copy, the parser may still take another non-BIN amount (e.g. **$100,000** offer max / example / unrelated copy) when "Buy it now for $1,488" is missed or ordered after. Buyer-visible BIN remains $1,488 (Gavriel earlier browser check on this name). No listing write.

## Rules
- R-1 Same as BUG-054 R-1: buyer-visible Buy Now / Buy it now only.
- R-2 Do not treat offer-form max/min, lease examples, or other non-BIN `$` amounts (including **$100,000**) as `shown`.
- R-3 Prefer **unknown** over a false mismatch when Buy Now is not findable.
- R-4 No listing writes / no money.
- R-5 Clear `LANDER_PRICE_MISMATCH` for ukcbamcompliance when next successful check matches plan BIN (or unknown — never re-raise on $100,000).

## Acceptance tests
- **AT-1 (fixture):** HTML with both `Buy it now for $1,488.00` and a `$100,000` (or `100000`) non-BIN amount nearby → `shown` = $1,488; **no** mismatch.
- **AT-2 (negative):** no Buy Now amount, only `$100,000` → **unknown**, not mismatch.
- **AT-3 (live):** after ship, `GET /report` on 5.67+ must not show ukcbamcompliance `LANDER_PRICE_MISMATCH` with `shown` $100,000 (after one `portfolioCheck`).

## Out of scope
Price/BIN changes; Sedo; browser automation; money routes.

## Changes
- 2026-10-27 ~16:28 IDT (DOM Architect): filed from live `/report` after manual daily portfolioCheck on 5.67.0 (ukcbam checked_at 16:21 IDT).

## BUILD NOW — Claude Code (Architect kickoff 2026-10-27 ~17:35 IDT)
Gavriel: Dvir does not kick off Claude Code; Architect drives this. **Build immediately.** Max 2 rounds. No money. No browser marketplace UI. Report when live on `/health`. Stamp `## DOM response` in this file + one line in `DOM-TO-GAVRIEL.md`.

Focus: Lander parser: never treat $100,000 (or similar non-BIN) as shown; prefer Buy it now / unknown.

## DOM response

**Shipped in v5.68.0** (same commit as BUG-057).

**Root cause:** `shownBuyNowCents()` iterated regex matches in document order. The generic pattern `buy\s*(?:it\s*)?now\s*(?:for|price)?\s*:?\s*(?:US)?$AMOUNT` matched "Buy Now $100,000" (an offer-cap or unrelated copy that appears earlier in the HTML) before "Buy it now for $1,488.00" (the actual buyer-visible BIN). The `usable()` filter correctly rejected $49,999,999 (above PLACEHOLDER_MIN_CENTS) but $100,000 at 10,000,000 cents passed.

**Fix:** added a highest-priority pattern `buy\s+it\s+now\s+for\s+(?:US)?$AMOUNT` (requiring both "it" and "for") that is tried first across the whole page before falling back to the original proximity patterns. Since the Afternic lander specifically says "Buy it now for $X", this pattern captures the buyer-visible BIN regardless of where unrelated amounts appear.

**ATs covered:**
- AT-1 → LP-9: HTML with "Buy it now for $1,488.00" and $100,000 → shown $1,488, no mismatch.
- AT-2 → LP-10: no Buy Now amount, only $100,000 → unknown, not mismatch.
- AT-3 (live): clears at the next `portfolioCheck` run; Architect to verify.

**No money, no marketplace writes, no listing changes.**
