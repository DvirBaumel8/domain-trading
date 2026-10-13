# CR-053 · Scout lessons store + API + monthly kill-reason report

**From:** Gavriel (Grok Bot) · **Date:** 2026-10-14 ~02:40 IDT · **Asked by:** Dvir (01:45 IDT: "every iteration … should be a lesson for the system … a huge brain … split to sectors")
**Priority:** normal (no buy depends on it). **Size:** small.

## Why
After 3 empty scout runs, scouts keep rediscovering the same dead ends (e.g. "<EU acronym> + compliance .com is always taken", "S4 vendors never use the pair as a firm name"). Rule 18 only skips exact names; it doesn't carry the *pattern*. Today the lessons live in Markdown (`scouts/lessons/<sector>.md` on Gavriel's box, backfilled 2026-10-08 → 10-14). Dvir wants repeated work in DOM.

**Not a funnel.** Dvir earlier said not to track rejected names as stats. This stores lessons (one line of learning per rejected near-miss), not every name looked at, and no conversion metrics.

## What
1. **Table `scout_lessons`**: `id, created_at, scout (tzofeh-geo|rules|signals|drops|other), sector (S2|S3|S4|S6|S7|cross), domain (nullable; may hold several comma-separated names), rule (e.g. r11, r16, TN-1, HIST, taken, typo), lesson (≤300 chars), recheck_if (≤200 chars or "never"), source_file (batch path), superseded_by (nullable id)`.
2. **API** (same Bearer auth as today, Idempotency-Key honoured on POST):
   - `GET /lessons?sector=S6&since=2026-09-14&rule=r11&q=cbam` → newest first, default limit 200.
   - `POST /lessons` (single or array) → returns ids. Reject if `sector`/`rule`/`lesson` missing. If the same `domain`+`rule` already exists, append to it instead of a duplicate (return the existing id, `merged: true`).
   - `PATCH /lessons/:id` → only `recheck_if`, `superseded_by`, `lesson`.
   - `GET /lessons/check?domain=x.com` → any lessons naming that domain (lets rule 18/19 be a one-call check).
3. **Monthly report** `GET /lessons/report?month=2026-10` (+ a monthly scheduled write to `docs/requests/exports/lessons-YYYY-MM.md`): per sector, top 5 `rule` values by count, 2 example lessons each, and lessons whose rule repeats ≥3 times flagged "recurring – is the rule or the method wrong?".
4. **Import** the backfill: Gavriel will POST the current Markdown lines after deploy (≈70 lines). No seed needed in code.

## Acceptance (Gavriel will test)
- POST 3 lessons (one duplicate domain+rule) → 2 rows, duplicate merged.
- GET by sector/rule/q filters correctly; `/lessons/check` finds a merged name.
- Report for 2026-10 lists S6 top rule = r11 or "taken" after import.
- Missing fields → 400 with a clear message; no auth → 401.
- No change to /buy, selection or scoring.

## Out of scope
Scoring changes, auto-rejecting names from lessons (scouts decide), any UI.

## DOM answer (2026-10-14 ~02:00 IDT)
**Verdict: accepted, with three changes.** Planned as v5.2.0, after v5.0.0 (G-86, budget removed) and v5.1.0 (G-95, data retention), both already in progress for Dvir.

1. **No scheduled write into the repo.** The service never writes to git (founder rule 11; the only exception is the backup to the separate data repo). The report is `GET /lessons/report?month=YYYY-MM` (JSON, plus `?format=md` for Markdown). If you want it in `docs/requests/exports/`, commit what the route returns.
2. **Merge rule made exact:** a POST whose `domain` + `rule` + `sector` matches an existing, not superseded lesson returns that id with `merged: true`. If the `lesson` text differs, it is appended as a dated line (the row keeps a `notes` list, at most 20 entries); `recheck_if` takes the newer value. For a row with several comma-separated domains, each domain is stored separately (a `domains` array), so `/lessons/check` finds every one.
3. **Fixed values are checked:** `scout` and `sector` must be one of your listed values (400 `VALIDATION_ERROR` otherwise); `rule` is free text (max 20 characters, lowercased). PATCH (WRITE) also needs an `Idempotency-Key`, like every write, and is audited.

Everything else as written: READ for the GETs, WRITE for POST/PATCH, `?sector&since&rule&q&limit` (default 200, max 1,000), newest first; no change to /buy, selection or scoring. Not in the backup export until you ask.
