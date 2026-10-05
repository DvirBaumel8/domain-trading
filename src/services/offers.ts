import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, DomainRow, OffersTable } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { formatUsd, usdStringToCents } from '../money.js';
import { wholeUsd } from '../pricing/present.js';
import { toJerusalemIso } from '../time.js';
import { checkApproval } from './approval.js';
import { classify, BUYER_TYPES, OFFER_SOURCES, type BuyerType, type OfferSnapshot, type OfferSource } from './offer-rules.js';
import { applyHold, withDomainLock } from './plan-store.js';

type OfferRow = Selectable<OffersTable>;

export interface RecordBody {
  domain: string; amount_usd: string; source: string; received_at: string;
  buyer_type?: string | null; buyer_ref?: string | null; external_ref?: string | null; note?: string | null;
  pricing_hold?: boolean | null; pricing_hold_reason?: string | null;
  approval_ref?: { text?: unknown; approved_at?: unknown } | null;
}

export interface OutcomeBody {
  outcome: string; note?: string | null; approval_ref?: { text?: unknown; approved_at?: unknown } | null;
}

export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
export const OFFER_BANDS = ['below_min', 'below_walkaway', 'mid_range', 'at_or_above_floor', 'at_or_above_bin', 'geo_below_bin', 'unpriced'] as const;
const OFFERS_LIMIT = 500;
const FUTURE_SKEW_MS = 5 * 60_000;
const OUTCOMES = ['declined', 'countered', 'accepted', 'expired', 'withdrawn', 'sold'] as const;
const FINAL = new Set(['declined', 'expired', 'withdrawn', 'sold']);
const AFTER: Record<string, readonly string[]> = {
  countered: ['countered', 'accepted', 'declined', 'expired', 'withdrawn'],
  accepted: ['sold', 'withdrawn'],
};
const APPROVAL_OUTCOMES: readonly string[] = ['countered', 'accepted', 'sold'];

const money = (cents: number | null) => (cents === null ? { cents: null, display: null } : { cents, display: formatUsd(cents) });

export function offerView(o: OfferRow, domain: string) {
  const bin = money(o.bin_cents_at); const floor = money(o.floor_cents_at); const min = money(o.min_offer_cents_at);
  return {
    id: o.id, domain, amount_cents: o.amount_cents, amount: formatUsd(o.amount_cents), source: o.source,
    received_at: toJerusalemIso(o.received_at), buyer_type: o.buyer_type, buyer_ref: o.buyer_ref, external_ref: o.external_ref, note: o.note,
    band: o.band, routing: o.routing, outcome: o.outcome,
    outcome_at: o.outcome_at ? toJerusalemIso(o.outcome_at) : null, outcome_note: o.outcome_note,
    snapshot: {
      bin_cents: bin.cents, bin: bin.display, floor_cents: floor.cents, floor: floor.display,
      walkaway_cents: o.walkaway_cents_at, walkaway: o.walkaway_cents_at === null ? null : `${wholeUsd(o.walkaway_cents_at)} (private)`,
      min_offer_cents: min.cents, min_offer: min.display,
    },
    listing_history_id: o.listing_history_id, recorded_by: o.recorded_by,
  };
}

/** The prices in force at `receivedAt`: the latest history row with a mode at or before it, else the latest at all, else the domain's own columns. */
export async function snapshotAt(db: Kysely<Database>, d: DomainRow, receivedAt: Date): Promise<OfferSnapshot> {
  const base = () => db.selectFrom('listing_history').selectAll().where('domain_id', '=', d.id).where('mode', 'is not', null)
    .orderBy('at', 'desc').orderBy('id', 'desc');
  const h = (await base().where('at', '<=', receivedAt).executeTakeFirst()) ?? (await base().executeTakeFirst());
  const listedAtReceipt = ['listed', 'delisted', 'sold'].includes(d.status)
    && d.first_listed_at !== null && d.first_listed_at.getTime() <= receivedAt.getTime()
    && (d.delisted_at === null || d.delisted_at.getTime() > receivedAt.getTime());
  if (h) {
    return {
      mode: h.mode, binCents: h.bin_cents, floorCents: h.floor_cents, walkawayCents: h.walkaway_cents, minOfferCents: h.min_offer_cents,
      listingHistoryId: h.id, listedAtReceipt, category: h.category ?? d.category,
    };
  }
  return {
    mode: d.listing_mode, binCents: d.bin_cents, floorCents: d.floor_cents, walkawayCents: d.walkaway_cents, minOfferCents: d.min_offer_cents,
    listingHistoryId: null, listedAtReceipt, category: d.category,
  };
}

