// GET /engine/health (v5.4.0, part 1 shape: the data and the endings fill; the model fields come with the model release).
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
  const newestSale = (s.newest as string | null) ?? null;
  const newestUnsold = (u.newest as string | null) ?? null;
  return {
    model_version: null,
    data: {
      sales_n: Number(s.n), unsold_n: Number(u.n), sales_newest: newestSale, unsold_newest: newestUnsold,
      data_age_days: { sold: age(newestSale), unsold: age(newestUnsold) },
      last_upload: { sales: await lastUpload(db, 'sales'), unsold: await lastUpload(db, 'unsold') },
    },
    endings: await endingsHealth(db, nowMs),
  };
}
