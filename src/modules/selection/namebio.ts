// CAP-11 / CR-062 (v5.11.0): NameBio keyword stats from the FREE public endpoints only, with attribution (a score feature, never a gate).
//
// Allowed: POST https://api.namebio.com/retailstats and GET api.namebio.com/retailstats-download (the free file; URL from env). Everything else (the paid
// comps, checkdomain, dailysales, topsales, keywordstats, tldstats, verisign, the website search, any other host or path) is refused by `assertNameBioRequest`
// BEFORE a request is sent (CR-062 R-1, R-2). Calls are sequential and rate limited in code (4 a minute; the counts live in `namebio_calls`, so a
// restart does not reset them).
// The numbers are keyword aggregates and never go into engine_sales (R-5). `sources.namebio` stays the on/off switch (off by default).
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import type { SelectionValuesT } from './settings.js';
import { readCappedBytes } from './capped-read.js';
import type { ScreeningDeps } from './types.js';

export const NAMEBIO_SOURCE = 'namebio_free' as const;
export const NAMEBIO_ATTRIBUTION_URL = 'https://namebio.com';
const NAMEBIO_API_HOST = 'api.namebio.com';
const NAMEBIO_ALLOWED_PATHS = ['/retailstats'] as const;
/** The free file (GET, Gavriel's confirmation of CR-062 Q3): the RetailStats CSV. */
const NAMEBIO_FILE_PATHS = ['/retailstats-download'] as const;
const PLACEMENTS = ['exact', 'start', 'end', 'middle'] as const;
export type Placement = (typeof PLACEMENTS)[number];

const PER_MINUTE = 4;
const RATE_WAIT_MS = 60_000;
const CACHE_HOURS = 24;
/** The RetailStats file is read up to this many bytes; a longer file is refused whole (a cut file is never parsed). */
export const MAX_CSV_BYTES = 100_000_000;
/** Per-keyword fetches per nightly run (4 a minute: this is about 5 minutes); the next night continues. */
const MAX_KEYWORDS_PER_RUN = 20;
const UA = 'domain-trading-reference/1 (+nightly cache; free NameBio endpoints)';

export class NameBioRequestRefused extends Error {
  constructor(message: string) { super(message); this.name = 'NameBioRequestRefused'; }
}
class NameBioRateLimited extends Error {
  constructor(message: string) { super(message); this.name = 'NameBioRateLimited'; }
}

/** Throws unless the request is one of the allowed free-endpoint calls. Runs before any request is sent. */
export function assertNameBioRequest(rawUrl: string, method: 'GET' | 'POST'): URL {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new NameBioRequestRefused('NameBio request refused: not a URL'); }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') throw new NameBioRequestRefused('NameBio request refused: https on the default port only');
  const host = u.hostname.toLowerCase();
  if (host === NAMEBIO_API_HOST) {
    const ok = method === 'POST' ? (NAMEBIO_ALLOWED_PATHS as readonly string[]).includes(u.pathname) : (NAMEBIO_FILE_PATHS as readonly string[]).includes(u.pathname);
    if (u.search !== '' || !ok) {
      throw new NameBioRequestRefused(`NameBio request refused: ${method} ${u.pathname} is not an allowed free endpoint`);
    }
    return u;
  }
  if (method === 'GET' && (host === 'namebio.com' || host.endsWith('.namebio.com'))) return u; // a published CSV file
  throw new NameBioRequestRefused(`NameBio request refused: ${method} ${host}${u.pathname}`);
}

