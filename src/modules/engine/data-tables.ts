// v5.12.0 (CR-063): loads and reads of domain_rdap, live_checks, tm_kills, bigco_names and sales_comps. Same pattern as the engine uploads:
// each row is checked on its own (a bad row is rejected with a reason, the rest are stored), one transaction under one advisory lock.
// /check and /buy never read these tables (they do their own live lookups); the retention step prunes domain_rdap and live_checks (`pruneDataTables`).
import { sql, type Kysely } from 'kysely';
import { idtDay, isRealDate } from '../../core/dates.js';
import { advisoryXactLock } from '../../core/locks.js';
import { formatUsd } from '../../core/money.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { centsOf, chunks, dateOf, domainOf, ENGINE_MAX_REJECTS, isObj, rawDomain, textOf, type Reject } from './uploads.js';

export const DATA_MAX_ROWS = 20_000;
export const DATA_TABLES = ['domain_rdap', 'live_checks', 'tm_kills', 'bigco_names', 'sales_comps'] as const;
export type DataTable = (typeof DATA_TABLES)[number];
export const RDAP_STALE_HOURS = 24;
export const LIVE_TTL_DAYS = 3;
export const CC_TTL_DAYS = 14;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface DataLoadResult {
  table: DataTable; dry_run: boolean; received_n: number; accepted_n: number; duplicate_n: number; rejected_n: number;
  skipped_not_in_pool_n?: number; rejects: Reject[];
}
interface Ctx { by: string; auditId: string | null; now: number; dryRun: boolean; sealedAfter: string }
type Parsed<T> = { ok: true; value: T } | { ok: false; domain: string | null; reason: string };

/** An instant from an ISO timestamp or a plain day; null when it does not read as a real one. */
function instantOf(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isRealDate(t) ? new Date(`${t}T00:00:00Z`) : null;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return null;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t.replace(' ', 'T') : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const optText = (v: unknown, max: number): { v: string | null } | null => (v === undefined || v === null || v === '' ? { v: null } : textOf(v, max) === null ? null : { v: textOf(v, max) });
const boolOf = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 1 || v === '1' || v === 'true' || v === 'True' ? true : v === 0 || v === '0' || v === 'false' || v === 'False' ? false : null);

// ---- parsers -------------------------------------------------------------------------------------------------------------------------------
interface RdapRow { host: string; created: Date | null; expires: Date | null; registrar: string | null; reg: boolean; checked_at: Date }
export function parseRdapRow(raw: unknown, now: number): Parsed<RdapRow> {
  if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
  const d = domainOf({ domain: raw.host });
  if ('reason' in d) return { ok: false, domain: typeof raw.host === 'string' ? raw.host.slice(0, 253) : null, reason: d.reason };
  const fail = (reason: string): Parsed<RdapRow> => ({ ok: false, domain: d.domain, reason });
  const reg = boolOf(raw.reg);
  if (reg === null) return fail('REG_INVALID');
  const checked = instantOf(raw.checked_at ?? raw.checked_utc);
  if (checked === null) return fail('CHECKED_AT_INVALID');
  if (checked.getTime() > now + DAY) return fail('CHECKED_AT_IN_FUTURE');
  let created: Date | null = null; let expires: Date | null = null;
  if (raw.created !== undefined && raw.created !== null && raw.created !== '') { created = instantOf(raw.created); if (created === null) return fail('CREATED_INVALID'); }
  if (raw.expires !== undefined && raw.expires !== null && raw.expires !== '') { expires = instantOf(raw.expires); if (expires === null) return fail('EXPIRES_INVALID'); }
  const registrar = optText(raw.registrar, 200);
  if (registrar === null) return fail('REGISTRAR_INVALID');
  return { ok: true, value: { host: d.domain, created, expires, registrar: registrar.v, reg, checked_at: checked } };
}

