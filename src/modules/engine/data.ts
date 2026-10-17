// Database loaders for the engine's features (read only). The pure feature code is in features.ts.
import { sql, type Kysely } from 'kysely';
import { dayNumber } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { currentLists, loadSplitV2, type SplitV2Table } from '../selection/index.js';
import { buildTokenIndex, sldOf, type EndingFact, type EngineTld, type FeatureContext } from './features.js';

/** The single-word terms of the current `regime` and `tech` selection lists: added to the split table as known words (acronyms and field terms). */
export async function loadExtraTerms(db: Kysely<Database>): Promise<string[]> {
  const lists = await currentLists(db, ['regime', 'tech']);
  const out = new Set<string>();
  for (const l of Object.values(lists)) for (const t of l.terms) if (/^[a-z]{2,24}$/.test(t)) out.add(t);
  return [...out].sort();
}

export const baseSplitTable = (): SplitV2Table => loadSplitV2('bt1@v3');

export interface SaleRow { domain: string; price_cents: number; sale_date: string }
export interface UnsoldRow { domain: string; type: 'dropped_after_held' | 'registered_unsold'; observation_date: string; caught_by_catcher: boolean | null }

export async function loadSales(db: Kysely<Database>): Promise<SaleRow[]> {
  const rows = await db.selectFrom('engine_sales').select(['domain', 'price_cents', 'sale_date']).orderBy('id').execute();
  return rows.map((r) => ({ domain: r.domain, price_cents: Number(r.price_cents), sale_date: String(r.sale_date) }));
}

/** Only the dropped-after-held rows (the only ones the features, the token index and the drift read); `countRegisteredUnsold` counts the rest. */
export async function loadUnsold(db: Kysely<Database>): Promise<UnsoldRow[]> {
  const rows = await db.selectFrom('engine_unsold').select(['domain', 'type', 'observation_date', 'caught_by_catcher']).where('type', '=', 'dropped_after_held').orderBy('id').execute();
  return rows.map((r) => ({ domain: r.domain, type: r.type, observation_date: String(r.observation_date), caught_by_catcher: r.caught_by_catcher }));
}

/** The registered-unsold rows (never used for training); only their number is reported in the dataset counts. */
export async function countRegisteredUnsold(db: Kysely<Database>): Promise<number> {
  const r = await db.selectFrom('engine_unsold').select((eb) => eb.fn.countAll<string>().as('n')).where('type', '=', 'registered_unsold').executeTakeFirstOrThrow();
  return Number(r.n);
}

type EndingsMap = Map<string, Partial<Record<EngineTld, EndingFact>>>;

/** The newest row of each (name, ending); `names` limits the load (the part before .com). */
export async function loadEndings(db: Kysely<Database>, names?: string[]): Promise<EndingsMap> {
  const rows = names
    ? (await sql<{ id: string; name: string; tld: EngineTld; registered: boolean | null; created_at_registry: Date | null }>`
        select distinct on (name, tld) id::text as id, name, tld, registered, created_at_registry from engine_endings where name = any(${names}) order by name, tld, checked_at desc, id desc`.execute(db)).rows
    : (await sql<{ id: string; name: string; tld: EngineTld; registered: boolean | null; created_at_registry: Date | null }>`
        select distinct on (name, tld) id::text as id, name, tld, registered, created_at_registry from engine_endings order by name, tld, checked_at desc, id desc`.execute(db)).rows;
  const out: EndingsMap = new Map();
  for (const r of rows) {
    const m = out.get(r.name) ?? out.set(r.name, {}).get(r.name)!;
    m[r.tld] = { registered: r.registered, createdMs: r.created_at_registry ? r.created_at_registry.getTime() : null, id: Number(r.id) };
  }
  return out;
}

/** Measured searches per keyword by upload month (oldest first); `keywords` limits the load. A later upload of the same month replaces an earlier one. */
export async function loadDemand(db: Kysely<Database>, keywords?: string[]): Promise<Map<string, { month: string; searches: number }[]>> {
  let q = db.selectFrom('keyword_demand as k').innerJoin('keyword_demand_uploads as u', 'u.id', 'k.upload_id')
    .select(['k.keyword', 'k.avg_monthly_searches', 'k.upload_id', 'u.month', 'u.uploaded_at']).where('k.avg_monthly_searches', 'is not', null);
  if (keywords) q = q.where('k.keyword', 'in', keywords.length ? keywords : ['']);
  const rows = await q.orderBy('k.upload_id').execute();
  const byKw = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const month = r.month ?? r.uploaded_at.toISOString().slice(0, 7);
    (byKw.get(r.keyword) ?? byKw.set(r.keyword, new Map()).get(r.keyword)!).set(month, r.avg_monthly_searches as number);
  }
  const out = new Map<string, { month: string; searches: number }[]>();
  for (const [kw, m] of byKw) out.set(kw, [...m.entries()].map(([month, searches]) => ({ month, searches })).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)));
  return out;
}

/** True when the dropped-after-held rows are dated over at least `days` days (first to last observation). */
export function unsoldSpanDays(unsold: readonly UnsoldRow[]): number {
  let lo = Infinity; let hi = -Infinity;
  for (const u of unsold) {
    if (u.type !== 'dropped_after_held') continue;
    const d = dayNumber(u.observation_date);
    if (d < lo) lo = d; if (d > hi) hi = d;
  }
  return hi < lo ? 0 : hi - lo;
}

export const UNSOLD_DATED_DAYS = 90;

/** The token part of a feature context (sales and unsold rows of the whole upload history; the features only read what is dated before each row's as_of). */
export function tokenContext(sales: readonly SaleRow[], unsold: readonly UnsoldRow[], table: SplitV2Table): FeatureContext['tokens'] {
  return buildTokenIndex(
    sales.map((s) => ({ sld: sldOf(s.domain), day: dayNumber(s.sale_date) })),
    unsold.filter((u) => u.type === 'dropped_after_held').map((u) => ({ sld: sldOf(u.domain), day: dayNumber(u.observation_date) })),
    table, unsoldSpanDays(unsold) >= UNSOLD_DATED_DAYS,
  );
}

