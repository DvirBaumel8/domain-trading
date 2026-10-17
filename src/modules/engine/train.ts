// Training of the scoring engine (CR-056 part 2). One run = one engine_models row (running -> done | failed) worked by the queue job `train` (step trainModel).
// The data, the split and the test file are fixed by dataset.ts; the models are the TypeScript ones in model/. No random choice depends on anything but the seed.
import { holdSlices } from './slices.js';
import { sql, type Kysely } from 'kysely';
import { dayNumber, idtDay, toJerusalemIso } from '../../core/dates.js';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { baseSplitTable, countRegisteredUnsold, loadDemand, loadEndings, loadExtraTerms, loadSales, loadUnsold, tokenContext, unsoldSpanDays, UNSOLD_DATED_DAYS } from './data.js';
import { computeDriftYielding } from './drift.js';
import { buildDataset, DataError, type Row } from './dataset.js';
import { COM_FEATURES, computeFeatures, ENDING_FEATURE_TLDS, extendedTable, FEATURE_NAMES, sldOf, toVector, type FeatureContext, type FeatureName } from './features.js';
import { fitGbm, gbmPredictAll, gbmProba, type GbmModel, type GbmParams } from './model/gbm.js';
import { fitLogit, logitProba, type LogitModel } from './model/logit.js';
import { auc, aucWithCi, precisionAtBaseRate, precisionAtTop, quantiles101 } from './model/metrics.js';
import { seedOf } from './model/rng.js';

const TRAIN_MIN_INTERVAL_MS = 24 * 3_600_000;
const TRAIN_TIME_BUDGET_MS = 25 * 60_000;
const TRAIN_SEED = 56;
const RECENCY_HALF_LIFE_DAYS = 365.25;
const RECENCY_MIN_GAIN = 0.01;
const COM_MIN_UNSOLD_COVERAGE = 0.3;
const KEEP_PARAMS_FOR_NEWEST = 4;
const BOOTSTRAP_RESAMPLES = 1000;
export const TIERS = ['lt1k', '1k_5k', '5k_25k', 'gt25k'] as const;
const tierOf = (cents: number): number => (cents < 100_000 ? 0 : cents < 500_000 ? 1 : cents < 2_500_000 ? 2 : 3);
const TIER_PARAMS: Partial<GbmParams> = { maxIter: 150, patience: 15 };

/** What a finished training stores in engine_models.params (JSON). */
export interface ModelParams {
  version: 1; seed: number;
  /** The model's columns, in order. */
  features: FeatureName[];
  excluded: { feature: FeatureName; reason: string }[];
  extra_terms: string[];
  tok_rate_enabled: boolean;
  gbm: GbmModel; logit: LogitModel; tier: GbmModel | null;
  /** Test-set score quantiles per class (101 points), for percentiles. */
  quantiles: { sold: number[]; dropped: number[] };
  /** Share of non-missing values per model feature on the training rows (for drift reports). */
  feature_coverage: Record<string, number>;
  split: { quarter: string; from: string; to: string; unsold_mode: 'dated' | 'hash'; train_newest: string | null };
}

export interface TrainDeps {
  db: Kysely<Database>; now: () => number;
  /** Real time source for the budget guard. */
  clock?: () => number; budgetMs?: number;
  gbmParams?: Partial<GbmParams>; tierParams?: Partial<GbmParams>;
  bootstrapResamples?: number; minTrainPerClass?: number; minTestPerClass?: number;
  /** Starts the queue job that works a run (set by app.ts). */
  enqueue?: (trainId: string, by: string) => Promise<{ runId: string }>;
  log?: { warn(o: object, m: string): void };
}

export interface TrainView {
  train_id: string; status: 'running' | 'done' | 'failed'; created_at: string; finished_at: string | null; trained_by: string; error: string | null;
  dataset: unknown; test_sha256: string | null; chosen_weighting: string | null; metrics: unknown; feature_list: unknown;
  /** v5.7.0 (CR-058): hold-time split of the test rows; null for a model trained before 5.7.0. */
  slices: unknown;
}

