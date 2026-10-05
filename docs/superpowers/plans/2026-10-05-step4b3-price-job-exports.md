# Step 4b-3: Daily price job + exports v2: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the pre-approved drop schedules every day without touching any registrar or marketplace. Make the weekly upload flow exact. In detail:
- the daily price job: apply due events, hold, delist, mark failures;
- `changed_only` exports with `X-Export-Id` and `X-Pending-Changes`;
- `POST /export/{venue}/uploaded`, which records that Dvir uploaded a file;
- `X-Manual-Delist` that lists sold, delisted or dropped names until an upload after the removal is confirmed;
- Sedo Make Offer as the default.

Gate G1 for PR-20–PR-23, PR-27–PR-29 and PR-36, E-1–E-8 (as updated) and E-10–E-12, plus LH-5.

**Not in this step:**
- `/report` warnings and heads-ups: PR-37 and PR-38 (4d);
- `drop_date` moves: PR-25 (4d, with `import-domain`/renew);
- `/sold` cancelling rows: PR-26 (4d);
- offers (4c).

**Architecture:**
- **`src/jobs/price-schedule.ts`:** a `PriceScheduleJob` class like `NsVerifier`. It has **no registrar or marketplace dependency at all**; its only deps are `db`, `now` and `log`.
- **Per domain:** the job runs inside `withDomainLock`, in one transaction, re-reading under `FOR UPDATE`. It applies only the latest due price event and supersedes the earlier due ones (§10.4 hold-lift rule). It always applies a due `delist`. It writes history, audit and the export flags.
- **Scheduling:**
  - `main.ts` runs the job at startup and daily at 00:30 UTC;
  - `npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]` runs it by hand.
- **Exports:** they become per venue.
  - `GET` records a **file snapshot** (`export_runs`: `export_id`, venue, domains, `created_at`) but changes no state that any later output depends on.
  - **Which rows count as pending and which domains need manual delisting depends only on confirmed uploads** (`export_uploads`).
  - A new `domains.listing_changed_at` holds the last time an exported value changed.

**Tech Stack:** As before.

**Spec:**
- `docs/specs/listing-strategy.md`: §6, §10.4 (hold, delist, cancel), §10.5 (job), §10.7 (export flags), §10.12;
- `docs/specs/export-csv.md` (E-*);
- `docs/specs/test-plan.md`: PR-20–PR-29, PR-36;
- CLAUDE.md "Don't let the price job touch registrars, marketplaces or nameservers, or send anything".

## Global Constraints

- Everything from earlier steps still holds: cents and display strings, the error envelope, idempotency and audit on POSTs, no network in tests, fake keys, ESM `.js` imports, never edit a spec test to make it pass.
- **The price job never calls a registrar, a marketplace, DNS or anything outbound, and never sends anything.** Enforce this structurally: the job class takes no adapters and no `nsLookup`. Prove it in a test (PR-20: 0 HTTP calls; MSW errors on any request).
- **Every write to a domain's listing or plan fields takes the per-domain lock** (`withDomainLock`) and uses only `conn` inside it. This applies to the job, `/list`, `/buy` post-buy and `POST /export/.../uploaded`.
- **Schedule rows:** a row is applied only when it is `planned`, belongs to the domain's current `plan_id`, and is due on or before `today` (the IDT date). Each row is applied at most once (status check under the lock).
- **`GET /export/*.csv` stays READ.** Its only write is the file snapshot row; no domain state changes.
- **Money:** whole-dollar prices in the files; the walk-away never appears in any file or header.

## Decisions taken in this plan that the spec doesn't spell out (Dvir to confirm)

