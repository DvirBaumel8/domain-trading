// v5.46.0: the unsold feed for GoDaddy closeout names that stayed on the list to their end date (nobody bought them, even at the lowest price). Called by the datasave step
// `buildPanel` after `tagDisappearances`; `engineFeed` turns the `dropped` rows into engine_unsold. Rules: docs/internal/closeouts.md "Closeout expiries".
//   1. collect: names of the stored pool days (datasave_pool, GoDaddy closeouts, .com, IN THE ENGINE'S REGIME ONLY) whose end time is inside the next
//      `datasave_pool_keep_days` days, or already past, get one row per (name, end time) while the pool still holds them (the pool keeps only a few days). `on conflict do nothing`.
//      v5.47.0 (F19): without a regime test nothing is collected (the 25 Oct first run stored 151,563 names, 21 MB); never-checked rows of names outside the regime are deleted.
//   2. check: Verisign .com RDAP, first `closeout_expiry_wait_days` after the end day (IDT), then every `closeout_expiry_recheck_days` until the name is decided or
//      `closeout_expiry_max_days` have passed. At most the lookups the disappearance tags left of the shared per-run cap (`capLeft`), in-regime names first, never-checked first.
//      Names that left the list before their end (a `disappearances` row) are not here: they have their own tag.
//   3. `expiryTagOf` is the rule. dropped (final) = 404, a redemption / pending-delete status, or a registration created after the end time (a catcher got it).
//      held (final) = still registered and the expiry date moved more than 90 days past the end time (bought and renewed). Otherwise pending; unknown at the max day.
//   4. prune rows older than settings.disappearance_keep_days after the end day.
//   v5.49.0 (P1): collect keeps at most `closeout_expiry_collect_max` (1000) NEW names per run, the smallest md5(domain) first (deterministic, unbiased: the hash does not know the name's value);
//      never-checked open rows whose end date is older than today - `closeout_expiry_max_days` are deleted (`stale_deleted_n`): they can no more be decided.
//   5. v5.47.0 (F19): delete decided rows `closeout_expiry_keep_days` (7) after they were fed (dropped) or decided (held, unknown). A fed row is needed no more, and the pool
//      no longer holds the name by then (the keep is at least the pool keep + 1 day), so it is not collected again.
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { addDays, idtDay } from '../../../core/dates.js';
import { dropStatusOf, RDAP_COM_BASE, rdapLookup as realRdap, type RdapLookup, type RdapLookupFn } from '../../../core/rdap.js';
import { type CachedAnswer, cacheGetMany, cachePutMany, cacheTtlMs, lookupFromCache } from '../../../core/rdap-cache.js';
import { chunks } from '../../../core/chunks.js';
import type { Database } from '../../../db/types.js';
import { hostPacer } from '../../selection/index.js';
import { TAG_CONCURRENCY } from './disappearances.js';

const DAY = 86_400_000;
export const RENEWED_MIN_DAYS = 90;
export const POOL_SOURCE = 'godaddy_closeouts';

export type ExpiryTag = 'pending' | 'dropped' | 'held' | 'unknown';
export interface ExpiryVerdict { tag: ExpiryTag; reason: string; final: boolean; caught: boolean | null }

/** The rule (see the header). `daysSinceEnd` is whole days from the end time to now. */
export function expiryTagOf(r: RdapLookup, endsAtMs: number, daysSinceEnd: number, maxDays: number): ExpiryVerdict {
  const late = daysSinceEnd >= maxDays;
  if (r.outcome === 'not_registered') return { tag: 'dropped', reason: 'NOT_REGISTERED', final: true, caught: false };
  if (r.outcome === 'unknown') return late ? { tag: 'unknown', reason: r.reasonCode ?? 'SOURCE_ERROR', final: true, caught: null } : { tag: 'pending', reason: r.reasonCode ?? 'SOURCE_ERROR', final: false, caught: null };
  const f = r.facts;
  const drop = dropStatusOf(f?.statuses ?? []);
  if (drop) return { tag: 'dropped', reason: `STATUS:${drop}`, final: true, caught: null };
  if (f?.created_at && Date.parse(f.created_at) > endsAtMs) return { tag: 'dropped', reason: 'RE_REGISTERED', final: true, caught: true };
  if (f?.expires_at && Date.parse(f.expires_at) > endsAtMs + RENEWED_MIN_DAYS * DAY) return { tag: 'held', reason: 'RENEWED', final: true, caught: null };
  return late ? { tag: 'unknown', reason: 'STILL_REGISTERED_AT_MAX_DAYS', final: true, caught: null } : { tag: 'pending', reason: 'STILL_REGISTERED', final: false, caught: null };
}

