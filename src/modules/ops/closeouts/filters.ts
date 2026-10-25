// v5.26.0 (CR-072 R-2): the hard filters of the closeout and drop candidates. First failing code wins, in this order:
//   1 SPELL-1  2 BRAND-1  3 BIGCO-1  4 TM_KILL   (selection `closeoutNameChecker`: form, brand list, bigco list + bigco_names, tm_kills)
//   5 FORBIDDEN_TERM  (an active, not retired `forbidden_terms` term is inside the name)
//   6 DIGITS_OR_HYPHEN  (setting `closeouts_filter_digits_hyphen`, default on)
//   7 OWNED  (the name is in `domains`, any status)
//   8 SALES_GRADED  (the name has a row in `engine_sales`, or a `market_names` episode with outcome sold)
// Pure after loading: classify() makes no database call and no network call.
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { closeoutNameChecker, termKey } from '../../selection/index.js';

export const FILTER_CODES = ['SPELL-1', 'BRAND-1', 'BIGCO-1', 'TM_KILL', 'FORBIDDEN_TERM', 'DIGITS_OR_HYPHEN', 'OWNED', 'SALES_GRADED'] as const;
export type FilterCode = (typeof FILTER_CODES)[number];

export interface Classifier { classify(domain: string): { code: FilterCode | null; words: string[] } }

/** Terms that are the target of a later row (`supersedes`) are replaced; the rest are current. */
export async function currentTerms(db: Kysely<Database>, table: 'tm_kills' | 'bigco_names'): Promise<string[]> {
  const col = table === 'tm_kills' ? 'term' : 'name';
  const rows = await (db.selectFrom(table as 'tm_kills') as never as { select(c: string[]): { execute(): Promise<Record<string, unknown>[]> } }).select(['id', col, 'supersedes']).execute();
  const replaced = new Set(rows.map((r) => r.supersedes).filter((x) => x !== null).map(Number));
  return rows.filter((r) => !replaced.has(Number(r.id))).map((r) => String(r[col]));
}

export async function buildClassifier(db: Kysely<Database>): Promise<Classifier> {
  const [bigcoNames, tmKills] = [await currentTerms(db, 'bigco_names'), await currentTerms(db, 'tm_kills')];
  const names = await closeoutNameChecker(db, { bigcoNames, tmKills });
  const forbidden = (await db.selectFrom('forbidden_terms as t').leftJoin('forbidden_term_retirements as r', 'r.term_id', 't.id').select('t.term').where('r.id', 'is', null).execute())
    .map((r) => termKey(r.term)).filter((t) => t !== '');
  const digitsHyphen = (await db.selectFrom('settings').select('closeouts_filter_digits_hyphen').executeTakeFirstOrThrow()).closeouts_filter_digits_hyphen;
  const owned = new Set((await db.selectFrom('domains').select('domain').execute()).map((r) => r.domain.toLowerCase()));
  const graded = new Set<string>();
  for (const r of await db.selectFrom('engine_sales').select('domain').distinct().execute()) graded.add(r.domain.toLowerCase());
  for (const r of await db.selectFrom('market_names').select('name').distinct().where('outcome', '=', 'sold').execute()) graded.add(r.name.toLowerCase());
  return {
    classify(raw) {
      const domain = raw.trim().toLowerCase();
      const v = names.check(domain);
      if (v.code) return { code: v.code, words: v.words };
      const sld = domain.endsWith('.com') ? domain.slice(0, -4) : domain;
      const key = termKey(sld);
      if (forbidden.some((t) => key.includes(t))) return { code: 'FORBIDDEN_TERM', words: v.words };
      if (digitsHyphen && /[0-9-]/.test(sld)) return { code: 'DIGITS_OR_HYPHEN', words: v.words };
      if (owned.has(domain)) return { code: 'OWNED', words: v.words };
      if (graded.has(domain)) return { code: 'SALES_GRADED', words: v.words };
      return { code: null, words: v.words };
    },
  };
}
