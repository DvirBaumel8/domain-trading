// Daily step `afternicSync` (v5.61.0). Read-only toward Afternic: lists every listing through the seller API, stores one row per name per UTC day
// (afternic_listings_daily), records each portfolio name's 30-day views and leads into the visits store as source `afternic` (replaces the hand import of CR-037),
// and counts the names whose Afternic values differ from the plan. The warnings AFTERNIC_DRIFT / AFTERNIC_NOT_LISTED are raised by /report from the stored rows.
// It never writes to Afternic (the push route does, on an operator's call). Without the key pair the step is skipped as not_configured.
import { sql, type Kysely } from 'kysely';
import { trySessionLock } from '../../../core/locks.js';
import type { Database } from '../../../db/types.js';
import { AfternicApiError, diffListing, loadPlans, type AfternicClient } from '../../listing/index.js';

export interface AfternicSyncSummary { status: 'ok' | 'not_configured' | 'error'; listings_n: number; drift_n: number; views_stored_n: number; skipped?: boolean; reason?: string; failed?: { domain: string; reason: string }[] }
const DAY = 86_400_000;
export type RecordViews = (o: { domain: string; date: string; views30d: number; leads30d: number | null; now: Date }) => Promise<boolean>;

export class AfternicSyncJob {
  constructor(private readonly deps: { db: Kysely<Database>; client: AfternicClient | null; now: () => number; recordViews?: RecordViews }) {}

  async runOnce(): Promise<AfternicSyncSummary> {
    const { db, client } = this.deps;
    if (!client) return { status: 'not_configured', skipped: true, reason: 'AFTERNIC_API_KEY / AFTERNIC_API_SECRET not set', listings_n: 0, drift_n: 0, views_stored_n: 0 };
    const lock = await trySessionLock(db, 'job:afternic-sync');
    if (!lock) return { status: 'ok', skipped: true, reason: 'another afternic sync is running', listings_n: 0, drift_n: 0, views_stored_n: 0 };
    try {
      const nowMs = this.deps.now();
      const now = new Date(nowMs);
      const day = now.toISOString().slice(0, 10);
      const listings = await client.list(); // throws AfternicApiError: the runner retries the step and shows the scrubbed error
      const plans = await loadPlans(db);
      const failed: { domain: string; reason: string }[] = [];
      let driftN = 0;
      let viewsN = 0;
      const startIso = new Date(Date.parse(`${day}T00:00:00Z`) - 30 * DAY).toISOString();
      for (const l of listings) {
        const p = plans.get(l.name);
        if (p && 'plan' in p && diffListing(p.plan, l).length > 0) driftN++;
        // 30-day views and leads of our own names from the stats API; the listing's own view counter is the fallback for views
        let views: number | null = l.intake_views;
        let leads: number | null = null;
        if (p) {
          try {
            const s = await client.stats(l.name, startIso, 30);
            views = s.views; leads = s.leads;
          } catch (e) {
            if (e instanceof AfternicApiError && e.code === 'AFTERNIC_AUTH') throw e;
            failed.push({ domain: l.name, reason: e instanceof AfternicApiError ? e.code : 'error' });
          }
        }
        await sql`
          insert into afternic_listings_daily (domain, day, list_status, bin_cents, floor_cents, min_offer_cents, leasing_enabled, max_lease_months, show_buynow, show_lto, show_offer, intake_style, hidden, views, leads, updated_at_afternic)
          values (${l.name}, ${day}::date, ${l.list_status}, ${l.bin_cents}, ${l.floor_cents}, ${l.min_offer_cents}, ${l.leasing_enabled}, ${l.max_lease_months}, ${l.show_buynow}, ${l.show_lto}, ${l.show_offer}, ${l.intake_style}, ${l.hidden}, ${views}, ${leads}, ${l.updated_at}::timestamptz)
          on conflict (domain, day) do update set list_status = excluded.list_status, bin_cents = excluded.bin_cents, floor_cents = excluded.floor_cents, min_offer_cents = excluded.min_offer_cents,
            leasing_enabled = excluded.leasing_enabled, max_lease_months = excluded.max_lease_months, show_buynow = excluded.show_buynow, show_lto = excluded.show_lto, show_offer = excluded.show_offer,
            intake_style = excluded.intake_style, hidden = excluded.hidden, views = excluded.views, leads = excluded.leads, updated_at_afternic = excluded.updated_at_afternic`.execute(db);
        if (p && views !== null && this.deps.recordViews && await this.deps.recordViews({ domain: l.name, date: day, views30d: views, leads30d: leads, now })) viewsN++;
      }
      return { status: failed.length > 0 && failed.length === listings.length ? 'error' : 'ok', listings_n: listings.length, drift_n: driftN, views_stored_n: viewsN, ...(failed.length > 0 ? { failed } : {}) };
    } finally {
      await lock.release();
    }
  }
}
