// v5.39.0 (CR-077): bid plans for auction (and other S8) buys. A plan is Dvir's approval of one name at one maximum price, created only after a pre-bid check that did not fail.
// Rules and test ids: docs/internal/auctions.md. The table `bid_plans` keeps the current status; every change is an append-only `bid_plan_events` row.
import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { checkApproval } from '../../../core/approval.js';
import { toJerusalemIso } from '../../../core/dates.js';
import { advisoryXactLock } from '../../../core/locks.js';
import { apiCents, formatUsd, pair } from '../../../core/money.js';
import { approvalRef } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';

export const VENUES = ['godaddy', 'dynadot'] as const;
export const PLAN_KINDS = ['auction', 'fixed_price', 'closeout'] as const;
/** An open plan whose auction ended more than this many days ago reads as `expired`. */
export const EXPIRE_AFTER_DAYS = 7;
/** Above this maximum (cents) the plan must say why the name is worth more (CLAUDE.md, main buying line). */
export const REASON_ABOVE_CENTS = 5000;
const DAY_MS = 86_400_000;

const Note = z.object({ checked: z.literal(true), note: z.string().trim().min(1).max(1000) }).strict();
const Text = z.string().trim().min(1).max(1000);

export const PlanBody = z.object({
  domain: z.string().min(1).max(253),
  venue: z.enum(VENUES),
  kind: z.enum(PLAN_KINDS),
  auction_end_at: z.iso.datetime({ offset: true }).optional(),
  max_bid_usd: z.number().positive(),
  prebid_id: z.number().int().positive(),
  manual: z.object({ exact_string_business: Note, history: Note }).strict(),
  reasons: z.object({ buyers: Text, other_endings: Text.optional(), comparables: Text.optional(), age: Text.optional() }).strict(),
  approval_ref: approvalRef,
}).strict();
export type PlanBodyT = z.infer<typeof PlanBody>;

export const ResultBody = z.object({
  outcome: z.enum(['won', 'lost', 'withdrawn']),
  final_price_usd: z.number().positive().optional(),
  ended_at: z.iso.datetime({ offset: true }),
}).strict();
export type ResultBodyT = z.infer<typeof ResultBody>;

