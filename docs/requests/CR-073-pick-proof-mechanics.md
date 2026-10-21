---
id: CR-073
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel)"
priority: P1
build_order: 4
depends_on: [CR-071, CR-072, CR-075]
supersedes: []
max_rounds: 2
---
# CR-073: DOM runs the pick-proof test mechanics (move 4 of 5)

**Approval:** Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel), top-5 move 4. Build right away, no ship date. No step for Dvir. Design: challenge/bot-pick-proof-plan.md v2 (bot box; key points copied below so this file stands alone).

## Why
The top-priority test (do bot picks beat random and a simple rule?) must not be run or graded by the picking bot. Code-made draws, hashes and stats remove self-grading and hand maths.

## What already exists (reference)
Seeded MT19937 / Fisher-Yates recipe (CR-008), test-set seals, cohorts with 30/60/90-day re-registration checks (cohortOutcomes) and Wilson reports, holdout guard. Cohorts cap at 200 names, so a new structure is needed.

## Rules
- R-1 Pool per day = the CR-071 snapshot at 06:00 IDT of Dynadot + GoDaddy closeouts at <= $40, minus sales-graded names; frozen pool sha256. Seed = first 8 hex of that sha256.
- R-2 Arms, k=100/day (setting, raise-only up to 300): A BOTS (`POST /pickproof/{date}/picks` from Buyer, scripted, before 16:00 UTC), B1 random from pool, B2 random from K1-passing, C1 random from 2-word <=10 letters, C2 .net-registered (reported only). DOM draws B1, B2, C1, C2.
- R-3 Seal: `GET /pickproof/{date}/manifest` returns sha256 of pool, seed, each arm, and the frozen recipe shas. The bots append it to docs/requests/pick-proof-seals.md (plan §13: git commit timestamps are the witness). After seal, picks for that day are 409 `PICKPROOF_SEALED`.
- R-4 Labels: daily step checks T30 ("taken in 30 days": registered at RDAP) for **every pool name**, blind to arms; unknown stays `unknown`, never "not taken". Labels are also read from `market_names` (CR-075): an arm name later seen listed and unsold there is a negative example; the seal format is shared with `GET /market/matched`.
- R-5 `GET /pickproof/report?from=&to=`: per arm n, events, rate; primary A vs C1 one-sided Fisher (alpha 0.05), CMH by price band; Holm-adjusted secondaries (A vs B1, A vs B2); overlap %; if overlap > 5% use the within-day permutation test (10,000 shuffles); fewer than 10 events → `UNPOWERED`. Labeled "proxy, not profit".
- R-6 No money action; no LLM; no email.

## Acceptance tests (via the API)
- AT-1 Given a sealed pool for D, When `GET /pickproof/D/manifest` is called twice, Then the same seed, arm hashes and draws (reproducible).
- AT-2 Given B1, Then 100 distinct names, all from the pool.
- AT-3 (negative) Given D sealed, When Buyer POSTs picks for D, Then 409 `PICKPROOF_SEALED`.
- AT-4 (negative) A picks list with a name outside the pool → 422 `NOT_IN_POOL`.
- AT-5 Given fixture labels with 4 events total, Then the report says `UNPOWERED`, no pass/fail.
- AT-6 Given a fixture with 12% overlap, Then the primary uses `permutation` and reports the p-value; with 2% overlap, `fisher`.
- AT-7 (negative) An RDAP error on a pool name gives label `unknown`, excluded from rates, counted in `unknown_n`.

## Out of scope
- Choosing the bots' picks; the 12-month DEV and $500+ sale limbs (later CR); Challenger's grading.

## Questions (max 3)
1. Can the 06:00 IDT pool use the previous evening's CR-071 save, or do you need a 06:00 fetch?
2. Should DOM push the manifest line to pick-proof-seals.md itself (data-only commit), or leave that to the bots?

## DVIR items
None.

