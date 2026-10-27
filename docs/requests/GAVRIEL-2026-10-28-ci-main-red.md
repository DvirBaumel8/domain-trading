# CI on main red (2026-10-28 ~01:38 IDT) — Gavriel note to DOM

1. **KB543-24 (knowledge load)** failed on e93c5d7: `0008-fertilize-2026-10-28.jsonl` had source rows with free-text `conflict_of_interest` (not in the enum) and 3 excerpts over 300 chars. Gavriel fixed the data in this commit (enum -> `sells_service`, excerpts trimmed to 300). No code change.
2. **job-cli "daily runs every step; the unconfigured backup step is skipped, not failed"** (shard 2) failed in the same run. Not caused by a data file as far as Gavriel can tell; please check whether it is flaky or a real regression from CR-088 / v5.72.0.
3. **release v5.72.0** workflow failed: the tag was pushed before PR #5 was merged ("tag is not on main"). The commit is on main now; please re-run the release (or re-tag) so v5.72.0 deploys, then confirm /health shows 5.72.0.
