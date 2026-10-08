import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

export type Venue = 'afternic' | 'sedo';
export const VENUES: readonly Venue[] = ['afternic', 'sedo'];

/** Snapshot time (export_runs.at) of the venue's newest confirmed upload, or null when none was ever confirmed. */
async function lastConfirmedFileAt(db: Kysely<Database>, venue: Venue): Promise<Date | null> {
  const r = await sql<{ at: Date | null }>`
    select max(r.at) as at from export_uploads u join export_runs r on r.export_id = u.export_id where u.venue = ${venue}`.execute(db);
  return r.rows[0]?.at ?? null;
}

/**
 * Listed domains changed since the venue's last confirmed file: listing_changed_at is after that file's snapshot time
 * (every listed name is pending while the venue has no confirmed upload).
 */
export async function pendingDomains(db: Kysely<Database>, venue: Venue): Promise<string[]> {
  const last = await lastConfirmedFileAt(db, venue);
  const r = await sql<{ domain: string }>`
    select d.domain from domains d
    where d.status = 'listed' and d.listing_changed_at is not null
      and (${last}::timestamptz is null or d.listing_changed_at > ${last}::timestamptz)
    order by d.domain`.execute(db);
  return r.rows.map((x) => x.domain);
}

/**
 * Sold/delisted/dropped domains that were first listed at or before the venue's last confirmed file and whose status
 * changed after it: the names to remove by hand. The next confirmed file clears them.
 */
export async function manualDelist(db: Kysely<Database>, venue: Venue): Promise<string[]> {
  const last = await lastConfirmedFileAt(db, venue);
  if (!last) return [];
  const r = await sql<{ domain: string }>`
    select d.domain from domains d
    where d.status in ('sold', 'delisted', 'dropped')
      and d.first_listed_at is not null and d.first_listed_at <= ${last}::timestamptz
      and d.listing_changed_at is not null and d.listing_changed_at > ${last}::timestamptz
    order by d.domain`.execute(db);
  return r.rows.map((x) => x.domain);
}

/** Columns to set whenever an exported value changes (mode, prices, LTO, display name, status to/from listed). */
export function changedColumns(cur: { export_pending_since: Date | null }, now: Date): { listing_changed_at: Date; export_pending_since: Date } {
  return { listing_changed_at: now, export_pending_since: cur.export_pending_since ?? now };
}
