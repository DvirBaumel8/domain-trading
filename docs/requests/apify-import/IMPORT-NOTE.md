# apify-actors source snapshot (for CR-127)

- Imported 26 Nov 2026 by DOM Architect, after Gavriel confirmed the repo is private (11:30 IST).
- Source: box working tree `/workspace/apify-actors`, local git head `98fcaf1`, **plus** Gavriel's uncommitted text edits (builds: dns, sitemap, availability 0.1.4; checkup 0.1.5), logos, `usage-report.py` and `VERIFY-ON-APIFY.md`.
- Left out: `.git`, `.venv`, `__pycache__`, `.pytest_cache`, `storage/`, `research/*.json` (survey output), and bot daily notes.
- No tokens are in this snapshot. `usage-report.py` reads the token from a file outside the repo; CR-127 Part B moves it to the `APIFY_TOKEN` GitHub secret (Q2, still open).
- Next step (CR-127 Part A, item 1): Claude Code moves this folder to top-level `apify-actors/` and deletes this snapshot.
