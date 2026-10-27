// v5.61.0: AFTERNIC_DRIFT and AFTERNIC_NOT_LISTED, from the newest daily afternicSync read (afternic_listings_daily) against the CURRENT plan.
// Nothing here calls Afternic. Silent when no read exists or the newest one is older than 3 days (a missing sync is the job's own failure, not drift).
import { sql, type Kysely } from 'kysely';
import type { Database, DomainRow } from '../../../db/types.js';
import { afternicPlanOf, diffListing, leaseOf, type StoredListing } from '../../listing/index.js';

type Add = (code: string, level: 'info' | 'warn' | 'error', message: string, domain?: string, details?: Record<string, unknown>) => void;
const STALE_DAYS = 3;

export async function afternicWarnings(db: Kysely<Database>, domains: DomainRow[], now: Date, add: Add): Promise<void> {
  const listed = domains.filter((d) => d.status === 'listed' && d.listing_mode);
  if (listed.length === 0) return;
  const newest = (await sql<{ day: string }>`select to_char(max(day), 'YYYY-MM-DD') as day from afternic_listings_daily`.execute(db)).rows[0]?.day;
  if (!newest) return;
  if (now.getTime() - Date.parse(`${newest}T00:00:00Z`) > (STALE_DAYS + 1) * 86_400_000) return;
  const rows = await db.selectFrom('afternic_listings_daily').selectAll().where(sql`day`, '=', sql`${newest}::date`).execute();
  const by = new Map<string, StoredListing>(rows.map((r) => [r.domain, r]));
  const st = await db.selectFrom('settings').select(['afternic_lease_to_own', 'afternic_lease_months']).executeTakeFirstOrThrow();
  const lease = leaseOf(st);
  for (const d of listed) {
    const stored = by.get(d.domain);
    if (!stored) {
      // a name listed after the read cannot be missing from it
      if (d.first_listed_at && d.first_listed_at.getTime() >= Date.parse(`${newest}T00:00:00Z`)) continue;
      add('AFTERNIC_NOT_LISTED', 'warn', `${d.domain} is listed in the plan but Afternic's listing read of ${newest} does not have it.`, d.domain, { read_day: newest });
      continue;
    }
    const p = afternicPlanOf(d, lease);
    if (!('plan' in p)) continue;
    const fields = diffListing(p.plan, stored);
    if (fields.length > 0) add('AFTERNIC_DRIFT', 'warn', `${d.domain}: Afternic shows ${fields.map((f) => f.field).join(', ')} different from the plan (read of ${newest}).`, d.domain, { domain: d.domain, fields, read_day: newest });
  }
}