export interface ExpiryDeps { db: Kysely<Database>; now: () => number; rdap?: RdapLookupFn; sleep?: (ms: number) => Promise<void>; regime?: (domain: string) => boolean; capLeft: number }
export interface ExpirySummary {
  status: 'ok' | 'stopped' | 'nothing_due';
  collected_n: number; due_n: number; regime_due_n: number; lookups_n: number; cache_hits_n: number; cap_left: number; stopped_reason: string | null;
  dropped_n: number; held_n: number; pending_n: number; unknown_n: number; caught_n: number; open_n: number; pruned_n: number;
  /** v5.47.0 */
  regime_loaded: boolean; out_of_regime_deleted_n: number; decided_deleted_n: number;
  /** v5.49.0 (P1) */
  stale_deleted_n: number; sample_max: number; eligible_new_n: number;
}

/** v5.49.0 (P1): the md5 of the name as lowercase hex; the sample order (the same as Postgres md5(domain)). */
export const md5Of = (domain: string): string => createHash('md5').update(domain).digest('hex');

/** Step 1. Bulk: one select of the candidate rows that are not stored yet, the regime filter, the md5 sample, one multi-row insert per 5,000. Returns the rows inserted and the new regime names seen. */
async function collect(db: Kysely<Database>, nowMs: number, keepDays: number, sampleMax: number, regime?: (d: string) => boolean): Promise<{ inserted: number; eligible: number }> {
  if (!regime) return { inserted: 0, eligible: 0 }; // v5.47.0: never collect without the regime test
  const horizon = new Date(nowMs + keepDays * DAY);
  const rows = (await sql<{ domain: string; ends_at: Date }>`select distinct on (p.domain, p.ends_at) p.domain, p.ends_at from datasave_pool p
    where p.source = ${POOL_SOURCE} and p.domain like '%.com' and p.ends_at <= ${horizon}
      and not exists (select 1 from closeout_expiries e where e.domain = p.domain and e.ends_at = p.ends_at)`.execute(db)).rows;
  const inRegime = rows.filter((r) => regime(r.domain));
  // P1: at most `sampleMax` new names a run, the smallest md5 first (ties by name and end time)
  const keep = inRegime.map((r) => ({ r, h: md5Of(r.domain) })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.r.domain < b.r.domain ? -1 : a.r.domain > b.r.domain ? 1 : a.r.ends_at.getTime() - b.r.ends_at.getTime())).slice(0, sampleMax).map((x) => x.r);
  const today = idtDay(nowMs);
  let n = 0;
  for (const part of chunks(keep, 5_000)) {
    const res = await sql`insert into closeout_expiries (domain, ends_at, ends_on, first_seen_on)
      select u.domain, u.ends_at, (u.ends_at at time zone 'Asia/Jerusalem')::date, ${today}::date
      from unnest(${part.map((x) => x.domain)}::text[], ${part.map((x) => x.ends_at)}::timestamptz[]) as u(domain, ends_at) on conflict do nothing`.execute(db);
    n += Number(res.numAffectedRows ?? 0);
  }
  return { inserted: n, eligible: inRegime.length };
}

/** F19: rows that were never asked and are not in the engine's regime are junk (collected before v5.47.0); one select, one delete per 5,000. */
async function deleteOutOfRegime(db: Kysely<Database>, regime: (d: string) => boolean): Promise<number> {
  const open = (await sql<{ domain: string }>`select distinct domain from closeout_expiries where attempts = 0 and not final`.execute(db)).rows;
  const junk = open.filter((r) => !regime(r.domain)).map((r) => r.domain);
  let n = 0;
  for (const part of chunks(junk, 5_000)) {
    const res = await sql`delete from closeout_expiries where attempts = 0 and not final and domain = any(${part}::text[])`.execute(db);
    n += Number(res.numAffectedRows ?? 0);
  }
  return n;
}

