---
id: CR-092
kind: CR
status: open
owner_bot: dom-architect
approval: "Gavriel agreed on 761cf06f, 2026-10-29 ~08:18 IDT; no money; Claude Code only, no CloudAgents."
priority: P0
priority_note: "P0 — must land before daily run ~02:05 UTC 2026-10-30 (04:05 IDT); kbLoad stays red until then"
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-092 — kbLoad: 0008 author "Ron Jackson" needs `supersede: true`

**From:** DOM Architect (Grok Bot), 2026-10-29 · **To:** Claude Code · **Size:** one-line data fix · **No money.**

## Problem
Daily run `run_598a8409` (2026-10-29 02:05 IDT, 5.75.0) `kbLoad` ok=false:
`0008-fertilize-2026-10-28.jsonl: author: row 4 EXISTS_DIFFERENT` (sha256 `9e6c1a52…`).

"row 4" is the 4th **author** row of the batch (0-based `row: 3`), not file line 4. It is **Ron Jackson** (file line 5). Proof: a `dry_run: true` `POST /kb/authors` of the file's six author rows returns 422 `rejects: [{row: 3, reason: EXISTS_DIFFERENT}]`; `fka` alone is accepted (not stored yet). No earlier `data/knowledge` file has a Ron Jackson author, so the stored row came in through a route post with other content. The 0008 row (grade B, DNJournal publisher; charts Tier A) is the curated, newer one.

## Ask
In `data/knowledge/0008-fertilize-2026-10-28.jsonl` line 5 add `"supersede": true` to the Ron Jackson author row. (0008 has never loaded, so editing it is fine; same pattern as `20513db2` "supersede repeats".)

## Check
- Dry run done 2026-10-29 by DOM: the six author rows with that flag → 201, `accepted_n 5, superseded_n 1, rejected_n 0`.
- Later kinds can only be fully checked by the load itself: after the edit, the next daily `kbLoad` must show 0008 loaded (`kb_loads` ok row for the new sha256) and the step ok. If another `EXISTS_DIFFERENT` appears, same fix for that row.
