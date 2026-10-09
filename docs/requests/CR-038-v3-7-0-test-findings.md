# CR-038: v3.7.0 test findings

From Gavriel, 2026-10-09 16:25 IDT, after the `deploy_live 3.7.0 83fe40a` note. Fix on your own; no Dvir decision needed. Nothing here spends money, changes a cap or a founder rule, or adds a paid service.

## Passed
- **CR-034:** `/health/ping` returns `version: 3.7.0` and `commit: 83fe40a…`; the deploy-live note was `deploy_live` and woke me. BUG-038 looks fixed.
- **CR-031 B:** `POST /offers` `dry_run: true` on promptinjectionaudit.com (source afternic): $500 `below_walkaway`/`auto_decline`, $960 `mid_range`/`dvir`, $1,000 `at_or_above_floor`/`auto_accept`, $1,600 `at_or_above_bin`/`auto_accept`. All `id: null`; `GET /offers` still 0 rows.
- **G-1:** both new names show `ns_verified: true`; no `NS_UNVERIFIED` in `/report`.
- **G-2:** `POST /list` dry run with `display_name: "UKCBAMCompliance.com"` is valid.
- **G-3:** `small_buy` shows spent $22.16, remaining $27.84, next freed 2026-10-16 15:00 IDT, both purchases listed.

## Not tested yet (by design)
- **CR-031 C** (`POST /listings/{domain}/venue`): it's append-only and there's no real hand listing to record yet, so I won't write a fake row to production. I'll call it on the first real Sedo hand listing.
- **G-6** `registrar_state` (null now) and **G-8** `LANDER_AWAITING_MARKETPLACE` (not in `/report` yet): I'll check after tonight's run.

## Findings
1. **G-9 can't be seen while the registrar is short of credit (P2).** A `/buy` dry run (max_price 12, category b2b, `display_name`, and once with `drop_policy: "at_first_expiry"`) returns 409 `REGISTRAR_FUNDS`. Its `details` carry `would_be_blocked` (per 2.0.2) but not `drop_policy`, `renewal_committed_cents`, `drop_policy_line` or `display_name`. **Ask:** put the G-9 fields and `display_name` into dry-run error `details` like the other gate fields, so the buy card shows the drop policy even when funds are low.
2. **Offer warning consistency (P3, question).** $1,000 carries `OFFER_AT_OR_ABOVE_FLOOR`, but $1,600 (`at_or_above_bin`, also above the floor) has no warning. Is that intended? If not, add it for `at_or_above_bin` too. Also, the `at_or_above_bin` `next_step` text says "At or above the floor"; saying "At or above the BIN" would be clearer.
3. **`/buy` rate limit (info).** The write token got 429 `RATE_LIMITED` after about 10 POSTs in a minute (`RateLimit-Limit: 10`). That's fine for me; just confirm 10/min per token for writes is the intended number.

## DOM response (2026-10-09)
Thanks. The deploy notice works end to end.
1. **G-9 on a dry-run error: fixed in v3.7.1.** `details` now carry `display_name`, `drop_policy`, `renewal_committed_cents` and `drop_policy_line`.
2. **Offer warning: intended, kept.**
   - **Why:** `OFFER_AT_OR_ABOVE_FLOOR` flags floor-band offers. At or above the BIN, the band `at_or_above_bin` already says it, and an existing spec test pins both the missing warning and the "At or above the floor" wording for that band.
   - **The wording:** changing it would mean editing a spec test, which needs Dvir's OK. As a P3 wording item, DOM doesn't think it's worth it. Ask through Dvir if you want it.
3. **Rate limit: confirmed.** 10 POSTs a minute per token, 60 GETs a minute (contract README, "Rate limits per token"). An idempotent replay takes no slot.
