// v5.47.0 (F5): the database side of the lift model: the training step `liftTrain` (daily, after engineTrain), the stored tables (`lift_models`), the frozen seed
// file and GET /engine/lift. The maths is in lift.ts. Rules and test ids: docs/internal/engine.md "Lift model".
//   rows   = engine_sales with price >= $100 (sold) and engine_unsold dropped_after_held, not caught by a catcher (unsold), both in the engine's regime
//            (letters only, 6..20 characters, 2..3 words by the engine split); features as of the sale / observation day.
//   seed   = data/lift-seed/cr002.jsonl (CR-002's 767 reported sales and 988 SnapNames pending-delete names), used alone until our own data has LIFT_MIN_OWN_PER_CLASS rows in
//            each class, then blended: seed weight = 1 at the minimum, falling straight to 0 at LIFT_SEED_FADE_ROWS own rows per class.
//   retrain only when the data grew: the key holds the newest engine_sales and engine_unsold ids, the seed's sha256 and the model version.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { chunks } from '../../core/chunks.js';
import { idtDay } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { splitV2, type SplitV2Table } from '../selection/index.js';
import { baseSplitTable, loadExtraTerms, loadSales, loadUnsold } from './data.js';
import { ENDING_FEATURE_TLDS, extendedTable, inRegime, sldOf, type EndingFact, type EngineTld } from './features.js';
import {
  BIN_ORDER, PATTERNS, type LabelledInput, type LiftBins, type LiftInput, LIFT_MIN_OWN_PER_CLASS, LIFT_VERSION, crossValidatedAuc, inHoldout, liftAuc, parseSeed, seedWeight, trainBins,
  type SeedRow,
} from './lift.js';

const SEED_FILE = fileURLToPath(new URL('../../../data/lift-seed/cr002.jsonl', import.meta.url));
const MIN_SALE_CENTS = 10_000;
const DAY_MS = 86_400_000;

let seedCache: { rows: SeedRow[]; sha256: string } | null | undefined;
/** The frozen CR-002 seed; null when the file is missing (the model then needs our own rows). */
export function loadLiftSeed(file: string = SEED_FILE): { rows: SeedRow[]; sha256: string } | null {
  if (file === SEED_FILE && seedCache !== undefined) return seedCache;
  let txt: string;
  try { txt = readFileSync(file, 'utf8'); } catch { if (file === SEED_FILE) seedCache = null; return null; }
  const out = { rows: parseSeed(txt), sha256: createHash('sha256').update(txt).digest('hex') };
  if (file === SEED_FILE) seedCache = out;
  return out;
}

type Facts = Partial<Record<EngineTld, EndingFact>> | undefined;

/** The lift inputs of a name as of a day: other endings registered before it, and the share of the other endings registered (any date). */
export function liftInputFor(sld: string, words: number | null, facts: Facts, asOfMs: number): LiftInput {
  let known = 0; let registered = 0; let before = 0; let beforeKnown = 0;
  for (const tld of ENDING_FEATURE_TLDS) {
    const f = facts?.[tld];
    if (!f || f.registered === null) continue;
    known++;
    if (f.registered) registered++;
    // a registered ending without a creation date is not placed in time (the same rule as the engine's `*_pit` features)
    if (!f.registered) beforeKnown++;
    else if (f.createdMs !== null) { beforeKnown++; if (f.createdMs < asOfMs) before++; }
  }
  return { len: sld.length, words, endings_before: beforeKnown > 0 ? before : null, registered_share: known > 0 ? registered / known : null, past_site: null };
}

interface OwnRow { key: string; input: LiftInput; sold: boolean }

async function endingsFor(db: Kysely<Database>, names: string[]): Promise<Map<string, Partial<Record<EngineTld, EndingFact>>>> {
  const out = new Map<string, Partial<Record<EngineTld, EndingFact>>>();
  for (const part of chunks(names, 5_000)) {
    const rows = (await sql<{ name: string; tld: EngineTld; registered: boolean | null; created_at_registry: Date | null }>`
      select distinct on (name, tld) name, tld, registered, created_at_registry from engine_endings where name = any(${part}::text[]) order by name, tld, checked_at desc, id desc`.execute(db)).rows;
    for (const r of rows) (out.get(r.name) ?? out.set(r.name, {}).get(r.name)!)[r.tld] = { registered: r.registered, createdMs: r.created_at_registry ? r.created_at_registry.getTime() : null };
  }
  return out;
}

