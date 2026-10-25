// CR-073 R-4 (as changed by DOM): the datasave step `pickproofLabels`. T30 ("taken in 30 days") for every name in the union of the sealed arms whose
// pick day D is at least 30 days old and that has no final label yet. Every name is checked the same way, with no arm attached (the test stays blind).
//   Verisign .com RDAP (src/core/rdap.ts `rdapLookup`), one lookup at a time with a pause, at most settings.pickproof_labels_max_per_run lookups a run.
//   registered, status not redemption period / pending delete -> taken (creation date and created_after_d are stored for the Challenger, they do not decide)
//   registered in redemption period or pending delete (an unsold closeout) -> not_taken
//   not registered (404)                  -> not_taken
//   error or timeout                      -> unknown, tried again on later runs until D+40, then it stays unknown. Never read as not_taken.
// Also shrinks pickproof_pool (v5.47.0, F18): a SEALED day older than settings.pickproof_pool_keep_days keeps only the rows of names that are in one of its arms; the labels and the
// report need only the arms, and the pool's sha256 and every arm's sha256 stay in pickproof_days. One day per statement.
import { sql, type Kysely } from 'kysely';
import { chunks } from '../../core/chunks.js';
import { addDays, dayNumber } from '../../core/dates.js';
import { dropStatusOf, rdapLookup as realRdap, type RdapLookupFn } from '../../core/rdap.js';
import { type CachedAnswer, cacheGetMany, cachePutMany, cacheTtlMs, lookupFromCache } from '../../core/rdap-cache.js';
import type { Database } from '../../db/types.js';
import { pickproofSettings } from './pool.js';

export const LABEL_AFTER_DAYS = 30;
export const LABEL_RETRY_UNTIL_DAYS = 40;
export const LABEL_PAUSE_MS = 250;

export interface LabelsDeps { db: Kysely<Database>; now: () => number; rdap?: RdapLookupFn; sleep?: (ms: number) => Promise<void>; log?: { warn: (obj: unknown, msg?: string) => void } }
export interface LabelsSummary {
  status: 'ok' | 'stopped' | 'nothing_due'; eligible_n: number; lookups_n: number; taken_n: number; not_taken_n: number; unknown_n: number; created_unknown_n: number;
  cap: number; stopped_reason: string | null; pool_rows_deleted_n: number;
}