const yieldTurn = (): Promise<void> => new Promise((r) => { setImmediate(r); });
/** A long synchronous loop gives the event loop a turn every this many rows, so the API keeps answering while a training runs. */
const YIELD_EVERY_ROWS = 2_000;
async function mapYielding<T, U>(rows: readonly T[], fn: (x: T) => U): Promise<U[]> {
  const out: U[] = new Array<U>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    out[i] = fn(rows[i]!);
    if ((i + 1) % YIELD_EVERY_ROWS === 0) await yieldTurn();
  }
  return out;
}

function viewOf(m: { id: string; status: 'running' | 'done' | 'failed'; created_at: Date; finished_at: Date | null; trained_by: string; error: string | null; dataset: unknown; test_sha256: string | null; chosen_weighting: string | null; metrics: unknown; feature_list: unknown }): TrainView {
  return {
    train_id: m.id, status: m.status, created_at: toJerusalemIso(m.created_at), finished_at: m.finished_at ? toJerusalemIso(m.finished_at) : null, trained_by: m.trained_by, error: m.error,
    dataset: m.dataset, test_sha256: m.test_sha256, chosen_weighting: m.chosen_weighting, metrics: m.metrics, feature_list: m.feature_list,
    slices: (m.metrics as { slices?: unknown } | null)?.slices ?? null,
  };
}

/** A running row this old has no worker any more (the step's own limit is 30 minutes). */
const TRAIN_STALE_MS = 45 * 60_000;

export class EngineTrainer {
  constructor(private readonly deps: TrainDeps) {}

