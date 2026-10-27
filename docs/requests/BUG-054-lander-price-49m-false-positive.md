---
id: BUG-054
kind: BUG
status: approved
owner_bot: dom-architect
approval: "none-needed (parser false positive vs contract jobs.md lander price; no money / no listing change)"
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
repro_test: "Given HTML (or fixture) that contains both buyer-visible 'Buy it now for $1,488.00' and the Afternic i18n string 'Offer cannot exceed $49,999,999', When lander price parse runs for plan BIN $1,488, Then shown matches $1,488 (or unknown), never $49,999,999, and LANDER_PRICE_MISMATCH is not raised."
---
> Status: Approved — BUILD NOW (maintenance; parser false positive)

# BUG-054: LANDER_PRICE_MISMATCH reads Afternic offer-limit $49,999,999 instead of buyer-visible Buy Now

| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot), from Gavriel browser check ~08:20 IDT |
| Date | 2026-10-27 ~08:25 IDT |
| Type | Bug / maintenance (allowed under freeze) |
| Build | Fix parser; clear stale warnings on next `portfolioCheck`. No marketplace writes. |

## Call made / expected / got
- **Call:** daily `portfolioCheck` lander price parse on `https://<name>/` (contract `docs/contract/jobs.md` §portfolioCheck — amount within 80 characters of "buy now"; script-rendered with no amount → unknown, never mismatch).
- **Expected:** buyer-visible Buy Now = plan BIN → no `LANDER_PRICE_MISMATCH`. Live buyer pages (Gavriel, no login): roofingvoiceagent.com, ukcbamcompliance.com, and afternic.com/domain/aievalsconsulting.com all show **Buy Now $1,488** / Make Offer on; **no $49,999,999**.
- **Got:** `/report` (live 5.65.0, generated ~08:21 IDT) still warns for the three Porkbun→Afternic-NS names:
  - `aievalsconsulting.com` `shown $49,999,999.00` (`shown_cents` 4999999900) vs `expected $1,488.00` (`checked_at` 2026-10-27T02:06:00+02:00)
  - `roofingvoiceagent.com` same shown (`checked_at` 02:06:06+02:00)
  - `ukcbamcompliance.com` same shown (`checked_at` 02:06:17+02:00)

## Why (root cause, verified without browser UI)
Afternic public HTML / i18n bundle includes the string **`Offer cannot exceed $49,999,999`** (`domain.details.offers.error.limit`). The same page also has the buyer line **`Buy it now for $1,488.00`**. The lander price scrape is picking the offer-ceiling placeholder, not the Buy Now amount. Apex `https://<name>/` is often a tiny JS stub that sets `location` to `/lander` (no HTTP redirect); curl sees no price there — the $49M only appears after the Afternic lander/document HTML is in play.

## Rules
- R-1 **Buyer-visible Buy Now only:** parse the amount the buyer is asked to pay for Buy Now / Buy it now (e.g. text like `Buy it now for $1,488` or the primary BIN control). Do **not** treat offer-form max/min error copy, lease examples, or unrelated `$` amounts as `shown`.
- R-2 **Ignore known placeholders:** amounts that only appear in offer-limit / validation strings (including `$49,999,999` / `49999999`) must never become `shown`. Prefer unknown over a false mismatch.
- R-3 **Contract stays:** if no Buy Now amount is findable (script-only / empty after redirects the service already follows), result is **unknown**, not mismatch (`jobs.md`).
- R-4 **No listing writes:** this BUG does not call Afternic push, change prices, or touch Sedo.
- R-5 **Clear on next check:** after the fix, the next successful `portfolioCheck` must clear `LANDER_PRICE_MISMATCH` for these three when buyer-visible BIN matches the plan (or leave unknown — never re-raise on $49,999,999).

## Acceptance tests
- **AT-1 (fixture):** HTML containing both `Buy it now for $1,488.00` and `Offer cannot exceed $49,999,999` with plan BIN $1,488 → parse `shown` = $1,488 (or equivalent cents); **no** `LANDER_PRICE_MISMATCH`.
- **AT-2 (negative):** same fixture with plan BIN $2,488 → `LANDER_PRICE_MISMATCH` with `shown` $1,488 (not $49,999,999).
- **AT-3 (negative):** HTML with only the offer-limit `$49,999,999` and no Buy Now amount → **unknown**, not mismatch.
- **AT-4 (live):** after ship, `GET /report` on 5.65+ with these three listed at BIN $1,488 must **not** show `LANDER_PRICE_MISMATCH` with `shown` $49,999,999 (after one `portfolioCheck` or equivalent). Stamp here when cleared.

## Also look (same thread; answer in DOM response — no money)
1. **aievalsconsulting.com apex → Afternic SSO:** Gavriel’s browser on `https://aievalsconsulting.com` redirected to `sso.afternic.com/?realm=idp&app=www&path=%2Fdomain%2Faievalsconsulting.com` instead of the lander. Listing URL `https://www.afternic.com/domain/aievalsconsulting.com` is fine at $1,488. roofingvoiceagent + ukcbamcompliance apexes land correctly. Compare NS / lander / Afternic API state for aievals vs the other two; say if this is expected, a lander config miss, or needs a follow-up CR. **No browser clicks from Claude Code** (Dvir t973u/t974u — Chrome = Gavriel).
2. **Public LTO button after 5.61/5.62 push:** API readback said lease-to-own button **on** for all five; Gavriel’s public landers showed **no LTO button on the listing body** (only a footer “Lease to Own” link under Sell Your Domains). Confirm whether Afternic’s public lander is supposed to show an LTO CTA when `show_lto` is true, or if API `show_lto` ≠ public button. Do not change listings unless a separate Dvir line says so.

## Out of scope
Price/BIN changes; Sedo; browser automation; activating settings that spend money; re-asking Dvir on §5 Security A.

## Changes
- 2026-10-27 ~08:25 IDT (DOM Architect): filed from Gavriel `GAVRIEL-TO-DOM` ~08:20 + live `/report` evidence + HTML confirmation of `$49,999,999` offer-limit string.
