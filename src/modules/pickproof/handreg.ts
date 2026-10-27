// F47 (v5.66.0): the hand-registration paper test. Each week the bots submit a pool of currently unregistered .com names they considered and their
// picks from it. The server draws a same-size random control from the rest of the pool in the same call (so the bots never see the control first),
// seals both, and months later (handreg-labels.ts) labels every name: did someone else register it, did it sell. A proxy, not profit.
// No money, no buying, no AI. The only outside call is the public RDAP host. Rules and test ids: docs/internal/handreg.md.
import { randomInt } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { addDays } from '../../core/dates.js';
import { MT19937, shuffle } from '../../core/mt19937.js';
import { dropStatusOf, rdapLookup as realRdap, type RdapLookupFn } from '../../core/rdap.js';
import { cachedRdapLookup, cacheTtlMs } from '../../core/rdap-cache.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { byteOrder } from './draw.js';
import { sha256Hex } from './recipe.js';
import { fisherGreater } from './stats.js';

export const HANDREG_PAUSE_MS = 250;
export const HORIZONS = { m6: 182, m12: 365 } as const;
export type Horizon = keyof typeof HORIZONS;
export const UNPOWERED_EVENTS = 10;

export interface HandregDeps { db: Kysely<Database>; now: () => number; rdap?: RdapLookupFn; sleep?: (ms: number) => Promise<void> }
type Db = Kysely<Database>;

/** The Monday (UTC) of the week that contains `ms`. */
export function mondayOf(ms: number): string {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(d.toISOString().slice(0, 10), -dow);
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.com$/;
/** Trim, lowercase; null when it is not a plain `.com` name (letters, digits and hyphens in the SLD, no leading or trailing hyphen). */
export function normalizeName(s: string): string | null {
  const n = s.trim().toLowerCase();
  return NAME.test(n) ? n : null;
}

export const poolSha = (sortedPool: readonly string[]): string => sha256Hex(JSON.stringify(sortedPool));
export const controlSha = (control: readonly string[]): string => sha256Hex(JSON.stringify(control));

/**
 * The control: the pool without the picks, byte-order sorted, shuffled by Fisher-Yates (i from n-1 down to 1, j = below(i+1)) with MT19937 initialised by
 * the array [seed] (the pickproof recipe, CR-008 Appendix B); the first `n` names in that order, rank = position from 1.
 */
export function drawControl(pool: readonly string[], picks: readonly string[], seed: number, n: number): string[] {
  const chosen = new Set(picks);
  const sub = pool.filter((d) => !chosen.has(d)).sort(byteOrder);
  shuffle(sub, new MT19937([seed >>> 0]));
  return sub.slice(0, n);
}

/** Validates and normalises a submission; the pool comes back sorted (byte order) and de-duplicated. Throws AppError. */
export function validateSubmission(input: { pool: string[]; picks: string[] }, maxPool: number, maxPicks: number): { pool: string[]; picks: string[] } {
  const bad: string[] = [];
  const pool = new Set<string>();
  for (const raw of input.pool) { const n = normalizeName(raw); if (n === null) bad.push(raw); else pool.add(n); }
  const picks: string[] = [];
  for (const raw of input.picks) { const n = normalizeName(raw); if (n === null) bad.push(raw); else picks.push(n); }
  if (bad.length > 0) throw new AppError(422, 'VALIDATION_ERROR', `${bad.length} name(s) are not plain .com names (letters, digits, hyphens)`, { names: bad.slice(0, 100) });
  if (pool.size > maxPool) throw new AppError(422, 'VALIDATION_ERROR', `The pool has at most ${maxPool} names`, { max_pool: maxPool });
  if (picks.length > maxPicks) throw new AppError(422, 'VALIDATION_ERROR', `At most ${maxPicks} picks a week`, { max_picks: maxPicks });
  if (new Set(picks).size !== picks.length) throw new AppError(422, 'VALIDATION_ERROR', 'The picks list has a name twice');
  const outside = picks.filter((p) => !pool.has(p));
  if (outside.length > 0) throw new AppError(422, 'NOT_IN_POOL', `${outside.length} pick(s) are not in the pool`, { names: outside.slice(0, 100), not_in_pool_n: outside.length });
  if (pool.size < 2 * picks.length) throw new AppError(422, 'HANDREG_POOL_TOO_SMALL', `The pool needs at least twice as many names as picks (${pool.size} < ${2 * picks.length}) so a same-size control exists`, { pool_n: pool.size, picks_n: picks.length, needed: 2 * picks.length });
  return { pool: [...pool].sort(byteOrder), picks };
}

export async function handregSettings(db: Db) {
  const s = await db.selectFrom('settings').select(['handreg_max_pool', 'handreg_max_picks', 'handreg_labels_max_per_run']).executeTakeFirstOrThrow();
  return { maxPool: s.handreg_max_pool, maxPicks: s.handreg_max_picks, labelsMaxPerRun: s.handreg_labels_max_per_run };
}

const sealedError = (week: string, sealedAt: Date) => new AppError(409, 'HANDREG_WEEK_SEALED', `Week ${week} already has a sealed submission; one submission per week, nothing changed`, { week, sealed_at: sealedAt.toISOString() });

export async function submitWeek(deps: HandregDeps, input: { pool: string[]; picks: string[]; dryRun: boolean; by: string; auditId: string | null }) {
  const { db } = deps;
  const st = await handregSettings(db);
  const v = validateSubmission(input, st.maxPool, st.maxPicks);
  const nowMs = deps.now();
  const week = mondayOf(nowMs);
  const existing = await db.selectFrom('handreg_weeks').select('sealed_at').where('week', '=', week).executeTakeFirst();
  if (existing) throw sealedError(week, existing.sealed_at);
  const base = { week, pool_n: v.pool.length, picks_n: v.picks.length, control_n: v.picks.length, pool_sha256: poolSha(v.pool) };
  if (input.dryRun) return { dry_run: true as const, ...base };

  const seed = randomInt(2 ** 32);
  const control = drawControl(v.pool, v.picks, seed, v.picks.length);
  const rdapAt = await rdapAtSeal(deps, [...v.picks, ...control]);
  const rows = [
    ...v.picks.map((domain, i) => ({ week, domain, arm: 'pick' as const, rank: i + 1, rdap_at_seal: rdapAt.get(domain)! })),
    ...control.map((domain, i) => ({ week, domain, arm: 'control' as const, rank: i + 1, rdap_at_seal: rdapAt.get(domain)! })),
  ];
  const cSha = controlSha(control);
  try {
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('handreg_weeks').values({ week, pool_n: v.pool.length, pool_sha256: base.pool_sha256, picks_n: v.picks.length, seed, control_sha256: cSha, submitted_by: input.by, sealed_at: new Date(nowMs) }).execute();
      await tx.insertInto('handreg_names').values(rows).execute();
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') { // a parallel submission won the week
      const w = await db.selectFrom('handreg_weeks').select('sealed_at').where('week', '=', week).executeTakeFirst();
      if (w) throw sealedError(week, w.sealed_at);
    }
    throw e;
  }
  return { dry_run: false as const, ...base, control_sha256: cSha, seed, registered_at_seal_n: rows.filter((r) => r.rdap_at_seal === 'registered').length };
}