interface LiveRow { host: string; source: 'live' | 'livefail' | 'cc'; label: string | null; park: string | null; checked_at: Date; value_json: string | null }
export function parseLiveRow(raw: unknown, now: number): Parsed<LiveRow> {
  if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
  const d = domainOf({ domain: raw.host });
  if ('reason' in d) return { ok: false, domain: typeof raw.host === 'string' ? raw.host.slice(0, 253) : null, reason: d.reason };
  const fail = (reason: string): Parsed<LiveRow> => ({ ok: false, domain: d.domain, reason });
  if (raw.source !== 'live' && raw.source !== 'livefail' && raw.source !== 'cc') return fail('SOURCE_INVALID');
  const checked = instantOf(raw.checked_at ?? raw.checked_utc);
  if (checked === null) return fail('CHECKED_AT_INVALID');
  if (checked.getTime() > now + DAY) return fail('CHECKED_AT_IN_FUTURE');
  const label = optText(raw.label, 200); if (label === null) return fail('LABEL_INVALID');
  const park = optText(raw.park, 200); if (park === null) return fail('PARK_INVALID');
  let value: string | null = null;
  if (raw.value_json !== undefined && raw.value_json !== null) {
    let obj: unknown = raw.value_json;
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return fail('VALUE_JSON_INVALID'); } }
    value = JSON.stringify(obj);
    if (value.length > 20_000) return fail('VALUE_JSON_INVALID');
  }
  return { ok: true, value: { host: d.domain, source: raw.source, label: label.v, park: park.v, checked_at: checked, value_json: value } };
}

interface TermRow { text: string; reason: string | null; source: string | null; raw: string | null; supersedes: number | null }
function parseTermRow(field: 'term' | 'name') {
  return (raw: unknown): Parsed<TermRow> => {
    if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
    const text = textOf(raw[field], 200);
    const shown = typeof raw[field] === 'string' ? (raw[field] as string).slice(0, 200) : null;
    if (text === null) return { ok: false, domain: shown, reason: field === 'term' ? 'TERM_INVALID' : 'NAME_INVALID' };
    const fail = (reason: string): Parsed<TermRow> => ({ ok: false, domain: text, reason });
    const reason = optText(raw.reason, 500); if (reason === null) return fail('REASON_INVALID');
    const source = optText(raw.source, 200); if (source === null) return fail('SOURCE_INVALID');
    let sup: number | null = null;
    if (raw.supersedes !== undefined && raw.supersedes !== null) {
      if (typeof raw.supersedes !== 'number' || !Number.isSafeInteger(raw.supersedes) || raw.supersedes < 1) return fail('SUPERSEDES_INVALID');
      sup = raw.supersedes;
    }
    let rawJson: string | null = null;
    if (raw.raw !== undefined && raw.raw !== null) {
      if (!isObj(raw.raw)) return fail('RAW_INVALID');
      rawJson = JSON.stringify(raw.raw);
      if (rawJson.length > 10_000) return fail('RAW_INVALID');
    }
    return { ok: true, value: { text, reason: reason.v, source: source.v, raw: rawJson, supersedes: sup } };
  };
}