export interface PlacementStats { sale_count: number | null; price_sum: number | null; price_avg: number | null; price_max: number | null; price_stddev: number | null }
interface KeywordStats {
  keyword: string; start_count: number | null; end_count: number | null; exact_count: number | null; middle_count: number | null;
  placements: Partial<Record<Placement, PlacementStats>>; fetched_at: string;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const placementOf = (o: unknown): PlacementStats | null => {
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  return { sale_count: num(r.sale_count), price_sum: num(r.price_sum), price_avg: num(r.price_avg), price_max: num(r.price_max), price_stddev: num(r.price_stddev) };
};

/** A RetailStats answer ({exact, start, end, middle}, optionally under `data`) as placement stats. Throws when no placement is there. */
function parseRetailStatsResponse(json: unknown): Partial<Record<Placement, PlacementStats>> {
  const root = (typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {});
  const body = (typeof root.data === 'object' && root.data !== null ? root.data : root) as Record<string, unknown>;
  const out: Partial<Record<Placement, PlacementStats>> = {};
  for (const p of PLACEMENTS) { const s = placementOf(body[p]); if (s) out[p] = s; }
  if (Object.keys(out).length === 0) throw new Error('NameBio retailstats answer has no placement stats');
  return out;
}

/**
 * RetailStats CSV: a `keyword` column plus `<placement>_<stat>` columns (exact_sale_count, start_price_avg, ...). Any other header stops the refresh
 * (a changed export is never guessed). Needs at least one `<placement>_sale_count` column. With `keep`, only those keywords are kept (the file lists far more than the service ever asks for).
 */
export function parseRetailStatsCsv(csv: string, keep?: ReadonlySet<string>): Map<string, Partial<Record<Placement, PlacementStats>>> {
  const lines = csv.split(/\r?\n/).filter((l) => l !== '');
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const iKey = header.indexOf('keyword');
  const counts = PLACEMENTS.filter((p) => header.includes(`${p}_sale_count`));
  if (iKey < 0 || counts.length === 0) throw new Error('NameBio RetailStats CSV header must have keyword and at least one <placement>_sale_count column');
  const out = new Map<string, Partial<Record<Placement, PlacementStats>>>();
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const keyword = (c[iKey] ?? '').trim().toLowerCase();
    if (!/^[a-z0-9-]{1,60}$/.test(keyword) || (keep && !keep.has(keyword))) continue;
    const at = (name: string) => { const i = header.indexOf(name); return i < 0 ? null : num(c[i]?.trim()); };
    const pl: Partial<Record<Placement, PlacementStats>> = {};
    for (const p of counts) pl[p] = { sale_count: at(`${p}_sale_count`), price_sum: at(`${p}_price_sum`), price_avg: at(`${p}_price_avg`), price_max: at(`${p}_price_max`), price_stddev: at(`${p}_price_stddev`) };
    out.set(keyword, pl);
  }
  return out;
}

interface NameBioClockDeps { now: () => number; sleep: (ms: number) => Promise<void> }
type PostDeps = Pick<ScreeningDeps, 'fetch'> & NameBioClockDeps;

/** Waits (persisted counts) until one more RetailStats request fits the limit; records it. */
async function reserve(db: Kysely<Database>, c: NameBioClockDeps): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const r = await sql<{ at: Date }>`select called_at as at from namebio_calls where kind = 'retailstats' and called_at > ${new Date(c.now() - RATE_WAIT_MS)} order by called_at asc`.execute(db);
    if (r.rows.length < PER_MINUTE) break;
    await c.sleep(Math.max(1, r.rows[0]!.at.getTime() + RATE_WAIT_MS - c.now()) + 50);
  }
  await sql`insert into namebio_calls (kind, called_at) values ('retailstats', ${new Date(c.now())})`.execute(db);
}

/** One POST to an allowed free endpoint: allow-list first, then the rate limit, then the request; on a 429 wait 60 s and retry once. */
export async function namebioPost(db: Kysely<Database>, deps: PostDeps, path: '/retailstats', payload: Record<string, unknown>): Promise<unknown> {
  const url = assertNameBioRequest(`https://${NAMEBIO_API_HOST}${path}`, 'POST');
  for (let attempt = 0; attempt < 2; attempt++) {
    await reserve(db, deps);
    const res = await deps.fetch(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify(payload) });
    if (res.status === 429) {
      if (attempt === 0) { await deps.sleep(RATE_WAIT_MS); continue; }
      throw new NameBioRateLimited('NameBio rate limit (HTTP 429) after one retry');
    }
    if (!res.ok) throw new Error(`NameBio retailstats HTTP ${res.status}`);
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const msg = json && typeof json.error === 'string' ? json.error : null;
    if (msg && /rate.?limit|too many/i.test(msg)) {
      if (attempt === 0) { await deps.sleep(RATE_WAIT_MS); continue; }
      throw new NameBioRateLimited('NameBio rate limit after one retry');
    }
    return json;
  }
  throw new NameBioRateLimited('NameBio rate limit after one retry');
}

const retailStats = async (db: Kysely<Database>, deps: PostDeps, keyword: string) => parseRetailStatsResponse(await namebioPost(db, deps, '/retailstats', { keyword }));

const dbBytes = async (db: Kysely<Database>): Promise<number> => Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);