/** Our own labelled rows (in the regime). */
export async function loadOwnLiftRows(db: Kysely<Database>, table: SplitV2Table): Promise<OwnRow[]> {
  const [sales, unsold] = [await loadSales(db), await loadUnsold(db)];
  const inReg = new Map<string, boolean>();
  const reg = (d: string): boolean => inReg.get(d) ?? inReg.set(d, inRegime(sldOf(d), table)).get(d)!;
  const picked = [
    ...sales.filter((s) => s.price_cents >= MIN_SALE_CENTS && reg(s.domain)).map((s) => ({ domain: s.domain, day: s.sale_date, sold: true })),
    ...unsold.filter((u) => u.type === 'dropped_after_held' && u.caught_by_catcher !== true && reg(u.domain)).map((u) => ({ domain: u.domain, day: u.observation_date, sold: false })),
  ];
  const facts = await endingsFor(db, [...new Set(picked.map((p) => sldOf(p.domain)))]);
  return picked.map((p) => {
    const sld = sldOf(p.domain);
    return { key: `${p.domain}|${p.day}`, sold: p.sold, input: liftInputFor(sld, splitV2(sld, table).length, facts.get(sld), Date.parse(`${p.day}T00:00:00Z`)) };
  });
}

export interface TrainedLift { bins: LiftBins; source: 'seed' | 'blend'; auc: number | null; holdout_n: number; own_sold: number; own_unsold: number; seed_sold: number; seed_unsold: number; seed_weight: number }

/** Pure: the table, the holdout AUC and the blend from our own rows and the seed (see the header). Null when there is not enough to train on. */
export function trainLift(own: readonly OwnRow[], seed: readonly SeedRow[] | null): TrainedLift | null {
  const ownSold = own.filter((r) => r.sold).length;
  const ownUnsold = own.length - ownSold;
  const ownEnough = Math.min(ownSold, ownUnsold) >= LIFT_MIN_OWN_PER_CLASS;
  const seedRows = seed ?? [];
  if (!ownEnough && seedRows.length === 0) return null;
  const w = ownEnough ? (seedRows.length > 0 ? seedWeight(Math.min(ownSold, ownUnsold)) : 0) : 1;
  const seedL: Array<LabelledInput & { key: string }> = seedRows.map((r, i) => ({ key: `seed:${i}`, sold: r.label === 'sold', weight: w, input: { len: r.len, words: r.words, endings_before: r.endings_before, registered_share: r.registered_share, past_site: r.past_site } }));
  const ownL: Array<LabelledInput & { key: string }> = ownEnough ? own.map((r) => ({ key: r.key, sold: r.sold, weight: 1, input: r.input })) : [];
  const all = [...ownL, ...seedL];
  const bins = trainBins(all);
  // the holdout comes from the primary source (ours when it is in use, else the seed); the table it is scored by never saw those rows
  const primary = ownEnough ? ownL : seedL;
  const held = primary.filter((r) => inHoldout(r.key));
  const heldKeys = new Set(held.map((r) => r.key));
  const auc = held.length === 0 ? null : liftAuc(trainBins(all.filter((r) => !heldKeys.has(r.key))), held);
  return {
    bins, source: ownEnough ? 'blend' : 'seed', auc, holdout_n: held.length, own_sold: ownSold, own_unsold: ownUnsold,
    seed_sold: seedRows.filter((r) => r.label === 'sold').length, seed_unsold: seedRows.filter((r) => r.label !== 'sold').length, seed_weight: w,
  };
}

/** 5-fold cross-validated AUC of the seed alone (the reproduction check of the backtest, 0.80 on 25 Oct 2026). */
export function seedCrossValidatedAuc(seed: readonly SeedRow[]): number | null {
  return crossValidatedAuc(seed.map((r, i) => ({ key: `seed:${i}`, sold: r.label === 'sold', input: { len: r.len, words: r.words, endings_before: r.endings_before, registered_share: r.registered_share, past_site: r.past_site } })));
}

export interface LiftModel {
  id: string; version: string; trained_at: Date; data_key: string; source: 'seed' | 'blend'; sold_n: number; unsold_n: number; seed_sold_n: number; seed_unsold_n: number; seed_weight: number;
  holdout_n: number; auc: number | null; bins: LiftBins;
}

