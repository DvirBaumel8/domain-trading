---
id: BUG-058
kind: BUG
status: approved
owner_bot: dom-architect
approval: "none-needed (parser read window too small vs live Afternic HTML; no money / no listing change)"
priority: P1
depends_on: [BUG-054, BUG-056]
supersedes: []
max_rounds: 2
repro_test: "Given live Afternic domain HTML (~337KB) where 'Buy it now for $1,488.00' appears after byte 200000 and 'Buy Now price must be below $100,000' appears earlier, When lander price parse runs for plan BIN $1,488 on 5.68.0+, Then shown is $1,488 (or unknown), never $100,000, and LANDER_PRICE_MISMATCH is not raised."
---
> Status: Approved — BUILD NOW (maintenance; body read window)

# BUG-058: LANDER_BODY_BYTES=200k truncates buyer BIN; falls back to $100,000 limit copy

| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot), after 5.68.0 AT-3 / AT-4 live fail |
| Date | 2026-10-27 ~19:10 IDT |
| Type | Bug / maintenance (allowed under freeze) |
| Build | Raise body read window and/or treat limit-copy as non-BIN. Clear stale mismatches on next portfolioCheck. No marketplace writes. |

## Call made / expected / got
- **Call:** `portfolioCheck` lander parse on Afternic HTML for `aievalsconsulting.com` (and siblings) on **5.68.0**.
- **Expected:** buyer-visible Buy Now = plan BIN **$1,488** → no `LANDER_PRICE_MISMATCH` (BUG-054 AT-4 / BUG-056 AT-3).
- **Got:** after daily `run_127e4120-…` (~19:05 IDT): `aievalsconsulting.com` shown **`$100,000.00`**. Simulated: first 200KB of live HTML → `$100,000`; first ≥260KB → `$1,488`.

## Why (verified)
`LANDER_BODY_BYTES = 200_000`. Fresh `www.afternic.com/domain/aievalsconsulting.com` HTML ~337KB; text `Buy it now for $1,488.00` at ~byte 251111 (past the cap). Within the first 200KB the fallback matches `Buy Now price must be below $100,000`. BUG-056's tight "buy it now for" pattern is correct but never sees the real BIN under the cap. Short fixtures still pass.

Roofing / ukcbam: apex is JS→`/lander`; GoDaddy forsale **403** to our UA → `unknown` does not clear stale `$49,999,999` / `$100,000` warns (separate refresh path; fix this BUG first so Afternic HTML names clear).

## Rules
- R-1 Read enough of the lander HTML that buyer-visible `Buy it now for $X` is in the parse window on current Afternic pages (raise `LANDER_BODY_BYTES` to at least **300000**, prefer **512000** unless memory cost forbids).
- R-2 Treat "Buy Now price must be below $…" / "must be below" offer-limit copy as **LIMIT_COPY** (never `shown`), same spirit as BUG-054 offer-ceiling skip.
- R-3 Prefer **unknown** over a false mismatch when Buy Now is not findable in the window.
- R-4 No listing writes / no money.
- R-5 After ship, next successful `portfolioCheck` clears `$100,000` / `$49,999,999` false mismatches when buyer BIN is present in the (larger) body.

## Acceptance tests
- **AT-1 (fixture):** HTML ≥260KB (or padded) with `Buy Now price must be below $100,000` early and `Buy it now for $1,488.00` after byte 200000 → `shown` = $1,488; **no** mismatch.
- **AT-2 (negative):** only limit-copy `$100,000` in window, no Buy it now → **unknown**, not mismatch.
- **AT-3 (live):** after ship on `/health`, one `portfolioCheck` then `GET /report`: `aievalsconsulting.com` must not show `LANDER_PRICE_MISMATCH` with `$100,000` (or `$49,999,999`).

## Out of scope
Price/BIN changes; Sedo; browser automation; money routes; GoDaddy 403 UA handling (optional follow-up).

## Changes
- 2026-10-27 ~19:10 IDT (DOM Architect): filed from live 5.68.0 fail + body-cap simulation (see BUG-056 AT-3 stamp).

## BUILD NOW — Claude Code (Architect kickoff 2026-10-27 ~19:10 IDT)
Gavriel: Dvir does not kick off Claude Code; Architect drives this. **Build immediately.** Max 2 rounds. No money. No browser marketplace UI. Report when live on `/health`. Stamp `## DOM response` in this file + one line in `DOM-TO-GAVRIEL.md`.

Focus: raise `LANDER_BODY_BYTES` and/or LIMIT_COPY for "must be below"; regression fixture with BIN past 200k.
