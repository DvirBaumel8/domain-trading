// A small synthetic data set for the scoring-engine tests: two-word names from the frozen split table, sold ones built from one half of a word pool
// and unsold ones mostly from the other half, with a noisy .net signal. Deterministic.
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/types.js';
import { baseSplitTable } from '../../src/modules/engine/data.js';
import { makeRng } from '../../src/modules/engine/model/rng.js';
import { splitV2 } from '../../src/modules/selection/index.js';

export function wordPool(n: number): string[] {
  const t = baseSplitTable();
  return [...t.cost.entries()].filter(([w, c]) => c <= 10 && /^[a-z]{4,6}$/.test(w)).map(([w]) => w).sort().filter((_, i) => i % 7 === 0).slice(0, n);
}

export function namesFrom(a: string[], b: string[], count: number, rng: () => number, used: Set<string>): string[] {
  const t = baseSplitTable();
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard++ < 100_000) {
    const x = a[Math.floor(rng() * a.length)]!; const y = b[Math.floor(rng() * b.length)]!;
    const name = `${x}${y}`;
    if (used.has(name) || name.length < 6 || name.length > 20) continue;
    const s = splitV2(name, t);
    if (s.length !== 2 || s[0] !== x || s[1] !== y) continue;
    used.add(name); out.push(name);
  }
  return out;
}

export interface EngineSeed { sold: { domain: string; date: string; cents: number }[]; unsold: string[] }

export async function seedEngineData(db: Kysely<Database>, o: { soldTrain?: number; soldTest?: number; unsold?: number; testFrom?: string } = {}): Promise<EngineSeed> {
  const rng = makeRng(99);
  const pool = wordPool(60);
  const A = pool.slice(0, 30); const B = pool.slice(30);
  const used = new Set<string>();
  const nTrain = o.soldTrain ?? 150; const nTest = o.soldTest ?? 40; const nUnsold = o.unsold ?? 600;
  const soldNames = namesFrom(A, A, nTrain + nTest, rng, used);
  const unsoldNames = [...namesFrom(B, B, Math.floor(nUnsold * 0.8), rng, used), ...namesFrom(A, B, nUnsold - Math.floor(nUnsold * 0.8), rng, used)];
  const up = await db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 0, accepted_n: 0, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'test', audit_id: null, created_at: new Date('2026-10-10T00:00:00Z') }).returning('id').executeTakeFirstOrThrow();
  const prices = [15_000, 40_000, 90_000, 250_000, 800_000, 3_000_000];
  const day = (i: number, from: string, span: number) => new Date(Date.parse(`${from}T00:00:00Z`) + (i % span) * 86_400_000).toISOString().slice(0, 10);
  const sold = soldNames.map((n, i) => ({
    domain: `${n}.com`, cents: prices[Math.floor(rng() * prices.length)]!,
    date: i < nTrain ? day(i, '2025-10-01', 270) : day(i, o.testFrom ?? '2026-07-01', 90),
  }));
  await db.insertInto('engine_sales').values(sold.map((s) => ({ domain: s.domain, price_cents: s.cents, sale_date: s.date, venue: 'v', source: 's', source_url: null, upload_id: up.id }))).execute();
  await db.insertInto('engine_unsold').values(unsoldNames.map((n) => ({ domain: `${n}.com`, type: 'dropped_after_held' as const, observation_date: '2026-10-08', caught_by_catcher: null, upload_id: up.id }))).execute();
  // a noisy .net signal: most sold names have a .net registered long ago; a few unsold do too. Only sold names have a .com answer.
  const endings: { name: string; tld: 'net' | 'com'; registered: boolean; created_at_registry: Date | null; checked_at: Date; http_status: number; reason_code: null; evidence: null }[] = [];
  const row = (name: string, tld: 'net' | 'com', registered: boolean, created: string | null) => ({ name, tld, registered, created_at_registry: registered && created ? new Date(`${created}T00:00:00Z`) : null, checked_at: new Date('2026-10-12T00:00:00Z'), http_status: registered ? 200 : 404, reason_code: null, evidence: null });
  for (const n of soldNames) { endings.push(row(n, 'net', rng() < 0.85, '2018-03-03')); endings.push(row(n, 'com', true, '2020-05-05')); }
  for (const n of unsoldNames) endings.push(row(n, 'net', rng() < 0.15, '2018-03-03'));
  for (let i = 0; i < endings.length; i += 500) await db.insertInto('engine_endings').values(endings.slice(i, i + 500)).execute();
  return { sold, unsold: unsoldNames.map((n) => `${n}.com`) };
}

/** Smaller models so a test trains in a couple of seconds. */
export const FAST_TRAIN = { gbmParams: { maxIter: 40, minSamplesLeaf: 5 }, tierParams: { maxIter: 20, minSamplesLeaf: 5 }, bootstrapResamples: 100 } as const;
