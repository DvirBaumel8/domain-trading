import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely, type Transaction, type Updateable } from 'kysely';
import type { Category, Database, DomainsTable, ListingHistoryTable } from '../db/types.js';
import { buildSchedule, type ScheduleEvent } from '../pricing/schedule.js';
import type { PricingSettings } from '../pricing/settings.js';
import type { ListingPlan } from './listing-v2.js';

export const newPlanId = (): string => `pl_${randomUUID()}`;

/** Session-level advisory lock on the same key /buy uses (pg_advisory_xact_lock(hashtext(domain))). */
export async function withDomainLock<T>(db: Kysely<Database>, domain: string, fn: (conn: Kysely<Database>) => Promise<T>): Promise<T> {
  return db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(hashtext(${domain}))`.execute(conn);
    try {
      return await fn(conn);
    } finally {
      await sql`select pg_advisory_unlock(hashtext(${domain}))`.execute(conn);
    }
  });
}

export async function writePlan(trx: Transaction<Database> | Kysely<Database>, o: {
  domainId: number; plan: ListingPlan; anchor: string; dropDate: string; settings: PricingSettings;
  planAuditId: string; startAfter?: string; now: Date;
}): Promise<{ planId: string; events: ScheduleEvent[] }> {
  await trx.updateTable('price_schedule').set({ status: 'superseded', updated_at: o.now })
    .where('domain_id', '=', o.domainId).where('status', '=', 'planned').execute();
  const events = buildSchedule({ plan: o.plan, anchor: o.anchor, dropDate: o.dropDate, settings: o.settings, startAfter: o.startAfter });
  const planId = newPlanId();
  if (events.length > 0) {
    await trx.insertInto('price_schedule').values(events.map((e) => ({
      domain_id: o.domainId, plan_id: planId, event: e.event, due_on: e.dueOn,
      bin_cents: e.binCents, floor_cents: e.floorCents, walkaway_cents: e.walkawayCents,
      settings_version: o.plan.settingsVersion, status: e.status,
    }))).execute();
  }
  await trx.updateTable('domains').set({ plan_id: planId, plan_audit_id: o.planAuditId }).where('id', '=', o.domainId).execute();
  return { planId, events };
}

export function historyRow(o: {
  domainId: number; source: 'buy' | 'list'; plan: ListingPlan | null; category: Category | null; grade: 'strong' | 'weaker' | null;
  lander: string | null; override: boolean; overrideReason: string | null;
  approvalText: string | null; approvalAt: Date | null; auditId: string; planAuditId: string | null;
}): Insertable<ListingHistoryTable> {
  const p = o.plan;
  return {
    domain_id: o.domainId, source: o.source, category: p?.category ?? o.category, mode: p?.mode ?? null,
    bin_cents: p?.binCents ?? null, floor_cents: p?.floorCents ?? null, min_offer_cents: p?.minOfferCents ?? null,
    lto_max_months: p?.ltoMaxMonths ?? null, lander: o.lander, override: o.override, override_reason: o.overrideReason,
    approval_text: o.approvalText, approval_at: o.approvalAt, audit_id: o.auditId,
    price_grade: p ? p.grade : o.grade, walkaway_cents: p?.walkawayCents ?? null, pricing_source: p?.pricingSource ?? null,
    pricing_settings_version: p?.settingsVersion ?? null, schedule_event_id: null, plan_audit_id: o.planAuditId,
  };
}

export function domainPlanColumns(plan: ListingPlan): Updateable<DomainsTable> {
  return {
    listing_mode: plan.mode, bin_cents: plan.binCents, floor_cents: plan.floorCents, walkaway_cents: plan.walkawayCents,
    min_offer_cents: plan.minOfferCents, lto_max_months: plan.ltoMaxMonths, price_grade: plan.grade,
    pricing_source: plan.pricingSource, pricing_settings_version: plan.settingsVersion,
  };
}