| # | Decision | Why |
|---|---|---|
| R1 | **"Pending upload" is per venue.** A domain is pending at venue V when it is `listed` and its `listing_changed_at` is later than the `created_at` of the newest **confirmed** V file that contained it (or no such file exists). `domains.export_pending_since` (the `/report` field) is set on a change and cleared only by an **Afternic** confirmation, for domains whose `listing_changed_at` ≤ that file's `created_at` | One column can't track two venues. Afternic holds the binding price, so its staleness is what `/report` warns about. A change made after the file was generated stays pending |
| R2 | `GET` records a file snapshot (`export_runs`: `export_id`, venue, domains, `created_at`, `changed_only`). `POST …/uploaded` takes only `{export_id, approval_ref}`, so the server must remember which domains a file held. The snapshot never affects later outputs | The spec's `POST` body has no domain list |
| R3 | **`X-Manual-Delist` for venue V:** domains with status `sold`, `delisted` or `dropped` that appeared in at least one confirmed V upload, and for which no V upload was confirmed after their `delisted_at`. A missing `delisted_at` (legacy) counts as still pending | E-12: "listed until an upload is confirmed". A confirmed upload after the removal is taken to mean Dvir did the removals the header asked for |
| R4 | `uploaded_at` = the `approved_at` of the `approval_ref` (when Dvir said he uploaded). The approval must be present, not in the future (60 s skew), at most 72 h old, and non-empty. It doesn't need to name a domain | The approval is about a file, not one domain |
| R5 | Confirming the same `export_id` again with a different key → 409 `EXPORT_ALREADY_CONFIRMED`. An unknown id, or one for another venue → 404 `EXPORT_NOT_FOUND`. An unknown venue → 404 `NOT_FOUND` | E-11 |
| R6 | **Job on a domain with status `sold` or `dropped`:** open rows → `cancelled`. Domains that aren't `listed` (`owned`, `delisted`) are skipped. A due `delist` always applies (a hold doesn't stop it): status → `delisted`, `delisted_at` = now, the remaining open rows → `cancelled`, one history row (`source=schedule`), and `listing_changed_at` set | §10.4 / §10.5 / PR-27 |
| R7 | **Several due price events for one domain** (missed days, or a hold just lifted): only the latest due row is applied; earlier due `planned` rows → `superseded`. A held domain keeps its due rows `planned` | §10.4 "when the hold is lifted, the next job run applies only the latest due event" (PR-23) |
| R8 | **Before applying, the row is validated against its own settings version** (PR-28). Hybrid: `walkaway_min ≤ walk ≤ floor ≤ bin`, `floor ≥ floor_min`, `bin ≥ hybrid_bin_min`, whole dollars. Geo: bin within `[geo_bin_min, geo_bin_max]`. A failure sets the row to `failed` with a note and an audit row, and leaves the domain unchanged | §10.5 "never applies a row whose values break V5/V6" |
| R9 | **Daily time:** at startup and then at 00:30 UTC every day (a timer chain that recomputes the delay after each run, `.unref()`). A run already in progress is skipped (`running` flag), as with `NsVerifier` | §10.5 |
| R10 | `settings.sedo_hybrid_as` default → `make_offer` (migration), plus an update of the existing row | §5 Settings: "make_offer default since v2" |

---

## File structure

```
migrations/1760100000000_exports-v2.sql   export_runs.export_id/changed_only, export_uploads (append-only), domains.listing_changed_at,
                                           audit_log scope 'job', settings.sedo_hybrid_as default make_offer
src/services/export-state.ts              pendingDomains(db, venue), manualDelist(db, venue), markChanged(cur, now)
src/services/export.ts                    (modify) per-venue, changed_only, snapshot, headers, confirmUpload
src/api/export.ts                         (modify) query/headers; POST /export/:venue/uploaded
src/jobs/price-schedule.ts                PriceScheduleJob.runOnce({ today?, dryRun? })
src/job.ts                                CLI: price-schedule [--dry-run] [--today]
src/app.ts, src/main.ts                   (modify) wire + daily timer
src/services/list.ts, src/services/buy.ts (modify) set listing_changed_at with export_pending_since
package.json                              "job" script
tests/api/price-job.test.ts, tests/api/export-v2.test.ts, tests/api/job-cli.test.ts, tests/unit/daily-timer.test.ts
```

---

### Task 1: Migration 6 + change tracking

**Files:**
- Create: `migrations/1760100000000_exports-v2.sql`, `src/services/export-state.ts`
- Modify: `src/db/types.ts`, `src/services/list.ts`, `src/services/buy.ts`, `tests/api/schema.test.ts`, `tests/api/admin-cli.test.ts` (6 migrations), `tests/helpers/db.ts` (TABLES + `export_uploads`), `tests/api/list.test.ts`, `tests/api/buy-listing.test.ts`

