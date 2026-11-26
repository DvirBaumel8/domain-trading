> **DRAFT, not approved, do not build.** Waiting for Dvir's yes through Gavriel (approval A3 in the AI-visibility 30-day plan).

# CR-126: AI-visibility engine as a separate private service

**Status:** Draft 25 Nov 2026. **From:** AI-visibility research (executor), for Gavriel. **To:** DOM (Claude Code).
**Decided by Dvir:** not yet. Background: Dvir approved the AI-visibility direction (t1362u) and asked that anything better done in code go to DOM (t1363u).
**Spec / reference code:** the working prototype lives on the bots' box at `/workspace/ai-visibility/engine` (Python, 27 passing tests); design notes in `/workspace/ai-visibility/02-engine-design.md` and `09-dom-vs-bots.md`. Gavriel copies them into the new private repo when this is approved.

This request authorizes no spending, no API sign-up, no publishing and no outside message. **Do not put this engine in this repo:** this repo is public and the app is stateless. Build it in a new **private** repo (name chosen by Gavriel) with its own storage. Do not print keys. Tests are the contract; at most two review rounds.

## Ask
1. Port the prototype: niches, prompt generation (frozen, versioned prompt sets), providers (mock, Pollinations free, OpenAI/Perplexity/Gemini/Claude locked behind `allow_paid`, env keys and a `BudgetGuard` hard cap in dollars), strict name matching with city/trade stop-words, scoring with Wilson ranges, reasons, HTML report, experiment (DiD + bootstrap + power).
2. Storage: runs, answers (raw text kept), mentions, costs. Postgres if available, else SQLite on a disk.
3. Jobs: `market-run` (niche, city, providers, repeats) and a scheduled `wave` re-check (weekly/monthly) — idempotent, every call cost-logged, stops at the cap.
4. Roster ingest: NPPES API (orgs, paginated, deduped) and CSV.
5. Read API for the checker site: `GET /market/{niche}/{city}` (latest scores, ranges, date, engines and mode), `GET /business?name=&city=&niche=`; no personal data beyond business names/addresses that are public.
6. Report renderer with optional white-label logo and agency name.

## Tests
- Paid providers never run without `allow_paid`, a key and room in the cap; a run that would exceed the cap stops before the call.
- No key or header ever appears in logs, errors or responses.
- Regression: "Austin Dental Clinic" does **not** match "Austin Dental Associates PLLC"; "Austin Dental Spa" matches "Austin Dental Spa, PLLC".
- Same seed → same prompts; a frozen prompt set never changes after a wave.
- A second `wave` for the same date does not duplicate rows.
- Every report row shows its engine mode (web-search / model-memory / simulated) and date.

## Done when
- All tests pass in CI of the private repo; a mock market run and one free Pollinations run produce a report and stored rows; the read API returns them. No paid call has been made.
