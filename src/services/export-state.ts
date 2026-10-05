import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export type Venue = 'afternic' | 'sedo';
export const VENUES: readonly Venue[] = ['afternic', 'sedo'];

/** Listed domains whose exported values changed after the newest confirmed file of this venue that contained them (R1). */
export async function pendingDomains(db: Kysely<Database>, venue: Venue): Promise<string[]> {
  const r = await sql<{ domain: string }>`
    select d.domain from domains d
    where d.status = 'listed' and d.listing_changed_at is not null
      and d.listing_changed_at > coalesce((
        select max(r.at) from export_uploads u join export_runs r on r.export_id = u.export_id
        where u.venue = ${venue} and d.domain = any(u.domains)), '-infinity'::timestamptz)
    order by d.domain`.execute(db);
  return r.rows.map((x) => x.domain);
}

/** R3: sold/delisted/dropped domains that went live at this venue and whose removal no confirmed upload has followed. */
export async function manualDelist(db: Kysely<Database>, venue: Venue): Promise<string[]> {
  const r = await sql<{ domain: string }>`
    select d.domain from domains d
    where d.status in ('sold', 'delisted', 'dropped')
      and exists (select 1 from export_uploads u where u.venue = ${venue} and d.domain = any(u.domains))
      and not exists (select 1 from export_uploads u where u.venue = ${venue} and d.delisted_at is not null and u.uploaded_at > d.delisted_at)
    order by d.domain`.execute(db);
  return r.rows.map((x) => x.domain);
}

/** Columns to set whenever an exported value changes (mode, prices, LTO, display name, status to/from listed). */
export function changedColumns(cur: { export_pending_since: Date | null }, now: Date): { listing_changed_at: Date; export_pending_since: Date } {
  return { listing_changed_at: now, export_pending_since: cur.export_pending_since ?? now };
}
