// CR-075 (v5.23.0) R-6: GET /market/matched. Each positive (a sold episode with sale_date <= asof) gets up to `ratio` negatives (UNSOLD_60D) of the same price band,
// both .com, the same letters-only flag, whose listing overlaps a 60-day window centred on the sale date. The draw is seeded and the set is frozen: the first call
// for (asof, ratio, seed) stores it with a sha256 over its canonical JSON, later calls return the stored set whatever the data has become since.
import { sql, type Kysely } from 'kysely';
import { withAdvisoryLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { canonicalJson } from '../../http/canonical-json.js';
import { addDays, lettersOnly, sha256 } from './common.js';
import { CLEAN_FEATURES, episodeOut, type MarketRow } from './read.js';

export const MATCH_HALF_WINDOW_DAYS = 30;
export const MATCH_RULE = 'm1';

/** mulberry32, seeded from sha256 text, so one positive's draw never depends on the others or on row order. */
function rng(text: string): () => number {
  let a = Buffer.from(sha256(text), 'hex').readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = MarketRow;

export interface MatchedSet {
  asof: string; ratio: number; seed: number; rule: string;
  summary: { positives_n: number; negatives_n: number; unmatched_positives_n: number; excluded_leakage_n: number };
  pairs: { positive: Record<string, unknown>; window: { from: string; to: string }; negatives: Record<string, unknown>[] }[];
}

export async function buildMatched(db: Kysely<Database>, asof: string, ratio: number, seed: number): Promise<MatchedSet> {
  const positives = await db.selectFrom('market_names').selectAll().where('outcome', '=', 'sold').where('tld', '=', 'com').where('sale_date', '<=', asof).where(CLEAN_FEATURES).orderBy('episode_id').execute();
  const pool = await db.selectFrom('market_names').selectAll().where('outcome', '=', 'unsold').where('outcome_rule', '=', 'UNSOLD_60D').where('tld', '=', 'com')
    .where('first_seen', '<=', addDays(asof, -60)).where(CLEAN_FEATURES).orderBy('episode_id').execute();
  const leak = await db.selectFrom('market_names').select((eb) => eb.fn.countAll<number>().as('n')).where(sql<boolean>`not ${CLEAN_FEATURES}`)
    .where((eb) => eb.or([eb.and([eb('outcome', '=', 'sold'), eb('sale_date', '<=', asof)]), eb.and([eb('outcome', '=', 'unsold'), eb('outcome_rule', '=', 'UNSOLD_60D')])])).where('tld', '=', 'com').executeTakeFirstOrThrow();
  const used = new Set<string>();
  const pairs: MatchedSet['pairs'] = [];
  let negatives = 0;
  for (const p of positives) {
    const from = addDays(p.sale_date!, -MATCH_HALF_WINDOW_DAYS);
    const to = addDays(p.sale_date!, MATCH_HALF_WINDOW_DAYS);
    const cands = pool.filter((n: Row) => !used.has(n.episode_id) && n.price_band === p.price_band && lettersOnly(n.sld) === lettersOnly(p.sld) && n.name !== p.name && n.last_seen >= from && n.first_seen <= to);
    const r = rng(`${asof}|${ratio}|${seed}|${p.episode_id}`);
    for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cands[i], cands[j]] = [cands[j]!, cands[i]!]; }
    const take = cands.slice(0, ratio);
    for (const n of take) used.add(n.episode_id);
    negatives += take.length;
    pairs.push({ positive: episodeOut(p), window: { from, to }, negatives: take.map(episodeOut) });
  }
  return {
    asof, ratio, seed, rule: MATCH_RULE,
    summary: { positives_n: positives.length, negatives_n: negatives, unmatched_positives_n: pairs.filter((x) => x.negatives.length === 0).length, excluded_leakage_n: Number(leak.n) },
    pairs,
  };
}

export async function matchedSet(db: Kysely<Database>, q: { asof: string; ratio: number; seed: number }) {
  const read = async (d: Kysely<Database>) => d.selectFrom('market_matched_sets').selectAll().where('asof', '=', q.asof).where('ratio', '=', q.ratio).where('seed', '=', q.seed).executeTakeFirst();
  const out = (r: { payload: unknown; sha256: string; created_at: Date }, frozen: boolean) => ({ ...(r.payload as MatchedSet), sha256: r.sha256, frozen, frozen_at: r.created_at.toISOString() });
  const stored = await read(db);
  if (stored) return out(stored, true);
  return withAdvisoryLock(db, 'market_matched', async (t) => {
    const trx = t as unknown as Kysely<Database>;
    const again = await read(trx);
    if (again) return out(again, true);
    const set = await buildMatched(trx, q.asof, q.ratio, q.seed);
    const sha = sha256(canonicalJson(set));
    const ins = await trx.insertInto('market_matched_sets').values({ asof: q.asof, ratio: q.ratio, seed: q.seed, sha256: sha, payload: JSON.stringify(set) }).returningAll().executeTakeFirstOrThrow();
    return out(ins, true);
  });
}
