// CR-073 R-4 (as changed by DOM): the datasave step `pickproofLabels`. T30 ("taken in 30 days") for every name in the union of the sealed arms whose
// pick day D is at least 30 days old and that has no final label yet. Every name is checked the same way, with no arm attached (the test stays blind).
//   Verisign .com RDAP (src/core/rdap.ts `rdapLookup`), one lookup at a time with a pause, at most settings.pickproof_labels_max_per_run lookups a run.
//   registered, status not redemption period / pending delete -> taken (creation date and created_after_d are stored for the Challenger, they do not decide)
//   registered in redemption period or pending delete (an unsold closeout) -> not_taken
//   not registered (404)                  -> not_taken
//   error or timeout                      -> unknown, tried again on later runs until D+40, then it stays unknown. Never read as not_taken.
// Also prunes pickproof_pool rows older than settings.pickproof_pool_keep_days (the labels need only the arms).
import { sql, type Kysely } from 'kysely';
import { addDays, dayNumber } from '../../core/dates.js';
import { dropStatusOf, rdapLookup as realRdap, type RdapLookupFn } from '../../core/rdap.js';
import { cacheTtlMs, cachedRdapLookup } from '../../core/rdap-cache.js';
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
  const rdap = cachedRdapLookup(db, deps.rdap ?? realRdap, { now: deps.now, ttlMs: await cacheTtlMs(db) });
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

  const seen = new Map<string, Awaited<ReturnType<RdapLookupFn>>>();
  for (const e of due) {
    let r = seen.get(e.domain);
    if (!r) {
      if (out.lookups_n >= st.labelsMaxPerRun) { out.stopped_reason = 'CAP'; break; }
      if (out.lookups_n > 0) await sleep(LABEL_PAUSE_MS);
      r = await rdap(e.domain);
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
    await sql`insert into pickproof_labels (domain, day, label, checked_at, attempts, created_at_rdap, created_unknown, created_after_d, statuses, reason)
      values (${e.domain}, ${e.day}::date, ${label}, ${new Date(nowMs)}, 1, ${created}::timestamptz, ${createdUnknown}, ${afterD}, ${statuses ? JSON.stringify(statuses) : null}::jsonb, ${reason})
      on conflict (domain, day) do update set label = excluded.label, checked_at = excluded.checked_at, attempts = pickproof_labels.attempts + 1,
        created_at_rdap = excluded.created_at_rdap, created_unknown = excluded.created_unknown, created_after_d = excluded.created_after_d, statuses = excluded.statuses, reason = excluded.reason`.execute(db);
    if (label === 'taken') out.taken_n++; else if (label === 'not_taken') out.not_taken_n++; else out.unknown_n++;
    if (createdUnknown) out.created_unknown_n++;
    if (r.reasonCode === 'RATE_LIMITED') { out.stopped_reason = 'RATE_LIMITED'; break; } // the registry asked us to slow down: the rest waits for the next run
  }
  if (out.eligible_n > 0) out.status = out.stopped_reason ? 'stopped' : 'ok';

  const keepFrom = addDays(today, -st.poolKeepDays);
  const del = await db.deleteFrom('pickproof_pool').where('day', '<', keepFrom).executeTakeFirst();
  out.pool_rows_deleted_n = Number(del.numDeletedRows);
  return out;
}
