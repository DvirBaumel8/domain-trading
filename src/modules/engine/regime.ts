// v5.41.0: the engine's regime test (letters only, 6..20 characters, 2..3 real words) as a ready-to-use function, for callers outside the engine
// (the datasave steps use it to spend their lookups on trainable names first). Same table as training and scoring: the frozen split table plus the
// current `regime` and `tech` list terms.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { baseSplitTable, loadExtraTerms } from './data.js';
import { extendedTable, inRegime, sldOf } from './features.js';

export type RegimeTest = (domain: string) => boolean;

export async function loadRegimeTest(db: Kysely<Database>): Promise<RegimeTest> {
  const table = extendedTable(baseSplitTable(), await loadExtraTerms(db));
  const memo = new Map<string, boolean>();
  return (domain) => memo.get(domain) ?? memo.set(domain, inRegime(sldOf(domain), table)).get(domain)!;
}
