// v5.25.0 (CR-070): the books in DOM. Non-money cost rows (POST /ledger/costs), the forward-cost plan (PUT /portfolio/{domain}/forward-costs),
// the forward-cost view (GET /costs/forward) and the private books CSV (GET /books.csv). Money is integer cents; derived numbers are computed, never typed.
import { sql, type Kysely } from 'kysely';
import { addMonthsClamped, idtDay, isRealDate } from '../../core/dates.js';
import { pair, usdSigned, usdStringToCents } from '../../core/money.js';
import type { Database, LedgerType } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { dropsAtFirstExpiry, unrenewedLiveNames } from './report/money.js';
import { csvSafeText, portfolioRows } from './report/portfolio.js';

const bad = (message: string, details: Record<string, unknown> = {}) => new AppError(422, 'VALIDATION_ERROR', message, details);

// ---- R-1 POST /ledger/costs ----
export const COST_TYPES = ['tool', 'ai', 'adjustment'] as const;
export const COSTS_MAX_ROWS = 500;
const SIGNED_USD = /^-?\d{1,7}(\.\d{1,2})?$/;
export interface CostRowIn { date: string; type: (typeof COST_TYPES)[number]; amount_usd: string; note: string; domain?: string }
export interface CostsInput { rows: unknown[]; dry_run?: boolean }

/** Validates every row (nothing is stored when one row is wrong), then appends them in one transaction. Any other ledger type is a 422. */
export async function postCosts(db: Kysely<Database>, body: unknown, ctx: { auditId: string | null }) {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('The body must be a JSON object {rows, dry_run?}');
  for (const k of Object.keys(b)) if (k !== 'rows' && k !== 'dry_run') throw bad(`Unknown field "${k}"`, { field: k });
  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') throw bad('dry_run must be a boolean');
  const rows = b.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > COSTS_MAX_ROWS) throw bad(`rows must be an array of 1 to ${COSTS_MAX_ROWS} rows`);
  const issues: { index: number; field: string; message: string }[] = [];
  const parsed: { date: string; type: LedgerType; cents: number; note: string; domain: string | null }[] = [];
  rows.forEach((r, index) => {
    const bad1 = (field: string, message: string) => { issues.push({ index, field, message }); };
    if (!r || typeof r !== 'object' || Array.isArray(r)) { bad1('row', 'must be an object'); return; }
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['date', 'type', 'amount_usd', 'note', 'domain'].includes(k)) bad1(k, 'unknown field');
    if (typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || !isRealDate(o.date)) bad1('date', 'must be a real date YYYY-MM-DD');
    if (typeof o.type !== 'string' || !(COST_TYPES as readonly string[]).includes(o.type)) bad1('type', `must be one of ${COST_TYPES.join(', ')} (registration, renewal, sale, commission, refund and fee rows come from their own routes)`);
    let cents = 0;
    if (typeof o.amount_usd !== 'string' || !SIGNED_USD.test(o.amount_usd)) bad1('amount_usd', 'must be a signed USD string with at most 2 decimals, like "-1.20"');
    else {
      cents = (o.amount_usd.startsWith('-') ? -1 : 1) * usdStringToCents(o.amount_usd.replace('-', ''));
      if (cents === 0) bad1('amount_usd', 'must not be zero');
    }
    if (typeof o.note !== 'string' || o.note.length < 1 || o.note.length > 200) bad1('note', 'must be a string of 1 to 200 characters');
    if (o.domain !== undefined && (typeof o.domain !== 'string' || o.domain.length < 1 || o.domain.length > 253)) bad1('domain', 'must be a domain name');
    parsed.push({ date: String(o.date), type: o.type as LedgerType, cents, note: String(o.note), domain: typeof o.domain === 'string' ? o.domain.trim().toLowerCase() : null });
  });
  if (issues.length > 0) throw bad(`${issues.length} invalid field(s); nothing was stored`, { issues: issues.slice(0, 50) });
  const names = [...new Set(parsed.map((p) => p.domain).filter((d): d is string => d !== null))];
  const ids = new Map<string, number>();
  if (names.length > 0) {
    for (const d of await db.selectFrom('domains').select(['id', 'domain']).where('domain', 'in', names).where('status', '!=', 'pending_purchase').execute()) ids.set(d.domain, d.id);
    const unknown = names.filter((n) => !ids.has(n));
    if (unknown.length > 0) throw bad(`domain not in the portfolio: ${unknown.join(', ')}; nothing was stored`, { unknown_domains: unknown });
  }
  const dryRun = b.dry_run === true;
  const total = parsed.reduce((s, p) => s + p.cents, 0);
  if (!dryRun) {
    await db.transaction().execute(async (trx) => {
      for (const p of parsed) {
        await trx.insertInto('ledger_entries').values({
          occurred_on: p.date, domain_id: p.domain ? ids.get(p.domain)! : null, type: p.type, amount_cents: p.cents, note: p.note, audit_id: ctx.auditId,
        }).execute();
      }
    });
  }
  return { dry_run: dryRun, received_n: parsed.length, accepted_n: parsed.length, rejected_n: 0, ...pair('total', total), total_usd: usdSigned(total) };
}