interface CompRow {
  domain: string; sale_date: string; price_cents: number; tier: 'T1' | 'T2' | 'T3' | 'T4'; year_flag: string | null; sale_year: number;
  reg_date_at_sale: string | null; net_reg_at_sale: string | null; org_reg_at_sale: string | null; source_url: string | null; dup_sources: string | null;
}
export function parseCompRow(raw: unknown, today: string, sealedAfter: string): Parsed<CompRow> {
  if (!isObj(raw)) return { ok: false, domain: null, reason: 'ROW_INVALID' };
  const d = domainOf(raw);
  if ('reason' in d) return { ok: false, domain: rawDomain(raw), reason: d.reason };
  const fail = (reason: string): Parsed<CompRow> => ({ ok: false, domain: d.domain, reason });
  const date = dateOf(raw.sale_date, today, sealedAfter);
  if ('reason' in date) return fail(date.reason);
  const cents = centsOf(raw.price_usd);
  if (cents === null) return fail('PRICE_INVALID');
  if (typeof raw.tier !== 'string' || !['T1', 'T2', 'T3', 'T4'].includes(raw.tier)) return fail('TIER_INVALID');
  let saleYear = Number(date.date.slice(0, 4));
  if (raw.sale_year !== undefined && raw.sale_year !== null && raw.sale_year !== '') {
    const y = typeof raw.sale_year === 'number' ? raw.sale_year : Number(raw.sale_year);
    if (!Number.isInteger(y) || y !== saleYear) return fail('SALE_YEAR_INVALID');
    saleYear = y;
  }
  const flat: Record<string, string | null> = {};
  for (const [k, max, code] of [['year_flag', 60, 'YEAR_FLAG_INVALID'], ['reg_date_at_sale', 60, 'REG_DATE_INVALID'], ['net_reg_at_sale', 60, 'NET_REG_INVALID'], ['org_reg_at_sale', 60, 'ORG_REG_INVALID'], ['source_url', 500, 'SOURCE_URL_INVALID'], ['dup_sources', 500, 'DUP_SOURCES_INVALID']] as const) {
    const v = raw[k] === undefined || raw[k] === null || raw[k] === '' ? { v: null } : typeof raw[k] === 'number' || typeof raw[k] === 'boolean' ? optText(String(raw[k]), max) : optText(raw[k], max);
    if (v === null) return fail(code);
    flat[k] = v.v;
  }
  return { ok: true, value: { domain: d.domain, sale_date: date.date, price_cents: cents, tier: raw.tier as CompRow['tier'], sale_year: saleYear,
    year_flag: flat.year_flag!, reg_date_at_sale: flat.reg_date_at_sale!, net_reg_at_sale: flat.net_reg_at_sale!, org_reg_at_sale: flat.org_reg_at_sale!, source_url: flat.source_url!, dup_sources: flat.dup_sources! } };
}

// ---- loader skeleton -----------------------------------------------------------------------------------------------------------------------
type Trx = Kysely<Database>;
async function run<T>(
  db: Kysely<Database>, table: DataTable, rows: unknown[], ctx: Ctx, parse: (raw: unknown) => Parsed<T>,
  apply: (trx: Trx, valid: { i: number; v: T }[], rejects: Reject[]) => Promise<{ accepted: number; duplicate: number; skipped?: number }>,
): Promise<DataLoadResult> {
  if (rows.length < 1 || rows.length > DATA_MAX_ROWS) throw new AppError(422, 'VALIDATION_ERROR', `rows must hold 1 to ${DATA_MAX_ROWS} rows`);
  const rejects: Reject[] = [];
  const valid: { i: number; v: T }[] = [];
  rows.forEach((raw, i) => {
    const p = parse(raw);
    if (p.ok) valid.push({ i, v: p.value });
    else rejects.push({ row: i, domain: p.domain, reason: p.reason });
  });
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'engine_upload');
    const r = await apply(trx, valid, rejects);
    rejects.sort((a, b) => a.row - b.row);
    return {
      table, dry_run: ctx.dryRun, received_n: rows.length, accepted_n: r.accepted, duplicate_n: r.duplicate, rejected_n: rejects.length,
      ...(r.skipped !== undefined && { skipped_not_in_pool_n: r.skipped }), rejects: rejects.slice(0, ENGINE_MAX_REJECTS),
    };
  });
}