export const PlansQuery = z.object({
  status: z.enum(['open', 'won', 'lost', 'withdrawn', 'expired']).optional(),
  domain: z.string().min(1).max(253).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

interface Row {
  id: number; domain: string; venue: string; kind: string; auction_end_at: Date | null; max_bid_cents: number; prebid_id: number; status: string; manual: unknown; reasons: unknown;
  approval_text: string; approval_at: Date; created_by: string | null; audit_id: string | null; final_price_cents: number | null; ended_at: Date | null; created_at: Date; updated_at: Date;
}

const iso = (d: Date | null): string | null => (d ? toJerusalemIso(d) : null);

/** `expired` is computed: an open plan whose auction ended more than 7 days before `nowMs`. */
export function effectiveStatus(r: Pick<Row, 'status' | 'auction_end_at'>, nowMs: number): string {
  if (r.status === 'open' && r.auction_end_at && r.auction_end_at.getTime() < nowMs - EXPIRE_AFTER_DAYS * DAY_MS) return 'expired';
  return r.status;
}

export function planView(r: Row, nowMs: number, events?: EventRow[]) {
  return {
    id: r.id, domain: r.domain, venue: r.venue, kind: r.kind, status: effectiveStatus(r, nowMs), stored_status: r.status,
    auction_end_at: iso(r.auction_end_at), ...pair('max_bid', r.max_bid_cents), prebid_id: r.prebid_id, manual: r.manual, reasons: r.reasons,
    approval: { text: r.approval_text, approved_at: iso(r.approval_at) },
    ...pair('final_price', r.final_price_cents), ended_at: iso(r.ended_at),
    created_by: r.created_by, audit_id: r.audit_id, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
    ...(events ? { events: events.map(eventView) } : {}),
  };
}

interface EventRow {
  id: number; plan_id: number; event: string; from_status: string | null; to_status: string; final_price_cents: number | null; ended_at: Date | null;
  detail: unknown; actor: string | null; audit_id: string | null; created_at: Date;
}
const eventView = (e: EventRow) => ({ id: e.id, event: e.event, from_status: e.from_status, to_status: e.to_status, ...pair('final_price', e.final_price_cents), ended_at: iso(e.ended_at), detail: e.detail, actor: e.actor, audit_id: e.audit_id, at: iso(e.created_at) });

/**
 * The dollar amounts a text names: `$180`, `180`, `$1,180`, `$180.00`, `$180.50` (in cents). The domain name is removed first, so a digit in the name is not an amount;
 * `1180` or `$18,000` do not name 180.
 */
export function amountsNamed(text: string, domain: string): Set<number> {
  const out = new Set<number>();
  const rest = text.replace(new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  for (const m of rest.matchAll(/(?<![\w.,])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\w]|,\d|\.\d)/g)) {
    out.add(Number(m[1]!.replace(/,/g, '')) * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0'))));
  }
  return out;
}

const isUnique = (e: unknown): boolean => (e as { code?: string }).code === '23505';

export interface Ctx { tokenName: string | null; auditId: string | null; nowMs: number }

async function event(trx: Kysely<Database> | Transaction<Database>, e: { plan_id: number; event: EventRow['event']; from: string | null; to: string; price?: number | null; ended_at?: Date | null; detail?: unknown; ctx: Ctx }): Promise<void> {
  await trx.insertInto('bid_plan_events').values({
    plan_id: e.plan_id, event: e.event as 'created', from_status: e.from, to_status: e.to, final_price_cents: e.price ?? null, ended_at: e.ended_at ?? null,
    detail: e.detail === undefined ? null : JSON.stringify(e.detail), actor: e.ctx.tokenName, audit_id: e.ctx.auditId, created_at: new Date(e.ctx.nowMs),
  }).execute();
}

/** POST /auctions/plans. Every refusal writes nothing. */
export async function createPlan(db: Kysely<Database>, b: PlanBodyT, ctx: Ctx) {
  const now = new Date(ctx.nowMs);
  const domain = normalizeDomain(b.domain);
  if (!domain.endsWith('.com') || domain.split('.').length !== 2) throw new AppError(422, 'VALIDATION_ERROR', 'Only .com names');
  const cfg = await db.selectFrom('settings').select(['approval_max_age_hours', 's8_max_price_cents', 's8_closeouts_allowed']).executeTakeFirstOrThrow();
  const maxBid = apiCents(b.max_bid_usd, 'max_bid_usd');
  if (b.kind === 'auction' && b.auction_end_at === undefined) throw new AppError(422, 'VALIDATION_ERROR', 'auction_end_at is required for kind "auction"');
  const endAt = b.auction_end_at === undefined ? null : new Date(b.auction_end_at);
  if (endAt && endAt.getTime() <= ctx.nowMs) throw new AppError(422, 'VALIDATION_ERROR', 'auction_end_at must be in the future');
  if (maxBid > cfg.s8_max_price_cents) {
    throw new AppError(400, 'S8_PRICE_CAP', `max_bid ${formatUsd(maxBid)} is over the S8 per-name cap ${formatUsd(cfg.s8_max_price_cents)}`, { max_bid_cents: maxBid, s8_max_price_cents: cfg.s8_max_price_cents });
  }
  // approval: the shared validator, then the text must name the maximum bid
  const appr = checkApproval(b.approval_ref ?? null, domain, now, cfg.approval_max_age_hours);
  if (!appr.ok) throw new AppError(422, appr.code, appr.reason);
  const text = String(b.approval_ref!.text);
  if (!amountsNamed(text, domain).has(maxBid)) {
    throw new AppError(422, 'APPROVAL_INVALID', `approval_ref.text must name the maximum bid (${formatUsd(maxBid)}) as a dollar amount`, { missing: 'max_bid_amount', max_bid_cents: maxBid });
  }
  if (maxBid > REASON_ABOVE_CENTS && !b.reasons.comparables && !b.reasons.other_endings) {
    throw new AppError(422, 'VALIDATION_ERROR', `Above ${formatUsd(REASON_ABOVE_CENTS)} reasons.comparables or reasons.other_endings is required: say why the name is worth more`, { required_one_of: ['reasons.comparables', 'reasons.other_endings'] });
  }
  if (b.kind === 'closeout' && !cfg.s8_closeouts_allowed) {
    throw new AppError(409, 'CLOSEOUTS_PAUSED', 'Closeouts get no money until the pick-proof test shows an edge (settings.s8_closeouts_allowed is false; migration only)');
  }
  // the pre-bid check: this name, this venue, fresh, not failed
  const pre = await db.selectFrom('prebid_checks').select(['id', 'domain', 'venue', 'verdict', 'created_at']).where('id', '=', b.prebid_id).executeTakeFirst();
  const preProblem = !pre ? 'no such pre-bid check' : pre.domain !== domain ? `that pre-bid check is for ${pre.domain}` : pre.venue !== b.venue ? `that pre-bid check is for venue ${pre.venue}`
    : ctx.nowMs - pre.created_at.getTime() > cfg.approval_max_age_hours * 3_600_000 ? `that pre-bid check is older than ${cfg.approval_max_age_hours} h: run POST /auctions/prebid again` : null;
  if (preProblem) throw new AppError(409, 'PREBID_REQUIRED', `A pre-bid check of ${domain} from the last ${cfg.approval_max_age_hours} h is required: ${preProblem}`, { prebid_id: b.prebid_id });
  if (pre!.verdict === 'fail') throw new AppError(409, 'PREBID_FAILED', `The pre-bid check ${pre!.id} of ${domain} failed; a failed name gets no bid plan`, { prebid_id: pre!.id });

  try {
    return await db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, `bid_plan:${domain}`);
      // an open plan whose auction ended long ago is set to expired (and logged) so a new plan can be made
      const stale = await trx.selectFrom('bid_plans').selectAll().where('domain', '=', domain).where('status', '=', 'open').execute();
      for (const s of stale) {
        if (effectiveStatus(s as unknown as Row, ctx.nowMs) === 'expired') {
          await trx.updateTable('bid_plans').set({ status: 'expired', updated_at: now }).where('id', '=', s.id).execute();
          await event(trx, { plan_id: s.id, event: 'expired', from: 'open', to: 'expired', detail: { reason: 'auction ended more than 7 days ago' }, ctx });
        } else throw new AppError(409, 'BID_PLAN_EXISTS', `${domain} already has an open bid plan (${s.id})`, { plan_id: s.id });
      }
      const row = await trx.insertInto('bid_plans').values({
        domain, venue: b.venue, kind: b.kind, auction_end_at: endAt, max_bid_cents: maxBid, prebid_id: b.prebid_id,
        manual: JSON.stringify(b.manual), reasons: JSON.stringify(b.reasons), approval_text: text, approval_at: appr.approvedAt,
        created_by: ctx.tokenName, audit_id: ctx.auditId, created_at: now, updated_at: now,
      }).returningAll().executeTakeFirstOrThrow();
      await event(trx, { plan_id: row.id, event: 'created', from: null, to: 'open', detail: { max_bid_cents: maxBid, prebid_id: b.prebid_id, kind: b.kind }, ctx });
      return planView(row as unknown as Row, ctx.nowMs);
    });
  } catch (e) {
    if (isUnique(e)) {
      const open = await db.selectFrom('bid_plans').select('id').where('domain', '=', domain).where('status', '=', 'open').executeTakeFirst();
      throw new AppError(409, 'BID_PLAN_EXISTS', `${domain} already has an open bid plan`, { plan_id: open?.id ?? null });
    }
    throw e;
  }
}