**Migration:**
```sql
-- Up Migration
ALTER TABLE export_runs ADD COLUMN export_id text, ADD COLUMN changed_only boolean NOT NULL DEFAULT false;
UPDATE export_runs SET export_id = 'exp_legacy_' || id WHERE export_id IS NULL;
ALTER TABLE export_runs ALTER COLUMN export_id SET NOT NULL, ADD CONSTRAINT export_runs_export_id_key UNIQUE (export_id);

CREATE TABLE export_uploads (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venue         text NOT NULL CHECK (venue IN ('afternic', 'sedo')),
  export_id     text NOT NULL UNIQUE REFERENCES export_runs (export_id),
  domains       text[] NOT NULL,
  uploaded_at   timestamptz NOT NULL,
  approval_text text NOT NULL CHECK (length(trim(approval_text)) > 0),
  audit_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX export_uploads_venue_at ON export_uploads (venue, uploaded_at);
CREATE TRIGGER export_uploads_append_only BEFORE UPDATE OR DELETE ON export_uploads FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER export_uploads_no_truncate BEFORE TRUNCATE ON export_uploads FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

ALTER TABLE domains ADD COLUMN listing_changed_at timestamptz;
UPDATE domains SET listing_changed_at = updated_at WHERE status = 'listed';

ALTER TABLE audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'admin', 'job'));

ALTER TABLE settings ALTER COLUMN sedo_hybrid_as SET DEFAULT 'make_offer';
UPDATE settings SET sedo_hybrid_as = 'make_offer', updated_at = now();

-- Down Migration
UPDATE settings SET sedo_hybrid_as = 'buy_now', updated_at = now();
ALTER TABLE settings ALTER COLUMN sedo_hybrid_as SET DEFAULT 'buy_now';
ALTER TABLE audit_log DROP CONSTRAINT audit_log_scope_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_scope_check CHECK (scope IN ('read', 'write', 'admin'));
ALTER TABLE domains DROP COLUMN listing_changed_at;
DROP TABLE export_uploads;
ALTER TABLE export_runs DROP CONSTRAINT export_runs_export_id_key, DROP COLUMN changed_only, DROP COLUMN export_id;
```
**Before writing it:** check the real constraint name for `audit_log.scope` (`\d audit_log`) and the current `sedo_hybrid_as` default. Use the real names. If the down migration's scope CHECK would fail because `job` rows exist, note it in the file as a forward-only data case (same as 4b-1's `delisted`).

**Types:** `ExportRunsTable` gains `export_id: string` and `changed_only: Generated<boolean>`; add `ExportUploadsTable`; `DomainsTable` gains `listing_changed_at: Timestamp | null`; the audit scope union gains `'job'`.

**`src/services/export-state.ts`:**
```ts
export type Venue = 'afternic' | 'sedo';
export const VENUES: readonly Venue[] = ['afternic', 'sedo'];
/** Listed domains whose exported values changed after the newest confirmed file of this venue that contained them (R1). */
export async function pendingDomains(db: Kysely<Database>, venue: Venue): Promise<string[]>;
/** R3: sold/delisted/dropped domains that went live at this venue and whose removal no confirmed upload has followed. */
export async function manualDelist(db: Kysely<Database>, venue: Venue): Promise<string[]>;
/** Columns to set whenever an exported value changes (mode, prices, LTO, display name, status to/from listed). */
export function changedColumns(cur: { export_pending_since: Date | null }, now: Date): { listing_changed_at: Date; export_pending_since: Date };
```
SQL for `pendingDomains` (sorted by domain):
```sql
select d.domain from domains d
where d.status = 'listed' and d.listing_changed_at is not null
  and d.listing_changed_at > coalesce((
    select max(r.created_at) from export_uploads u join export_runs r on r.export_id = u.export_id
    where u.venue = $venue and d.domain = any(u.domains)), '-infinity')
order by d.domain
```
SQL for `manualDelist`:
```sql
select d.domain from domains d
where d.status in ('sold', 'delisted', 'dropped')
  and exists (select 1 from export_uploads u where u.venue = $venue and d.domain = any(u.domains))
  and not exists (select 1 from export_uploads u where u.venue = $venue and d.delisted_at is not null and u.uploaded_at > d.delisted_at)
order by d.domain
```
Keep the 4a `SAFE_DOMAIN` filter at the export layer.