const CHUNK = 2_000;
const nameCount = async (trx: Trx, t: DataTable): Promise<number> => Number((await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)}`.execute(trx)).rows[0]!.n);

/** Hosts (of `hosts`) that are in the candidate pool: a non-removed intake name or a kept drop-list row. */
export async function poolHosts(trx: Trx, hosts: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(hosts)], 5_000)) {
    for (const r of await trx.selectFrom('candidate_intake').select('domain').where('domain', 'in', part).where('status', '<>', 'removed').execute()) out.add(r.domain);
    for (const r of await trx.selectFrom('drop_list_rows').select('domain').where('domain', 'in', part).where('kept', '=', true).execute()) out.add(r.domain);
  }
  return out;
}

export function loadRdap(db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<DataLoadResult> {
  return run<RdapRow>(db, 'domain_rdap', rows, ctx, (raw) => parseRdapRow(raw, ctx.now), async (trx, valid) => {
    const pool = await poolHosts(trx, valid.map((x) => x.v.host));
    const inPool = valid.filter((x) => pool.has(x.v.host));
    const skipped = valid.length - inPool.length;
    const have = new Map<string, number>();
    for (const part of chunks([...new Set(inPool.map((x) => x.v.host))], 5_000)) {
      for (const f of await trx.selectFrom('domain_rdap').select(['host', 'checked_at']).where('host', 'in', part).execute()) have.set(f.host, f.checked_at.getTime());
    }
    const pending = new Map<string, RdapRow>();
    for (const { v } of inPool) {
      const cur = pending.get(v.host)?.checked_at.getTime() ?? have.get(v.host) ?? -Infinity;
      if (v.checked_at.getTime() > cur) pending.set(v.host, v);
    }
    if (!ctx.dryRun) {
      const at = new Date(ctx.now);
      for (const part of chunks([...pending.values()], CHUNK)) {
        await trx.insertInto('domain_rdap').values(part.map((r) => ({ ...r, loaded_at: at })))
          .onConflict((oc) => oc.column('host').doUpdateSet((eb) => ({ created: eb.ref('excluded.created'), expires: eb.ref('excluded.expires'), registrar: eb.ref('excluded.registrar'), reg: eb.ref('excluded.reg'), checked_at: eb.ref('excluded.checked_at'), loaded_at: eb.ref('excluded.loaded_at') }))).execute();
      }
    }
    return { accepted: pending.size, duplicate: inPool.length - pending.size, skipped };
  });
}

export function loadLive(db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<DataLoadResult> {
  return run<LiveRow>(db, 'live_checks', rows, ctx, (raw) => parseLiveRow(raw, ctx.now), async (trx, valid) => {
    const seen = new Set<string>();
    for (const part of chunks([...new Set(valid.map((x) => x.v.host))], 5_000)) {
      for (const f of await trx.selectFrom('live_checks').select(['host', 'source', 'checked_at']).where('host', 'in', part).execute()) seen.add(`${f.host}|${f.source}|${f.checked_at.getTime()}`);
    }
    const accepted: LiveRow[] = [];
    let dup = 0;
    for (const { v } of valid) {
      const k = `${v.host}|${v.source}|${v.checked_at.getTime()}`;
      if (seen.has(k)) dup += 1; else { seen.add(k); accepted.push(v); }
    }
    if (!ctx.dryRun) {
      const at = new Date(ctx.now);
      for (const part of chunks(accepted, CHUNK)) await trx.insertInto('live_checks').values(part.map((r) => ({ ...r, loaded_at: at }))).execute();
    }
    return { accepted: accepted.length, duplicate: dup };
  });
}

function loadTerms(table: 'tm_kills' | 'bigco_names') {
  const field = table === 'tm_kills' ? 'term' : 'name';
  return (db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<DataLoadResult> =>
    run<TermRow>(db, table, rows, ctx, parseTermRow(field), async (trx, valid, rejects) => {
      const supIds = [...new Set(valid.map((x) => x.v.supersedes).filter((x): x is number => x !== null))];
      const known = new Set<number>();
      if (supIds.length > 0) for (const r of await sql<{ id: number }>`select id from ${sql.table(table)} where id = any(${supIds})`.execute(trx).then((x) => x.rows)) known.add(r.id);
      const seen = new Set<string>();
      for (const part of chunks([...new Set(valid.map((x) => x.v.text))], 5_000)) {
        const found = await sql<{ t: string; reason: string | null; source: string | null; supersedes: number | null }>`select ${sql.ref(field)} as t, reason, source, supersedes from ${sql.table(table)} where ${sql.ref(field)} = any(${part})`.execute(trx);
        for (const f of found.rows) seen.add(JSON.stringify([f.t, f.reason, f.source, f.supersedes]));
      }
      const accepted: TermRow[] = [];
      let dup = 0;
      for (const { i, v } of valid) {
        if (v.supersedes !== null && !known.has(v.supersedes)) { rejects.push({ row: i, domain: v.text, reason: 'SUPERSEDES_NOT_FOUND' }); continue; }
        const k = JSON.stringify([v.text, v.reason, v.source, v.supersedes]);
        if (seen.has(k)) dup += 1; else { seen.add(k); accepted.push(v); }
      }
      if (!ctx.dryRun) {
        const at = new Date(ctx.now);
        for (const part of chunks(accepted, CHUNK)) {
          await trx.insertInto(table).values(part.map((r) => ({ [field]: r.text, reason: r.reason, source: r.source, raw: r.raw, supersedes: r.supersedes, by: ctx.by, audit_id: ctx.auditId, created_at: at })) as never).execute();
        }
      }
      return { accepted: accepted.length, duplicate: dup };
    });
}
export const loadTmKills = loadTerms('tm_kills');
export const loadBigcoNames = loadTerms('bigco_names');

export function loadSalesComps(db: Kysely<Database>, rows: unknown[], ctx: Ctx): Promise<DataLoadResult> {
  const today = idtDay(ctx.now);
  return run<CompRow>(db, 'sales_comps', rows, ctx, (raw) => parseCompRow(raw, today, ctx.sealedAfter), async (trx, valid) => {
    const domains = [...new Set(valid.map((x) => x.v.domain))];
    const seen = new Set<string>();
    const engine = new Map<string, number>();
    for (const part of chunks(domains, 5_000)) {
      for (const f of await trx.selectFrom('sales_comps').select(['domain', 'sale_date', 'price_cents']).where('domain', 'in', part).execute()) seen.add(`${f.domain}|${f.sale_date}|${f.price_cents}`);
      for (const f of await trx.selectFrom('engine_sales').select(['id', 'domain', 'sale_date', 'price_cents']).where('domain', 'in', part).orderBy('id').execute()) {
        const k = `${f.domain}|${f.sale_date}|${f.price_cents}`;
        if (!engine.has(k)) engine.set(k, f.id);
      }
    }
    const accepted: (CompRow & { engine_sale_id: number | null })[] = [];
    let dup = 0;
    for (const { v } of valid) {
      const k = `${v.domain}|${v.sale_date}|${v.price_cents}`;
      if (seen.has(k)) dup += 1; else { seen.add(k); accepted.push({ ...v, engine_sale_id: engine.get(k) ?? null }); }
    }
    if (!ctx.dryRun) {
      const at = new Date(ctx.now);
      for (const part of chunks(accepted, CHUNK)) await trx.insertInto('sales_comps').values(part.map((r) => ({ ...r, by: ctx.by, audit_id: ctx.auditId, created_at: at }))).execute();
    }
    return { accepted: accepted.length, duplicate: dup };
  });
}

/** Rows per data table (the answer of every load). */
export async function dataRowCounts(db: Kysely<Database>): Promise<Record<DataTable, number>> {
  const out = {} as Record<DataTable, number>;
  for (const t of DATA_TABLES) out[t] = await nameCount(db, t);
  return out;
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------------------
export interface DataQuery { host?: string; since?: string; limit: number; now: number }
const dayStart = (since: string): Date => new Date(/^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00Z` : since);
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export async function readData(db: Kysely<Database>, table: DataTable, q: DataQuery): Promise<{ count: number; rows: Record<string, unknown>[] }> {
  const since = q.since !== undefined ? dayStart(q.since) : undefined;
  switch (table) {
    case 'domain_rdap': {
      let s = db.selectFrom('domain_rdap').selectAll();
      if (q.host) s = s.where('host', '=', q.host);
      if (since) s = s.where('checked_at', '>=', since);
      const rows = (await s.orderBy('id', 'desc').limit(q.limit).execute()).map((r) => ({
        host: r.host, kind: 'rdap', created: iso(r.created), expires: iso(r.expires), registrar: r.registrar, reg: r.reg, checked_at: iso(r.checked_at), loaded_at: iso(r.loaded_at),
        stale: q.now - r.checked_at.getTime() > RDAP_STALE_HOURS * HOUR,
      }));
      return { count: rows.length, rows };
    }
    case 'live_checks': {
      let s = db.selectFrom('live_checks').selectAll();
      if (q.host) s = s.where('host', '=', q.host);
      if (since) s = s.where('checked_at', '>=', since);
      const rows = (await s.orderBy('id', 'desc').limit(q.limit).execute()).map((r) => ({ host: r.host, source: r.source, label: r.label, park: r.park, checked_at: iso(r.checked_at), value_json: r.value_json, loaded_at: iso(r.loaded_at) }));
      return { count: rows.length, rows };
    }
    case 'tm_kills': case 'bigco_names': {
      const field = table === 'tm_kills' ? 'term' : 'name';
      let s = (db as Kysely<any>).selectFrom(table).selectAll(); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (q.host) s = s.where(field, '=', q.host);
      if (since) s = s.where('created_at', '>=', since);
      const got = (await s.orderBy('id', 'desc').limit(q.limit).execute()) as Record<string, unknown>[];
      const rows = got.map((r) => ({ id: r.id, [field]: r[field], reason: r.reason, source: r.source, raw: r.raw, supersedes: r.supersedes, by: r.by, created_at: iso(r.created_at as Date) }));
      return { count: rows.length, rows };
    }
    case 'sales_comps': {
      let s = db.selectFrom('sales_comps').selectAll();
      if (q.host) s = s.where('domain', '=', q.host);
      if (since) s = s.where('sale_date', '>=', since.toISOString().slice(0, 10));
      const rows = (await s.orderBy('id', 'desc').limit(q.limit).execute()).map((r) => ({
        id: r.id, domain: r.domain, sale_date: r.sale_date, price_cents: r.price_cents, price: formatUsd(r.price_cents), tier: r.tier, year_flag: r.year_flag, sale_year: r.sale_year,
        reg_date_at_sale: r.reg_date_at_sale, net_reg_at_sale: r.net_reg_at_sale, org_reg_at_sale: r.org_reg_at_sale, source_url: r.source_url, dup_sources: r.dup_sources, engine_sale_id: r.engine_sale_id,
      }));
      return { count: rows.length, rows };
    }
  }
}

