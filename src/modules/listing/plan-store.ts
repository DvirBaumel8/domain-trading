import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely, type Transaction, type Updateable } from 'kysely';
import type { Category, Database, DomainRow, DomainsTable, ListingHistoryTable } from '../../db/types.js';
import { buildSchedule, type ScheduleEvent } from './pricing/schedule.js';
import type { PricingSettings } from './pricing/settings.js';
import { AppError } from '../../http/errors.js';
import type { ListingPlan } from './listing-v2.js';

export const newPlanId = (): string => `pl_${randomUUID()}`;

export async function writePlan(trx: Transaction<Database>, o: {
  domainId: number; plan: ListingPlan; anchor: string; dropDate: string; settings: PricingSettings;
  planAuditId: string; startAfter?: string; now: Date;
}): Promise<{ planId: string; events: ScheduleEvent[] }> {
  if (o.settings.version !== o.plan.settingsVersion) {
    throw new Error(`writePlan: settings v${o.settings.version} does not match plan v${o.plan.settingsVersion}`);
  }
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
  await trx.updateTable('domains').set({ plan_id: planId, plan_audit_id: o.planAuditId, updated_at: o.now }).where('id', '=', o.domainId).execute();
  return { planId, events };
}

export function historyRow(o: {
  domainId: number; source: 'buy' | 'import' | 'list'; plan: ListingPlan | null; category: Category | null; grade: 'strong' | 'weaker' | null;
  lander: string | null; override: boolean; overrideReason: string | null;
  approvalText: string | null; approvalAt: Date | null; auditId: string; planAuditId: string | null; at: Date;
}): Insertable<ListingHistoryTable> {
  const p = o.plan;
  return {
    domain_id: o.domainId, at: o.at, source: o.source, category: p?.category ?? o.category, mode: p?.mode ?? null,
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

/**
 * Set or clear the pricing hold on a locked domain row (`cur`, selected FOR UPDATE in `trx`). A no-op when the hold already has that value.
 * Writes the hold's own history row unless the caller writes one for the whole change (`history: false`).
 */
export async function applyHold(trx: Transaction<Database>, cur: DomainRow, o: {
  hold: boolean; reason: string | null; approvalText: string | null; approvalAt: Date | null; auditId: string; now: Date; history?: boolean;
}): Promise<boolean> {
  if (cur.pricing_hold === o.hold) return false;
  await trx.updateTable('domains').set({ pricing_hold: o.hold, pricing_hold_reason: o.hold ? (o.reason?.trim() ?? null) : null, updated_at: o.now })
    .where('id', '=', cur.id).execute();
  if (o.history !== false) {
    await trx.insertInto('listing_history').values(historyRow({
      domainId: cur.id, source: 'list', plan: currentPlan(cur, cur.pricing_settings_version ?? 0), category: cur.category, grade: cur.price_grade,
      lander: cur.lander, override: false, overrideReason: null, approvalText: o.approvalText, approvalAt: o.approvalAt,
      auditId: o.auditId, planAuditId: cur.plan_audit_id, at: o.now,
    })).execute();
  }
  return true;
}

/** The listing stored on the row, as a plan (for views and history rows of calls that change no price). */
export function currentPlan(row: DomainRow, fallbackVersion: number): ListingPlan | null {
  if (!row.listing_mode || !row.category) return null;
  return {
    mode: row.listing_mode, category: row.category, grade: row.category === 'geo' ? row.price_grade : null,
    binCents: row.bin_cents, floorCents: row.floor_cents, walkawayCents: row.walkaway_cents, minOfferCents: row.min_offer_cents ?? 0,
    ltoMaxMonths: row.lto_max_months, pricingSource: row.pricing_source ?? 'formula', settingsVersion: row.pricing_settings_version ?? fallbackVersion,
    overrideUsed: false, warnings: [], formula: null,
  };
}