/** POST /auctions/plans/:id/result. */
export async function recordResult(db: Kysely<Database>, id: number, b: ResultBodyT, ctx: Ctx) {
  const now = new Date(ctx.nowMs);
  const endedAt = new Date(b.ended_at);
  if (endedAt.getTime() > ctx.nowMs + 60_000) throw new AppError(422, 'VALIDATION_ERROR', 'ended_at must not be in the future');
  if (b.outcome === 'won' && b.final_price_usd === undefined) throw new AppError(422, 'VALIDATION_ERROR', 'final_price_usd is required for outcome "won"');
  if (b.outcome === 'withdrawn' && b.final_price_usd !== undefined) throw new AppError(422, 'VALIDATION_ERROR', 'final_price_usd does not apply to outcome "withdrawn"');
  const price = b.final_price_usd === undefined ? null : apiCents(b.final_price_usd, 'final_price_usd');
  return db.transaction().execute(async (trx) => {
    const plan = await trx.selectFrom('bid_plans').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!plan) throw new AppError(404, 'BID_PLAN_NOT_FOUND', `No bid plan ${id}`);
    if (plan.status !== 'open' && plan.status !== 'expired') throw new AppError(409, 'BID_PLAN_CLOSED', `Bid plan ${id} is already ${plan.status}`, { status: plan.status });
    if (b.outcome === 'won' && price! > plan.max_bid_cents) {
      throw new AppError(409, 'PRICE_ABOVE_PLAN', `final_price ${formatUsd(price!)} is above the plan's maximum bid ${formatUsd(plan.max_bid_cents)}; nothing was recorded`, { final_price_cents: price, max_bid_cents: plan.max_bid_cents });
    }
    const row = await trx.updateTable('bid_plans').set({ status: b.outcome, final_price_cents: price, ended_at: endedAt, updated_at: now }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await event(trx, { plan_id: id, event: b.outcome, from: plan.status, to: b.outcome, price, ended_at: endedAt, ctx });
    return planView(row as unknown as Row, ctx.nowMs);
  });
}

