import { pair, usdSigned } from '../../../core/money.js';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { toJerusalemIso } from '../../../core/dates.js';
import { pendingDomains, VENUES, type Venue } from '../../listing/index.js';
import { perDomain } from './domains.js';
import { priceValues } from './money.js';

const iso = (d: Date | null) => (d ? toJerusalemIso(d) : null);


export interface LedgerFilter { type?: string; domain?: string; from?: string; to?: string }

export async function ledgerRows(db: Kysely<Database>, f: LedgerFilter) {
  let q = db.selectFrom('ledger_entries').leftJoin('domains', 'domains.id', 'ledger_entries.domain_id')
    .select(['ledger_entries.id', 'ledger_entries.occurred_on', 'ledger_entries.type', 'domains.domain', 'ledger_entries.deal_id', 'ledger_entries.amount_cents',
      'ledger_entries.counterparty', 'ledger_entries.receipt_ref', 'ledger_entries.note']);
  if (f.type) q = q.where('ledger_entries.type', '=', f.type as never);
  if (f.domain) q = q.where('domains.domain', '=', f.domain);
  if (f.from) q = q.where('ledger_entries.occurred_on', '>=', f.from);
  if (f.to) q = q.where('ledger_entries.occurred_on', '<=', f.to);
  return q.orderBy('ledger_entries.occurred_on').orderBy('ledger_entries.id').execute();
}

const LEDGER_CSV_HEADER = ['date', 'type', 'domain', 'deal_id', 'amount_usd', 'counterparty', 'receipt_ref', 'note'];
/** G-98: a free-text cell that starts with = + - @ (or a tab / CR) would run as a formula in a spreadsheet: prefix an apostrophe. Not for `amount_usd` (a signed number). */
export const csvSafeText = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
export const ledgerCsvRows = (rows: Awaited<ReturnType<typeof ledgerRows>>): string[][] => [
  LEDGER_CSV_HEADER,
  ...rows.map((r) => [
    r.occurred_on, csvSafeText(r.type), csvSafeText(r.domain ?? ''), csvSafeText(String(r.deal_id ?? '')), usdSigned(r.amount_cents),
    csvSafeText(r.counterparty ?? ''), csvSafeText(r.receipt_ref ?? ''), csvSafeText(r.note ?? ''),
  ]),
];
export const ledgerJson = (rows: Awaited<ReturnType<typeof ledgerRows>>) => rows.map((r) => ({
  id: r.id, date: r.occurred_on, type: r.type, domain: r.domain, deal_id: r.deal_id, ...pair('amount', r.amount_cents),
  amount_usd: usdSigned(r.amount_cents), counterparty: r.counterparty, receipt_ref: r.receipt_ref, note: r.note,
}));

export async function portfolioRows(db: Kysely<Database>, now: Date, status?: string) {
  const rows = await perDomain(db, now);
  return status ? rows.filter((r) => r.status === status) : rows;
}

