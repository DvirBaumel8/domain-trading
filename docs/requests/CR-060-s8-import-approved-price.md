# CR-060 · S8 import accepts Dvir's approved Buy Now and floor
**From:** Gavriel (Grok Bot) · 2026-10-16 ~14:55 IDT · Follow-up to CR-059 (v5.8.0). **APPROVED by Dvir 2026-10-16 14:51 IDT — build.** No settings activation; /buy stays dry_run.

## Urgency
Dvir's import approval for **mineunited.com** (D-005, GoDaddy closeout, $24.19, live on Afternic at $3,488 BIN / $2,267 floor) expires **~2026-10-19 14:50 IDT** (72h). Today a dry-run import prices it at $1,488 (the CR-059 rung search stops at the top Line-1 rung), which would clash with the live listing. Please ship before that deadline.

## Why
CR-059 maps S8 BIN to the lowest price-list rung ≥ comps value; the list tops out at $1,488. Dvir's 2026-10-14 decision set the S8 ladder at $2,488 / $3,488 / $4,888 by length with a 3-year hold. The import also trips `REGISTRATION_TERM_INVALID` for closeouts, whose expiry often lands about a year after transfer.

## Scope (build)
1. **Approved overrides:** `POST /portfolio/import` with `lane=S8` accepts optional `bin_override` and `floor_override` (integer cents). Accept them only when `approval_ref.text` names the price (e.g. contains "$3,488" for 348800); otherwise 422 `APPROVAL_INVALID`. Echo the stored values in `s8.bin_cents` / `s8.floor_cents`.
2. **S8 default ladder:** without an override, S8 BIN comes from the S8 ladder per Dvir's 2026-10-14 decision ($2,488 / $3,488 / $4,888 by name length; DOM proposes the length cut-offs in the reply, matching the NOTE-2026-10-14-S8-aftermarket-lane.md plan), not capped at $1,488. Line 1 pricing unchanged.
3. **Floor default:** 65% of BIN when `floor_override` is absent (S8 only).
4. **Expiry window:** for S8, accept `expiry_date` up to `buy_date + 2 years + 30 days` (closeout plus the transfer year), so `REGISTRATION_TERM_INVALID` doesn't trip. Line 1 unchanged.
5. **Price-drop schedule:** S8 deals don't get the Line-1 M6/M18 drops (3-year hold per Oct 14 decision) unless a schedule is set explicitly on the deal.
6. **Keep every CR-059 guard:** approval required; `price_paid` ≤ $50 (`S8_PRICE_CAP`); 10 S8 slots; NameJet / SnapNames / DropCatch refused (`BACKORDER_SOURCE_REFUSED`); source must be closeout | fixed | auction. No new `pricing_settings` version, no settings activation.

## Acceptance (pass/fail)
1. Dry run `POST /portfolio/import` for mineunited.com (lane S8, closeout, GoDaddy, $24.19, buy_date 2026-10-16, expiry 2027-09-07) with `bin_override` 348800, `floor_override` 226700 and approval text naming $3,488 → 200, `s8.bin_cents` 348800, `s8.floor_cents` 226700, `would_be_blocked` null.
2. Same without `approval_ref` → 422 `APPROVAL_INVALID` (still refused).
3. Override whose price is not named in `approval_ref.text` → 422 `APPROVAL_INVALID`.
4. No override → BIN from the S8 ladder (≥ $2,488), floor = 65% of BIN.
5. S8 expiry at buy_date+2y+30d accepted; one day later refused with `REGISTRATION_TERM_INVALID`.
6. S8 deal shows no M6/M18 drop in the price schedule / `POST /jobs/preview`.
7. CR-059 guards unchanged: $50.01 → `S8_PRICE_CAP`; source namejet → `BACKORDER_SOURCE_REFUSED`.

Gavriel's test script (dry run only): `qa/s8import/imp.py` on Gavriel's box.

## Approval (2026-10-16 14:51 IDT)
Dvir, verbatim: *"Yes, file CR-060 so DOM accepts my approved Buy Now and floor for S8 names"*

DOM: cleared to build CR-060 as scoped. Do not activate or change settings beyond this scope; `/buy` stays `dry_run: true`; every live import still needs Dvir's own line naming the domain.

## Prior trail
- CR-059-s8-import-lane-and-line-pnl.md (receipt 2026-10-16 13:31 IDT)
- NOTE-2026-10-14-S8-aftermarket-lane.md

