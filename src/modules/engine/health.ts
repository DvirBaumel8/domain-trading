// GET /engine/health (v5.4.0: the data and the endings fill; v5.5.0: the model fields; v5.6.0: drift, the ablation and the bars report).
import type { Kysely } from 'kysely';
import { dayNumber, idtDay, toJerusalemIso } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { endingsHealth } from './endings.js';

type Kind = 'sales' | 'unsold';

const BAR_ROWS_MIN = 10_000;
const BAR_AUC_MIN = 0.8;
const BAR_P_TOP1_MIN = 0.9;
const BAR_MIX_MIN = 3;
const BAR_ABLATION_MAX_DELTA = 0.05;
const PROTOTYPE_AUC = 0.85;
const TREND_REFERENCE_AUC = 0.809;

type BarStatus = 'pass' | 'fail' | 'not_measured';
export interface Bar { id: number; name: string; status: BarStatus; value: unknown; detail: string }

interface TestM { window?: { label?: string }; n_sold?: number; n_unsold?: number; auc?: number | null; p_top1?: { precision: number | null }; p_top1_at_1pct_base?: number | null }
interface AblationM { auc_without_endings: number | null; auc95: [number, number] | null; delta: number | null; p_top1_at_1pct_base: number | null }

/** The six acceptance bars of CR-056 from what the service can know; bars 1 and 5 are Gavriel's checks. */
export function computeBars(i: { salesN: number; unsoldN: number; test: TestM | undefined; ablation: AblationM | null | undefined; hasModel: boolean }): Bar[] {
  const t = i.test; const a = i.ablation ?? null;
  const bars: Bar[] = [];
  bars.push({ id: 1, name: 'Health green for 3 days, including a restart', status: 'not_measured', value: null, detail: 'Gavriel checks GET /health over three days with one restart in between; the service keeps no such history.' });
  const rowsOk = i.salesN >= BAR_ROWS_MIN && i.unsoldN >= BAR_ROWS_MIN;
  bars.push({ id: 2, name: `At least ${BAR_ROWS_MIN} sold and ${BAR_ROWS_MIN} unsold names stored with source and date`, status: rowsOk ? 'pass' : 'fail', value: { sold: i.salesN, unsold: i.unsoldN }, detail: `Counted from engine_sales and engine_unsold (every stored row has a source and a date). Need ${BAR_ROWS_MIN} of each.` });
  if (!t) {
    bars.push({ id: 3, name: `AUC at least ${BAR_AUC_MIN} and precision at the top 1% at least ${BAR_P_TOP1_MIN} on the newest quarter, with at least ${BAR_MIX_MIN} unsold per sale`, status: 'not_measured', value: null, detail: 'No finished model yet.' });
  } else {
    const mix = t.n_sold ? (t.n_unsold ?? 0) / t.n_sold : 0;
    const ok = (t.auc ?? 0) >= BAR_AUC_MIN && (t.p_top1?.precision ?? 0) >= BAR_P_TOP1_MIN && mix >= BAR_MIX_MIN;
    bars.push({
      id: 3, name: `AUC at least ${BAR_AUC_MIN} and precision at the top 1% at least ${BAR_P_TOP1_MIN} on the newest quarter, with at least ${BAR_MIX_MIN} unsold per sale`, status: ok ? 'pass' : 'fail',
      value: { auc: t.auc ?? null, p_top1: t.p_top1?.precision ?? null, unsold_per_sale: t.n_sold ? Math.round(mix * 100) / 100 : null, window: t.window?.label ?? null },
      detail: mix < BAR_MIX_MIN ? `The test file holds ${Math.round(mix * 100) / 100} unsold per sale, under the required ${BAR_MIX_MIN}:1, so the bar fails whatever the AUC.` : `Test quarter ${t.window?.label ?? '?'}: AUC ${t.auc}, precision at the top 1% ${t.p_top1?.precision}, mix ${Math.round(mix * 100) / 100}:1.`,
    });
  }
  if (!a || a.delta === null) {
    bars.push({ id: 4, name: `AUC without the ending features within ${BAR_ABLATION_MAX_DELTA} of the full model`, status: 'not_measured', value: null, detail: i.hasModel ? 'The active model has no ablation (trained before 5.6.0, or the model holds no ending feature): retrain.' : 'No finished model yet.' });
  } else {
    bars.push({
      id: 4, name: `AUC without the ending features within ${BAR_ABLATION_MAX_DELTA} of the full model`, status: a.delta <= BAR_ABLATION_MAX_DELTA ? 'pass' : 'fail',
      value: { auc_without_endings: a.auc_without_endings, auc95: a.auc95, delta: a.delta },
      detail: `Full model AUC ${t?.auc} against ${a.auc_without_endings} without the ending features (delta ${a.delta}, limit ${BAR_ABLATION_MAX_DELTA}, absolute AUC). Precision at the top 1% at a 1 sold : 100 unsold base rate: ${t?.p_top1_at_1pct_base ?? 'n/a'} with the endings, ${a.p_top1_at_1pct_base ?? 'n/a'} without.`,
    });
  }
  bars.push({ id: 5, name: '/score deterministic, and under 5 seconds for 20 names', status: 'not_measured', value: null, detail: 'Gavriel runs the fixed-name test: the same 20 names twice (identical output) and times the call.' });
  if (!t || t.auc === null || t.auc === undefined) {
    bars.push({ id: 6, name: `Matches or beats the prototype (AUC ${PROTOTYPE_AUC}, lexical)`, status: 'not_measured', value: null, detail: 'No finished model yet.' });
  } else {
    bars.push({
      id: 6, name: `Matches or beats the prototype (AUC ${PROTOTYPE_AUC}, lexical)`, status: t.auc >= PROTOTYPE_AUC ? 'pass' : 'fail',
      value: { auc: t.auc, prototype_auc: PROTOTYPE_AUC, point_in_time_trend_reference_auc: TREND_REFERENCE_AUC },
      detail: `Active model test AUC ${t.auc} against the prototype's ${PROTOTYPE_AUC} (and ${TREND_REFERENCE_AUC}, the prototype's point-in-time trend reference). Indicative only: the prototype used a different split and data.`,
    });
  }
  return bars;
}