  /** Opens a run and queues its job. 409 TRAIN_TOO_SOON within 24 hours of the last run that did not fail. */
  async start(by: string, auditId: string | null): Promise<{ id: string; runId: string | null }> {
    const { db, now } = this.deps;
    const id = await db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, 'engine_train');
      await this.reapStale(trx);
      const last = await trx.selectFrom('engine_models').select(['id', 'created_at', 'status']).where('status', 'in', ['running', 'done']).orderBy('n', 'desc').limit(1).executeTakeFirst();
      if (last && now() - last.created_at.getTime() < TRAIN_MIN_INTERVAL_MS) {
        throw new AppError(409, 'TRAIN_TOO_SOON', 'A training ran (or is running) in the last 24 hours', {
          last_train_id: last.id, last_status: last.status, next_allowed_at: toJerusalemIso(new Date(last.created_at.getTime() + TRAIN_MIN_INTERVAL_MS)),
        });
      }
      const row = await trx.insertInto('engine_models').values({ trained_by: by, audit_id: auditId, created_at: new Date(now()) }).returning('id').executeTakeFirstOrThrow();
      return row.id;
    });
    let runId: string | null = null;
    if (this.deps.enqueue) {
      try {
        runId = (await this.deps.enqueue(id, by)).runId;
        await this.deps.db.updateTable('engine_models').set({ queue_run_id: runId }).where('id', '=', id).execute();
      } catch (e) {
        await this.fail(id, `could not queue the training: ${(e as Error).message}`);
        throw e;
      }
    }
    return { id, runId };
  }

  /** A run left `running` long ago is failed, so the 24-hour rule and the status never hold on a dead worker. */
  private async reapStale(db: Kysely<Database>): Promise<void> {
    await db.updateTable('engine_models').set({ status: 'failed', error: 'abandoned: no worker finished this run (the process restarted or timed out)', finished_at: new Date(this.deps.now()) })
      .where('status', '=', 'running').where('created_at', '<', new Date(this.deps.now() - TRAIN_STALE_MS)).execute();
  }

  async get(id: string): Promise<TrainView | null> {
    await this.reapStale(this.deps.db);
    const m = await this.deps.db.selectFrom('engine_models').select(['id', 'status', 'created_at', 'finished_at', 'trained_by', 'error', 'dataset', 'test_sha256', 'chosen_weighting', 'metrics', 'feature_list']).where('id', '=', id).executeTakeFirst();
    return m ? viewOf(m) : null;
  }

  private async fail(id: string, error: string): Promise<void> {
    await this.deps.db.updateTable('engine_models').set({ status: 'failed', error: error.slice(0, 500), finished_at: new Date(this.deps.now()) }).where('id', '=', id).where('status', '=', 'running').execute();
  }

  /** The queue step: works one run. A run that is not `running` any more is skipped. A failure is stored on the run and thrown (the step shows it). */
  async runById(id: string): Promise<unknown> {
    const row = await this.deps.db.selectFrom('engine_models').select('status').where('id', '=', id).executeTakeFirst();
    if (!row || row.status !== 'running') return { skipped: true, reason: row ? `run is ${row.status}` : 'unknown run' };
    try {
      return await this.train(id);
    } catch (e) {
      const msg = e instanceof DataError ? `${e.code}: ${e.message} ${JSON.stringify(e.details)}` : e instanceof Error && e.message === 'TRAIN_TIME_BUDGET' ? 'TRAIN_TIME_BUDGET: training stopped at its time limit' : e instanceof Error ? e.message : String(e);
      await this.fail(id, msg);
      throw new Error(msg.slice(0, 200));
    }
  }

  /**
   * The daily step engineTrain: a first training when data exists and no model yet, else a retrain when a sales upload arrived since the active model
   * and it is Monday (IDT) or the active model is 7 days old. The 24-hour rule applies; a failed run is not retried before new data arrives.
   */
  async weekly(): Promise<unknown> {
    const { db, now } = this.deps;
    const active = await db.selectFrom('engine_models').select(['id', 'created_at']).where('status', '=', 'done').orderBy('n', 'desc').limit(1).executeTakeFirst();
    const last = await db.selectFrom('engine_models').select(['id', 'status', 'created_at']).orderBy('n', 'desc').limit(1).executeTakeFirst();
    if (last?.status === 'running' && now() - last.created_at.getTime() < TRAIN_STALE_MS) return { skipped: true, reason: `training ${last.id} is running` };
    const upload = await db.selectFrom('engine_uploads').select((eb) => eb.fn.max('created_at').as('at')).where('kind', '=', 'sales').executeTakeFirst();
    const lastSalesUpload = upload?.at ?? null;
    const anySales = await db.selectFrom('engine_sales').select('id').limit(1).executeTakeFirst();
    const anyUnsold = await db.selectFrom('engine_unsold').select('id').limit(1).executeTakeFirst();
    let reason: string;
    if (!active) {
      if (!anySales || !anyUnsold) return { skipped: true, reason: 'no model yet and no data to train on' };
      if (last?.status === 'failed' && (!lastSalesUpload || lastSalesUpload.getTime() <= last.created_at.getTime())) return { skipped: true, reason: `the last training (${last.id}) failed and no sales upload arrived since` };
      reason = 'no model yet';
    } else {
      if (!lastSalesUpload || lastSalesUpload.getTime() <= active.created_at.getTime()) return { skipped: true, reason: 'no sales upload since the active model' };
      const monday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(now()) === 'Mon';
      const ageDays = (now() - active.created_at.getTime()) / 86_400_000;
      if (!monday && ageDays < 7) return { skipped: true, reason: 'a sales upload arrived, but it is not Monday (IDT) and the model is under 7 days old' };
      reason = monday ? 'sales upload since the active model, Monday' : 'sales upload since the active model, model is 7 days old';
    }
    try {
      const r = await this.start('engine-weekly', null);
      return { started: true, train_id: r.id, run_id: r.runId, reason };
    } catch (e) {
      if (e instanceof AppError && e.code === 'TRAIN_TOO_SOON') return { skipped: true, reason: 'TRAIN_TOO_SOON', details: e.details };
      throw e;
    }
  }

  /** The whole training; returns a short summary. */
  private async train(id: string): Promise<unknown> {
    const { db, now } = this.deps;
    const clock = this.deps.clock ?? Date.now;
    const t0 = clock();
    const expired = (): boolean => clock() - t0 > (this.deps.budgetMs ?? TRAIN_TIME_BUDGET_MS);
    const seed = TRAIN_SEED;
    const baseTable = baseSplitTable();
    const extra = await loadExtraTerms(db);
    const table = extendedTable(baseTable, extra);
    const [sales, unsold] = [await loadSales(db), await loadUnsold(db)];
    const registeredUnsold = await countRegisteredUnsold(db);
    const ds = buildDataset(sales, unsold, { table, today: idtDay(now()), seed, registeredUnsold, minTrainPerClass: this.deps.minTrainPerClass, minTestPerClass: this.deps.minTestPerClass });
    // the test file is frozen (hashed and stored) before any model sees a row
    await db.updateTable('engine_models').set({ dataset: JSON.stringify({ ...ds.counts, quarter: ds.quarter.label, unsold_mode: ds.unsoldMode, test_from: ds.quarter.from, test_to_exclusive: ds.quarter.to }), test_sha256: ds.testSha256 }).where('id', '=', id).execute();
    const tokRateEnabled = unsoldSpanDays(unsold) >= UNSOLD_DATED_DAYS;
    const ctx: FeatureContext = { table, tokens: tokenContext(sales, unsold, table), endings: await loadEndings(db), demand: await loadDemand(db) };
    const trainRows = [...ds.trainSold, ...ds.trainUnsold].sort(rowOrder);
    const testRows = [...ds.testSold, ...ds.testUnsold].sort(rowOrder);
    const featOf = (r: Row) => computeFeatures(ctx, r.domain, r.asOf);
    const trainFeat = await mapYielding(trainRows, featOf);
    const testFeat = await mapYielding(testRows, featOf);
    // which features enter the model
    const excluded: ModelParams['excluded'] = [];
    const coverage = (name: FeatureName, rows: number[]): number => (rows.length ? rows.filter((i) => trainFeat[i]!.values[name] !== null).length / rows.length : 0);
    const unsoldIdx = trainRows.map((r, i) => (r.label === 0 ? i : -1)).filter((i) => i >= 0);
    const allIdx = trainRows.map((_, i) => i);
    const features = FEATURE_NAMES.filter((f) => {
      if (coverage(f, allIdx) === 0) { excluded.push({ feature: f, reason: f === 'tok_rate_pit' && !tokRateEnabled ? 'unsold rows are not dated over 90 days yet' : 'no value on any training row' }); return false; }
      if ((COM_FEATURES as readonly string[]).includes(f) && coverage(f, unsoldIdx) < COM_MIN_UNSOLD_COVERAGE) {
        excluded.push({ feature: f, reason: `the .com creation date is known for under ${COM_MIN_UNSOLD_COVERAGE * 100}% of the unsold rows (a dropped name has no registry record), so having it would reveal the label` });
        return false;
      }
      return true;
    });
    if (features.length === 0) throw new DataError('NOT_ENOUGH_DATA', 'No feature has a value');
    const F = features.length;
    const matrix = (feat: ReturnType<typeof featOf>[]): Float64Array => { const X = new Float64Array(feat.length * F); feat.forEach((x, i) => X.set(toVector(x.values, features), i * F)); return X; };
    const Xtr = matrix(trainFeat); const Xte = matrix(testFeat);
    const ytr = Int32Array.from(trainRows, (r) => r.label); const yte = Int32Array.from(testRows, (r) => r.label);
    const fit = (w: Float64Array | null, tag: string): Promise<GbmModel> => fitGbm({
      X: Xtr, n: trainRows.length, F, y: ytr, w, classes: 2, featureNames: [...features], seed: seedOf(`${seed}:${tag}`), params: this.deps.gbmParams, yieldFn: yieldTurn, expired,
    });
    const gbmU = await fit(null, 'gbm');
    const scoresU = gbmPredictAll(gbmU, Xte, testRows.length, F);
    const aucU = auc(scoresU, yte);
    // recency: half-life 12 months, rescaled per class so the class balance is unchanged
    const newest = trainRows.reduce((m, r) => Math.max(m, dayNumber(r.asOf)), -Infinity);
    const w = new Float64Array(trainRows.length);
    trainRows.forEach((r, i) => { w[i] = 0.5 ** ((newest - dayNumber(r.asOf)) / RECENCY_HALF_LIFE_DAYS); });
    for (const lab of [0, 1]) {
      let s = 0; let n = 0;
      trainRows.forEach((r, i) => { if (r.label === lab) { s += w[i]!; n++; } });
      if (s > 0) trainRows.forEach((r, i) => { if (r.label === lab) w[i]! *= n / s; });
    }
    const gbmW = await fit(w, 'gbm-w');
    const scoresW = gbmPredictAll(gbmW, Xte, testRows.length, F);
    const aucW = auc(scoresW, yte);
    const useW = aucW !== null && aucU !== null && aucW >= aucU + RECENCY_MIN_GAIN;
    const gbm = useW ? gbmW : gbmU;
    const scores = useW ? scoresW : scoresU;
    const ci0 = aucWithCi(scores, yte, seedOf(`${seed}:bootstrap`), this.deps.bootstrapResamples ?? BOOTSTRAP_RESAMPLES);
    // ablation (bar 4): the same GBM (same frozen split, same weighting) without the ending features
    const endingCols = new Set<string>([...ENDING_FEATURE_TLDS.map((t) => `${t}_pit`), 'n_endings_pit']);
    const keepIdx = features.map((f, i) => (endingCols.has(f) ? -1 : i)).filter((i) => i >= 0);
    let ablation: { auc_without_endings: number | null; auc95: [number, number] | null; delta: number | null; p_top1_at_1pct_base: number | null; removed: string[]; features_kept: number } | null = null;
    if (keepIdx.length > 0 && keepIdx.length < F) {
      const sub = (X: Float64Array, n: number): Float64Array => { const o = new Float64Array(n * keepIdx.length); for (let i = 0; i < n; i++) keepIdx.forEach((c, k) => { o[i * keepIdx.length + k] = X[i * F + c]!; }); return o; };
      const Fa = keepIdx.length;
      const gbmA = await fitGbm({
        X: sub(Xtr, trainRows.length), n: trainRows.length, F: Fa, y: ytr, w: useW ? w : null, classes: 2, featureNames: keepIdx.map((i) => features[i]!), seed: seedOf(`${seed}:${useW ? 'gbm-w' : 'gbm'}`), params: this.deps.gbmParams, yieldFn: yieldTurn, expired,
      });
      const scoresA = gbmPredictAll(gbmA, sub(Xte, testRows.length), testRows.length, Fa);
      const ciA = aucWithCi(scoresA, yte, seedOf(`${seed}:bootstrap`), this.deps.bootstrapResamples ?? BOOTSTRAP_RESAMPLES);
      ablation = {
        auc_without_endings: ciA.auc, auc95: ciA.ci, delta: ciA.auc === null || ci0.auc === null ? null : round4(ci0.auc - ciA.auc),
        p_top1_at_1pct_base: precisionAtBaseRate(scoresA, yte, 0.01, 100), removed: features.filter((f) => endingCols.has(f)), features_kept: Fa,
      };
    }
    const logit = fitLogit({ X: Xtr, n: trainRows.length, F, y: ytr, featureNames: [...features] });
    const logitScores = Float64Array.from({ length: testRows.length }, (_, i) => logitProba(logit, Xte.subarray(i * F, (i + 1) * F)));
    // price tier on the sold rows
    let tier: GbmModel | null = null;
    let tierMetrics: { n_train: number; n_test: number; accuracy: number | null; logloss: number | null } = { n_train: ds.trainSold.length, n_test: ds.testSold.length, accuracy: null, logloss: null };
    if (ds.trainSold.length >= 40) {
      const soldIdx = trainRows.map((r, i) => (r.label === 1 ? i : -1)).filter((i) => i >= 0);
      const Xs = new Float64Array(soldIdx.length * F); soldIdx.forEach((i, k) => Xs.set(Xtr.subarray(i * F, (i + 1) * F), k * F));
      const ys = Int32Array.from(soldIdx, (i) => tierOf(trainRows[i]!.priceCents!));
      tier = await fitGbm({ X: Xs, n: soldIdx.length, F, y: ys, classes: 4, featureNames: [...features], seed: seedOf(`${seed}:tier`), params: { ...TIER_PARAMS, ...this.deps.tierParams }, yieldFn: yieldTurn, expired });
      let hit = 0; let ll = 0; let n = 0;
      testRows.forEach((r, i) => {
        if (r.label !== 1) return;
        const p = gbmProba(tier!, Xte.subarray(i * F, (i + 1) * F));
        const y = tierOf(r.priceCents!);
        if (p.indexOf(Math.max(...p)) === y) hit++;
        ll += -Math.log(Math.max(p[y]!, 1e-12)); n++;
      });
      tierMetrics = { n_train: ds.trainSold.length, n_test: n, accuracy: n ? round4(hit / n) : null, logloss: n ? round4(ll / n) : null };
    }
    // metrics on the frozen test file
    const ci = ci0;
    const p1 = precisionAtTop(scores, yte, 0.01); const p5 = precisionAtTop(scores, yte, 0.05);
    const base1 = precisionAtBaseRate(scores, yte, 0.01, 100);
    const soldScores: number[] = []; const dropScores: number[] = [];
    testRows.forEach((r, i) => { (r.label === 1 ? soldScores : dropScores).push(scores[i]!); });
    const quantiles = { sold: quantiles101(soldScores), dropped: quantiles101(dropScores) };
    const importance = features.map((f, i) => ({ feature: f, gain: gbm.importance[i]! })).sort((a, b) => b.gain - a.gain);
    const featureCoverage = Object.fromEntries(features.map((f) => [f, round4(coverage(f, allIdx))]));
    // drift per year and for the newest full quarter, each row's features as of its own date (stored so GET /engine/health reads it cheaply)
    const drift = await computeDriftYielding(ctx, sales, unsold, idtDay(now()), yieldTurn);
    const slices = holdSlices(testRows.map((r, i) => ({ label: r.label, asOf: r.asOf, score: scores[i]!, netPit: testFeat[i]!.values.net_pit, comCreatedMs: testFeat[i]!.comCreatedMs })));
    const metrics = {
      slices,
      test: {
        window: { label: ds.quarter.label, from: ds.quarter.from, to_exclusive: ds.quarter.to }, unsold_mode: ds.unsoldMode, n_sold: ds.testSold.length, n_unsold: ds.testUnsold.length,
        auc: ci.auc, auc95: ci.ci, p_top1: { precision: p1.precision, ci95: p1.ci, n_top: p1.n_top }, p_top5: { precision: p5.precision, ci95: p5.ci, n_top: p5.n_top },
        p_top1_at_1pct_base: base1, auc_logit: auc(logitScores, yte), bootstrap_resamples: this.deps.bootstrapResamples ?? BOOTSTRAP_RESAMPLES,
      },
      weighting: { unweighted_auc: aucU, half_life_12m_auc: aucW, rule: `half-life 12 months is kept only if its test AUC is at least ${RECENCY_MIN_GAIN} above unweighted`, chosen: useW ? 'half_life_12m' : 'unweighted' },
      tier: tierMetrics,
      ablation,
      drift,
      quantiles,
      importance,
      train: { n_sold: ds.trainSold.length, n_unsold: ds.trainUnsold.length, gbm_iterations: gbm.bestIter, tier_iterations: tier?.bestIter ?? null, logit_iterations: logit.iterations },
      seconds: Math.round((clock() - t0) / 100) / 10,
    };
    const params: ModelParams = {
      version: 1, seed, features: [...features], excluded, extra_terms: extra, tok_rate_enabled: tokRateEnabled, gbm, logit, tier, quantiles, feature_coverage: featureCoverage,
      split: { quarter: ds.quarter.label, from: ds.quarter.from, to: ds.quarter.to, unsold_mode: ds.unsoldMode, train_newest: trainRows.length ? trainRows.reduce((m, r) => (r.asOf > m ? r.asOf : m), '') : null },
    };
    const testOut = { domain: testRows.map((r) => r.domain), label: testRows.map((r) => r.label), as_of: testRows.map((r) => r.asOf), score: Array.from(scores, (s) => Math.round(s * 1e6) / 1e6) };
    await db.updateTable('engine_models').set({
      status: 'done', finished_at: new Date(now()), params: JSON.stringify(params), metrics: JSON.stringify(metrics), chosen_weighting: useW ? 'half_life_12m' : 'unweighted',
      feature_list: JSON.stringify({ model: features, excluded }), test_rows: JSON.stringify(testOut),
    }).where('id', '=', id).execute();
    await sql`update engine_models set params = null, test_rows = null where status = 'done' and (params is not null or test_rows is not null)
      and id not in (select id from engine_models where status = 'done' order by n desc limit ${KEEP_PARAMS_FOR_NEWEST})`.execute(db);
    return { train_id: id, status: 'done', auc: ci.auc, chosen_weighting: useW ? 'half_life_12m' : 'unweighted', train_rows: { sold: ds.trainSold.length, unsold: ds.trainUnsold.length }, seconds: metrics.seconds };
  }
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const rowOrder = (a: Row, b: Row): number => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : a.label - b.label);

/** A short stable fingerprint of a model's parameters (for logs and tests). */
export { sldOf };