export async function listPlans(db: Kysely<Database>, q: z.infer<typeof PlansQuery>, nowMs: number) {
  let sel = db.selectFrom('bid_plans').selectAll();
  if (q.domain) sel = sel.where('domain', '=', normalizeDomain(q.domain));
  const cut = new Date(nowMs - EXPIRE_AFTER_DAYS * DAY_MS);
  const staleOpen = sql`(status = 'open' and auction_end_at is not null and auction_end_at < ${cut})`;
  if (q.status === 'expired') sel = sel.where(sql<boolean>`(status = 'expired' or ${staleOpen})`);
  else if (q.status === 'open') sel = sel.where('status', '=', 'open').where(sql<boolean>`not ${staleOpen}`);
  else if (q.status) sel = sel.where('status', '=', q.status);
  const rows = await sel.orderBy('id', 'desc').limit(q.limit).execute();
  return { plans: rows.map((r) => planView(r as unknown as Row, nowMs)), count: rows.length };
}

export async function getPlan(db: Kysely<Database>, id: number, nowMs: number) {
  const r = await db.selectFrom('bid_plans').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw new AppError(404, 'BID_PLAN_NOT_FOUND', `No bid plan ${id}`);
  const events = await db.selectFrom('bid_plan_events').selectAll().where('plan_id', '=', id).orderBy('id').execute();
  return planView(r as unknown as Row, nowMs, events as unknown as EventRow[]);
}

/** The plan an S8 import runs under: the newest plan of the name that is stored `open` (and not expired by the 7-day rule) or `won`. */
export async function importPlanFor(db: Kysely<Database>, domain: string, nowMs: number): Promise<{ id: number; status: 'open' | 'won'; maxBidCents: number; approvalText: string; approvalAt: Date } | null> {
  const rows = await db.selectFrom('bid_plans').selectAll().where('domain', '=', domain).where('status', 'in', ['open', 'won']).orderBy('id', 'desc').execute();
  for (const r of rows) {
    if (effectiveStatus(r as unknown as Row, nowMs) === 'expired') continue;
    return { id: r.id, status: r.status as 'open' | 'won', maxBidCents: r.max_bid_cents, approvalText: r.approval_text, approvalAt: new Date(r.approval_at) };
  }
  return null;
}

/** Inside the import transaction: the plan becomes `won` with the paid price (when open), or gets an `imported` event (when already won). Re-checks status and price under the row lock. */
export async function markImported(trx: Transaction<Database>, planId: number, paidCents: number, ctx: Ctx & { domainId: number }): Promise<void> {
  const plan = await trx.selectFrom('bid_plans').selectAll().where('id', '=', planId).forUpdate().executeTakeFirstOrThrow();
  if (plan.status !== 'open' && plan.status !== 'won') {
    throw new AppError(409, 'BID_PLAN_REQUIRED', `Bid plan ${planId} is ${plan.status}; an S8 import needs an open or won bid plan`, { plan_id: planId, status: plan.status });
  }
  if (paidCents > plan.max_bid_cents) throw new AppError(409, 'PRICE_ABOVE_PLAN', `price_paid ${formatUsd(paidCents)} is above the plan's maximum bid ${formatUsd(plan.max_bid_cents)}`, { plan_id: planId, price_paid_cents: paidCents, max_bid_cents: plan.max_bid_cents });
  const now = new Date(ctx.nowMs);
  if (plan.status === 'open') {
    await trx.updateTable('bid_plans').set({ status: 'won', final_price_cents: paidCents, ended_at: now, updated_at: now }).where('id', '=', planId).execute();
    await event(trx, { plan_id: planId, event: 'won', from: 'open', to: 'won', price: paidCents, ended_at: now, detail: { by: 'import', domain_id: ctx.domainId }, ctx });
  } else {
    await event(trx, { plan_id: planId, event: 'imported', from: 'won', to: 'won', price: paidCents, detail: { domain_id: ctx.domainId, plan_final_price_cents: plan.final_price_cents }, ctx });
  }
}