// ---- R-2 PUT /portfolio/{domain}/forward-costs ----
/** Numbers DOM computes from the plan and the rules; a bot may never type one (422 DERIVED_FIELD). Checked at the top level and in every line. */
export const DERIVED_FIELDS: readonly string[] = [
  'walkaway', 'walk_away', 'floor', 'min_offer', 'bin', 'renewal_due', 'renewal_due_date', 'renewal_cost', 'renewal', 'renewal_price', 'forward_total', 'committed_forward',
  'total', 'planned_total', 'spend', 'spent', 'expiry', 'expiry_date', 'drop_date', 'cost', 'price',
];
const isDerived = (k: string): boolean => DERIVED_FIELDS.includes(k.replace(/_(cents|usd)$/, '')) || DERIVED_FIELDS.includes(k);

export interface ForwardLineIn { month: string; item: string; planned_usd: string; basis: string; cost_type: string }
export const FORWARD_MAX_LINES = 240;
const LINE_KEYS = ['month', 'item', 'planned_usd', 'basis', 'cost_type'];

export function parseForwardBody(body: unknown): { month: string; item: string; planned_cents: number; basis: string; cost_type: string }[] {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('The body must be a JSON object {lines: [...]}');
  const found: string[] = [];
  for (const k of Object.keys(b)) if (isDerived(k)) found.push(k);
  if (Array.isArray(b.lines)) b.lines.forEach((l, i) => {
    if (l && typeof l === 'object' && !Array.isArray(l)) for (const k of Object.keys(l)) if (isDerived(k)) found.push(`lines.${i}.${k}`);
  });
  if (found.length > 0) throw new AppError(422, 'DERIVED_FIELD', `${found.join(', ')} is computed by DOM from the plan and the rules and may not be sent`, { fields: found });
  for (const k of Object.keys(b)) if (k !== 'lines') throw bad(`Unknown field "${k}"`, { field: k });
  if (!Array.isArray(b.lines) || b.lines.length > FORWARD_MAX_LINES) throw bad(`lines must be an array of 0 to ${FORWARD_MAX_LINES} lines`);
  const issues: { index: number; field: string; message: string }[] = [];
  const out: { month: string; item: string; planned_cents: number; basis: string; cost_type: string }[] = [];
  b.lines.forEach((l, index) => {
    const bad1 = (field: string, message: string) => { issues.push({ index, field, message }); };
    if (!l || typeof l !== 'object' || Array.isArray(l)) { bad1('line', 'must be an object'); return; }
    const o = l as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!LINE_KEYS.includes(k)) bad1(k, 'unknown field');
    if (typeof o.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(o.month)) bad1('month', 'must be YYYY-MM');
    if (typeof o.item !== 'string' || o.item.length < 1 || o.item.length > 200) bad1('item', 'must be a string of 1 to 200 characters');
    if (typeof o.planned_usd !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(o.planned_usd)) bad1('planned_usd', 'must be a USD string (0 or more, at most 2 decimals) like "12.50"');
    if (typeof o.basis !== 'string' || o.basis.length < 1 || o.basis.length > 300) bad1('basis', 'must be a string of 1 to 300 characters');
    if (typeof o.cost_type !== 'string' || o.cost_type.length < 1 || o.cost_type.length > 60) bad1('cost_type', 'must be a string of 1 to 60 characters');
    if (issues.some((x) => x.index === index)) return;
    out.push({ month: o.month as string, item: o.item as string, planned_cents: usdStringToCents(o.planned_usd as string), basis: o.basis as string, cost_type: o.cost_type as string });
  });
  if (issues.length > 0) throw bad(`${issues.length} invalid field(s); nothing was stored`, { issues: issues.slice(0, 50) });
  return out;
}