**Writers:**
- `/list` save sets `changedColumns(cur, now)` wherever it currently sets `export_pending_since` (plan written or display name changed).
- `/buy` `saveListing` does the same.

`listing_changed_at` always moves to `now`; `export_pending_since` keeps its existing value.

- [ ] **Step 1: Failing tests:**
  - **Schema:**
    - `export_uploads` UPDATE/DELETE/TRUNCATE raise;
    - a duplicate `export_id` raises;
    - the audit scope `job` is accepted;
    - the settings default is `sedo_hybrid_as = 'make_offer'`.
  - **`pendingDomains` / `manualDelist`** (DB tests in `tests/api/export-state.test.ts`, built from hand-inserted rows):
    1. a listed domain with no uploads is pending;
    2. after a confirmed upload whose file `created_at` is ≥ `listing_changed_at`, it isn't pending;
    3. a change after the file's `created_at` (even if confirmed later) makes it pending again;
    4. the venues are independent;
    5. a `delisted` domain that was in a confirmed upload, with `delisted_at` after it, is in `manualDelist`;
    6. after a later confirmed upload, it's gone;
    7. a sold domain never uploaded isn't listed;
    8. `delisted_at` null + uploaded → listed.
  - **`/list` and `/buy`:** after a plan save, `listing_changed_at` = NOW (fixed clock), and `export_pending_since` keeps an earlier value when one was set.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement. `npm run migrate up` on the dev DB, then `down` and `up`.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit` → all green. Some existing Sedo export tests assumed `buy_now`; update **only** their expectations of the default, as E-7 now specifies (make offer by default; `buy_now` only when set by an admin).
- [ ] **Step 5: Commit** `feat: migration 6 (export file ids, export_uploads append-only, listing_changed_at, job audit scope, Sedo make_offer default) + per-venue pending/delist queries`

---

### Task 2: Price job core

**Files:**
- Create: `src/jobs/price-schedule.ts`, `tests/api/price-job.test.ts`
- Modify: `src/app.ts` (decorate `app.priceJob`), `tests/helpers/app.ts` (if it needs to expose it)

**Interface:**
```ts
export interface PriceJobResult {
  today: string; dryRun: boolean; skipped: boolean;           // skipped = another run in progress
  applied: { domain: string; event: string; rowId: number; bin_cents: number | null; floor_cents: number | null; walkaway_cents: number | null }[];
  superseded: number[]; failed: { domain: string; rowId: number; reason: string }[];
  held: string[]; delisted: string[]; cancelled: number[];
}
export class PriceScheduleJob {
  constructor(deps: { db: Kysely<Database>; now: () => number; log?: { warn(o: object, m: string): void; error(o: object, m: string): void } });
  runOnce(opts?: { today?: string; dryRun?: boolean }): Promise<PriceJobResult>;
}
```

**Algorithm** (`today` = `opts.today` ?? `jerusalemDate(now)`; validate `YYYY-MM-DD`):
1. Pick candidate domains: `select distinct domain_id` from `price_schedule` where `status = 'planned'` and `due_on <= today`. Join `domains` for the name.
2. For each domain (sorted by name), run `withDomainLock(db, domain, conn => conn.transaction().execute(trx => …))`, wrapped in a per-domain `try/catch`. On error, log it, record `failed` with reason `error`, and continue.

   Inside the transaction:
   1. `cur = select * from domains where id … for update`.
   2. `due` = the planned rows with `plan_id = cur.plan_id` and `due_on <= today`, ordered by `due_on`, then id.
   3. Planned due rows of **other** `plan_id`s: these shouldn't exist, but if they do, set them to `superseded`.
   4. **`cur.status` is `sold` or `dropped`:** set every planned row of the domain to `cancelled` (R6), then stop.
   5. **`cur.status !== 'listed'`:** stop (no change).
   6. **A delist row is due:**
      - set the status to `delisted` and `delisted_at` = now;
      - set the `changedColumns` columns;
      - insert a history row: `source 'schedule'`, the current values, `schedule_event_id` = the row id, `plan_audit_id = cur.plan_audit_id`, `pricing_settings_version = row.settings_version`, no approval;
      - set the row to `applied` (`applied_at`, `listing_history_id`);
      - set every other planned row to `cancelled`;
      - write the audit row;
      - stop.

      The hold doesn't matter here.
   7. **`cur.pricing_hold`:** stop (`held`).
   8. **Price rows:** `last` = the last due row; every earlier due row → `superseded`.
   9. **Validate `last`** with `rowValid(last, settingsByVersion(last.settings_version), cur.listing_mode)` (R8). If it's invalid: `last` → `failed` with `note`, audit row, stop.
   10. **Apply:**
       - update the domain's `bin_cents`, `floor_cents` and `walkaway_cents` from the row;
       - `min_offer_cents`: unchanged for hybrid; equal to the new BIN for `bin` mode (geo);
       - plus `changedColumns` and `updated_at`;
       - insert history via `historyRow`-equivalent fields (`source 'schedule'`, `schedule_event_id`, `plan_audit_id`, the row's `settings_version`, `pricing_source` and grade from `cur`);
       - row → `applied`;
       - audit row.
3. **Audit row** (inside the transaction):
   - `{ id: newAuditId(), scope: 'job', method: 'JOB', path: 'price-schedule', request: JSON.stringify({ domain, event, row_id, today }), status_code: 200, result_summary: '<event> applied|failed|delisted' }`;
   - for `failed`, `status_code` = 422 and `result_summary` = the reason.
4. **Dry run:** same reads and decisions, no writes. Run without the lock, using a read-only plain query, so it never blocks.
5. **Re-entry:** a `running` flag returns `skipped: true` on re-entry (same process). Cross-process safety comes from the domain lock plus the `planned` status check under `FOR UPDATE`.

`rowValid(row, s, mode)`:
- all prices whole dollars;
- hybrid: `s.walkawayMinCents <= walk <= floor <= bin`, `floor >= s.floorMinCents`, `bin >= hybridBinMin(s)`;
- bin: `s.geoBinMinCents <= bin <= s.geoBinMaxCents`, with `floor === bin === walk`;
- returns a reason string or null.

**Not this task:** the timer and the CLI (Task 3).

- [ ] **Step 1: Failing tests** (`tests/api/price-job.test.ts`). Create a listed domain through a real `/list` call with a fixed app clock of 2026-10-12, hybrid 1995, giving the PR-12 rows. Then run `new PriceScheduleJob({ db, now })`.
  - **PR-20:**
    - `runOnce({ today: '2027-04-12' })`;
    - the domain has bin/floor/walk 159500/103500/77000 and min offer 10000;
    - one history row with `source 'schedule'`, `schedule_event_id` = the M6 row id, `plan_audit_id` = the domain's, `pricing_settings_version` 2;
    - the M6 row is `applied` with `listing_history_id`;
    - `listing_changed_at` and `export_pending_since` are set;
    - an audit row with scope `job`;
    - the result's `applied` has one entry.
    - **No outbound call:** build the job with no adapters. The global MSW `onUnhandledRequest: 'error'` plus the `dgram` block would fail any network attempt. Also assert `pb.calls` (the app's FakeAdapter) has no calls after the job.
  - **PR-21:** `today: '2027-04-11'` → nothing changes and the result is empty.
  - **PR-22:**
    - run twice on `2027-04-12` → still one history row and one change;
    - two concurrent `runOnce` calls on **two separate job instances** (`Promise.all`) → exactly one history row.
  - **PR-23:**
    1. `/list` `pricing_hold: true` + reason + approval (fixed clock).
    2. `runOnce({ today: '2027-04-12' })` → nothing applied, the result has `held: [domain]`, the rows stay `planned`.
    3. `runOnce({ today: '2028-04-20' })` (still held) → nothing.
    4. Lift the hold via `/list` (with the app clock still 2026-10-12, so the hold change doesn't regenerate rows).
    5. `runOnce({ today: '2028-04-20' })` → only M18 applied (domain 129500/83000/61500), M6 `superseded`, one schedule history row.
  - **PR-27:**
    - `runOnce({ today: '2028-09-27' })` on a domain whose M6, M18 and final push were already applied (run the job at each date first) → status `delisted`, `delisted_at` set, the delist row `applied`, no `planned` rows left, a history row.
    - **The same with a hold set → still delisted.**
  - **R6:** a domain set to `sold` by hand with planned rows → `runOnce` sets the rows to `cancelled`; the price is unchanged.
  - **PR-28:**
    - by direct update, set a planned M6 row's `floor_cents` to 70000 (still ≤ bin, so the DB CHECK passes, but below `floor_min`);
    - `runOnce` on its date → the row is `failed` with a note, the domain is unchanged, there is no history row, and there is an audit row with status 422.
  - **PR-29:** the job's change carries no `approval_text`. The same price via `POST /list` without approval → 422 `APPROVAL_REQUIRED` (already covered; reference it).
  - **LH-5:** the PR-20 history row has `source=schedule`, `schedule_event_id`, `plan_audit_id` and `approval_text` null.
  - **Dry run:** `runOnce({ today: '2027-04-12', dryRun: true })` reports M6 in `applied`, but no DB row changes and no audit row is written.
  - **Geo strong:** a listed 499 geo domain; `runOnce` on the M12 date → bin, floor, min and walk all 39900.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: daily price job (apply latest due event, hold, delist, cancel on sold/dropped, validate rows; no outbound calls) (PR-20–PR-23, PR-27–PR-29, LH-5)`

