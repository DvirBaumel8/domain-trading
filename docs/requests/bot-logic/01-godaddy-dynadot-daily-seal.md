# Job: GoDaddy inventory freeze + Dynadot closeout seal

## Purpose
Every evening, archive that day's GoDaddy auction/closeout inventory files and seal Dynadot expired closeouts so Buyer has a fresh, dated pool. Without this, buy search runs on stale data (Oct 23–26 Grok outage left box gaps).

## Algorithm (plain words)
1. After ~17:40 IDT, when GoDaddy rebuilds public inventory zips, download/archive all expected files for data date D (expiring, listings ending today, closeouts, biddable, auctions ending today).
2. Freeze/copy into dated raw + warehouse paths keyed by **source data date**, not box clock.
3. Dynadot: read-only `get_expired_closeout_domains`, one call at a time (~90 s apart), pages sized per current plan (~20k/page), save pages, then seal COMPLETE (or PARTIAL_* if pages missing). Prices in **cents**.
4. Upload/seal into DOM snapshots with Idempotency-Key for date D. Never invent backfill for missing days — write GAP.
5. Log every call (ok and fail). Errors are ERROR/UNKNOWN with status, never silent 0.

## Inputs / outputs
- In: date D, GoDaddy public inventory URLs, Dynadot closeout MCP/API (read-only).
- Out: sealed GoDaddy set for D; sealed Dynadot closeouts for D (row count + sha); or GAP note.

## Pass / fail
- Pass: GoDaddy expected files present and sealed; Dynadot closeouts COMPLETE or explicit PARTIAL/GAP; Buyer can filter on D.
- Fail: missing day with no GAP; double seal; invented backfill.

## Why bot vs why DOM
Mechanical fetch + seal. High company risk when only Grok runs it (token outage = gap). **Move to DOM as primary** (datasave job). Grok nudge = backup only.

## Token cost class
Low (scheduled DOM job). High if done by a Grok routine that re-plans each night.

## Owner
- Primary: DOM datasave
- Backup: Gavriel → DOM Architect nudge (lease per `00-dual-runner-lock-rule.md`)

## Sources
`knowledge/handoffs/data-engineer.md` §§2–3; lessons/mahandes.md; BUG-051; Oct 26 catch-up seal report.