// ---- retention -----------------------------------------------------------------------------------------------------------------------------
export interface DataPruneSummary { live_checks: { deleted: number; days: number; cc_days: number }; domain_rdap: { deleted: number } }

/** Daily retention (called by the ops retention step): live and livefail rows older than 3 days, cc rows older than 14 days, RDAP rows of names no longer in the pool.
 *  Never touches tm_kills, bigco_names or sales_comps. `dryRun` counts only. */
export async function pruneDataTables(db: Kysely<Database>, now: number, dryRun: boolean): Promise<DataPruneSummary> {
  const liveCut = new Date(now - LIVE_TTL_DAYS * DAY);
  const ccCut = new Date(now - CC_TTL_DAYS * DAY);
  const stale = sql`((source in ('live', 'livefail') and checked_at < ${liveCut}) or (source = 'cc' and checked_at < ${ccCut}))`;
  const gone = sql`(not exists (select 1 from candidate_intake c where c.domain = host and c.status <> 'removed') and not exists (select 1 from drop_list_rows d where d.domain = host and d.kept))`;
  const count = async (t: string, where: ReturnType<typeof sql>) => Number((await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)} where ${where}`.execute(db)).rows[0]!.n);
  if (dryRun) return { live_checks: { deleted: await count('live_checks', stale), days: LIVE_TTL_DAYS, cc_days: CC_TTL_DAYS }, domain_rdap: { deleted: await count('domain_rdap', gone) } };
  const live = await sql`delete from live_checks where ${stale}`.execute(db);
  const rdap = await sql`delete from domain_rdap where ${gone}`.execute(db);
  return { live_checks: { deleted: Number(live.numAffectedRows ?? 0), days: LIVE_TTL_DAYS, cc_days: CC_TTL_DAYS }, domain_rdap: { deleted: Number(rdap.numAffectedRows ?? 0) } };
}