---

### Task 3: Job scheduling + CLI

**Files:**
- Create: `src/job.ts`, `src/jobs/daily-timer.ts`, `tests/unit/daily-timer.test.ts`, `tests/api/job-cli.test.ts`
- Modify: `src/main.ts`, `package.json` (`"job": "tsx --env-file-if-exists=.env src/job.ts"`)

**`src/jobs/daily-timer.ts`:**
```ts
/** Milliseconds from `nowMs` until the next HH:MM UTC (strictly in the future). */
export function msUntilNextUtc(nowMs: number, hour: number, minute: number): number;
/** Runs `fn` at the next HH:MM UTC and then every day; the delay is recomputed after each run. Returns a stop function. Timers are unref'd. */
export function scheduleDailyUtc(fn: () => Promise<unknown>, hour: number, minute: number, now?: () => number): () => void;
```
**`main.ts`:**
```ts
const runPriceJob = () => app.priceJob.runOnce().catch((e: unknown) => app.log.error({ errMessage: (e as Error).message }, 'price job failed'));
void runPriceJob();               // at startup (catches up after downtime; idempotent)
scheduleDailyUtc(runPriceJob, 0, 30);
```
**`src/job.ts`:**
- Usage: `npm run job -- price-schedule [--dry-run] [--today YYYY-MM-DD]`.
- Build the config and DB like `admin.ts`. Build the job with `db` and `Date.now` only.
- Print the result as JSON (`JSON.stringify(result, null, 2)`) and exit 0.
- Usage error → exit 2. A bad `--today` → exit 2.
- On any error, log the message (never the env) → exit 1.

