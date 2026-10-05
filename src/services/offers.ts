import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, DomainRow, OffersTable } from '../db/types.js';
import { parseCsv } from '../csv-parse.js';
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
const IMPORT_HEADER = ['domain', 'amount_usd', 'source', 'received_at', 'buyer_type', 'external_ref', 'outcome', 'note'] as const;
const IMPORT_OUTCOMES: readonly string[] = ['declined', 'expired', 'withdrawn'];
const APPROVAL_OUTCOMES: readonly string[] = ['countered', 'accepted', 'sold'];
const isEmailSource = (s: string) => s === 'email_inbound' || s === 'outbound_reply';

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
      if (!body.approval_ref) throw new AppError(422, 'APPROVAL_REQUIRED', "pricing_hold needs approval_ref (Dvir's words)");
      const settings = await db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
      const a = checkApproval(body.approval_ref, body.domain, now, settings.approval_max_age_hours);
      if (!a.ok) throw new AppError(422, a.code, a.reason);
      approvedAt = a.approvedAt;
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
              hold: true, reason: body.pricing_hold_reason ?? null, approvalText: String(body.approval_ref!.text), approvalAt: approvedAt,
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

  /** POST /offers/import: all-or-nothing validation of a whole CSV, dedupe in the DB and in the file, one transaction. */
  async importCsv(raw: string, opts: { dryRun: boolean }, ctx: { auditId: string; recordedBy: string }, attempt = 0): Promise<{ status: 200 | 422; body: Record<string, unknown> }> {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
    const countBands = (rows: { band: string }[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.band] = (m[r.band] ?? 0) + 1;
      return m;
    };
    if (!opts.dryRun) {
      const prior = await db.selectFrom('offer_imports').selectAll().where('file_sha256', '=', sha).executeTakeFirst();
      if (prior) return { status: 200, body: { import_id: prior.id, rows: prior.rows, inserted: 0, duplicates: prior.rows, by_band: {} } };
    }

    const table = parseCsv(raw);
    if (!table) throw new AppError(422, 'CSV_HEADER_INVALID', 'The CSV is malformed (quoting)');
    if (table.length === 0 || table[0]!.join(',') !== IMPORT_HEADER.join(',')) {
      throw new AppError(422, 'CSV_HEADER_INVALID', `The header must be exactly ${IMPORT_HEADER.join(',')}`, { expected: IMPORT_HEADER.join(',') });
    }

    const errors: { row: number; field: string; code: string }[] = [];
    type Pending = { row: number; domain: DomainRow; p: ReturnType<typeof validateOffer>; externalRef: string | null; note: string | null; outcome: string | null };
    const pending: Pending[] = [];
    const domains = new Map<string, DomainRow | null>();
    for (let i = 1; i < table.length; i++) {
      const cells = table[i]!;
      const row = i; // 1-based data row (the header is table[0]); blank lines keep their number but are skipped
      if (cells.length === 1 && cells[0] === '') continue;
      if (cells.length !== IMPORT_HEADER.length) { errors.push({ row, field: 'row', code: 'COLUMN_COUNT' }); continue; }
      const [domainRaw, amount, source, receivedAt, buyerType, externalRef, outcome, note] = cells as [string, string, string, string, string, string, string, string];
      let domainName: string;
      try { domainName = normalizeDomain(domainRaw); } catch (e) { errors.push({ row, field: 'domain', code: (e as AppError).code }); continue; }
      if (!domains.has(domainName)) {
        const d = await db.selectFrom('domains').selectAll().where('domain', '=', domainName).executeTakeFirst();
        domains.set(domainName, d && d.status !== 'pending_purchase' ? d : null);
      }
      const d = domains.get(domainName);
      if (!d) { errors.push({ row, field: 'domain', code: 'DOMAIN_NOT_FOUND' }); continue; }
      let p: ReturnType<typeof validateOffer>;
      try {
        p = validateOffer({ amount_usd: amount, source, received_at: receivedAt, buyer_type: buyerType === '' ? null : buyerType, note: note === '' ? null : note }, now);
      } catch (e) {
        if (e instanceof FieldError) { errors.push({ row, field: e.field, code: e.code }); continue; }
        throw e;
      }
      if (outcome !== '' && !IMPORT_OUTCOMES.includes(outcome)) {
        errors.push({ row, field: 'outcome', code: APPROVAL_OUTCOMES.includes(outcome) ? 'OUTCOME_NEEDS_APPROVAL' : 'OUTCOME_INVALID' });
        continue;
      }
      pending.push({ row, domain: d, p, externalRef: externalRef === '' ? null : externalRef, note: note === '' ? null : note, outcome: outcome === '' ? null : outcome });
    }

    // Dedupe: against the DB (the single-offer rules) and within the file.
    const seen = new Map<string, number>(); // natural key -> domain_id
    const fresh: (Pending & { snap: OfferSnapshot; c: ReturnType<typeof classify> })[] = [];
    let duplicates = 0;
    for (const x of pending) {
      const key = x.externalRef !== null ? `e|${x.p.source}|${x.externalRef}` : `n|${x.domain.id}|${x.p.amountCents}|${x.p.source}|${x.p.receivedAt.getTime()}`;
      const inFile = seen.get(key);
      if (inFile !== undefined) {
        if (inFile !== x.domain.id) errors.push({ row: x.row, field: 'external_ref', code: 'EXTERNAL_REF_CONFLICT' }); else duplicates++;
        continue;
      }
      seen.set(key, x.domain.id);
      const existing = await this.findDuplicate(db, x.domain.id, x.p.source, x.p.amountCents, x.p.receivedAt, x.externalRef);
      if (existing) {
        if (existing.domain_id !== x.domain.id) errors.push({ row: x.row, field: 'external_ref', code: 'EXTERNAL_REF_CONFLICT' }); else duplicates++;
        continue;
      }
      const snap = await snapshotAt(db, x.domain, x.p.receivedAt);
      fresh.push({ ...x, snap, c: classify(snap, x.p.amountCents, x.p.source) });
    }

    if (errors.length > 0) {
      errors.sort((a, b) => a.row - b.row);
      return { status: 422, body: { error: { code: 'IMPORT_INVALID', message: `${errors.length} problem(s) in the file; nothing was imported`, details: { errors } } } };
    }
    const rows = table.slice(1).filter((c) => !(c.length === 1 && c[0] === '')).length;
    const by_band = countBands(fresh.map((f) => ({ band: f.c.band })));
    if (opts.dryRun) return { status: 200, body: { dry_run: true, rows, would_insert: fresh.length, duplicates, by_band } };

    try {
      const importId = await db.transaction().execute(async (trx) => {
        const imp = await trx.insertInto('offer_imports').values({
          file_sha256: sha, rows, inserted: fresh.length, duplicates, recorded_by: ctx.recordedBy, audit_id: ctx.auditId,
        }).returning('id').executeTakeFirstOrThrow();
        for (const f of fresh) {
          await trx.insertInto('offers').values({
            ...offerValues(f.domain.id, { ...f.p, buyerRef: null, externalRef: f.externalRef, note: f.note }, f.snap, f.c),
            ...(f.outcome ? { outcome: f.outcome as OffersTable['outcome'], outcome_at: now } : {}),
            recorded_by: ctx.recordedBy, audit_id: ctx.auditId, import_id: imp.id,
          }).execute();
        }
        return imp.id;
      });
      return { status: 200, body: { import_id: importId, rows, inserted: fresh.length, duplicates, by_band } };
    } catch (e) {
      // A concurrent writer won a unique race (same file, or one of the offers): start over once; the re-run sees it as a duplicate.
      if ((e as { code?: string }).code === '23505' && attempt === 0) return this.importCsv(raw, opts, ctx, 1);
      throw e;
    }
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
    if ((body.outcome === 'countered' || body.outcome === 'accepted') && (o.routing === 'dvir' || isEmailSource(o.source))) {
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

/** The one set of field rules for an offer, shared by POST /offers and the CSV import. */
export function validateOffer(
  body: { amount_usd: string; source: string; received_at: string; buyer_type?: string | null; buyer_ref?: string | null; note?: string | null },
  now: Date,
): { amountCents: number; source: OfferSource; buyerType: BuyerType; receivedAt: Date } {
  const amountCents = parseAmount(body.amount_usd);
  if (!(OFFER_SOURCES as readonly string[]).includes(body.source)) throw new FieldError('source', 422, 'SOURCE_INVALID', `source must be one of ${OFFER_SOURCES.join(', ')}`);
  const buyerType = body.buyer_type ?? 'unknown';
  if (!(BUYER_TYPES as readonly string[]).includes(buyerType)) throw new FieldError('buyer_type', 422, 'BUYER_TYPE_INVALID', `buyer_type must be one of ${BUYER_TYPES.join(', ')}`);
  if (!ISO_WITH_OFFSET.test(body.received_at) || Number.isNaN(Date.parse(body.received_at))) {
    throw new FieldError('received_at', 422, 'VALIDATION_ERROR', 'received_at must be ISO 8601 with a timezone offset');
  }
  const receivedAt = new Date(body.received_at);
  if (!realDate(body.received_at)) throw new FieldError('received_at', 422, 'VALIDATION_ERROR', 'received_at is not a real calendar date');
  if (receivedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) throw new FieldError('received_at', 422, 'RECEIVED_AT_IN_FUTURE', 'received_at is more than 5 minutes in the future');
  // external_ref may legitimately be an email Message-ID, so it is exempt from the '@' rule
  for (const [f, v] of [['buyer_ref', body.buyer_ref], ['note', body.note]] as const) {
    if (v != null && v.includes('@')) throw new FieldError(f, 422, 'NO_PII', `${f} must not contain an email address or '@'`);
  }
  return { amountCents, source: body.source as OfferSource, buyerType: buyerType as BuyerType, receivedAt };
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
