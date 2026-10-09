> Status: open. Sent by Gavriel. Dvir chose this path on 2026-10-09 at 13:53 IDT ("of course with dom"). It changes a buying rule, so it was sent only after his OK.

# CR-030: a Dvir-approved small-buy exception to the buy hold
| Field | Value |
|---|---|
| CR id | CR-030 |
| From | Gavriel (customer), on behalf of Dvir |
| Date | 2026-10-09 IDT |
| Priority | **P1**: Dvir picked ukcbamcompliance.com and aievalsconsulting.com at 13:46 IDT. Both pass screening under v11.3 (tier L, EV +$15.50), but `/buy` can't run while `buy_hold` is on. |
| Based on | Live API v3.4.x: `GET /selection/buy-hold` (steps 1, 3, 5 open; no hold suite frozen or scored), dry-run `/buy` of both names (`would_be_blocked: BUY_HOLD`). No src/ or tests/ read. |

## Why
- **The hold is right for buying at scale, and it stays.** Clearing it needs three frozen, disjoint holdout suites with at least 50 fresh sold names each. Our last fresh test (round 15, TEST15) is used, and fresh sold data comes in slowly (about 800 eligible sales in two years of public reports).
- **What we need meanwhile:** a narrow way for Dvir to buy single, hand-picked names at the normal registration price. It should cost little and be fully logged.

## Ask
- **A. The exception path on `POST /buy`.** A real buy of a held name passes `BUY_HOLD` only when **all** of these hold:
  1. `small_buy_exception: true` is sent (new optional field; default false);
  2. `approval_ref` names the domain (as today) **and** contains the words "small buy". Example: "I approve a small buy of example.com at up to $11.08";
  3. the live quote is **not premium** and the first-year price is at most the registrar's normal .com price under the current pricing settings (`small_buy.max_first_year_cents`, default 1108). Otherwise 409 `SMALL_BUY_PRICE`;
  4. the **full screening pack** gate still applies unchanged: complete, from the latest run, active settings, at most 72 h old. So do the tranche gate, the POC cap and every registrar check;
  5. a **hard weekly cap**: the sum of first-year costs of small-buy purchases in the current 7 days (rolling, IDT) plus this buy must stay at or below `small_buy.weekly_cap_cents` (default **5000**, $50). Otherwise 409 `SMALL_BUY_WEEKLY_CAP` with `{cap_cents, spent_cents, cost_cents, next_allowed_at}`. Pending purchases count.
- **B. Settings.** A new `small_buy` block: `enabled` (default **false**), `max_first_year_cents` (1108), `weekly_cap_cents` (5000). Turning it on, or raising either number, is a settings draft that Dvir activates with his own line, like every other settings change. The draft path must not be able to set `weekly_cap_cents` above 5000 without a release (a hard ceiling in code).
- **C. Logging.**
  - Each small buy is marked `small_buy_exception: true` on the purchase row and its audit row, with the approval text.
  - `/report` gets a `small_buys` section: last 7 days, spent vs cap, and the domains.
  - `GET /selection/buy-hold` keeps showing `buy_hold: true`; this path never clears or edits the hold.
- **D. Dry run.**
  - `dry_run: true` with `small_buy_exception: true` reports `would_be_blocked` as it would be under the exception: `BUY_HOLD` is skipped only when A1–A3 and A5 pass, and the response shows the weekly cap state.
  - `dry_run: "strict"` returns the first refusal as the error.

## Acceptance
1. A held name with a complete pack, `small_buy_exception: true` and a valid "small buy" line naming it: the dry run shows `would_be_blocked: null` and the cap state.
2. The same call without the flag, or without "small buy" in the line → `BUY_HOLD`, as today.
3. An incomplete pack → `SCREENING_PACK_REQUIRED`, even with the flag.
4. A premium quote, or a first-year price above `max_first_year_cents` → `SMALL_BUY_PRICE`.
5. A buy whose cost would push the 7-day sum past $50 → `SMALL_BUY_WEEKLY_CAP`.
6. `small_buy.enabled: false` (the default) → the flag is refused with 409 `SMALL_BUY_DISABLED`.
7. A draft with `weekly_cap_cents` above 5000 → 422 `SETTINGS_INVALID`.
8. The purchase, audit and `/report` show the exception.
9. `buy_hold` stays `true` throughout.

The two names waiting: ukcbamcompliance.com and aievalsconsulting.com.
