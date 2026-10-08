# Plan: step-by-step refactor and a Postgres job queue (8 Oct 2026)

**Status (8 Oct 2026): done.**
- **R1:** v2.16.1 (core) and v2.16.2 (locks and efficiency).
- **R2:** v2.16.3 and v2.16.4 (nine modules).
- **R3:** v3.0.0 (job queue, with a self keep-alive while it works).
- **Open follow-up:** running independent steps in parallel under the shared per-registry pacer.

**Decided by Dvir (8 Oct 2026):** a durable job queue in Postgres, **yes**; a step-by-step refactor into modules on a shared core, **"Totally yes!!"**; stay on Render free; no backups; no outside monitoring services. No rewrite: each step is one release, full gate green, deployed and verified before the next. **No contract change** unless a step says so (then it is a MINOR release with a CHANGELOG entry).

## Why now
- **Size and authorship:** the service grew from about 9k to about 21k lines of code in two days (v2.1 to v2.15), written by many agents. The 8 Oct review found the same rule written several times: IDT-day helpers in 5 places, money formatting in 7, date validators in 8, tier evaluation in 2, member hash in 2.
- **Job weaknesses:** jobs run as one long HTTP request. They use in-memory locks and flags, which are lost on a restart and unsafe when two instances overlap during a deploy. A hung step blocks later runs, and a failed item is easy to miss.

## R1: shared core (`src/core/`), behaviour unchanged (PATCH)
1. **`core/dates.ts`:** one implementation each of `idtDay(instant)`, `idtDayStart`, `nextIdtMidnight`, `addDays`, `addMonthsClamped`, `dayNumber`, `isRealDate`, `utcMonth`, `isoWithOffset` (zod), and `ymd` (zod). Replace every copy (`dates.ts`, `time.ts`, `review/packet.ts` `idtDay`, `drops/drop-lists.ts`, `report/domains.ts`, `pricing/schedule.ts`, `list.ts`, the zod `ymd` copies, the 8 real-date validators, and the 3 ISO-offset regexes).
2. **`core/money.ts`:** `formatUsd`, `wholeUsd`, `pair(name, cents)`, and integer-only conversions. Remove `wholeDollars`, the local `usd` helpers and float `dollars` in `list.ts`.
3. **`core/locks.ts`:**
   - `withAdvisoryLock(key, fn)` (transaction-scoped, `hashtext`) and `withDomainLock`, moved here;
   - **every in-memory mutex and `running` flag in jobs becomes a DB lock** (multi-instance safe);
   - a lock registry with named keys, so two jobs never share a key by accident.
4. **`core/validation.ts`:** the shared zod pieces (`usd`, `domainParam`, `approvalRef`, `comps`), and the personal-data check (`NO_PII`) used by offers, sold, uploads and intake.
5. **`core/redact.ts`:** one scrub helper (secret values and token names) used by audit, runner, Buffer, Gemini and the Worker logs. "Free-text route" becomes a route option instead of a path regex in `audit.ts`.
6. **Efficiency (Dvir asked, 8 Oct):**
   - **One shared pacer per registry host for the whole process,** so parallel work can never exceed our polite rate.
   - **Batched engine writes:** the heartbeat at most every 10 s, the cancel check at most every 5 s, manual-row lookups only for checks that can be manual. That cuts the database calls per check from about 4 to about 1.
   - **Light progress reads:** stored per-run summaries instead of loading every result row on each poll.
   - **Step timings** recorded in each job run, so gains are measured.
7. **Gate for R1:** an `import-boundaries` unit test that fails if a new copy appears, by searching for the old helper names outside `core/`.

## R2: modules with public entry points (PATCH)
- **Target layout:** `src/modules/<name>/` with an `index.ts` that is the only file other modules may import. Routes stay in each module's `api.ts`.
  - **`selection`:** screening engine, checks, settings, siblings, test sets, replays, packs, tranches, buy hold.
  - **`candidates`:** intake, daily list, domain records, drop lists, cohorts.
  - **`buying`:** check, buy, reconciler, registrars, bookkeeping, budget, import.
  - **`listing`:** pricing, plans, schedules, list, lander, exports.
  - **`selling`:** offers, sold.
  - **`reporting`:** report, ledger, audit reads, portfolio.
  - **`outreach`:** posting, review, company document, block list.
  - **`ops`:** jobs, job runs, health, admin.
- **Order:** one module per sub-step, smallest coupling first (`outreach`, then `reporting`, `selling`, `listing`, `candidates`, `buying`, `selection`). Files move with `git mv`, so history is kept.
- **Gate for R2:** a unit test reads the import graph and fails on an import that reaches into another module's internals (`modules/x/...` from outside `x`, except through `index.ts`). `src/db/types.ts` stays shared for now and is split per module last.

## R3: the job queue in Postgres (MINOR: `GET /jobs/runs` gains per-step attempts)
- **Homegrown, not pg-boss or graphile-worker.** Those libraries poll the database every few seconds while the process is awake, which on Neon free burns compute hours and keeps the database from suspending. Our work comes in a few bursts a day, so a small table-based queue that is worked only when a job run starts (or a route asks for it) fits better and adds no dependency.
- **Table:** `job_steps(id, run_id, step, status queued|running|done|failed|skipped, attempt, max_attempts, timeout_ms, locked_by, locked_until, started_at, finished_at, summary jsonb, error)`. Items are claimed with `FOR UPDATE SKIP LOCKED`. A step whose `locked_until` has passed (the instance died or slept) is retried by the next worker. Every step has a timeout.
- **Jobs:**
  - **`POST /jobs/run`** enqueues the job's steps and answers at once with the run id (202), so the Worker no longer waits 90 seconds;
  - **the in-process worker** works through the steps in order while the instance is awake;
  - **`GET /jobs/runs`** shows each step's status, attempts and errors;
  - **`JOB_OVERDUE`** also fires for a step that failed after its last attempt.
- **Independent steps run in parallel** under the shared per-registry pacer: the portfolio web checks 4 at a time, and steps that don't depend on each other side by side.
- **Long screening runs** (test sets, cohorts, intake) keep their own engine for now. They already resume after a restart and are moved onto the queue only if that proves simpler.
- **Contract:** `POST /jobs/run` changes from a 200 with all step results to a 202 with the run id. That breaks the Worker and workflows, which DOM updates in the same release. Bots read results through `GET /jobs/runs`. This is a **MAJOR** change for `/jobs/run` callers, and DOM is the only one (Worker, workflow). Gavriel's manual runs are announced in `DOM-TO-GAVRIEL.md`, so it ships as 3.0.0 with a release note.

## Order and size
1. **R1**, one release.
2. **R2**, two or three releases (by module).
3. **R3**, one release (3.0.0).

Each release runs the full gate, deploys, and is checked live. Parked items from the 8 Oct pass (`gaps.md` G-85 to G-97) are picked up where a step touches them; for example, R3 closes G-96 (step timeouts).
