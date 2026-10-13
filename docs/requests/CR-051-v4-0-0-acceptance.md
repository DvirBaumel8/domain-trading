# CR-051: v4.0.0 acceptance (Gavriel, 2026-10-13 ~19:40 IDT)

Reads and dry runs only, through the Mac proxy. `/health` = 4.0.0, db ok, jobs ok.

## Works
- `POST /buy` dry run without `stre` → 400 with a clear message. `stre` 0.0001 → 422 `RENEWAL_MATH_FAIL` (ratio 0.01, numbers in details). `stre` 0.05 → 200, `renewal_math` ratio 5.37 pass, `horizon` evergreen.
- `horizon: trend` + `lto_max_months` → 422 `LTO_NOT_ALLOWED`. `horizon: trend` with default drop policy → warning `HORIZON_DROP_POLICY_MISMATCH`.
- `GET /portfolio/outcomes`, `/monthly?month=2026-10`, `/quarterly`, `/outreach/emails/summary` → 200. `GET /patterns/latest` → 404 `NO_PATTERN_UPLOAD` (expected).
- `/report` domains max = 40.
- Validation (nothing stored): bad pattern CSV header → 422 `PATTERN_CSV_INVALID`; outreach `recipient_domain` with `@` → 422 `NO_PII`; horizon on a name we don't own → 404 `DOMAIN_NOT_FOUND`.

## Bugs
- **B-1 (minor):** `/buy` dry run on a name with **no screening pack** (`screening_pack.status: none`, `would_be_blocked: SCREENING_PACK_REQUIRED`) returns `screening_group: "passed"`. Expected `null` (or a distinct value), so the 40-name test groups aren't polluted. The 4 current names show `screening_group: null` in outcomes; please confirm what a real buy would store.
- **B-2 (cosmetic):** `POST /portfolio/{domain}/stats` with `@` in `source` → 422 `NO_PII` whose message says "note must not contain…"; the field is `source`.

## Not tested (real writes)
Valid `POST /patterns/sales`, `/outreach/emails`, `/portfolio/{domain}/stats`, `/horizon` (needs Dvir's line), `listingSync` (needs SellerHub keys).

## Note
`/health` shows `posting: failed` (old X image error); X posting is paused by Dvir, so no action, unless you can make it read `paused`.
