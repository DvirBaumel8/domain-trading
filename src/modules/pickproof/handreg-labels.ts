// F47 (v5.66.0): the datasave step `handregLabels`. For every sealed name that was not registered at the seal, a label at month 6 (week + 182 days) and
// month 12 (week + 365 days): taken (someone registered it and it is not in redemption period / pending delete, the pick-proof rule 7), not_taken, or
// unknown (error or timeout; retried on later runs, at most 5 attempts). Oldest first, at most settings.handreg_labels_max_per_run lookups a run
// (a name due at both horizons is looked up once), 250 ms between live asks, a 429 ends the run. Runs whether or not `pickproof_enabled` is on.
import { sql, type Kysely } from 'kysely';
import { rdapLookup as realRdap, type RdapLookupFn } from '../../core/rdap.js';
import { cachedRdapLookup, cacheTtlMs } from '../../core/rdap-cache.js';
import type { Database } from '../../db/types.js';
import { HANDREG_PAUSE_MS, handregSettings, HORIZONS, takenOf, type Horizon } from './handreg.js';

export const HANDREG_MAX_ATTEMPTS = 5;

export interface HandregLabelsDeps { db: Kysely<Database>; now: () => number; rdap?: RdapLookupFn; sleep?: (ms: number) => Promise<void>; log?: { warn: (obj: unknown, msg?: string) => void } }
export interface HandregLabelsSummary { status: 'ok' | 'stopped'; checked_n: number; due_n: number; taken_n?: number; not_taken_n?: number; unknown_n?: number; stopped_reason?: string | null }

export async function handregLabels(deps: HandregLabelsDeps): Promise<HandregLabelsSummary> {
  const { db } = deps;
  const nowMs = deps.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const st = await handregSettings(db);
  // a week is due for m6 when week + 182 <= today, for m12 when week + 365 <= today: week <= today - days
  const due = (await sql<{ week: string; domain: string; horizon: Horizon }>`
    select n.week::text as week, n.domain, h.horizon
    from handreg_names n
    cross join (values ('m6', ${HORIZONS.m6}::int), ('m12', ${HORIZONS.m12}::int)) as h(horizon, days)
    left join handreg_labels l on l.week = n.week and l.domain = n.domain and l.horizon = h.horizon
    where n.rdap_at_seal <> 'registered' and n.week <= (${today}::date - h.days)
      and (l.week is null or (l.label = 'unknown' and l.attempts < ${HANDREG_MAX_ATTEMPTS}))
    order by n.week, h.days, n.domain`.execute(db)).rows;
  if (due.length === 0) return { status: 'ok', checked_n: 0, due_n: 0 };

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const live = deps.rdap ?? realRdap;
  let liveN = 0;
  const paced: RdapLookupFn = async (d, o) => { if (liveN++ > 0) await sleep(HANDREG_PAUSE_MS); return live(d, o); };
  const look = cachedRdapLookup(db, paced, { now: deps.now, ttlMs: await cacheTtlMs(db) });

  const out: HandregLabelsSummary = { status: 'ok', checked_n: 0, due_n: due.length, taken_n: 0, not_taken_n: 0, unknown_n: 0, stopped_reason: null };
  const seen = new Map<string, Awaited<ReturnType<RdapLookupFn>>>();
  for (const e of due) {
    let r = seen.get(e.domain);
    if (!r) {
      if (seen.size >= st.labelsMaxPerRun) { out.stopped_reason = 'CAP'; break; }
      r = await look(e.domain);
      seen.set(e.domain, r);
    }
    if (r.reasonCode === 'RATE_LIMITED') { out.stopped_reason = 'RATE_LIMITED'; break; } // the registry asked us to slow down: the rest waits for the next run
    let label: 'taken' | 'not_taken' | 'unknown';
    let reason: string | null = null;
    if (r.outcome === 'registered') label = takenOf(r.facts?.statuses ?? []) ? 'taken' : 'not_taken';
    else if (r.outcome === 'not_registered') label = 'not_taken';
    else { label = 'unknown'; reason = r.reasonCode ?? 'SOURCE_ERROR'; }
    const created = r.facts?.created_at ? new Date(r.facts.created_at) : null;
    await db.insertInto('handreg_labels').values({ week: e.week, domain: e.domain, horizon: e.horizon, label, checked_at: new Date(nowMs), created_at_rdap: created, reason, attempts: 1 })
      .onConflict((oc) => oc.columns(['week', 'domain', 'horizon']).doUpdateSet((eb) => ({ label: eb.ref('excluded.label'), checked_at: eb.ref('excluded.checked_at'), created_at_rdap: eb.ref('excluded.created_at_rdap'), reason: eb.ref('excluded.reason'), attempts: sql`handreg_labels.attempts + 1` }))).execute();
    out.checked_n++;
    if (label === 'taken') out.taken_n!++; else if (label === 'not_taken') out.not_taken_n!++; else out.unknown_n!++;
  }
  if (out.stopped_reason) out.status = 'stopped';
  return out;
}