async function upsertKeywords(db: Kysely<Database>, rows: { keyword: string; placements: object }[], url: string, at: Date): Promise<number> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ keyword: r.keyword, placements: JSON.stringify(r.placements), source: NAMEBIO_SOURCE, source_url: url, fetched_at: at }));
    await db.insertInto('namebio_keyword_stats').values(chunk as never).onConflict((oc) => oc.column('keyword').doUpdateSet((eb) => ({
      placements: eb.ref('excluded.placements'), source_url: eb.ref('excluded.source_url'), fetched_at: eb.ref('excluded.fetched_at'),
    }))).execute();
  }
  return rows.length;
}

async function downloadCsv(deps: ScreeningDeps, rawUrl: string): Promise<string> {
  const u = assertNameBioRequest(rawUrl, 'GET');
  const res = await deps.fetch(u.toString(), { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`NameBio CSV HTTP ${res.status}`);
  const { bytes, cut } = await readCappedBytes(res, MAX_CSV_BYTES);
  if (cut) throw new Error(`NameBio CSV is over the ${MAX_CSV_BYTES / 1_000_000} MB cap`);
  return bytes.toString('utf8');
}

/** Keywords of the candidate pool (queued intake): the scout's first and last word piece, else the whole second-level label. */
async function candidatePoolKeywords(db: Kysely<Database>): Promise<string[]> {
  const rows = await db.selectFrom('candidate_intake').select(['domain', 'words']).where('status', '=', 'queued').orderBy('received_at', 'desc').limit(300).execute();
  const out = new Set<string>();
  for (const r of rows) {
    const w = (r.words ?? []).map((x) => x.toLowerCase());
    const ks = w.length > 0 ? [w[0]!, w[w.length - 1]!] : [r.domain.toLowerCase().replace(/\.com$/, '')];
    for (const k of ks) if (/^[a-z0-9-]{1,60}$/.test(k)) out.add(k);
  }
  return [...out];
}

/**
 * Keywords the service can ask about: the words and labels of every intake name, the labels of owned domains, and the keywords the form check
 * found in screened names (last 90 days). The CSV refresh stores only these.
 */
async function wantedKeywords(db: Kysely<Database>, now: number): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (k: unknown) => { if (typeof k === 'string') { const v = k.toLowerCase(); if (/^[a-z0-9-]{1,60}$/.test(v)) out.add(v); } };
  for (const r of await db.selectFrom('candidate_intake').select(['domain', 'words']).execute()) { for (const w of r.words ?? []) add(w); add(r.domain.replace(/\.com$/, '')); }
  for (const r of await db.selectFrom('domains').select('domain').execute()) add(r.domain.replace(/\.com$/, ''));
  const forms = await sql<{ k: string }>`select distinct k from screening_results r, lateral jsonb_array_elements_text(case when jsonb_typeof(r.fields->'keywords') = 'array' then r.fields->'keywords' else '[]'::jsonb end) k
    where r.check_id = 'form' and r.checked_at > ${new Date(now - 90 * 86_400_000)}`.execute(db);
  for (const r of forms.rows) add(r.k);
  return out;
}

export interface NameBioRefreshSummary {
  mode: 'csv' | 'api'; rows_written: number; file_bytes: number; requests: number; keywords_pending: number; errors: string[];
  db_bytes_before: number; db_bytes_after: number;
}

/**
 * The nightly step (CR-062 R-3): with a CSV URL set (NAMEBIO_RETAILSTATS_CSV_URL) it downloads the file and upserts, at most
 * once in 24 h; otherwise it asks RetailStats per keyword of the candidate pool that is not cached within 24 h, inside the limits.
 * `sources.namebio` false: skipped, nothing fetched.
 */