export async function checkExpiries(deps: ExpiryDeps): Promise<ExpirySummary> {
  const { db } = deps;
  const rdap = deps.rdap ?? realRdap;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = deps.now();
  const now = new Date(nowMs);
  const today = idtDay(nowMs);
  const st = await db.selectFrom('settings').select(['closeout_expiry_wait_days', 'closeout_expiry_recheck_days', 'closeout_expiry_max_days', 'datasave_pool_keep_days', 'disappearance_keep_days', 'closeout_expiry_keep_days', 'closeout_expiry_collect_max']).executeTakeFirstOrThrow();
  const out: ExpirySummary = {
    status: 'nothing_due', collected_n: 0, due_n: 0, regime_due_n: 0, lookups_n: 0, cache_hits_n: 0, cap_left: Math.max(0, deps.capLeft), stopped_reason: null,
    dropped_n: 0, held_n: 0, pending_n: 0, unknown_n: 0, caught_n: 0, open_n: 0, pruned_n: 0, regime_loaded: deps.regime !== undefined, out_of_regime_deleted_n: 0, decided_deleted_n: 0,
    stale_deleted_n: 0, sample_max: st.closeout_expiry_collect_max, eligible_new_n: 0,
  };
  if (deps.regime) out.out_of_regime_deleted_n = await deleteOutOfRegime(db, deps.regime);
  // P1: a never-checked row whose end date is older than the max window can no more be decided
  const stale = await sql`delete from closeout_expiries where attempts = 0 and not final and ends_on < ${addDays(today, -st.closeout_expiry_max_days)}::date`.execute(db);
  out.stale_deleted_n = Number(stale.numAffectedRows ?? 0);
  const col = await collect(db, nowMs, st.datasave_pool_keep_days, st.closeout_expiry_collect_max, deps.regime);
  out.collected_n = col.inserted;
  out.eligible_new_n = col.eligible;

  // due: open, the wait is over, and not checked within the recheck interval (IDT days); names that left the list early have their own tag
  const waitCut = addDays(today, -st.closeout_expiry_wait_days);
  const recheckCut = new Date(nowMs - st.closeout_expiry_recheck_days * DAY + 60 * 60_000);
  const due = (await sql<{ domain: string; ends_at: Date; ends_on: string; attempts: number }>`
    select e.domain, e.ends_at, e.ends_on::text as ends_on, e.attempts from closeout_expiries e
    where not e.final and e.ends_on <= ${waitCut}::date and (e.rdap_checked_at is null or e.rdap_checked_at < ${recheckCut})
      and not exists (select 1 from disappearances d where d.source = ${POOL_SOURCE} and d.domain = e.domain and d.gone_date <= e.ends_on)
    order by (e.attempts > 0), e.ends_on, e.domain`.execute(db)).rows;
  out.due_n = due.length;
  if (deps.regime) {
    const flag = new Map<string, boolean>();
    for (const d of due) if (!flag.has(d.domain)) flag.set(d.domain, deps.regime(d.domain));
    out.regime_due_n = due.filter((d) => flag.get(d.domain)).length;
    due.sort((a, b) => Number(flag.get(b.domain)) - Number(flag.get(a.domain)));
  }

  const ttl = await cacheTtlMs(db);
  let hits = new Map<string, CachedAnswer>();
  if (ttl > 0 && due.length > 0) { try { hits = await cacheGetMany(db, [...new Set(due.map((d) => d.domain))], ttl, nowMs); } catch { /* the cache is an optimisation */ } }
  const pace = hostPacer(new URL(RDAP_COM_BASE).host, sleep);
  type Upd = { domain: string; ends_at: Date; v: ExpiryVerdict; checked: boolean; registrar: string | null; statuses: string | null; created: string | null; expires: string | null };
  let pending: Upd[] = [];
  let toCache: Array<{ domain: string; r: RdapLookup }> = [];
  const flush = async (): Promise<void> => {
    const rows = pending; pending = [];
    const puts = toCache; toCache = [];
    for (const part of chunks(rows, 300)) {
      await sql`update closeout_expiries t set tag = u.tag, tag_reason = u.reason, final = u.final, caught = u.caught, attempts = t.attempts + 1,
        rdap_checked_at = case when u.checked then ${now}::timestamptz else t.rdap_checked_at end,
        rdap_registrar = u.registrar, rdap_statuses = u.statuses::jsonb, rdap_created = u.created, rdap_expires = u.expires
        from unnest(${part.map((x) => x.domain)}::text[], ${part.map((x) => x.ends_at)}::timestamptz[], ${part.map((x) => x.v.tag)}::text[], ${part.map((x) => x.v.reason)}::text[],
          ${part.map((x) => x.v.final)}::bool[], ${part.map((x) => x.v.caught)}::bool[], ${part.map((x) => x.checked)}::bool[], ${part.map((x) => x.registrar)}::text[],
          ${part.map((x) => x.statuses)}::text[], ${part.map((x) => x.created)}::timestamptz[], ${part.map((x) => x.expires)}::timestamptz[])
          as u(domain, ends_at, tag, reason, final, caught, checked, registrar, statuses, created, expires)
        where t.domain = u.domain and t.ends_at = u.ends_at`.execute(db);
    }
    try { await cachePutMany(db, puts, nowMs); } catch { /* the cache is an optimisation */ }
  };
  let next = 0;
  let halt = false;
  let probe: Promise<void> | undefined;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halt) return;
      const d = due[next++];
      if (!d) return;
      const endsMs = d.ends_at.getTime();
      const daysSinceEnd = Math.floor((nowMs - endsMs) / DAY);
      // a stored answer counts only if it was read after the wait after the end time is over
      const floor = Math.max(endsMs + st.closeout_expiry_wait_days * DAY, nowMs - ttl);
      const hit = hits.get(d.domain);
      let r: RdapLookup;
      let live = false;
      if (hit && hit.checkedAt.getTime() >= floor) { r = lookupFromCache(hit); out.cache_hits_n++; } else {
        if (probe) { await probe; if (halt) return; }
        if (out.lookups_n >= out.cap_left) { out.stopped_reason ??= 'CAP'; halt = true; return; }
        if (pace.breakerOpen) { out.stopped_reason ??= 'RATE_LIMITED'; halt = true; return; }
        out.lookups_n++;
        let release: () => void = () => {};
        if (!probe) probe = new Promise<void>((resolve) => { release = resolve; });
        let res: RdapLookup;
        try { res = await pace.run(() => rdap(d.domain)); } finally { release(); }
        if (res.reasonCode === 'RATE_LIMITED' || res.httpStatus === 429 || res.httpStatus === 403) pace.slowDown(); else pace.noteNotRefused();
        r = res; live = true;
        toCache.push({ domain: d.domain, r });
      }
      const v = expiryTagOf(r, endsMs, daysSinceEnd, st.closeout_expiry_max_days);
      const f = r.outcome === 'registered' ? r.facts : null;
      // an error answer is not a check: the name is asked again on the next run
      pending.push({ domain: d.domain, ends_at: d.ends_at, v, checked: r.outcome !== 'unknown' || v.final, registrar: f?.registrar ?? null, statuses: f ? JSON.stringify(f.statuses) : null, created: f?.created_at ?? null, expires: f?.expires_at ?? null });
      if (v.tag === 'dropped') { out.dropped_n++; if (v.caught) out.caught_n++; } else if (v.tag === 'held') out.held_n++; else if (v.tag === 'unknown') out.unknown_n++; else out.pending_n++;
      if (live && r.reasonCode === 'RATE_LIMITED') { out.stopped_reason ??= 'RATE_LIMITED'; halt = true; }
      if (pending.length >= 300) await flush();
    }
  };
  try {
    await Promise.all(Array.from({ length: TAG_CONCURRENCY }, worker));
  } finally {
    await flush();
  }
  if (out.due_n > 0) out.status = out.stopped_reason ? 'stopped' : 'ok';
  out.open_n = Number((await sql<{ n: string }>`select count(*)::text as n from closeout_expiries where not final`.execute(db)).rows[0]!.n);
  const del = await sql`delete from closeout_expiries where ends_on < ${addDays(today, -st.disappearance_keep_days)}::date`.execute(db);
  out.pruned_n = Number(del.numAffectedRows ?? 0);
  // F19: decided rows go after the short keep. The keep is never shorter than the pool keep + 1 day, so a fed name is not collected again from the pool.
  const keepDecided = Math.max(st.closeout_expiry_keep_days, st.datasave_pool_keep_days + 1);
  const cut = new Date(nowMs - keepDecided * DAY);
  const gone = await sql`delete from closeout_expiries where final and (
      (tag = 'dropped' and fed_at is not null and fed_at < ${cut}) or (tag in ('held', 'unknown') and coalesce(rdap_checked_at, created_at) < ${cut}))`.execute(db);
  out.decided_deleted_n = Number(gone.numAffectedRows ?? 0);
  return out;
}