/** RDAP state of each name at the moment of the seal. Cached lookup, 250 ms between live asks; a 429 stops asking; any error is `unknown`, never a failure. */
async function rdapAtSeal(deps: HandregDeps, names: string[]): Promise<Map<string, 'available' | 'registered' | 'unknown'>> {
  const out = new Map<string, 'available' | 'registered' | 'unknown'>(names.map((n) => [n, 'unknown'] as const));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const live = deps.rdap ?? realRdap;
  let liveN = 0;
  try {
    const paced: RdapLookupFn = async (d, o) => { if (liveN++ > 0) await sleep(HANDREG_PAUSE_MS); return live(d, o); };
    const look = cachedRdapLookup(deps.db, paced, { now: deps.now, ttlMs: await cacheTtlMs(deps.db) });
    for (const n of names) {
      const r = await look(n);
      if (r.outcome === 'registered') out.set(n, 'registered');
      else if (r.outcome === 'not_registered') out.set(n, 'available');
      if (r.reasonCode === 'RATE_LIMITED') break;
    }
  } catch { /* the seal never fails because of the registry */ }
  return out;
}

export async function listWeeks(db: Db) {
  const rows = await sql<{ week: string; pool_n: number; picks_n: number; sealed_at: Date; submitted_by: string; registered_at_seal_n: number; labels_n: number }>`
    select w.week::text as week, w.pool_n, w.picks_n, w.sealed_at, w.submitted_by,
      (select count(*)::int from handreg_names n where n.week = w.week and n.rdap_at_seal = 'registered') as registered_at_seal_n,
      (select count(*)::int from handreg_labels l where l.week = w.week) as labels_n
    from handreg_weeks w order by w.week desc`.execute(db);
  return { weeks: rows.rows.map((r) => ({ week: r.week, pool_n: r.pool_n, picks_n: r.picks_n, control_n: r.picks_n, registered_at_seal_n: r.registered_at_seal_n, labels_n: r.labels_n, submitted_by: r.submitted_by, sealed_at: r.sealed_at.toISOString() })) };
}