export async function refreshNameBio(db: Kysely<Database>, deps: ScreeningDeps, s: SelectionValuesT, now: () => number = Date.now):
  Promise<NameBioRefreshSummary | { skipped: true; reason: string }> {
  if (!s.sources.namebio) return { skipped: true, reason: 'SOURCE_DISABLED' };
  const clock: NameBioClockDeps = { now, sleep: deps.sleep };
  const before = await dbBytes(db);
  const at = new Date(now());
  const fresh = new Date(now() - CACHE_HOURS * 3_600_000);
  const errors: string[] = [];
  let rows = 0, fileBytes = 0, requests = 0, pending = 0;
  const rsUrl = deps.namebio?.retailstatsCsvUrl;
  const csvMode = Boolean(rsUrl);
  if (rsUrl) {
    try {
      const last = await db.selectFrom('namebio_keyword_stats').select(sql<Date | null>`max(fetched_at)`.as('at')).where('source_url', '=', rsUrl).executeTakeFirst();
      if (!last?.at || last.at < fresh) {
        const text = await downloadCsv(deps, rsUrl);
        fileBytes += Buffer.byteLength(text);
        requests++;
        const parsed = parseRetailStatsCsv(text, await wantedKeywords(db, now()));
        rows += await upsertKeywords(db, [...parsed].map(([keyword, placements]) => ({ keyword, placements })), rsUrl, at);
      }
    } catch (e) { errors.push(`retailstats_csv: ${String((e as Error).message).slice(0, 120)}`); }
  }
  if (!rsUrl) {
    const pool = await candidatePoolKeywords(db);
    const cached = pool.length === 0 ? [] : await db.selectFrom('namebio_keyword_stats').select('keyword').where('keyword', 'in', pool).where('fetched_at', '>=', fresh).execute();
    const have = new Set(cached.map((r) => r.keyword));
    const todo = pool.filter((k) => !have.has(k));
    pending = Math.max(0, todo.length - MAX_KEYWORDS_PER_RUN);
    for (const keyword of todo.slice(0, MAX_KEYWORDS_PER_RUN)) {
      try {
        requests++;
        const placements = await retailStats(db, { fetch: deps.fetch, ...clock }, keyword);
        rows += await upsertKeywords(db, [{ keyword, placements }], `https://${NAMEBIO_API_HOST}/retailstats`, new Date(now()));
      } catch (e) {
        errors.push(`${keyword}: ${String((e as Error).message).slice(0, 100)}`);
        if (e instanceof NameBioRateLimited || e instanceof NameBioRequestRefused) { pending += 1; break; }
      }
    }
  }
  return { mode: csvMode ? 'csv' : 'api', rows_written: rows, file_bytes: fileBytes, requests, keywords_pending: pending, errors, db_bytes_before: before, db_bytes_after: await dbBytes(db) };
}

export interface KeywordCounts {
  cache_date: string | null; stale: boolean; source: typeof NAMEBIO_SOURCE; attribution: string; attribution_url: string; stats: Record<string, KeywordStats | null>;
}

/**
 * Stats for keywords from the stored copies only (never a request to NameBio). `cache_date` is the fetch date of the oldest requested keyword that
 * is stored; with none stored it is the newest fetch date of the table (null when the table is empty, then stale and every stat null).
 */
export async function keywordCounts(db: Kysely<Database>, keywords: string[], s: SelectionValuesT, now: () => number = Date.now): Promise<KeywordCounts> {
  const base = { source: NAMEBIO_SOURCE, attribution: s.namebio.attribution, attribution_url: NAMEBIO_ATTRIBUTION_URL };
  const rows = keywords.length === 0 ? [] : await db.selectFrom('namebio_keyword_stats').selectAll().where('keyword', 'in', keywords).execute();
  const stats: Record<string, KeywordStats | null> = Object.fromEntries(keywords.map((k) => [k, null]));
  for (const r of rows) {
    const pl = (typeof r.placements === 'string' ? JSON.parse(r.placements) : r.placements) as Partial<Record<Placement, PlacementStats>>;
    stats[r.keyword] = {
      keyword: r.keyword, exact_count: pl.exact?.sale_count ?? null, start_count: pl.start?.sale_count ?? null, end_count: pl.end?.sale_count ?? null, middle_count: pl.middle?.sale_count ?? null,
      placements: pl, fetched_at: r.fetched_at.toISOString(),
    };
  }
  let when: Date | null = rows.length > 0 ? new Date(Math.min(...rows.map((r) => r.fetched_at.getTime()))) : null;
  if (!when) {
    const newest = await db.selectFrom('namebio_keyword_stats').select(sql<Date | null>`max(fetched_at)`.as('at')).executeTakeFirst();
    when = newest?.at ?? null;
  }
  if (!when) return { ...base, cache_date: null, stale: true, stats };
  const stale = now() - when.getTime() > s.namebio.max_cache_age_hours * 3_600_000;
  return { ...base, cache_date: when.toISOString().slice(0, 10), stale, stats };
}