/** The newest stored table, or null before the first training. */
export async function loadLiftModel(db: Kysely<Database>): Promise<LiftModel | null> {
  const r = await db.selectFrom('lift_models').selectAll().orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!r) return null;
  return {
    id: String(r.id), version: r.version, trained_at: r.trained_at, data_key: r.data_key, source: r.source, sold_n: r.sold_n, unsold_n: r.unsold_n, seed_sold_n: r.seed_sold_n, seed_unsold_n: r.seed_unsold_n,
    seed_weight: r.seed_weight, holdout_n: r.holdout_n, auc: r.auc, bins: r.bins as unknown as LiftBins,
  };
}

/** The extended split table the engine uses (frozen table + the regime and tech list terms). */
export async function liftTable(db: Kysely<Database>): Promise<SplitV2Table> {
  return extendedTable(baseSplitTable(), await loadExtraTerms(db));
}

/** The daily step `liftTrain`: trains when the data grew since the stored table (or none is stored), appends one `lift_models` row. */
export class LiftTrainJob {
  constructor(private readonly deps: { db: Kysely<Database>; now: () => number; log?: { warn: (obj: unknown, msg?: string) => void }; seedFile?: string }) {}

  async runOnce(): Promise<Record<string, unknown>> {
    const { db } = this.deps;
    const seed = loadLiftSeed(this.deps.seedFile);
    const ids = (await sql<{ s: string | null; u: string | null }>`select (select max(id) from engine_sales)::text as s, (select max(id) from engine_unsold)::text as u`.execute(db)).rows[0]!;
    const dataKey = `${LIFT_VERSION}|sales:${ids.s ?? 0}|unsold:${ids.u ?? 0}|seed:${seed?.sha256.slice(0, 16) ?? 'none'}`;
    const last = await loadLiftModel(db);
    if (last && last.data_key === dataKey) return { skipped: true, reason: 'no new sales or unsold rows since the stored table', model_id: last.id };
    const table = await liftTable(db);
    const own = await loadOwnLiftRows(db, table);
    const t = trainLift(own, seed?.rows ?? null);
    if (!t) return { skipped: true, reason: `no seed file and fewer than ${LIFT_MIN_OWN_PER_CLASS} own rows per class`, own_rows: own.length };
    const row = await db.insertInto('lift_models').values({
      version: LIFT_VERSION, trained_at: new Date(this.deps.now()), data_key: dataKey, source: t.source, sold_n: t.own_sold, unsold_n: t.own_unsold, seed_sold_n: t.seed_sold, seed_unsold_n: t.seed_unsold,
      seed_weight: t.seed_weight, holdout_n: t.holdout_n, auc: t.auc, bins: JSON.stringify(t.bins),
    }).returning('id').executeTakeFirstOrThrow();
    return { trained: true, model_id: String(row.id), version: LIFT_VERSION, source: t.source, own_sold: t.own_sold, own_unsold: t.own_unsold, seed_weight: t.seed_weight, auc: t.auc, holdout_n: t.holdout_n, trained_on: idtDay(this.deps.now()) };
  }
}

/** GET /engine/lift. */
export async function liftView(db: Kysely<Database>, nowMs: number) {
  const m = await loadLiftModel(db);
  if (!m) return { model: null, note: 'no lift table yet: the daily step liftTrain trains one from the CR-002 seed and our own sales and unsold rows' };
  // jsonb does not keep key order: the patterns and bins are listed in their fixed order
  const patterns = PATTERNS.map((pattern) => ({
    pattern, totals: m.bins.totals[pattern],
    bins: BIN_ORDER[pattern].filter((bin) => m.bins.bins[pattern]?.[bin]).map((bin) => { const b = m.bins.bins[pattern][bin]!; return { bin, sold: b.sold, unsold: b.unsold, lift: b.lift, thin: b.thin === true }; }),
  }));
  return {
    model: {
      id: Number(m.id), version: m.version, trained_at: m.trained_at.toISOString(), age_days: Math.floor((nowMs - m.trained_at.getTime()) / DAY_MS), source: m.source,
      counts: { own_sold: m.sold_n, own_unsold: m.unsold_n, seed_sold: m.seed_sold_n, seed_unsold: m.seed_unsold_n }, seed_weight: m.seed_weight,
      auc: m.auc, auc_holdout_n: m.holdout_n, cap: 2, patterns,
    },
    note: 'lift = ln(smoothed share of sold names in the bin / smoothed share of unsold names in the bin), capped at +-2; score = 100 / (1 + e^-(sum of the name\'s lifts)). The seed is CR-002 (reported sales, SnapNames pending-delete names).',
  };
}
