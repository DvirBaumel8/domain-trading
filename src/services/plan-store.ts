import { randomUUID } from 'node:crypto';
import { sql, type Insertable, type Kysely, type Transaction, type Updateable } from 'kysely';
import type { Category, Database, DomainsTable, ListingHistoryTable } from '../db/types.js';
import { buildSchedule, type ScheduleEvent } from '../pricing/schedule.js';
import type { PricingSettings } from '../pricing/settings.js';
import { AppError } from '../http/errors.js';
import type { ListingPlan } from './listing-v2.js';

export const newPlanId = (): string => `pl_${randomUUID()}`;

const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function release(conn: Kysely<Database>, domain: string): Promise<void> {
  // fn may have left a transaction open (possibly aborted); roll it back so the connection returns to the pool clean
  try { await sql`rollback`.execute(conn); } catch { /* nothing to roll back */ }
  try {
    await sql`select pg_advisory_unlock(hashtext(${domain}))`.execute(conn);
  } catch {
    await sql`select pg_advisory_unlock_all()`.execute(conn);
  }
}

/** Session-level advisory lock on the same key /buy uses (pg_advisory_xact_lock(hashtext(domain))). Bounded wait. */
export async function withDomainLock<T>(
  db: Kysely<Database>, domain: string, fn: (conn: Kysely<Database>) => Promise<T>, opts?: { timeoutMs?: number },
): Promise<T> {
  const deadline = Date.now() + (opts?.timeoutMs ?? LOCK_TIMEOUT_MS);
  return db.connection().execute(async (conn) => {
    for (;;) {
      const r = await sql<{ ok: boolean }>`select pg_try_advisory_lock(hashtext(${domain})) as ok`.execute(conn);
      if (r.rows[0]?.ok) break;
      if (Date.now() >= deadline) throw new AppError(503, 'DOMAIN_BUSY', 'Another change to this domain is in progress; retry shortly');
      await sleep(LOCK_POLL_MS);
    }
    let result: T | undefined;
    let failed = false;
    let error: unknown;
    try {
      result = await fn(conn);
    } catch (e) {
      failed = true;
      error = e;
    }
    try {
      await release(conn, domain);
    } catch (e) {
      if (!failed) throw e; // never mask fn's error
    }
    if (failed) throw error;
    return result as T;
  });
}

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
