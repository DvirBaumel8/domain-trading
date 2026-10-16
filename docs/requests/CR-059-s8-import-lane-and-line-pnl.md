# CR-059 · S8 import lane, line tags, caps, and per-line P&L
**From:** Gavriel (Grok Bot) · 2026-10-15 ~01:10 IDT · Follow-up to DRAFT of 2026-10-14 and DOM's early comments. Dvir decided tests 3 and 4 in DOM's chat (recorded 2026-10-15). **APPROVED by Dvir 2026-10-15 01:06 IDT — build.** No settings activation; /buy stays dry_run.

## Why
The company has two lines: Line 1 hand-registration, Line 2 S8 (existing names Dvir buys on GoDaddy/Dynadot websites: closeouts, fixed-price, public auctions). `/buy` only registers unregistered names, so S8 needs an import path, slot and per-name caps, and per-line reporting. Paper phase needs nothing in the service; this CR is for the live test that starts no earlier than 2026-11-13 after 30 days of paper results.

## Scope (build)
1. **Import route** with Dvir's `approval_ref`, lane `S8`, price paid, source (`closeout` | `fixed` | `auction`), and registrar; ledger entry on success.
2. **Line tag:** every deal carries a line (1|2). Lane `S8` = line 2; every other lane = line 1. `/report` shows spend, sales, P&L, committed renewals and names **per line**.
3. **Caps (migration, not API):** ≤10 S8 names (10 of 40 slots reserved; non-S8 buys stop at 30); ≤$50 purchase per S8 name. **No $600 S8 total in the service** (G-86: Gavriel owns that budget).
4. **S8 BIN:** rule 4 unchanged. Caller supplies a comps-based value; the service picks the **lowest price-list rung ≥ that value**. Floor and walk-away rules unchanged. No new `pricing_settings` version.
5. **Founder rule 5:** update CLAUDE.md only with Dvir's confirmed wording (approved, see below).
6. **Refuse** backorder/catch sources: NameJet, SnapNames, DropCatch as source or registrar; import `source` must be closeout, fixed or auction.

## Acceptance (pass/fail)
1. Import an existing name with `approval_ref`, `lane=S8`, price paid, source (`closeout`|`fixed`|`auction`), registrar; refused without `approval_ref`.
2. Every deal carries a line (1|2); `/report` shows spend, sales, P&L, committed renewals and names per line.
3. S8 caps enforced: ≤10 S8 names, ≤$50 purchase per name; Line 1 cannot use the 10 reserved slots. (No service-side $600 S8 total.)
4. S8 BIN is the lowest price-list rung ≥ the comps-based value supplied; floor/walk-away unchanged; rule 4 unchanged.
5. Founder rule 5 updated only with Dvir's confirmed wording.
6. Backorder/catch sources (NameJet, SnapNames, DropCatch) refused.

## Rule 5 wording (approved by Dvir 2026-10-15 01:06 IDT)
*"Never premium names or backorder or catch services (NameJet, SnapNames, DropCatch). Aftermarket buys (closeouts, fixed-price listings, GoDaddy/Dynadot public auctions) only in lane S8, at most $50 per name, each with Dvir's approval."*

## What Dvir's approval line must name
- This CR id (`CR-059`)
- The $50 per-name cap and 10 S8 slots (no $600 total in the service)
- S8 BIN = price-list rung from comps
- The rule 5 wording (or a clear yes to the proposed text above)

## Prior trail
- NOTE-2026-10-14-S8-aftermarket-lane.md
- DRAFT file (superseded by this request): was `CR-059-DRAFT-s8-import-lane-and-line-pnl.md`
- DOM early comments 2026-10-14 14:55 IDT and Dvir answers 2026-10-15 in DOM-TO-GAVRIEL.md / that DRAFT

## Size
One MINOR release, about 1–2 days once approved (DOM estimate). Ready well before the 2026-11-13 live test.

## Approval (2026-10-15 01:06 IDT)
Dvir, verbatim: *"Approved: CR-059 with the $50 per-name cap, 10 S8 slots, S8 Buy Now from the price list via comps, plus the rule 5 wording."*

DOM: cleared to build CR-059 as scoped above, including the CLAUDE.md founder rule 5 update with the approved wording. Do not activate or change any settings beyond the caps migration in scope; `/buy` stays `dry_run: true` and every live buy still needs Dvir's own line.

## Gavriel receipt (2026-10-16 13:31 IDT)

v5.8.0 is live on the Mac host. `GET /health` → version `5.8.0`, db/jobs ok.

Dry-run acceptance (nothing written):
1. `POST /portfolio/import` dry_run closeout/dynadot/$12.50 comps_value 1200 → 200, `s8.bin_cents` 148800 ($1,488), `would_be_blocked` null
2. No `approval_ref` → 422 `APPROVAL_INVALID`
3. `price_paid` 50.01 → 400 `S8_PRICE_CAP`
4. `source` namejet → 400 `BACKORDER_SOURCE_REFUSED`
5. `GET /report` → `lines` length 2 (Line 1: 4 names; Line 2: 0); `per_domain[].line` present

No settings activation; no live import. Ready when Dvir wants an S8 name imported (e.g. mineunited.com) with his `approval_ref`.
