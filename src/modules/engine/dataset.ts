// The training set of the engine: which uploaded rows are sold (label 1) and which are unsold (label 0), the time split, and the frozen test file.
// Rules (CR-056, DOM's answer): sold = .com sale of $100 or more in the regime; unsold = dropped-after-held, not caught by a catcher, in the regime.
// Test = the sold rows of the newest full calendar quarter that has any; train = every sold row before it. The test file is hashed (sha256) before training.
import { createHash } from 'node:crypto';
import { dayNumber } from '../../core/dates.js';
import type { SplitV2Table } from '../selection/index.js';
import { UNSOLD_DATED_DAYS, type SaleRow, type UnsoldRow } from './data.js';
import { inRegime, sldOf } from './features.js';
import { hashUnit } from './model/rng.js';

export const MIN_SALE_CENTS = 10_000;
/** Unsold rows kept per sold row in the test file (a mix of at least this many unsold per sale; all of them when fewer exist). */
export const TEST_UNSOLD_PER_SALE = 3;
/** Training keeps at most this many unsold rows per sold row (deterministic hash order); it only bites once the daily unsold uploads have piled up. */
export const TRAIN_UNSOLD_PER_SALE_MAX = 10;
/** Without this many days of dated unsold rows, a seeded hash puts this share of the unsold rows into the test file. */
export const HASH_TEST_SHARE = 0.2;

export interface Row { domain: string; label: 0 | 1; asOf: string; priceCents: number | null }

export interface Quarter { label: string; from: string; to: string }

const pad = (n: number): string => String(n).padStart(2, '0');
/** The calendar quarter holding a YYYY-MM-DD day: label 2026-Q3, from 2026-07-01, to (exclusive) 2026-10-01. */
export function quarterOf(day: string): Quarter {
  const y = Number(day.slice(0, 4)); const q = Math.floor((Number(day.slice(5, 7)) - 1) / 3);
  const from = `${y}-${pad(q * 3 + 1)}-01`;
  const to = q === 3 ? `${y + 1}-01-01` : `${y}-${pad(q * 3 + 4)}-01`;
  return { label: `${y}-Q${q + 1}`, from, to };
}

export class DataError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

export interface EngineDataset {
  quarter: Quarter;
  unsoldMode: 'dated' | 'hash';
  trainSold: Row[]; trainUnsold: Row[]; testSold: Row[]; testUnsold: Row[];
  testSha256: string;
  counts: Record<string, number>;
}

export const frozenHash = (rows: readonly Row[]): string =>
  createHash('sha256').update(rows.map((r) => `${r.domain}|${r.label}|${r.asOf}`).sort().join('\n')).digest('hex');

const byHash = (seed: number, tag: string) => (a: Row, b: Row): number => {
  const ha = hashUnit(`${seed}:${tag}:${a.domain}|${a.asOf}`); const hb = hashUnit(`${seed}:${tag}:${b.domain}|${b.asOf}`);
  return ha - hb || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0);
};

export interface BuildOptions { table: SplitV2Table; today: string; seed: number; minTrainPerClass?: number; minTestPerClass?: number }