const lineOut = (l: { line_no: number; month: string; item: string; planned_cents: number; basis: string; cost_type: string }) => ({
  month: l.month, item: l.item, ...pair('planned', l.planned_cents), planned_usd: usdSigned(l.planned_cents), basis: l.basis, cost_type: l.cost_type,
});

/** Appends a new plan version for the domain (the previous version stays as history). */
export async function putForwardCosts(db: Kysely<Database>, domain: string, lines: ReturnType<typeof parseForwardBody>, ctx: { tokenName: string | null; auditId: string | null }) {
  return db.transaction().execute(async (trx) => {
    const d = await trx.selectFrom('domains').select(['id', 'status']).where('domain', '=', domain).forUpdate().executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    const prev = await trx.selectFrom('forward_cost_plans').select((eb) => eb.fn.max('version').as('v')).where('domain_id', '=', d.id).executeTakeFirst();
    const previous = prev?.v ?? null;
    const version = (previous ?? 0) + 1;
    const plan = await trx.insertInto('forward_cost_plans').values({ domain_id: d.id, version, line_count: lines.length, token_name: ctx.tokenName, audit_id: ctx.auditId }).returning('id').executeTakeFirstOrThrow();
    if (lines.length > 0) await trx.insertInto('forward_cost_lines').values(lines.map((l, i) => ({ plan_id: plan.id, line_no: i + 1, ...l }))).execute();
    const total = lines.reduce((s, l) => s + l.planned_cents, 0);
    return { domain, version, previous_version: previous, lines_n: lines.length, lines: lines.map((l, i) => lineOut({ line_no: i + 1, ...l })), ...pair('planned_total', total) };
  });
}

/** The plan history of a domain, newest first (every version, superseded ones included). */
export async function forwardCostHistory(db: Kysely<Database>, domain: string) {
  const rows = await sql<{ version: number; created_at: Date; token_name: string | null; line_no: number | null; month: string | null; item: string | null; planned_cents: number | null; basis: string | null; cost_type: string | null }>`
    select p.version, p.created_at, p.token_name, l.line_no, l.month, l.item, l.planned_cents, l.basis, l.cost_type
    from forward_cost_plans p join domains d on d.id = p.domain_id left join forward_cost_lines l on l.plan_id = p.id
    where d.domain = ${domain} order by p.version desc, l.line_no`.execute(db);
  const byVersion = new Map<number, { version: number; created_at: string; token_name: string | null; lines: ReturnType<typeof lineOut>[] }>();
  for (const r of rows.rows) {
    let v = byVersion.get(r.version);
    if (!v) { v = { version: r.version, created_at: r.created_at.toISOString(), token_name: r.token_name, lines: [] }; byVersion.set(r.version, v); }
    if (r.line_no !== null) v.lines.push(lineOut({ line_no: r.line_no, month: r.month!, item: r.item!, planned_cents: r.planned_cents!, basis: r.basis!, cost_type: r.cost_type! }));
  }
  return [...byVersion.values()];
}

// ---- R-2 GET /costs/forward ----
const ym = (d: string): string => d.slice(0, 7);
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = `${from}-01`;
  while (ym(cur) <= to) { out.push(ym(cur)); cur = addMonthsClamped(cur, 1); }
  return out;
}
/** Twelve months from `from`. */
export const twelveMonthsFrom = (from: string): string => ym(addMonthsClamped(`${from}-01`, 11));
export const defaultForwardRange = (now: Date): { from: string; to: string } => {
  const from = ym(idtDay(now));
  return { from, to: twelveMonthsFrom(from) };
};