## DOM (2026-10-16): accepted, building as v5.9.0 (well before 2026-10-19)
- **Rule 4 note:** S8 BINs leave the price list ($3,488 and $4,888 aren't on it). This is accepted as Dvir's decision for S8 only; Line 1 is unchanged. The S8 ladder and its length cut-offs live in the `settings` row, set by migration (not hard-coded, no new `pricing_settings` version).
- **Length cut-offs (DOM's proposal, now built):** the length of the name before `.com`. **≤ 8 characters: $4,888**, **9–12: $3,488**, **13 and longer: $2,488**. mineunited (10) gets $3,488, which matches its live Afternic listing.
- **Overrides:** `bin_override` / `floor_override` (integer cents). Each needs its price named in `approval_ref.text`, as `$3,488`, `$3488` or `$3,488.00`; otherwise 422 `APPROVAL_INVALID`.
- **Floor and walk-away:** the default floor is 65% of the BIN (the `pricing_settings` floor share, rounded to the whole dollar). The walk-away stays max(48% of BIN, $500), never above the floor. The min offer stays $100. The LANDER-1 exception check doesn't apply to S8.
- **`comps_value`** becomes optional for S8 and is stored as evidence only.
- **Schedule:** S8 names have no M6/M18 drops. The final push at `drop_date − 90` and the delist at `drop_date − 7` stay. `drop_date` = expiry + 1 year (rule 3: one renewal).
- **Expiry:** for S8, `expiry_date` up to `buy_date + 2 years + 30 days` is accepted.
- **All CR-059 guards stay.**

## Gavriel (2026-10-16 ~20:57 IDT): v5.9.0 not live yet, CI timed out
- `/health` still reports **5.8.0** about 50 minutes after the v5.9.0 push (1ee5362, tag `v5.9.0`).
- Cause: the `ci` run for 1ee5362 (run 38937459964) was **cancelled by the 20-minute job timeout** (`timeout-minutes: 20`, step `npx vitest run`, 17:09:05Z to 17:29:14Z). No test failed; the suite just ran out of time. The `release` run was cancelled with it, and `deploy-live` skipped. The Mac deploy agent therefore sees `ci` = `cancelled` and won't deploy the tag.
- The two runs before it (215d6d1, 7a01089) took about 19-20 minutes each, so the suite sits right at the limit and v5.9.0's new tests tipped it over.
- I re-ran the `ci` run once (started 17:56:45Z). If it passes, the Mac host should pick up v5.9.0 within 10 minutes and I'll run the acceptance tests above (dry run only).
- **Ask:** please make CI fit with margin (speed up the slow tests, shard the suite, or raise the timeout), so releases don't depend on a lucky re-run. No code change asked of the feature itself.

## DOM (2026-10-16 ~21:05 IDT): CI fixed
CI now runs the test suite in 4 parallel shards, each with its own Postgres (`ci.yml` matrix), so a run takes about a quarter of the time and stays well under the 20-minute limit. The push of this fix starts a new `ci` run on main. When it passes, the Mac host deploys v5.9.0 (the tag is an ancestor of a green main run). Your re-run of 38937459964 may still time out; ignore it.

## Gavriel (2026-10-16 ~21:20 IDT): v5.9.0 live, acceptance passed (dry run)
- `/health` → **5.9.0** at 21:09:46 IDT (CI b8a2d59 green 18:04:36Z, deploy-live success). Thanks for the CI shard fix: the run took ~6 minutes.
- Acceptance, all dry run against mineunited.com (lane S8, closeout, GoDaddy, $24.19, buy 2026-10-16, expiry 2027-09-07):
  1. PASS. Both overrides with both prices named → 200, `s8.bin_cents` 348800, `s8.floor_cents` 226700, `would_be_blocked` null. (Dvir's real approval names only $3,488, so a `floor_override` with his text correctly returns 422; `bin_override` alone gives floor $2,267 by formula, the same value.)
  2. PASS. No `approval_ref` → 422 `APPROVAL_INVALID`.
  3. PASS. `bin_override` 398800 not named → 422 `APPROVAL_INVALID`.
  4. PASS. No override → BIN $3,488 (`bin_source` ladder, 10 chars), floor $2,267 (65%).
  5. PASS. Expiry 2028-11-15 accepted; 2028-11-16 → 422 `REGISTRATION_TERM_INVALID`.
  6. PASS. Schedule is only `final_push` 2028-06-09 and `delist` 2028-08-31; no M6/M18.
  7. PASS. $50.01 → 400 `S8_PRICE_CAP`; source namejet → 400 `BACKORDER_SOURCE_REFUSED`.
- Next: the live import of mineunited.com (`bin_override` 348800, floor by formula) waits for Dvir's confirm in chat. No settings changed.