- [ ] **Step 1: Failing tests:**
  - `msUntilNextUtc`: at 00:29:59Z → 1 s; at exactly 00:30:00Z → 24 h; at 23:00Z → 1 h 30 m; across a month end.
  - `scheduleDailyUtc` with fake timers (`vi.useFakeTimers`):
    - fires at the boundary, then again 24 h later;
    - the stop function cancels;
    - a rejected `fn` doesn't stop the chain.
  - CLI (`execFile npx tsx src/job.ts`, env from `testEnv()`):
    - `price-schedule --dry-run --today 2027-04-12` → exit 0 and JSON with `"dryRun": true`;
    - `price-schedule --today 2027-13-01` → exit 2;
    - no subcommand → exit 2;
    - the output has no `pk1_`/`sk1_`.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit && npm run build`.
- [ ] **Step 5: Commit** `feat: price job scheduling (startup + daily 00:30 UTC) and npm run job CLI (--dry-run, --today)`

---

### Task 4: Exports v2 + upload confirmation

**Files:**
- Modify: `src/services/export.ts`, `src/api/export.ts`, `tests/api/export.test.ts`
- Create: `tests/api/export-v2.test.ts`

**`GET /export/{afternic|sedo}.csv`:**
- **Query:** `changed_only` (`true`/`false`, default false; anything else → 400 `VALIDATION_ERROR`); unknown parameters → 400.
- **Rows:**
  - `listed` domains (as now);
  - with `changed_only=true`, only `pendingDomains(db, venue)`.
- **Snapshot:** after building the rows, insert `export_runs { export_id: 'exp_' + randomUUID(), marketplace: venue, domains: exported, changed_only }`. This is the only write.
- **Headers:**
  - `X-Export-Id`;
  - `X-Pending-Changes` = `(await pendingDomains(db, venue)).length` (computed before the snapshot; the snapshot doesn't change it);
  - `X-Manual-Delist` = `manualDelist(db, venue)` joined with `,` (for **both** venues; Sedo didn't send it before);
  - `X-Export-Warnings`;
  - `Content-Disposition` as now.
- **Delist rule:** remove the 4a interim rule (the `export_runs`-based delist query); `manualDelist` replaces it.
- **Sedo:** reads `settings.sedo_hybrid_as`, which now defaults to `make_offer`. With no template → 501 as now.

**`POST /export/:venue/uploaded`** (WRITE; idempotent and audited by the existing middleware):
- **Body** (zod, strict): `{ export_id: string, approval_ref: { text, approved_at } }`.
- **Venue:** not `afternic`/`sedo` → 404 `NOT_FOUND`.
- **Approval (R4):**
  - `text` must be non-empty after trimming → else 422 `APPROVAL_INVALID`;
  - `approved_at` must be ISO with an offset, not more than 60 s in the future, and at most `approval_max_age_hours` old → else 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED`;
  - reuse the internals of `checkApproval` if you can do so without the domain-naming rule; otherwise write `checkTimedApproval(ref, now, maxAgeHours)` in `approval.ts` and have `checkApproval` call it.