export class OffersService {
  constructor(private readonly deps: { db: Kysely<Database>; now: () => number }) {}

  async record(body: RecordBody, ctx: { auditId: string; recordedBy: string }) {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const d = await db.selectFrom('domains').selectAll().where('domain', '=', body.domain).executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${body.domain} is not an owned domain`);

    const { amountCents, source, buyerType, receivedAt } = validateOffer(body, now);

    const hold = body.pricing_hold === true;
    let approvedAt: Date | null = null;
    if (hold) {
      if (d.status !== 'owned' && d.status !== 'listed') throw new AppError(404, 'NOT_IN_PORTFOLIO', `${body.domain} is not an owned or listed domain`);
      if (!body.pricing_hold_reason?.trim()) throw new AppError(422, 'HOLD_REASON_REQUIRED', 'pricing_hold needs pricing_hold_reason');
      if (body.approval_ref) {
        const settings = await db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
        const a = checkApproval(body.approval_ref, body.domain, now, settings.approval_max_age_hours);
        if (!a.ok) throw new AppError(422, a.code, a.reason);
        approvedAt = a.approvedAt;
      }
    }

    const externalRef = body.external_ref ?? null;
    const existing = await this.findDuplicate(db, d.id, source, amountCents, receivedAt, externalRef);
    if (existing) return this.duplicate(existing, d.id);

    const snap = await snapshotAt(db, d, receivedAt);
    const c = classify(snap, amountCents, source);

    const insert = async (conn: Kysely<Database>): Promise<{ row: OfferRow; duplicate: boolean }> => {
      try {
        const row = await conn.transaction().execute(async (trx) => {
          const r = await trx.insertInto('offers').values({
            ...offerValues(d.id, { amountCents, source, receivedAt, buyerType, buyerRef: body.buyer_ref ?? null, externalRef, note: body.note ?? null }, snap, c),
            recorded_by: ctx.recordedBy, audit_id: ctx.auditId,
          }).returningAll().executeTakeFirstOrThrow();
          if (hold) {
            const cur = await trx.selectFrom('domains').selectAll().where('id', '=', d.id).forUpdate().executeTakeFirstOrThrow();
            if (cur.status !== 'owned' && cur.status !== 'listed') throw new AppError(404, 'NOT_IN_PORTFOLIO', `${body.domain} is not an owned or listed domain`);
            await applyHold(trx, cur, {
              hold: true, reason: body.pricing_hold_reason ?? null, approvalText: body.approval_ref ? String(body.approval_ref.text) : null, approvalAt: approvedAt,
              auditId: ctx.auditId, now,
            });
          }
          return r;
        });
        return { row, duplicate: false };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          const dup = await this.findDuplicate(db, d.id, source, amountCents, receivedAt, externalRef);
          if (dup) return { row: dup, duplicate: true };
        }
        throw e;
      }
    };
    const r = hold ? await withDomainLock(db, d.domain, insert) : await insert(db);
    if (r.duplicate) return this.duplicate(r.row, d.id);
    return { status: 201 as const, body: { ...offerView(r.row, d.domain), next_step: c.nextStep, warnings: c.warnings } };
  }

  /** A genuine duplicate shows the row's real domain; an external_ref already used for another domain is a conflict. */
  private async duplicate(row: OfferRow, domainId: number) {
    if (row.domain_id !== domainId) {
      throw new AppError(409, 'EXTERNAL_REF_CONFLICT', 'external_ref is already recorded for a different offer', { offer_id: row.id });
    }
    const dom = await this.deps.db.selectFrom('domains').select('domain').where('id', '=', row.domain_id).executeTakeFirstOrThrow();
    return { status: 200 as const, body: { ...offerView(row, dom.domain), duplicate: true } };
  }

  private async findDuplicate(db: Kysely<Database>, domainId: number, source: OfferSource, amountCents: number, receivedAt: Date, externalRef: string | null) {
    const q = db.selectFrom('offers').selectAll().where('source', '=', source);
    return externalRef !== null
      ? q.where('external_ref', '=', externalRef).executeTakeFirst()
      : q.where('domain_id', '=', domainId).where('amount_cents', '=', amountCents).where('received_at', '=', receivedAt).executeTakeFirst();
  }

  async outcome(id: number, body: OutcomeBody) {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const o = await db.selectFrom('offers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!o) throw new AppError(404, 'OFFER_NOT_FOUND', `Offer ${id} not found`);
    const d = await db.selectFrom('domains').selectAll().where('id', '=', o.domain_id).executeTakeFirstOrThrow();
    if (!(OUTCOMES as readonly string[]).includes(body.outcome)) {
      throw new AppError(422, 'VALIDATION_ERROR', `outcome must be one of ${OUTCOMES.join(', ')}`);
    }
    if (body.note != null && body.note.includes('@')) throw new AppError(422, 'NO_PII', "note must not contain an email address or '@'");
    if (FINAL.has(o.outcome)) throw new AppError(409, 'OUTCOME_FINAL', `Offer is already ${o.outcome}`);
    if (o.outcome !== 'open' && o.outcome !== 'declined_auto' && !AFTER[o.outcome]?.includes(body.outcome)) {
      throw new AppError(409, 'OUTCOME_TRANSITION_INVALID', `Cannot go from ${o.outcome} to ${body.outcome}`);
    }

    let approvalText: string | null = null;
    if ((body.outcome === 'countered' || body.outcome === 'accepted') && o.routing !== 'auto_accept' && o.routing !== 'accept_preapproved') {
      if (!body.approval_ref) throw new AppError(422, 'APPROVAL_REQUIRED', "This outcome needs approval_ref (Dvir's words)");
      const settings = await db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
      const a = checkApproval(body.approval_ref, d.domain, now, settings.approval_max_age_hours);
      if (!a.ok) throw new AppError(422, a.code, a.reason);
      approvalText = String(body.approval_ref.text);
    }
    if (body.outcome === 'sold' && d.status !== 'sold') {
      throw new AppError(409, 'OFFER_SOLD_MISMATCH', 'sold needs the domain to be recorded as sold first');
    }

    const updated = await db.updateTable('offers').set({
      outcome: body.outcome as OffersTable['outcome'], outcome_at: now, outcome_note: body.note ?? null, outcome_approval_text: approvalText,
    }).where('id', '=', id).where('outcome', '=', o.outcome).returningAll().executeTakeFirst();
    if (!updated) throw new AppError(409, 'OUTCOME_CHANGED_CONCURRENTLY', 'The offer changed while this request ran; retry');
    return { ...offerView(updated, d.domain), outcome_approval_text: updated.outcome_approval_text };
  }

  async list(f: { domain?: string; from?: { date?: string; at?: Date }; to?: { date?: string; at?: Date }; band?: string; source?: string }) {
    let q = this.deps.db.selectFrom('offers').innerJoin('domains', 'domains.id', 'offers.domain_id').selectAll('offers').select('domains.domain as domain_name');
    if (f.domain) q = q.where('domains.domain', '=', f.domain);
    if (f.band) q = q.where('offers.band', '=', f.band as OffersTable['band']);
    if (f.source) q = q.where('offers.source', '=', f.source as OffersTable['source']);
    if (f.from?.date) q = q.where(sql<boolean>`offers.received_at >= (${f.from.date}::date::timestamp at time zone 'Asia/Jerusalem')`);
    if (f.from?.at) q = q.where('offers.received_at', '>=', f.from.at);
    if (f.to?.date) q = q.where(sql<boolean>`offers.received_at < ((${f.to.date}::date + 1)::timestamp at time zone 'Asia/Jerusalem')`);
    if (f.to?.at) q = q.where('offers.received_at', '<=', f.to.at);
    const rows = await q.orderBy('offers.received_at', 'desc').orderBy('offers.id', 'desc').limit(OFFERS_LIMIT + 1).execute();
    return { offers: rows.slice(0, OFFERS_LIMIT).map((r) => offerView(r, r.domain_name)), truncated: rows.length > OFFERS_LIMIT };
  }
}

/** An AppError that knows which input field it is about (the CSV import reports it per row). */
export class FieldError extends AppError {
  constructor(public readonly field: string, status: number, code: string, message: string) { super(status, code, message); }
}

/** The one set of field rules for an offer, shared by POST /offers and the CSV import: every problem, in field order. */
export function validateOfferAll(
  body: { amount_usd: string; source: string; received_at: string; buyer_type?: string | null; buyer_ref?: string | null; note?: string | null },
  now: Date,
): { errors: FieldError[]; value: { amountCents: number; source: OfferSource; buyerType: BuyerType; receivedAt: Date } | null } {
  const errors: FieldError[] = [];
  const fail = (field: string, code: string, msg: string) => { errors.push(new FieldError(field, 422, code, msg)); };
  let amountCents = 0;
  try { amountCents = parseAmount(body.amount_usd); } catch (e) { if (e instanceof FieldError) errors.push(e); else throw e; }
  if (!(OFFER_SOURCES as readonly string[]).includes(body.source)) fail('source', 'SOURCE_INVALID', `source must be one of ${OFFER_SOURCES.join(', ')}`);
  const buyerType = body.buyer_type ?? 'unknown';
  if (!(BUYER_TYPES as readonly string[]).includes(buyerType)) fail('buyer_type', 'BUYER_TYPE_INVALID', `buyer_type must be one of ${BUYER_TYPES.join(', ')}`);
  let receivedAt = new Date(0);
  if (!ISO_WITH_OFFSET.test(body.received_at) || Number.isNaN(Date.parse(body.received_at))) {
    fail('received_at', 'VALIDATION_ERROR', 'received_at must be ISO 8601 with a timezone offset');
  } else if (!realDate(body.received_at)) {
    fail('received_at', 'VALIDATION_ERROR', 'received_at is not a real calendar date');
  } else {
    receivedAt = new Date(body.received_at);
    if (receivedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) fail('received_at', 'RECEIVED_AT_IN_FUTURE', 'received_at is more than 5 minutes in the future');
  }
  // external_ref may legitimately be an email Message-ID, so it is exempt from the '@' rule
  for (const [f, v] of [['buyer_ref', body.buyer_ref], ['note', body.note]] as const) {
    if (v != null && v.includes('@')) fail(f, 'NO_PII', `${f} must not contain an email address or '@'`);
  }
  return { errors, value: errors.length ? null : { amountCents, source: body.source as OfferSource, buyerType: buyerType as BuyerType, receivedAt } };
}

/** POST /offers: the first problem is thrown. */
export function validateOffer(body: Parameters<typeof validateOfferAll>[0], now: Date): NonNullable<ReturnType<typeof validateOfferAll>['value']> {
  const r = validateOfferAll(body, now);
  if (r.errors[0]) throw r.errors[0];
  return r.value!;
}

/** The offer row values common to POST /offers and the CSV import (the facts, the snapshot at receipt, the classification). */
function offerValues(
  domainId: number,
  p: { amountCents: number; source: OfferSource; receivedAt: Date; buyerType: BuyerType; buyerRef: string | null; externalRef: string | null; note: string | null },
  snap: OfferSnapshot,
  c: ReturnType<typeof classify>,
) {
  return {
    domain_id: domainId, amount_cents: p.amountCents, source: p.source, received_at: p.receivedAt, buyer_type: p.buyerType,
    buyer_ref: p.buyerRef, external_ref: p.externalRef,
    bin_cents_at: snap.binCents, floor_cents_at: snap.floorCents, walkaway_cents_at: snap.walkawayCents, min_offer_cents_at: snap.minOfferCents,
    listing_history_id: snap.listingHistoryId, band: c.band, routing: c.routing, outcome: c.outcome, note: p.note,
  };
}

function parseAmount(s: string): number {
  const bad = () => new FieldError('amount_usd', 422, 'AMOUNT_INVALID', 'amount_usd must be a positive USD amount with at most 2 decimals');
  if (typeof s !== 'string' || !/^\d+(\.\d{1,2})?$/.test(s)) throw bad();
  let c: number;
  try { c = usdStringToCents(s); } catch { throw bad(); }
  if (c <= 0 || c > 2_000_000_000) throw bad();
  return c;
}

/** The date part must be a real calendar day (JS would roll 02-30 into March). */
function realDate(iso: string): boolean {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