export async function pickproofLabels(deps: LabelsDeps): Promise<LabelsSummary> {
  const { db } = deps;
  // CR-074: through the shared RDAP cache (an answer up to lookups_rdap_ttl_hours old is fine for a T30 label); a live answer fills it. Never counts against the bot limit.
  // v5.42.0: the cache is read once for the names this run can reach and written once at the end (multi-row), not one query per name.
  const live = deps.rdap ?? realRdap;
  const ttlMs = await cacheTtlMs(db);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const st = await pickproofSettings(db);
  const nowMs = deps.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const out: LabelsSummary = { status: 'nothing_due', eligible_n: 0, lookups_n: 0, taken_n: 0, not_taken_n: 0, unknown_n: 0, created_unknown_n: 0, cap: st.labelsMaxPerRun, stopped_reason: null, pool_rows_deleted_n: 0 };

  const cutoff = addDays(today, -LABEL_AFTER_DAYS);
  const retryFrom = addDays(today, -LABEL_RETRY_UNTIL_DAYS);
  // never labelled first (oldest day first), then the unknown ones that are still inside D+40
  const due = (await sql<{ domain: string; day: string }>`
    select distinct a.domain, a.day::text as day, (l.domain is not null) as retry
    from pickproof_arms a join pickproof_days d on d.day = a.day and d.sealed_at is not null
    left join pickproof_labels l on l.domain = a.domain and l.day = a.day
    where a.day <= ${cutoff}::date and (l.domain is null or (l.label = 'unknown' and a.day >= ${retryFrom}::date))
    order by 3, 2, 1`.execute(db)).rows;
  out.eligible_n = due.length;

  const reach = [...new Set(due.map((e) => e.domain))].slice(0, st.labelsMaxPerRun);
  let hits = new Map<string, CachedAnswer>();
  try { hits = await cacheGetMany(db, reach, ttlMs, nowMs); } catch { /* the cache is an optimisation */ }
  const toCache: Array<{ domain: string; r: Awaited<ReturnType<RdapLookupFn>> }> = [];
  type LabelRow = { domain: string; day: string; label: 'taken' | 'not_taken' | 'unknown'; checked_at: Date; attempts: number; created_at_rdap: string | null; created_unknown: boolean; created_after_d: boolean | null; statuses: string | null; reason: string | null };
  let pending: LabelRow[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const rows = pending; pending = [];
    for (const part of chunks(rows, 500)) {
      await db.insertInto('pickproof_labels').values(part).onConflict((oc) => oc.columns(['domain', 'day']).doUpdateSet((eb) => ({
        label: eb.ref('excluded.label'), checked_at: eb.ref('excluded.checked_at'), attempts: sql`pickproof_labels.attempts + 1`,
        created_at_rdap: eb.ref('excluded.created_at_rdap'), created_unknown: eb.ref('excluded.created_unknown'), created_after_d: eb.ref('excluded.created_after_d'), statuses: eb.ref('excluded.statuses'), reason: eb.ref('excluded.reason'),
      }))).execute();
    }
  };

  const seen = new Map<string, Awaited<ReturnType<RdapLookupFn>>>();
  let liveN = 0;
  try {
    for (const e of due) {
      let r = seen.get(e.domain);
      if (!r) {
        if (out.lookups_n >= st.labelsMaxPerRun) { out.stopped_reason = 'CAP'; break; }
        const hit = hits.get(e.domain);
        if (hit) r = lookupFromCache(hit);
        else {
          if (liveN > 0) await sleep(LABEL_PAUSE_MS);
          r = await live(e.domain);
          liveN++;
          toCache.push({ domain: e.domain, r });
        }
        out.lookups_n++;
        seen.set(e.domain, r);
      }
      let label: 'taken' | 'not_taken' | 'unknown';
      let created: string | null = null;
      let createdUnknown = false;
      let reason: string | null = null;
      let afterD: boolean | null = null;
      let statuses: string[] | null = null;
      if (r.outcome === 'registered') {
        created = r.facts?.created_at ?? null;
        statuses = r.facts?.statuses ?? [];
        if (created === null) createdUnknown = true;
        else afterD = dayNumber(created.slice(0, 10)) > dayNumber(e.day);
        // an unsold closeout lingers in redemption period, then pending delete; any other registered state means someone holds the name
        label = dropStatusOf(statuses) !== null ? 'not_taken' : 'taken';
      } else if (r.outcome === 'not_registered') label = 'not_taken';
      else { label = 'unknown'; reason = r.reasonCode ?? 'SOURCE_ERROR'; }
      pending.push({ domain: e.domain, day: e.day, label, checked_at: new Date(nowMs), attempts: 1, created_at_rdap: created, created_unknown: createdUnknown, created_after_d: afterD, statuses: statuses ? JSON.stringify(statuses) : null, reason });
      if (pending.length >= 200) await flush();
      if (label === 'taken') out.taken_n++; else if (label === 'not_taken') out.not_taken_n++; else out.unknown_n++;
      if (createdUnknown) out.created_unknown_n++;
      if (r.reasonCode === 'RATE_LIMITED') { out.stopped_reason = 'RATE_LIMITED'; break; } // the registry asked us to slow down: the rest waits for the next run
    }
  } finally {
    await flush();
    try { await cachePutMany(db, toCache, nowMs); } catch { /* the cache is an optimisation */ }
  }
  if (out.eligible_n > 0) out.status = out.stopped_reason ? 'stopped' : 'ok';

  out.pool_rows_deleted_n = await shrinkPool(db, addDays(today, -st.poolKeepDays));
  return out;
}

/**
 * v5.47.0 (F18): deletes, for every sealed day before `keepFrom`, the pool rows of names that are in no arm of that day. An unsealed day is never touched (its pool is
 * still needed for the draw). Days that have nothing more to delete are skipped by one cheap lookup. Returns the number of rows deleted.
 */
export async function shrinkPool(db: Kysely<Database>, keepFrom: string): Promise<number> {
  const days = (await sql<{ day: string }>`
    select d.day::text as day from pickproof_days d
    where d.sealed_at is not null and d.day < ${keepFrom}::date
      and exists (select 1 from pickproof_pool p where p.day = d.day and not exists (select 1 from pickproof_arms a where a.day = p.day and a.domain = p.domain))
    order by d.day`.execute(db)).rows;
  let n = 0;
  for (const d of days) {
    const r = await sql`delete from pickproof_pool p where p.day = ${d.day}::date and not exists (select 1 from pickproof_arms a where a.day = p.day and a.domain = p.domain)`.execute(db);
    n += Number(r.numAffectedRows ?? 0);
  }
  return n;
}