export async function forwardCosts(db: Kysely<Database>, from: string, to: string) {
  const months = monthsBetween(from, to);
  const lineRows = await sql<{ domain: string; version: number; line_no: number; month: string; item: string; planned_cents: number; basis: string; cost_type: string }>`
    select d.domain, p.version, l.line_no, l.month, l.item, l.planned_cents, l.basis, l.cost_type
    from forward_cost_plans p join domains d on d.id = p.domain_id join forward_cost_lines l on l.plan_id = p.id
    where p.version = (select max(version) from forward_cost_plans x where x.domain_id = p.domain_id) and l.month between ${from} and ${to}
    order by l.month, d.domain, l.line_no`.execute(db);
  const names = await unrenewedLiveNames(db);
  const warnings: { code: 'RENEWAL_PRICE_UNKNOWN'; domain: string; month: string; message: string }[] = [];
  const per = months.map((month) => {
    const planned = lineRows.rows.filter((l) => l.month === month).map((l) => ({ domain: l.domain, ...lineOut(l) }));
    const renewals = names.filter((d) => d.expiry_date !== null && ym(d.expiry_date) === month).map((d) => {
      const base = { domain: d.domain, due_on: d.expiry_date };
      if (dropsAtFirstExpiry(d)) return { ...base, ...pair('renewal', 0), counted: false, reason: 'DROPS_AT_FIRST_EXPIRY' };
      if (d.renewal_price_cents === null) {
        warnings.push({ code: 'RENEWAL_PRICE_UNKNOWN', domain: d.domain, month, message: `${d.domain} has no renewal price on record; its renewal is not summed (POST /portfolio/${d.domain}/renewal-price)` });
        return { ...base, ...pair('renewal', null), counted: false, reason: 'RENEWAL_PRICE_UNKNOWN' };
      }
      return { ...base, ...pair('renewal', d.renewal_price_cents), renewal_price_source: d.renewal_price_source, counted: true };
    });
    const plannedSum = planned.reduce((s, l) => s + (l.planned_cents ?? 0), 0);
    const renewalSum = renewals.reduce((s, r) => s + (r.counted ? (r.renewal_cents ?? 0) : 0), 0);
    const incomplete = renewals.some((r) => 'reason' in r && r.reason === 'RENEWAL_PRICE_UNKNOWN');
    return { month, planned, renewals, ...pair('planned_total', plannedSum), ...pair('renewals_total', renewalSum), ...pair('total', plannedSum + renewalSum), incomplete };
  });
  const p = per.reduce((s, m) => s + (m.planned_total_cents ?? 0), 0);
  const r = per.reduce((s, m) => s + (m.renewals_total_cents ?? 0), 0);
  return {
    from, to, months: per,
    totals: { ...pair('planned_total', p), ...pair('renewals_total', r), ...pair('total', p + r), incomplete: warnings.length > 0 },
    warnings,
  };
}

// ---- R-5 GET /books.csv ----
/** The header of GET /books.csv (docs/contract/formats.md "Books CSV"). */
export const BOOKS_HEADER = ['domain', 'display_name', 'line', 'category', 'status', 'buy_date', 'cost_usd', 'expiry_date', 'renewal_price_usd', 'renewal_price_source', 'drop_date',
  'bin_usd', 'floor_usd', 'walkaway_usd', 'min_offer_usd', 'next_event', 'next_event_date', 'listed_venues'];
const usd = (c: number | null): string => (c === null ? '' : usdSigned(c));

/** One row per live name (owned, listed or delisted; not sold, dropped or pending). Values come from the same rows as GET /portfolio. */
export async function booksRows(db: Kysely<Database>, now: Date): Promise<string[][]> {
  const live = (await portfolioRows(db, now)).filter((r) => ['owned', 'listed', 'delisted'].includes(r.status));
  const extra = new Map((await db.selectFrom('domains').select(['domain', 'display_name', 'buy_date', 'renewal_price_source']).where('domain', 'in', live.length ? live.map((r) => r.domain) : ['']).execute()).map((d) => [d.domain, d]));
  const venues = await sql<{ domain: string; venue: string }>`
    select domain, venue from (select distinct on (domain, venue) domain, venue, delisted from venue_listings order by domain, venue, id desc) v where not delisted`.execute(db);
  const listed = new Map<string, string[]>();
  for (const v of venues.rows) listed.set(v.domain, [...(listed.get(v.domain) ?? []), v.venue].sort());
  return [BOOKS_HEADER, ...live.map((r) => {
    const e = extra.get(r.domain);
    return [
      csvSafeText(r.domain), csvSafeText(e?.display_name ?? ''), String(r.line), csvSafeText(r.category ?? ''), r.status, e?.buy_date ?? '', usd(r.cost_cents), r.expiry_date ?? '',
      usd(r.renewal_price_cents), csvSafeText(e?.renewal_price_source ?? ''), r.drop_date ?? '', usd(r.bin_cents), usd(r.floor_cents), usd(r.walkaway_cents), usd(r.min_offer_cents),
      r.next_price_event?.event ?? '', r.next_price_event?.due_on ?? '', (listed.get(r.domain) ?? []).join(';'),
    ];
  })];
}
