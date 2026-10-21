// CR-073 R-5: GET /pickproof/report. Per arm n, events, rate, unknown_n; A against C1 (primary), B1 and B2 (secondary, Holm). Everything is labelled
// "proxy, not profit": a name being registered by someone else within 30 days of a closeout is demand evidence, not a sale and not money.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { ALL_ARMS, sha256Hex, type ArmName } from './recipe.js';
import { cmh, fisherGreater, holm, permutationTest, type PermDay, type Table2x2 } from './stats.js';

export const PROXY_LABEL = 'proxy, not profit';
export const ALPHA = 0.05;
export const MIN_EVENTS = 10;
export const OVERLAP_PERMUTATION_PCT = 5;
export const SHUFFLES = 10_000;
export const BANDS = [
  { band: '$0-9.99', max_cents: 999 },
  { band: '$10-19.99', max_cents: 1999 },
  { band: '$20-40', max_cents: Infinity },
] as const;
const bandOf = (cents: number): string => BANDS.find((b) => cents <= b.max_cents)!.band;

interface Entry { day: string; domain: string; price_cents: number; label: 'taken' | 'not_taken' | 'unknown' | null }
const labelled = (es: Entry[]) => es.filter((e) => e.label === 'taken' || e.label === 'not_taken');

function armStats(es: Entry[]) {
  const l = labelled(es);
  const events = l.filter((e) => e.label === 'taken').length;
  return {
    names_n: es.length, n: l.length, events, rate: l.length > 0 ? events / l.length : null,
    unknown_n: es.filter((e) => e.label === 'unknown').length, pending_n: es.filter((e) => e.label === null).length, label: PROXY_LABEL,
  };
}

export async function report(db: Kysely<Database>, q: { from?: string; to?: string }) {
  const days = (await db.selectFrom('pickproof_days').select(['day', 'pool_sha256', 'arms']).where('sealed_at', 'is not', null)
    .$if(!!q.from, (b) => b.where('day', '>=', q.from!)).$if(!!q.to, (b) => b.where('day', '<=', q.to!)).orderBy('day').execute());
  const dayList = days.map((d) => d.day);
  const rows = dayList.length === 0 ? [] : (await sql<{ day: string; arm: ArmName; domain: string; price_cents: number; label: Entry['label'] }>`
    select a.day::text as day, a.arm, a.domain, a.price_cents, l.label from pickproof_arms a
    left join pickproof_labels l on l.domain = a.domain and l.day = a.day
    where a.day = any(${dayList}::date[]) order by a.day, a.arm, a.rank`.execute(db)).rows;
  const byArm = new Map<ArmName, Entry[]>(ALL_ARMS.map((a) => [a, []]));
  for (const r of rows) byArm.get(r.arm)!.push({ day: r.day, domain: r.domain, price_cents: r.price_cents, label: r.label });

  // the seed of every permutation test comes from the seals of the range, so the same range always gives the same p
  const rangeSeed = (arm: ArmName) => parseInt(sha256Hex(days.map((d) => `${d.day}:${d.pool_sha256}:${(d.arms as Record<string, { sha256: string }>)['A']?.sha256}:${(d.arms as Record<string, { sha256: string }>)[arm]?.sha256}`).join('|')).slice(0, 8), 16) >>> 0;

  const A = byArm.get('A')!;
  const compare = (vs: 'C1' | 'B1' | 'B2', role: 'primary' | 'secondary') => {
    const X = byArm.get(vs)!;
    const la = labelled(A), lx = labelled(X);
    const t: Table2x2 = { a: la.filter((e) => e.label === 'taken').length, b: 0, c: lx.filter((e) => e.label === 'taken').length, d: 0 };
    t.b = la.length - t.a; t.d = lx.length - t.c;
    const xKeys = new Set(X.map((e) => `${e.day}|${e.domain}`));
    const overlapN = A.filter((e) => xKeys.has(`${e.day}|${e.domain}`)).length;
    const overlapPct = A.length > 0 ? (100 * overlapN) / A.length : 0;
    const method: 'fisher' | 'permutation' = overlapPct > OVERLAP_PERMUTATION_PCT ? 'permutation' : 'fisher';
    const base = {
      vs, role, label: PROXY_LABEL, alpha: ALPHA, method, events_a: t.a, events_b: t.c, n_a: la.length, n_b: lx.length,
      rate_a: la.length > 0 ? t.a / la.length : null, rate_b: lx.length > 0 ? t.c / lx.length : null,
      overlap_n: overlapN, overlap_pct: Math.round(overlapPct * 100) / 100, events_total: t.a + t.c,
    };
    if (t.a + t.c < MIN_EVENTS || la.length === 0 || lx.length === 0) {
      return { ...base, status: 'UNPOWERED' as const, p_value: null, p_adjusted: null, result: null, fisher_p: null, permutation: null, cmh: null,
        note: `fewer than ${MIN_EVENTS} events in total (or an empty arm): no pass or fail` };
    }
    const fisherP = fisherGreater(t);
    let permutation: { p_value: number; observed: number; shuffles: number; seed: number } | null = null;
    if (method === 'permutation') {
      const perDay: PermDay[] = [];
      for (const d of dayList) {
        const a = la.filter((e) => e.day === d), x = lx.filter((e) => e.day === d);
        if (a.length === 0 || x.length === 0) continue;
        perDay.push({ outcomes: [...a, ...x].map((e) => (e.label === 'taken' ? 1 : 0)), n1: a.length });
      }
      const seed = rangeSeed(vs);
      permutation = { ...permutationTest(perDay, seed, SHUFFLES), seed };
    }
    const strata = BANDS.map((b) => {
      const inBand = (e: Entry) => bandOf(e.price_cents) === b.band;
      const sa = la.filter(inBand), sx = lx.filter(inBand);
      const a = sa.filter((e) => e.label === 'taken').length, c = sx.filter((e) => e.label === 'taken').length;
      return { band: b.band, a, b: sa.length - a, c, d: sx.length - c };
    });
    const c = cmh(strata);
    const p = method === 'permutation' ? permutation!.p_value : fisherP;
    return { ...base, status: 'OK' as const, p_value: p, p_adjusted: p as number | null, result: (p <= ALPHA ? 'pass' : 'fail') as 'pass' | 'fail' | null, fisher_p: fisherP, permutation,
      cmh: { strata, ...c } };
  };

  const primary = compare('C1', 'primary');
  const secondaries = [compare('B1', 'secondary'), compare('B2', 'secondary')];
  const powered = secondaries.filter((s) => s.status === 'OK');
  const adj = holm(powered.map((s) => s.p_value!));
  powered.forEach((s, i) => { s.p_adjusted = adj[i]!; s.result = adj[i]! <= ALPHA ? 'pass' : 'fail'; });

  const arms: Record<string, unknown> = {};
  for (const a of ALL_ARMS) arms[a] = armStats(byArm.get(a)!);
  arms.C2 = { status: 'not_built' };
  return {
    label: PROXY_LABEL, from: q.from ?? dayList[0] ?? null, to: q.to ?? dayList[dayList.length - 1] ?? null,
    days: { sealed_n: dayList.length, list: dayList }, arms, primary, secondary: secondaries,
    notes: ['unknown labels are excluded from every rate and counted in unknown_n; pending_n are names whose pick day is not 30 days old yet', 'primary: one-sided, alpha 0.05, A has the higher taken rate; secondaries are Holm-adjusted over the powered ones'],
  };
}