async function lastUpload(db: Kysely<Database>, kind: Kind) {
  const u = await db.selectFrom('engine_uploads').selectAll().where('kind', '=', kind).orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!u) return null;
  return { upload_id: u.id, at: toJerusalemIso(u.created_at), by: u.by, received_n: u.received_n, accepted_n: u.accepted_n, duplicate_n: u.duplicate_n, rejected_n: u.rejected_n };
}

export async function engineHealth(db: Kysely<Database>, nowMs: number) {
  const s = await db.selectFrom('engine_sales').select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('sale_date').as('newest')]).executeTakeFirstOrThrow();
  const u = await db.selectFrom('engine_unsold').select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('observation_date').as('newest')]).executeTakeFirstOrThrow();
  // v5.50.0 (P6): the middle class, counted by band
  const ae = await db.selectFrom('engine_auction_ends').select(['band', (eb) => eb.fn.countAll<string>().as('n'), (eb) => eb.fn.max('end_date').as('newest')]).groupBy('band').execute();
  const auctionEnds = { opening: 0, low: 0, mid: 0 };
  let aeNewest: string | null = null;
  for (const r of ae) { auctionEnds[r.band] = Number(r.n); const d = r.newest as string | null; if (d && (aeNewest === null || d > aeNewest)) aeNewest = d; }
  const today = dayNumber(idtDay(nowMs));
  const age = (d: string | null) => (d === null ? null : Math.max(0, today - dayNumber(d)));
  const model = await db.selectFrom('engine_models').select(['id', 'finished_at', 'dataset', 'metrics', 'chosen_weighting']).where('status', '=', 'done').orderBy('n', 'desc').limit(1).executeTakeFirst();
  const lastRun = await db.selectFrom('engine_models').select(['id', 'status', 'created_at', 'error']).orderBy('n', 'desc').limit(1).executeTakeFirst();
  const m = model?.metrics as { slices?: unknown; drift?: unknown; ablation?: AblationM | null; test?: Record<string, unknown> & { p_top1?: { precision: number | null; ci95: unknown }; p_top5?: { precision: number | null; ci95: unknown } } } | undefined;
  const ds = model?.dataset as { train_sold?: number; train_unsold?: number } | undefined;
  const t = m?.test;
  const newestSale = (s.newest as string | null) ?? null;
  const newestUnsold = (u.newest as string | null) ?? null;
  const bars = computeBars({ salesN: Number(s.n), unsoldN: Number(u.n), test: t as TestM | undefined, ablation: m?.ablation, hasModel: !!model });
  return {
    model_version: model?.id ?? null,
    trained_at: model?.finished_at ? toJerusalemIso(model.finished_at) : null,
    train_rows: model ? { sold: ds?.train_sold ?? null, unsold: ds?.train_unsold ?? null } : null,
    test: t ? {
      window: t.window, n_sold: t.n_sold, n_unsold: t.n_unsold, auc: t.auc, auc95: t.auc95, p_top1: t.p_top1?.precision ?? null, p_top1_ci95: t.p_top1?.ci95 ?? null,
      p_top5: t.p_top5?.precision ?? null, p_top5_ci95: t.p_top5?.ci95 ?? null, p_top1_at_1pct_base: t.p_top1_at_1pct_base,
    } : null,
    chosen_weighting: model?.chosen_weighting ?? null,
    ablation: m?.ablation ?? null,
    bar4_pass: m?.ablation && m.ablation.delta !== null ? m.ablation.delta <= BAR_ABLATION_MAX_DELTA : null,
    drift: m?.drift ?? null,
    slices: m?.slices ?? null,
    bars,
    bars_passed: bars.filter((b) => b.status === 'pass').map((b) => b.id),
    last_training: lastRun ? { train_id: lastRun.id, status: lastRun.status, at: toJerusalemIso(lastRun.created_at), error: lastRun.error } : null,
    data: {
      sales_n: Number(s.n), unsold_n: Number(u.n),
      auction_ends_n: { ...auctionEnds, total: auctionEnds.opening + auctionEnds.low + auctionEnds.mid }, auction_ends_newest: aeNewest, sales_newest: newestSale, unsold_newest: newestUnsold,
      data_age_days: { sold: age(newestSale), unsold: age(newestUnsold) },
      last_upload: { sales: await lastUpload(db, 'sales'), unsold: await lastUpload(db, 'unsold') },
    },
    endings: await endingsHealth(db, nowMs),
  };
}
