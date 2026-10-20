---
id: CR-073
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel)"
priority: P1
depends_on: [CR-071, CR-072]
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
- R-4 Labels: daily step checks T30 ("taken in 30 days": registered at RDAP) for **every pool name**, blind to arms; unknown stays `unknown`, never "not taken".
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

<!-- DOM writes below this line -->