## Changes
- 2026-10-20 23:55 IDT: build_order 4: follows CR-071 (P0, built first) (Gavriel's answers, 2026-10-20 ~23:53 IDT).
- 2026-10-21 00:00 IDT (Gavriel): both changes accepted (labels for arm names only; C2 `not_built`). Bots append the seal line, as you say.
- 2026-10-21 00:00 IDT: both changes accepted (labels for arm names only; C2 `not_built`); Q1/Q2 answers accepted, bots append the seal line (Gavriel).

- 2026-10-21 00:14 IDT: R-4 labels read from `market_names`; depends_on adds CR-075 (Dvir approved the data program (knowledge/data-program-v1.md) at 00:12 IDT Oct 21, via Gavriel).

<!-- DOM writes below this line -->

## DOM response (2026-10-21): accepted with two changes; built after CR-071/072 (v5.23.0)

- **R-4 changed: labels for the arm names only, not the whole pool.** The pool can hold tens of thousands of names a day, and RDAP-checking all of them again 30 days later would hammer Verisign's free RDAP service. Labelling only the union of every arm's names keeps the test blind: the code labels each name the same way, with no arm attached. Unknown stays `unknown`.
- **R-2 changed: arm C2 (.net-registered) is deferred.** Drawing it needs a .net lookup for every pool name, the same problem. A, B1, B2 and C1 are built. The report lists C2 as `not_built`.
- **Q1:** yes, the 06:00 IDT pool is the previous evening's sealed CR-071 save (the 15:00 UTC run).
- **Q2:** the bots append the seal line. DOM doesn't push data commits to this repo for the bots.
- **Unchanged:** everything else as written (seed from the pool sha256, k = 100 raise-only up to 300, 409 `PICKPROOF_SEALED`, 422 `NOT_IN_POOL`, Fisher, CMH, Holm, the permutation rule, `UNPOWERED`, "proxy, not profit").

## DOM release (2026-10-22): v5.28.0 tagged
- **Routes:** `GET /pickproof/{date}/manifest`, `POST /pickproof/{date}/picks` (bots or WRITE; picks close at 16:00 UTC of D), `GET /pickproof/{date}/arms?arm=` (only after the seal; before it, 409 `PICKPROOF_NOT_SEALED`) and `GET /pickproof/report?from=&to=`.
- **Pool for D:** the sealed save of D-1, made of GoDaddy closeouts plus the Dynadot closeouts upload if one is sealed. It is `.com`, ≤ $40 and excludes sales-graded names. It is frozen with a sha256, and the seed is its first 8 hex.
- **Seal:** the first manifest call at or after 16:00 UTC of D seals the day. Please make that call and append the manifest line to `pick-proof-seals.md`. The random arms are readable only after it.
- **Arms:** A, B1, B2 and C1 are built; C2 is `not_built`. The exact recipe and its sha256 values are in every manifest (`recipe`) and in `docs/internal/pickproof.md`.
- **T30 labels:** checked by RDAP **status**, for the arm names only.
  - Registered and not in redemption period or pending delete → `taken`.
  - Redemption period, pending delete or not registered → `not_taken`.
  - Errors → `unknown`, retried until D+40.
  - Creation date and statuses are stored for Challenger. A bought closeout keeps its old creation date, so the date doesn't decide the label.
- **Report:** Fisher (one-sided) with CMH by price band for A vs C1, Holm for A vs B1 and A vs B2, the permutation test when overlap is over 5%, `UNPOWERED` under 10 events. Every result is labelled "proxy, not profit".
- **Please verify** AT-1..AT-7 from the first day after the next 15:00 UTC save.

## Gavriel (2026-10-21 04:09 IDT): v5.28.0 first look
- `GET /pickproof/2026-10-21/manifest` (before the seal) gave 200: `data_date` 2026-10-20, `pool_n` 129,996 (GoDaddy 125,395 + Dynadot 4,601 sealed), `k` 100, arm A open with 0 picks, B1/B2/C1 `pending_seal`, C2 `not_built`, recipe hashes present.
- `GET /pickproof/2026-10-21/arms?arm=A` before 16:00 UTC gave 409 `PICKPROOF_NOT_SEALED` with the 19:00 IDT deadline. Pass.
- Gavriel will make the seal call at or after 16:00 UTC and append the line to `pick-proof-seals.md`; AT-1..AT-7 from the first day after the next 15:00 UTC save.
