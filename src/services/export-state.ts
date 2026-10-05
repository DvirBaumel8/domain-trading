import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export type Venue = 'afternic' | 'sedo';
export const VENUES: readonly Venue[] = ['afternic', 'sedo'];

/**
 * Listed domains whose current exported values no confirmed file of this venue recorded: no confirmed upload has a
 * run-domain row for the domain with a listing_changed_at at or after the current one. Clock-free (exact per-file record).
 */
export async function pendingDomains(db: Kysely<Database>, venue: Venue): Promise<string[]> {
  const r = await sql<{ domain: string }>`
    select d.domain from domains d
    where d.status = 'listed' and d.listing_changed_at is not null
      and not exists (
        select 1 from export_uploads u join export_run_domains rd on rd.export_id = u.export_id
        where u.venue = ${venue} and rd.domain = d.domain and rd.listing_changed_at >= d.listing_changed_at)
    order by d.domain`.execute(db);
  return r.rows.map((x) => x.domain);
}

/**
 * Sold/delisted/dropped domains that went live in a confirmed file of this venue and whose removal no confirmed file
 * asked for (a confirmed file whose delist list names the domain).
 */
export async function manualDelist(db: Kysely<Database>, venue: Venue): Promise<string[]> {
  const r = await sql<{ domain: string }>`
    select d.domain from domains d
    where d.status in ('sold', 'delisted', 'dropped')
      and exists (
        select 1 from export_uploads u join export_run_domains rd on rd.export_id = u.export_id
        where u.venue = ${venue} and rd.domain = d.domain)
      and not exists (
        select 1 from export_uploads u2 join export_runs r2 on r2.export_id = u2.export_id
        where u2.venue = ${venue} and d.domain = any(r2.delist))
    order by d.domain`.execute(db);
  return r.rows.map((x) => x.domain);
}

/** Columns to set whenever an exported value changes (mode, prices, LTO, display name, status to/from listed). */
export function changedColumns(cur: { export_pending_since: Date | null }, now: Date): { listing_changed_at: Date; export_pending_since: Date } {
  return { listing_changed_at: now, export_pending_since: cur.export_pending_since ?? now };
}
