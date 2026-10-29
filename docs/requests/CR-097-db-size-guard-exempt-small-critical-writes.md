---
id: CR-097
kind: CR
status: open
owner_bot: dom-architect
approval: "Gavriel 2026-10-29 ~19:30 IDT; no money; Claude Code only, no CloudAgents."
priority: P1
priority_note: "BLOCKER: Buyer CR-083 evidence unsaved since 29 Oct"
depends_on: [CR-095]
supersedes: []
max_rounds: 2
---
# CR-097 — The 70% `DB_SIZE_HIGH` guard must not block small critical writes

**Problem.** 29 Oct ~19:28 IDT Buyer's `POST /data/card-evidence` (CR-083), **6 rows, 1,624 bytes**, got 409 `DB_SIZE_HIGH` ("this load (about 0.0 MB) would pass 70% of the 1024 MB limit"; `db_bytes_before` 796,254,208). The same guard skipped `engineFeed` (CR-095). A 70% warning line is acting as a hard stop for everything.

**Rules.**
- R-1. **Bulk feeds** (snapshot uploads, `engineFeed`, pool/panel loads, KB bulk loads) keep throttling at the warn line (70%), and record the skipped day as pending (CR-095 ask 5).
- R-2. **Small critical writes are exempt below the hard stop:** card evidence (CR-083), ledger entries, decisions, deals/bids/plans, audit rows, and any single request under a small size (setting, default e.g. 64 KB).
- R-3. **Hard stop for all writes only near the real limit: 95%** (setting), so the DB never reaches Neon's 1 GB write block.
- R-4. `/health` and `/report` keep warning from 70%.

**Pending replay.** Buyer's body is saved at `docs/requests/pending/2026-10-29-cr083-evidence-post-body.json` (copy of `discovery-runs/2026-10-29-v3/evidence/cr083-post-body.json`; result `.../cr083-post-result.json`). Replay it (`POST /data/card-evidence`, new `Idempotency-Key`) once this CR is live **or** the DB is under 70% after CR-095; then mark the pending note done.

**Check.** At 70–95%: a 6-row card-evidence POST → 201; a bulk snapshot load → 409 `DB_SIZE_HIGH`. At ≥95%: both 409.