export function buildDataset(sales: readonly SaleRow[], unsold: readonly UnsoldRow[], o: BuildOptions): EngineDataset {
  const minTrain = o.minTrainPerClass ?? 20; const minTest = o.minTestPerClass ?? 5;
  const regime = new Map<string, boolean>();
  const inReg = (domain: string): boolean => regime.get(domain) ?? regime.set(domain, inRegime(sldOf(domain), o.table)).get(domain)!;
  const soldAll: Row[] = sales.filter((s) => s.price_cents >= MIN_SALE_CENTS && inReg(s.domain)).map((s) => ({ domain: s.domain, label: 1 as const, asOf: s.sale_date, priceCents: s.price_cents }));
  const unsoldAll: Row[] = unsold.filter((u) => u.type === 'dropped_after_held' && u.caught_by_catcher !== true && inReg(u.domain)).map((u) => ({ domain: u.domain, label: 0 as const, asOf: u.observation_date, priceCents: null }));
  const counts: Record<string, number> = {
    sales_rows: sales.length, sold_eligible: soldAll.length, unsold_rows: unsold.length, unsold_eligible: unsoldAll.length,
    registered_unsold_not_used: unsold.filter((u) => u.type === 'registered_unsold').length,
    dropped_caught_by_catcher_excluded: unsold.filter((u) => u.type === 'dropped_after_held' && u.caught_by_catcher === true).length,
  };
  // the newest full calendar quarter (one that ended before today) with a sale
  let quarter: Quarter | null = null;
  for (const s of soldAll) {
    const q = quarterOf(s.asOf);
    if (q.to <= o.today && (quarter === null || q.from > quarter.from)) quarter = q;
  }
  if (!quarter) throw new DataError('NOT_ENOUGH_DATA', 'No full calendar quarter with sales in the regime yet', { sold_eligible: soldAll.length });
  const q = quarter;
  const testSold = soldAll.filter((s) => s.asOf >= q.from && s.asOf < q.to);
  const trainSold = soldAll.filter((s) => s.asOf < q.from);
  // unsold: dated split when the rows span enough days and the quarter has some, else a seeded hash
  let hi = -Infinity; let lo = Infinity; // loop, not Math.max(...spread): the row count can pass the argument limit
  for (const u of unsoldAll) { const n = dayNumber(u.asOf); if (n > hi) hi = n; if (n < lo) lo = n; }
  const span = unsoldAll.length ? hi - lo : 0;
  const unsoldMode: 'dated' | 'hash' = span >= UNSOLD_DATED_DAYS && unsoldAll.some((u) => u.asOf >= q.from && u.asOf < q.to) ? 'dated' : 'hash';
  let testUnsoldAll: Row[]; let trainUnsoldAll: Row[];
  if (unsoldMode === 'dated') {
    testUnsoldAll = unsoldAll.filter((u) => u.asOf >= q.from && u.asOf < q.to);
    trainUnsoldAll = unsoldAll.filter((u) => u.asOf < q.from);
  } else {
    testUnsoldAll = unsoldAll.filter((u) => hashUnit(`${o.seed}:${u.domain}`) < HASH_TEST_SHARE);
    trainUnsoldAll = unsoldAll.filter((u) => hashUnit(`${o.seed}:${u.domain}`) >= HASH_TEST_SHARE);
  }
  const testCap = TEST_UNSOLD_PER_SALE * testSold.length;
  const testUnsold = testUnsoldAll.length > testCap ? [...testUnsoldAll].sort(byHash(o.seed, 'test')).slice(0, testCap) : testUnsoldAll;
  const trainCap = TRAIN_UNSOLD_PER_SALE_MAX * trainSold.length;
  const trainUnsold = trainUnsoldAll.length > trainCap ? [...trainUnsoldAll].sort(byHash(o.seed, 'train')).slice(0, trainCap) : trainUnsoldAll;
  Object.assign(counts, {
    train_sold: trainSold.length, train_unsold: trainUnsold.length, train_unsold_available: trainUnsoldAll.length, test_sold: testSold.length, test_unsold: testUnsold.length, test_unsold_available: testUnsoldAll.length,
  });
  if (trainSold.length < minTrain || trainUnsold.length < minTrain || testSold.length < minTest || testUnsold.length < minTest) {
    throw new DataError('NOT_ENOUGH_DATA', 'Too few rows to train and test', { ...counts, need_train_per_class: minTrain, need_test_per_class: minTest, quarter: q.label });
  }
  return { quarter: q, unsoldMode, trainSold, trainUnsold, testSold, testUnsold, testSha256: frozenHash([...testSold, ...testUnsold]), counts };
}
