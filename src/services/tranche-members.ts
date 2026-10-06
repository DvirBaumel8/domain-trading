// Tranche membership reads (kept apart from the service: the screening checks use them and must not import the engine).
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export async function openTrancheFor(db: Kysely<Database>, domain: string): Promise<{ trancheId: string } | null> {
  const r = await db.selectFrom('tranche_members as m').innerJoin('tranches as t', 't.id', 'm.tranche_id')
    .select('t.id').where('t.status', '=', 'open').where('m.domain', '=', domain).where('m.removed_at', 'is', null).executeTakeFirst();
  return r ? { trancheId: r.id } : null;
}

export async function geoMembers(db: Kysely<Database>, trancheId: string): Promise<number> {
  const r = await db.selectFrom('tranche_members').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('tranche_id', '=', trancheId).where('is_geo', '=', true).where('removed_at', 'is', null).executeTakeFirstOrThrow();
  return Number(r.n);
}