export async function weekView(db: Db, week: string) {
  const w = await db.selectFrom('handreg_weeks').selectAll().where('week', '=', week).executeTakeFirst();
  if (!w) throw new AppError(404, 'HANDREG_WEEK_NOT_FOUND', `No sealed hand-registration week ${week}`, { week });
  const names = await db.selectFrom('handreg_names').select(['domain', 'arm', 'rank', 'rdap_at_seal']).where('week', '=', week).orderBy('arm', 'desc').orderBy('rank').execute();
  const labels = await db.selectFrom('handreg_labels').selectAll().where('week', '=', week).orderBy('horizon').orderBy('domain').execute();
  return {
    week: w.week, pool_n: w.pool_n, pool_sha256: w.pool_sha256, picks_n: w.picks_n, control_n: w.picks_n, seed: Number(w.seed), control_sha256: w.control_sha256,
    submitted_by: w.submitted_by, sealed_at: w.sealed_at.toISOString(),
    names,
    labels: labels.map((l) => ({ domain: l.domain, horizon: l.horizon, label: l.label, checked_at: l.checked_at.toISOString(), created_at_rdap: l.created_at_rdap ? l.created_at_rdap.toISOString() : null, reason: l.reason, attempts: l.attempts })),
  };
}

interface Arm { n: number; labelled_n: number; taken_n: number; taken_pct: number | null; sold_n: number; unknown_n: number; pending_n: number }

/** Picks against the random control, per horizon. Names registered at the seal are left out of `n` (they were never available). `sold_n` counts names with a sale dated after the week and up to its horizon end. */
export async function report(db: Db) {
  const rows = (await sql<{ horizon: Horizon; arm: 'pick' | 'control'; n: number; labelled_n: number; taken_n: number; unknown_n: number; sold_n: number }>`
    select h.horizon, n.arm,
      count(*)::int as n,
      count(*) filter (where l.label in ('taken', 'not_taken'))::int as labelled_n,
      count(*) filter (where l.label = 'taken')::int as taken_n,
      count(*) filter (where l.label = 'unknown')::int as unknown_n,
      count(*) filter (where exists (select 1 from market_sales s where s.name = n.domain and s.sale_date > n.week and s.sale_date <= n.week + h.days)
                          or exists (select 1 from engine_sales s where s.domain = n.domain and s.sale_date > n.week and s.sale_date <= n.week + h.days))::int as sold_n
    from handreg_names n
    cross join (values ('m6', ${HORIZONS.m6}::int), ('m12', ${HORIZONS.m12}::int)) as h(horizon, days)
    left join handreg_labels l on l.week = n.week and l.domain = n.domain and l.horizon = h.horizon
    where n.rdap_at_seal <> 'registered'
    group by h.horizon, n.arm`.execute(db)).rows;
  const weeks = (await sql<{ n: number; registered: number }>`select (select count(*)::int from handreg_weeks) as n, (select count(*)::int from handreg_names where rdap_at_seal = 'registered') as registered`.execute(db)).rows[0]!;
  const empty = (): Arm => ({ n: 0, labelled_n: 0, taken_n: 0, taken_pct: null, sold_n: 0, unknown_n: 0, pending_n: 0 });
  const horizons = {} as Record<Horizon, { picks: Arm; control: Arm; comparison: { status: 'OK' | 'UNPOWERED'; events_n: number; fisher_p: number | null } }>;
  for (const h of Object.keys(HORIZONS) as Horizon[]) {
    const arm = (a: 'pick' | 'control'): Arm => {
      const r = rows.find((x) => x.horizon === h && x.arm === a);
      if (!r) return empty();
      return { n: r.n, labelled_n: r.labelled_n, taken_n: r.taken_n, taken_pct: r.labelled_n > 0 ? Math.round((r.taken_n / r.labelled_n) * 10000) / 100 : null, sold_n: r.sold_n, unknown_n: r.unknown_n, pending_n: r.n - r.labelled_n - r.unknown_n };
    };
    const picks = arm('pick'), control = arm('control');
    const events = picks.taken_n + control.taken_n;
    const powered = events >= UNPOWERED_EVENTS && picks.labelled_n > 0 && control.labelled_n > 0;
    horizons[h] = {
      picks, control,
      comparison: { status: powered ? 'OK' : 'UNPOWERED', events_n: events, fisher_p: powered ? fisherGreater({ a: picks.taken_n, b: picks.labelled_n - picks.taken_n, c: control.taken_n, d: control.labelled_n - control.taken_n }) : null },
    };
  }
  return { weeks_n: weeks.n, registered_at_seal_n: weeks.registered, horizons, note: 'proxy, not profit' };
}

/** Same rule as the pick-proof labels: taken = registered and not in redemption period or pending delete. Exported for handreg-labels.ts. */
export const takenOf = (statuses: readonly string[]): boolean => dropStatusOf(statuses) === null;