- **Run lookup:** `export_runs` by `export_id`. Missing, or `marketplace !== venue` → 404 `EXPORT_NOT_FOUND`.
- **Already confirmed** (an existing `export_uploads` row for that `export_id`) → 409 `EXPORT_ALREADY_CONFIRMED`.
- **Write:**
  - insert `export_uploads { venue, export_id, domains: run.domains, uploaded_at: approvedAt, approval_text, audit_id }`;
  - **Afternic only:** for each domain in the file, under `withDomainLock` (sorted, one at a time), clear `export_pending_since` where `listing_changed_at <= run.at`.
- **Response 200:** `{ venue, export_id, domains: n, uploaded_at, pending_after: (await pendingDomains(db, venue)).length, still_pending: [domains of this file that are still pending] }`.

- [ ] **Step 1: Failing tests** (`export-v2.test.ts`; fixed app clock; domains created via `/list` so the plan and change columns are real; a Sedo test template as in the existing Sedo tests):
  - **E-1/E-5:** unchanged; still green.
  - **E-2 (updated to the v2 rules):**
    - fixture: geo bin 399; trend hybrid 4995 + LTO 24 by override; buzzword offer min 500 by override; one sold domain that was in a **confirmed** Afternic upload before its `delisted_at`;
    - expect 3 rows exactly as LX-1/LX-4/LX-2, with the sold domain in `X-Manual-Delist`.
  - **PR-36 / E-10:**
    1. three listed domains, all in one confirmed Afternic upload;
    2. run the price job on one domain's M6 date;
    3. `GET ?changed_only=true` → exactly 1 row with the M6 values (`…,1595,1035,100,…`) and `X-Pending-Changes: 1`;
    4. `POST /export/afternic/uploaded` with that `X-Export-Id` + approval → 200;
    5. then `X-Pending-Changes: 0` and `export_pending_since` null for that domain.
  - **R1, a change after the file:**
    1. `GET` (id A);
    2. a `/list` price change on a domain in A (fixed clock later than A's `created_at`: use a second app with a later clock);
    3. confirm A → that domain is still pending and its `export_pending_since` is not cleared.
  - **Venue independence:** a confirmed Afternic upload doesn't clear Sedo pending (`GET /export/sedo.csv?changed_only=true` still has the row).
  - **E-11:**
    - unknown `export_id` → 404 `EXPORT_NOT_FOUND`;
    - an Afternic id posted to `/export/sedo/uploaded` → 404;
    - READ token → 403;
    - same key and body twice → the second is replayed (`Idempotent-Replayed: true`) with one `export_uploads` row;
    - a new key for an already-confirmed id → 409 `EXPORT_ALREADY_CONFIRMED`;
    - `/export/dan/uploaded` → 404;
    - a missing or stale approval → 422.
  - **E-12 / PR-27:**
    - a listed domain in a confirmed Afternic upload hits its delist (price job);
    - the next `GET` excludes it from rows and lists it in `X-Manual-Delist` (Afternic and Sedo, given a confirmed Sedo upload too);
    - after a new upload is confirmed (approval time later than `delisted_at`), it's gone from `X-Manual-Delist`.
  - **E-7:** with the default settings, the Sedo hybrid row is make-offer, with price 1995 and minimum 100. After an admin sets `sedo_hybrid_as='buy_now'` (direct DB update in the test), the row is fixed price with no minimum.
  - **The walk-away never appears:** no file or header contains `960` (`grep` the CSV and the headers) for a 1995 formula domain.
  - **`changed_only=maybe`** → 400.
  - **GET writes only the snapshot:** row counts of `domains`, `listing_history`, `export_uploads` and `audit_log` are unchanged by a GET, and `export_runs` has +1.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: exports v2 (per-venue changed_only, X-Export-Id, X-Pending-Changes, X-Manual-Delist until a confirmed upload; POST /export/{venue}/uploaded) (E-10–E-12, PR-36)`

---

### Task 5 (Opus): Gate report + spec sync

- [ ] Full suite, typecheck and build; record the counts.
- [ ] Map spec IDs to tests: PR-20–PR-23, PR-27–PR-29, PR-36, E-1–E-8, E-10–E-12, LH-5.
- [ ] Final whole-change review, then one fix wave and adjudication.
- [ ] Spec sync after Dvir confirms R1–R10: "Decided" notes in `export-csv.md` and `listing-strategy.md` §10.5/§10.7. Then report and push.

---

## Review Focus

1. **A file generated before a scheduled drop is confirmed after it.** The dropped domain must stay pending; the confirmation must not clear it (R1). Test in Task 4.
2. **Two job runs at once on two instances.** Exactly one application per row (lock plus status under `FOR UPDATE`). Test in Task 2.
3. **Hold lifted after several due events.** Only the latest is applied; the earlier ones are superseded. A held domain still gets delisted. Test in Task 2.
4. **A schedule row whose values break V5/V6.** The row is `failed`, the domain is untouched, and an audit row is written. Test in Task 2.
5. **Downtime across a due date.** The startup run applies what is due (catch-up), still only the latest event per domain. Covered by Task 2's PR-23 shape and Task 3's startup call.

## Self-review notes

- **Spec coverage:**
  - §10.5 job → Tasks 2 and 3: per-domain lock, skips when not listed or on hold, the apply steps, idempotency, no outbound calls, `failed` rows, delist.
  - §10.7 export flags → Tasks 1 and 4.
  - export-csv E-10–E-12 → Task 4.
  - §10.4: hold lift → Task 2; delist cancels → Task 2; sold cancel → 4d (`/sold`), with the job defensively cancelling rows of sold or dropped domains (R6).
- **Deliberately not here:** `/report` `EXPORT_PENDING` and heads-ups (PR-37/38); `drop_date` moves (PR-25); `/sold` (PR-26); offers.
- **Type consistency:**
  - `Venue` and `pendingDomains`/`manualDelist`/`changedColumns` (Task 1) are used by Tasks 2 and 4.
  - `PriceScheduleJob` (Task 2) is used by Task 3 (`app.priceJob`).
