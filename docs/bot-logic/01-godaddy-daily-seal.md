# Job: GoDaddy inventory freeze + removed-provider closeout seal

## Purpose
Every evening, archive that day's GoDaddy auction/closeout inventory files and seal removed-provider expired closeouts so Buyer has a fresh, dated pool. Without this, buy search runs on stale data (Oct 23–26 Grok outage left box gaps).

## Algorithm (plain words)
1. After ~17:40 IDT, when GoDaddy rebuilds public inventory zips, download/archive all expected files for data date D (expiring, listings ending today, closeouts, biddable, auctions ending today).
2. Freeze/copy into dated raw + warehouse paths keyed by **source data date**, not box clock.
3. removed-provider: read-only `get_expired_closeout_domains`, one call at a time (~90 s apart), pages sized per current plan (~20k/page), save pages, then seal COMPLETE (or PARTIAL_* if pages missing). Prices in **cents**.
4. Upload/seal into DOM snapshots with Idempotency-Key for date D. Never invent backfill for missing days — write GAP.
5. Log every call (ok and fail). Errors are ERROR/UNKNOWN with status, never silent 0.

## Inputs / outputs
- In: date D, GoDaddy public inventory URLs, removed-provider closeout API via `REMOVED_PROVIDER_API_KEY` on Mac prod.env (read-only). Grok MCP is backup only when the key is absent or datasave is down.
- Out: sealed GoDaddy set for D; sealed removed-provider closeouts for D (row count + sha); or GAP note.

## Pass / fail
- Pass: GoDaddy expected files present and sealed; removed-provider closeouts COMPLETE or explicit PARTIAL/GAP; Buyer can filter on D.
- Fail: missing day with no GAP; double seal; invented backfill.

## Why bot vs why DOM
Mechanical fetch + seal. High company risk when only Grok runs it (token outage = gap). **DOM datasave is primary** once `REMOVED_PROVIDER_API_KEY` is on Mac prod.env (CR-080 round 2). Grok nudge / MCP = backup only behind seal-state lock (409 `SNAPSHOT_SEALED`).

## Token cost class
Low (scheduled DOM job). High if done by a Grok routine that re-plans each night.

## Owner
- Primary: DOM datasave (removed-provider half requires `REMOVED_PROVIDER_API_KEY` in Mac prod.env; GoDaddy already DOM-primary)
- Backup: Gavriel → DOM Architect nudge (seal-state lock per `00-dual-runner-lock-rule.md`; `docs/locks/` notes only)

## Sources
`knowledge/handoffs/data-engineer.md` §§2–3; lessons/mahandes.md; BUG-051; Oct 26 catch-up seal report.