/** The values in force at the newest confirmed file of the venue that contains the domain (never the walk-away). */
async function exportBlock(db: Kysely<Database>, domain: string, domainId: number, venue: Venue, pending: Set<string>) {
  const f = await sql<{ uploaded_at: Date; at: Date }>`
    select u.uploaded_at, r.at from export_uploads u
    join export_runs r on r.export_id = u.export_id
    where u.venue = ${venue} and ${domain} = any(r.domains) order by r.at desc, u.id desc limit 1`.execute(db);
  const file = f.rows[0];
  let lastUploaded = null;
  if (file) {
    const h = await db.selectFrom('listing_history').select(['bin_cents', 'floor_cents', 'min_offer_cents'])
      .where('domain_id', '=', domainId).where('at', '<=', file.at).orderBy('at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (h) lastUploaded = { ...pair('bin', h.bin_cents), ...pair('floor', h.floor_cents), ...pair('min_offer', h.min_offer_cents) };
  }
  // v3.7.0 (CR-031 C): a listing made by hand on the venue. The latest record decides (a delisting ends it); `pending` then follows what is shown there against the current plan.
  const hand = await db.selectFrom('venue_listings').selectAll().where('domain', '=', domain).where('venue', '=', venue).orderBy('id', 'desc').limit(1).executeTakeFirst();
  const handLive = hand && !hand.delisted ? hand : null;
  let isPending = pending.has(domain);
  if (handLive) {
    const plan = await db.selectFrom('domains').select(['bin_cents', 'min_offer_cents']).where('id', '=', domainId).executeTakeFirstOrThrow();
    isPending = !((handLive.price_cents === null || handLive.price_cents === plan.bin_cents) && (handLive.min_offer_cents === null || handLive.min_offer_cents === plan.min_offer_cents));
  }
  return {
    pending: isPending, last_confirmed_upload_at: iso(file?.uploaded_at ?? null), last_uploaded: lastUploaded,
    listed_by_hand_at: iso(handLive?.listed_at ?? null),
    shown: handLive ? { mode: handLive.mode, ...pair('price', handLive.price_cents), ...pair('min_offer', handLive.min_offer_cents) } : null,
    delisted_by_hand_at: hand?.delisted ? iso(hand.listed_at) : null,
  };
}

export async function portfolioDetail(db: Kysely<Database>, now: Date, domain: string) {
  // one name: its row is built from this name's data only (v5.14.0), and the independent reads run together
  const row = (await perDomain(db, now, { domain }))[0];
  if (!row) return null;
  const d = await db.selectFrom('domains').select(['id', 'plan_id', 'renewal_price_source', 'renewal_price_as_of']).where('domain', '=', domain).executeTakeFirstOrThrow();
  const [ledger, purchases, quotes, history, sched, sale, rs, ex] = await Promise.all([
    ledgerRows(db, { domain }),
    db.selectFrom('purchases').select(['id', 'state', 'dry_run', 'registrar', 'charged_cents', 'created_at']).where('domain', '=', domain).orderBy('id').execute(),
    (async () => {
      const latest = await db.selectFrom('quotes').select('check_id').where('domain', '=', domain).orderBy('quoted_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
      return latest ? db.selectFrom('quotes').select(['registrar', 'quoted_at', 'available', 'premium', 'first_year_cents', 'renewal_cents', 'eligible', 'exclusion_reason'])
        .where('check_id', '=', latest.check_id).where('domain', '=', domain).orderBy('id').execute() : [];
    })(),
    db.selectFrom('listing_history').selectAll().where('domain_id', '=', d.id).orderBy('id', 'desc').execute(),
    d.plan_id ? db.selectFrom('price_schedule').selectAll().where('domain_id', '=', d.id).where('plan_id', '=', d.plan_id).orderBy('due_on').orderBy('id').execute() : Promise.resolve([]),
    db.selectFrom('sales').selectAll().where('domain_id', '=', d.id).orderBy('id', 'desc').limit(1).executeTakeFirst(),
    db.selectFrom('registrar_state_checks').select(['checked_at', 'auto_renew', 'privacy', 'ns']).where('domain', '=', domain).orderBy('id', 'desc').limit(1).executeTakeFirst(),
    Promise.all(VENUES.map(async (v) => [v, await exportBlock(db, domain, d.id, v, new Set(await pendingDomains(db, v)))] as const)).then((e) => Object.fromEntries(e) as Record<string, unknown>),
  ]);
  const offers = await db.selectFrom('offers').select(['id', 'amount_cents', 'source', 'received_at', 'buyer_type', 'band', 'routing', 'outcome', 'note'])
    .where('domain_id', '=', d.id).orderBy('received_at', 'desc').orderBy('id', 'desc').limit(50).execute();
  return {
    ...row,
    renewal_price_source: d.renewal_price_source, renewal_price_as_of: d.renewal_price_as_of,
    ledger: ledgerJson(ledger),
    purchases: purchases.map((p) => ({ id: p.id, state: p.state, dry_run: p.dry_run, registrar: p.registrar, ...pair('cost', p.charged_cents), created_at: iso(p.created_at) })),
    quotes: quotes.map((q) => ({ registrar: q.registrar, quoted_at: iso(q.quoted_at), available: q.available, premium: q.premium,
      ...pair('first_year', q.first_year_cents), ...pair('renewal', q.renewal_cents), eligible: q.eligible, exclusion_reason: q.exclusion_reason })),
    listing_history: history.map((h) => ({
      id: h.id, at: iso(h.at), source: h.source, category: h.category, mode: h.mode, ...priceValues(h), ...pair('min_offer', h.min_offer_cents),
      price_grade: h.price_grade, pricing_source: h.pricing_source, pricing_settings_version: h.pricing_settings_version,
      override: h.override, override_reason: h.override_reason, approval_text: h.approval_text, approval_at: iso(h.approval_at),
    })),
    schedule: sched.map((s) => ({ event: s.event, due_on: s.due_on, status: s.status, settings_version: s.settings_version, ...priceValues(s), applied_at: iso(s.applied_at), note: s.note })),
    sale: sale ? {
      venue: sale.venue, transaction_ref: sale.transaction_ref, ...pair('sale_price', sale.sale_price_cents), ...pair('commission', sale.commission_cents),
      ...pair('other_fees', sale.other_fees_cents), sold_at: iso(sale.sold_at), evidence_source: sale.evidence_source, evidence_ref: sale.evidence_ref,
      confirmed: sale.confirmed, recorded_by: sale.recorded_by, offer_id: sale.offer_id,
    } : null,
    export: ex,
    registrar_state: rs ? { auto_renew: rs.auto_renew, privacy: rs.privacy, ns: rs.ns, checked_at: iso(rs.checked_at) } : null,
    offers: offers.map((o) => ({ id: o.id, ...pair('amount', o.amount_cents), source: o.source, received_at: iso(o.received_at), buyer_type: o.buyer_type, band: o.band, routing: o.routing, outcome: o.outcome, note: o.note })),
  };
}

export async function dealView(db: Kysely<Database>, id: string) {
  const deal = await db.selectFrom('deals').selectAll().where('id', '=', id).executeTakeFirst();
  if (!deal) return null;
  const rows = await db.selectFrom('audit_log').select(['id', 'at', 'method', 'path', 'approval_text', 'approval_at', 'status_code', sql<unknown>`request->'dry_run'`.as('dry_run')])
    .where('approval_text', 'is not', null)
    .where((eb) => eb.or([
      eb(sql`request->>'deal_id'`, '=', id),
      ...(deal.domain ? [eb(sql`request->>'domain'`, '=', deal.domain), eb('path', 'like', `%/${deal.domain}`)] : []),
    ])).orderBy('at').orderBy('id').execute();
  return {
    id: deal.id, domain: deal.domain, strategy: deal.strategy, status_note: deal.status_note, created_at: iso(deal.created_at),
    approvals: rows.map((r) => ({ audit_id: r.id, at: iso(r.at), method: r.method, path: r.path, approval_text: r.approval_text, approval_at: iso(r.approval_at), status_code: r.status_code, dry_run: r.dry_run === true || r.dry_run === 'strict' })),
  };
}

export async function auditRows(db: Kysely<Database>, o: { since?: Date; limit: number }) {
  let q = db.selectFrom('audit_log').selectAll();
  if (o.since) q = q.where('at', '>=', o.since);
  const rows = await q.orderBy('at', 'desc').orderBy('id', 'desc').limit(o.limit).execute();
  return rows.map((r) => ({
    id: r.id, at: iso(r.at), token_id: r.token_id, scope: r.scope, method: r.method, path: r.path, idempotency_key: r.idempotency_key,
    approval_text: r.approval_text, approval_at: iso(r.approval_at), request: r.request, status_code: r.status_code, result_summary: r.result_summary, client_ip: r.client_ip, bot_name: r.bot_name,
  }));
}
