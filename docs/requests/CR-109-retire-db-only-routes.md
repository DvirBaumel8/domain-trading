> Status: Approved by Dvir 2026-11-23 10:03 IST (via Gavriel)

# CR-109 — Retire database-only routes (contract v7.0.0)
| Field | Value |
|---|---|
| CR id | CR-109 |
| Series | S5 of S1–S8 (fully stateless, no database) |
| From | DOM Architect (Grok Bot), on behalf of Dvir (via Gavriel) |
| Date | 2026-11-23 10:09 IST |
| Approved by Dvir | 2026-11-23 10:03 IST, relayed by Gavriel: go fully stateless, no database. He accepts the loss of back-comparisons, the knowledge base, engine models and the other retired surfaces. |
| Priority | P1 (can start after CR-105, in parallel with CR-107) |
| Depends on | CR-105 |
| Max Claude Code rounds | 2 |
| Spend | $0 |

## 1. Business need
Dvir approved fully stateless on 2026-11-23 10:03 IST (via Gavriel). $0 spend. The Neon project stays idle and is never deleted. At most 2 Claude Code rounds. Tests are the contract. This CR is one of the S1–S8 series (CR-105..CR-112) that replaces the slim-DB restore plan. Claude Code only; no CloudAgents. No money actions and no settings activation.

Dvir sees no present value in the research, knowledge-base, engine, market-history and related surfaces. Those routes must go away cleanly (410 + a pointer) so bots and crons do not keep writing to a database that no longer exists. The contract becomes v7.0.0.


## 2. Rules
- **R-1 (410 Gone + pointer): the following return 410 with a short pointer to this CR and to the v7.0.0 changelog, and write nothing: `/kb/*`, `/engine/*`, `/score`, `/market/*`, `/pickproof/*`, `/replay/*`, `/patterns/*`, `/lessons`, `/lessons/{id}`, `/lessons/check`, `/lessons/report`, `/data/*`, `/screening/*`, `POST /tranches` and other tranche writes, `/visits*`, `/snapshots*`, `/candidates/*`, `POST /selection/*` (writes; reads of active lists stay if CR-107 needs them from `config/`), `/db/report`, `/rdap/*`, `/lookups/usage`, `/jobs/preview`.**
- **R-2: `docs/contract` is bumped to v7.0.0. CHANGELOG and `/openapi.json` drop the retired routes. Remaining bot routes from CR-107 and CR-108 are unchanged.**
- **R-3: no database is opened to answer a retired route.**

## 3. Acceptance criteria
- **AC-1 (RT-1): each path in R-1 returns 410 with a pointer; the FileStore and any leftover DB (must not be contacted) are unchanged.**
- **AC-2 (RT-2): `/openapi.json` and the v7.0.0 contract contain none of the retired paths.**
- **AC-3 (RT-3): a fixture walk of the remaining bot/READ/WRITE routes from CR-107 and CR-108 still matches their contracts.**

## 4. Open questions for DOM
- Q1: should `GET /selection/settings` and `GET /selection/lists/{name}` stay as file-backed reads (recommended, because `/buy` and preflight need the active lists) or also return 410? If you keep them, only the GET forms stay; all POSTs in `/selection/*` still return 410.

<!-- DOM writes below this line -->
