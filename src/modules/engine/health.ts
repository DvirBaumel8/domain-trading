// GET /engine/health (v5.4.0: the data and the endings fill; v5.5.0: the model fields. Drift, the bars report and the ablation come with 5.6.0).
import type { Kysely } from 'kysely';
import { dayNumber, idtDay, toJerusalemIso } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { endingsHealth } from './endings.js';

type Kind = 'sales' | 'unsold';

async function lastUpload(db: Kysely<Database>, kind: Kind) {
  const u = await db.selectFrom('engine_uploads').selectAll().where('kind', '=', kind).orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!u) return null;
  return { upload_id: u.id, at: toJerusalemIso(u.created_at), by: u.by, received_n: u.received_n, accepted_n: u.accepted_n, duplicate_n: u.duplicate_n, rejected_n: u.rejected_n };
}

export async function engineHealth(db: Kysely<Database>, nowMs: number) {
  const s = await db.selectFrom('engine_sales').select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('sale_date').as('newest')]).executeTakeFirstOrThrow();
  const u = await db.selectFrom('engine_unsold').select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('observation_date').as('newest')]).executeTakeFirstOrThrow();
  const today = dayNumber(idtDay(nowMs));
  const age = (d: string | null) => (d === null ? null : Math.max(0, today - dayNumber(d)));
  const model = await db.selectFrom('engine_models').select(['id', 'finished_at', 'dataset', 'metrics', 'chosen_weighting']).where('status', '=', 'done').orderBy('n', 'desc').limit(1).executeTakeFirst();
  const lastRun = await db.selectFrom('engine_models').select(['id', 'status', 'created_at', 'error']).orderBy('n', 'desc').limit(1).executeTakeFirst();
  const m = model?.metrics as { test?: Record<string, unknown> & { p_top1?: { precision: number | null; ci95: unknown }; p_top5?: { precision: number | null; ci95: unknown } } } | undefined;
  const ds = model?.dataset as { train_sold?: number; train_unsold?: number } | undefined;
  const t = m?.test;
  const newestSale = (s.newest as string | null) ?? null;
  const newestUnsold = (u.newest as string | null) ?? null;
  return {
    model_version: model?.id ?? null,
    trained_at: model?.finished_at ? toJerusalemIso(model.finished_at) : null,
    train_rows: model ? { sold: ds?.train_sold ?? null, unsold: ds?.train_unsold ?? null } : null,
    test: t ? {
      window: t.window, n_sold: t.n_sold, n_unsold: t.n_unsold, auc: t.auc, auc95: t.auc95, p_top1: t.p_top1?.precision ?? null, p_top1_ci95: t.p_top1?.ci95 ?? null,
      p_top5: t.p_top5?.precision ?? null, p_top5_ci95: t.p_top5?.ci95 ?? null, p_top1_at_1pct_base: t.p_top1_at_1pct_base,
    } : null,
    chosen_weighting: model?.chosen_weighting ?? null,
    last_training: lastRun ? { train_id: lastRun.id, status: lastRun.status, at: toJerusalemIso(lastRun.created_at), error: lastRun.error } : null,
    data: {
      sales_n: Number(s.n), unsold_n: Number(u.n), sales_newest: newestSale, unsold_newest: newestUnsold,
      data_age_days: { sold: age(newestSale), unsold: age(newestUnsold) },
      last_upload: { sales: await lastUpload(db, 'sales'), unsold: await lastUpload(db, 'unsold') },
    },
    endings: await endingsHealth(db, nowMs),
  };
}
