---
id: CR-079
kind: CR
status: approved
owner_bot: dom-architect
approval: "Gavriel 2026-10-26 (Dvir Oct 23 widget yes: build the daily missing-name check now; freeze override for this one item)"
priority: P1
depends_on: [CR-070, CR-076]
supersedes: []
max_rounds: 2
---
# CR-079: daily missing-name check (registrar × venues × ledger)

## Changes
- 2026-10-26 23:35 IDT (round 1, Gavriel's answers): checks fold into `portfolioCheck` (no `ownershipCheck` step; supersedes DOM answer 1); approval trail = sealed/confirmed export containing the name when `approval_text` is absent (unconfirmed/pending/stale export does not count); severities: warn for LISTING_RECORD_MISSING, LISTING_UNAPPROVED, RECEIPT_POINTER_MISSING, registrar-hold vs ledger mismatch; OBSERVED_UNCONFIRMED stays info. Questions replaced by Decisions.

**Approval:** Gavriel relayed Dvir's Oct 23 widget yes — build this now; freeze override for this one item. Build right away, no ship date (README standing rule). Nothing here needs a step from Dvir. No per-step OK lines.

## Why
We can lose a name at the registrar, leave it on hold, or have it show as listed on Afternic/Sedo without a matching sale or listing approval in our books. Today the pieces live in separate jobs and warnings (`registrarCheck`, `portfolioCheck`, `RECEIPT_MISSING`, venue provenance). Gavriel needs one daily check that compares the three sources and raises clear `/report` warnings he alone watches. Prefer a DOM job or report warning over a new bot.

## What already exists (reference, don't rebuild)
- `registrarCheck` → `/report` `DOMAIN_LEFT_ACCOUNT` (name gone from registrar account, no sale recorded).
- `portfolioCheck` registry → `/report` `REGISTRY_MISMATCH` (not registered, other registrar, other expiry, or on hold / pending delete / redemption).
- Purchase reconciler → `RECEIPT_MISSING`, `PURCHASE_UNKNOWN`, `PURCHASE_UNRESOLVED`.
- CR-076 provenance: `listed_venues` = `ours_confirmed` only; `observed_venues` = public sightings; `POST /listings/{domain}/observed` never counts as ours.
- Ledger registration rows already carry `receipt_ref` (e.g. `porkbun:12047825`); `GET /portfolio/{domain}` exposes `purchases` + `ledger`.
- Legal: no scraping Afternic / Sedo / GoDaddy seller pages. Venue truth for this check is **DOM records** (hand venue rows, export confirms, SellerHub sync if configured), not a live marketplace scrape.

## Rules
- R-1 **Daily step:** fold the R-3 checks into the existing `portfolioCheck` step (named warnings on `/report`); **no** separate `ownershipCheck` step (R-SIMPLE). `portfolioCheck`'s summary in `GET /jobs/runs` lists the new codes explicitly (`by_code` with each code from R-3, `alerts_n`). Read-only toward registrars and marketplaces. No money actions, no price/list/delist writes.
- R-2 **Three sources compared every run** (live names = status `owned` | `listed` | `delisted`):
  1. **Registrar hold:** account presence (`registrarCheck` / adapter where `registrar_api` ≠ `none`) plus registry RDAP state from `portfolioCheck` (hold / redemption / pending delete).
  2. **Venue listings:** DOM `ours_confirmed` venues for Afternic and Sedo, plus last confirmed export upload / hand-list timestamps on `GET /portfolio/{domain}.export`. SellerHub rows from `listingSync` count when that key is set. Never scrape Afternic/Sedo.
  3. **Portfolio ledger:** `GET /portfolio` / `GET /books.csv` live rows and the registration ledger row per name.
- R-3 **Alert rules** (raise or keep these `/report` warnings; reuse existing codes where the meaning matches; add the new codes below). Alert consumer is **Gavriel via `GET /report`** (and job summary) — not Dvir, not a new bot.
  - **Missing at registrar / registry:** keep `DOMAIN_LEFT_ACCOUNT` and `REGISTRY_MISMATCH` (including on-hold / redemption / pending-delete). Do not invent a second code for the same fact.
  - **Registrar hold vs ledger mismatch (warn):** registrar/registry shows a hold (clientHold/serverHold/redemption/pending delete) while the ledger shows the name live and not on hold → raised as `REGISTRY_MISMATCH` at warn.
  - **On pricing hold > 30 days:** keep `HOLD_STALE`.
  - **`LISTING_RECORD_MISSING` (new, warn):** status is `listed` but `listed_venues` has neither `afternic` nor `sedo` (no `ours_confirmed` record). Details: `{domain, status, listed_venues}`.
  - **`LISTING_UNAPPROVED` (new, warn):** an `ours_confirmed` Afternic or Sedo venue exists, and there is no matching sale (`sold_at` / sale ledger row) **and** no listing approval trail for that venue (no `listing_history` row with `approval_text`/`approval_at` that covers the list, and no audit / `POST /listings/{domain}/venue` evidence DOM already stores for that venue, and no **sealed/confirmed** Afternic or Sedo export upload that includes the name). An unconfirmed, pending, or stale export upload does **not** count as approval. Hand-seeded CR-076 R-4 rows that pre-date this CR are grandfathered until a one-time migration tags them `approval_source: seed_cr076` (still not `LISTING_UNAPPROVED`). Details: `{domain, venue, listed_by_hand_at?, export_confirmed_at?}`.
  - **`OBSERVED_UNCONFIRMED` (new, info):** `observed_venues` contains a venue that is not in `listed_venues` for a live name (public sighting, ownership of that listing unknown). Details: `{domain, venue}`.
  - **`RECEIPT_POINTER_MISSING` (new, warn):** a live name has no registration ledger row, or that row's `receipt_ref` is null/empty. Placeholder refs that DOM already stored (e.g. `godaddy:none` on an import) **do** count as a pointer for this check (they are present); only blank/absent fails. Keep existing `RECEIPT_MISSING` for open purchases. Details: `{domain, deal_id?}`.
- R-4 **Purchase receipt pointer:** every live name exposes a stable pointer:
  - keep ledger `receipt_ref` as the source of truth;
  - add `receipt_ref` (and `deal_id` when present) to `GET /portfolio` list rows and to `GET /books.csv` (append columns at the end so existing diffs by position keep working);
  - `GET /portfolio/{domain}` already has ledger — leave shape, just ensure the list/books match.
- R-5 **Quiet when clean:** if no R-3 condition fires, the step is `ok` with `alerts_n: 0` and `/report` shows none of the new codes.
- R-6 Money routes, prices, listings, exports and settings activation are untouched. Bots token stays non-money.

## R-STOP-FIRST
| | |
|---|---|
| **Pass marks** | AT-1…AT-7 below all pass in CI and on the live API after `/health` shows the release; `portfolioCheck` job summary lists the new codes in `by_code`; Gavriel can see any firing warning on `GET /report` with no new bot. |
| **Stop condition** | After at most **2 rounds** (this file → one DOM response → one bot clarification → one DOM answer), freeze the thread. Any further gap is a new CR or BUG citing an AT. Style/preference notes do not reopen. |
| **Max rounds** | **2** (`max_rounds: 2`). |

## Acceptance tests (via the API)
- AT-1 Fixture: live name absent from registrar account and not sold → `/report` contains `DOMAIN_LEFT_ACCOUNT` for that domain after the daily `portfolioCheck` path (existing behaviour pinned).
- AT-2 Fixture: registry status `clientHold` or `redemptionPeriod` → `/report` contains `REGISTRY_MISMATCH` with the hold/redemption in `differences` (existing behaviour pinned).
- AT-3 Fixture: status `listed`, `listed_venues` empty → `/report` has `LISTING_RECORD_MISSING`; after an `ours_confirmed` Afternic venue is recorded, the warning clears on the next check.
- AT-4 Fixture: `ours_confirmed` Sedo venue with no sale and no listing approval trail (and not a CR-076 seed) → `/report` has `LISTING_UNAPPROVED` (warn) for `sedo`; grandfathered seed does **not**; a sealed/confirmed Sedo export containing the name clears it; an unconfirmed/pending/stale export does **not**.
- AT-5 (negative) `POST /listings/{domain}/observed` for Afternic on a live name → 201; `listed_venues` unchanged; `/report` may show `OBSERVED_UNCONFIRMED` (info) and must **not** raise `LISTING_UNAPPROVED` or change exports/prices.
- AT-6 Fixture: live name with registration ledger `receipt_ref` blank → `RECEIPT_POINTER_MISSING`; with `receipt_ref: "porkbun:1"` the warning is absent; `godaddy:none` does **not** raise it.
- AT-7 `GET /portfolio` and `GET /books.csv` include `receipt_ref` (and `deal_id` when set) per live name, equal to the registration ledger row; column order for previous books.csv fields is unchanged (`receipt_ref` / `deal_id` appended).

## Out of scope
- Scraping or signing into Afternic, Sedo or GoDaddy seller UIs; any price, list, delist, buy, sell or export write.
- A new bot, email/Slack alerter, or message to Dvir.
- Changing CR-076 provenance rules, walk-away, drop dates, or buy caps.
- Backfilling past marketplace truth we never recorded.

## Decisions (Gavriel, 2026-10-26)
1. Fold into `portfolioCheck`; no `ownershipCheck` step. New codes shown clearly in the job summary.
2. Sealed/confirmed Afternic or Sedo export upload including the name = approval trail when `listing_history.approval_text` is absent. Unconfirmed, pending, or stale export = not.
3. `OBSERVED_UNCONFIRMED` stays info. Warn only for `LISTING_RECORD_MISSING`, `LISTING_UNAPPROVED`, `RECEIPT_POINTER_MISSING`, and registrar hold vs ledger mismatch.

## DVIR items
None (freeze override already granted for this item; no money, no new paid service, no founder-rule change).

## Changes
- 2026-10-26 23:26 IDT: filed (DOM Architect). Design note sent to Gavriel in parallel.

<!-- DOM writes below this line -->

## DOM response (2026-10-26, round 1)
**Verdict:** accepted (pre-approved: Dvir's bots' CRs, CLAUDE.md). Building now as **5.58.0**.
**Answers:**
1. **A new daily step `ownershipCheck`**, right after `portfolioCheck` (and after `registrarCheck`). It computes the R-3 checks with the same function `/report` uses, so the step summary (`{status, checked_n, alerts_n, by_code}`) and `/report` never disagree; `/report` computes them live (a fix shows on the next `/report`, not only after the next daily run).
2. **Approval trail for `LISTING_UNAPPROVED`:** any one of (a) a `listing_history` row with approval text/time for that name, (b) the venue record itself when it was written through `POST /listings/{domain}/venue` (that route is WRITE-only and audited, so the record carries its audit row), (c) a confirmed export upload (`POST /export/{venue}/uploaded`) whose file contained the name. In practice it fires for an `ours_confirmed` record with no audit row that is not a tagged CR-076 seed.
3. **`OBSERVED_UNCONFIRMED` stays `info`**: a public sighting is not ours to act on, and `info` does not add to the warning count Gavriel watches.
**Note:** `receipt_ref` / `deal_id` are appended at the end of `GET /books.csv` rows and added to `GET /portfolio` list rows (R-4); nothing else in those shapes moves.
