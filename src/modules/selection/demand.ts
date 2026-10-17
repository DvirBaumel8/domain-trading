// v4.2.0 (CR-044 item 3): keyword demand from the monthly Google Keyword Planner export. Dvir exports it by hand (United States, Saved keywords tab, CSV);
// Gavriel base64s the file and POSTs it. The real export is UTF-16LE with a BOM, tab-separated, two preamble lines (title, date range in the account's
// locale) and then a header row; the columns are read BY HEADER NAME, never by position, and the localized `Competition` text column is ignored.
// Rows with an empty Keyword are the "Segmentation" rows and are skipped. Nothing here calls Google: the file is the only source.
import type { Kysely } from 'kysely';
import { toJerusalemIso } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';

export const KEYWORD_MAX_ROWS = 5000;
export const KEYWORD_MAX_FILE_BYTES = 1_000_000;
/** Header names that must be present (compared case-insensitively, trimmed). */
export const KEYWORD_REQUIRED_HEADERS = ['Keyword', 'Avg. monthly searches', 'Competition (indexed value)'] as const;
const OPTIONAL = { three: 'three month change', yoy: 'yoy change' };

export interface KeywordRow { keyword: string; avg_monthly_searches: number | null; competition_index: number | null; three_month_change: string | null; yoy_change: string | null }
export interface ParsedKeywords { title_line: string | null; date_range_line: string | null; rows: KeywordRow[]; skipped_n: number }

/** UTF-16LE / UTF-16BE (by BOM, or by the NUL bytes of ASCII text without one) or UTF-8; a BOM is dropped. */
export function decodeKeywordFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    if (sw.length % 2 === 1) return sw.subarray(0, sw.length - 1).swap16().toString('utf16le');
    return sw.swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const head = buf.subarray(0, Math.min(buf.length, 200));
  let oddZeros = 0;
  for (let i = 1; i < head.length; i += 2) if (head[i] === 0) oddZeros++;
  if (head.length >= 4 && oddZeros >= head.length / 4) return buf.toString('utf16le');
  return buf.toString('utf8');
}

const cellsOf = (line: string): string[] => line.split('\t').map((c) => c.trim().replace(/^"(.*)"$/s, '$1').trim());
const invalid = (message: string, details: Record<string, unknown> = {}): AppError => new AppError(422, 'KEYWORD_CSV_INVALID', message, details);
const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const raw = (s: string | undefined): string | null => (s === undefined || s === '' ? null : s.slice(0, 40));

/** The keywords of an export. 422 KEYWORD_CSV_INVALID (`details.missing_headers`) when a required header is absent; nothing is stored on any error. */
export function parseKeywordExport(file: Buffer): ParsedKeywords {
  if (file.length === 0) throw invalid('The file is empty', { missing_headers: [...KEYWORD_REQUIRED_HEADERS] });
  const lines = decodeKeywordFile(file).split(/\r?\n/);
  const hAt = lines.findIndex((l) => cellsOf(l).some((c) => c.toLowerCase() === 'keyword'));
  if (hAt < 0) throw invalid('No header row with a "Keyword" column was found', { missing_headers: [...KEYWORD_REQUIRED_HEADERS] });
  const head = cellsOf(lines[hAt]!).map((c) => c.toLowerCase());
  const missing = KEYWORD_REQUIRED_HEADERS.filter((h) => !head.includes(h.toLowerCase()));
  if (missing.length > 0) throw invalid(`Required header(s) missing: ${missing.join(', ')}`, { missing_headers: missing });
  const at = (name: string): number => head.indexOf(name.toLowerCase());
  const iKw = at('Keyword'); const iAvg = at('Avg. monthly searches'); const iComp = at('Competition (indexed value)');
  const iThree = head.indexOf(OPTIONAL.three); const iYoy = head.indexOf(OPTIONAL.yoy);
  const pre = lines.slice(0, hAt).map((l) => cellsOf(l).join(' ').trim()).filter((l) => l !== '');
  const rows: KeywordRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const line of lines.slice(hAt + 1)) {
    if (line.trim() === '') continue;
    const c = cellsOf(line);
    const keyword = (c[iKw] ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (keyword === '' || seen.has(keyword)) { skipped++; continue; } // a segmentation row, or a repeated keyword (the first wins)
    if (rows.length >= KEYWORD_MAX_ROWS) throw invalid(`At most ${KEYWORD_MAX_ROWS} keywords per upload`);
    seen.add(keyword);
    const ci = num(c[iComp]);
    rows.push({
      keyword: keyword.slice(0, 200), avg_monthly_searches: num(c[iAvg]),
      competition_index: ci !== null && ci <= 100 ? Math.round(ci) : null,
      three_month_change: iThree < 0 ? null : raw(c[iThree]), yoy_change: iYoy < 0 ? null : raw(c[iYoy]),
    });
  }
  if (rows.length === 0) throw invalid('The file has no keyword rows', { missing_headers: [] });
  return { title_line: pre[0]?.slice(0, 200) ?? null, date_range_line: pre[1]?.slice(0, 200) ?? null, rows, skipped_n: skipped };
}

export interface StoredUpload { upload_id: number; uploaded_at: string; rows: number; skipped: number; date_range_line: string | null }

export async function storeKeywordUpload(
  db: Kysely<Database>, p: ParsedKeywords, o: { now: Date; by: string; auditId: string | null; location: string | null; month: string | null },
): Promise<StoredUpload> {
  return db.transaction().execute(async (trx) => {
    const up = await trx.insertInto('keyword_demand_uploads').values({
      uploaded_at: o.now, title_line: p.title_line, date_range_line: p.date_range_line, location: o.location, month: o.month,
      rows_n: p.rows.length, skipped_n: p.skipped_n, recorded_by: o.by, audit_id: o.auditId,
    }).returning('id').executeTakeFirstOrThrow();
    for (let i = 0; i < p.rows.length; i += 500) {
      await trx.insertInto('keyword_demand').values(p.rows.slice(i, i + 500).map((r) => ({ upload_id: up.id, ...r }))).execute();
    }
    return { upload_id: up.id, uploaded_at: toJerusalemIso(o.now), rows: p.rows.length, skipped: p.skipped_n, date_range_line: p.date_range_line };
  });
}

export interface KeywordValue {
  keyword: string; avg_monthly_searches: number | null; competition_index: number | null; three_month_change: string | null; yoy_change: string | null;
  upload_id: number; uploaded_at: Date; date_range_line: string | null; location: string | null; month: string | null;
}

/** The newest stored row of a keyword (the latest upload that has it), or null. */
export async function latestKeyword(db: Kysely<Database>, keyword: string): Promise<KeywordValue | null> {
  const r = await db.selectFrom('keyword_demand as k').innerJoin('keyword_demand_uploads as u', 'u.id', 'k.upload_id')
    .select(['k.keyword', 'k.avg_monthly_searches', 'k.competition_index', 'k.three_month_change', 'k.yoy_change', 'k.upload_id', 'u.uploaded_at', 'u.date_range_line', 'u.location', 'u.month'])
    .where('k.keyword', '=', keyword.toLowerCase().replace(/\s+/g, ' ').trim()).orderBy('k.upload_id', 'desc').limit(1).executeTakeFirst();
  return r ?? null;
}

export type NameDemand = { keyword: string; avg_monthly_searches: number; competition_index: number | null; as_of: string } | { status: 'unmeasured' };

/** The demand of a name: the first keyword (its split tokens joined with spaces, then the scout `words`) whose newest row has a number. */
export async function demandForKeywords(db: Kysely<Database>, keywords: string[]): Promise<NameDemand> {
  const norm = (k: string): string => k.toLowerCase().replace(/\s+/g, ' ').trim();
  const order = [...new Set(keywords.filter((x) => x !== '').map(norm))].filter((x) => x !== '');
  if (order.length === 0) return { status: 'unmeasured' };
  // M10: one query for all candidates (newest upload first); the newest row of each keyword decides, the first keyword in `order` with a number wins.
  const rows = await db.selectFrom('keyword_demand as k').innerJoin('keyword_demand_uploads as u', 'u.id', 'k.upload_id')
    .select(['k.keyword', 'k.avg_monthly_searches', 'k.competition_index', 'u.uploaded_at'])
    .where('k.keyword', 'in', order).orderBy('k.upload_id', 'desc').execute();
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!newest.has(r.keyword)) newest.set(r.keyword, r);
  for (const k of order) {
    const v = newest.get(k);
    if (v && v.avg_monthly_searches !== null) {
      return { keyword: v.keyword, avg_monthly_searches: v.avg_monthly_searches, competition_index: v.competition_index, as_of: toJerusalemIso(v.uploaded_at) };
    }
  }
  return { status: 'unmeasured' };
}

/** The keyword candidates of a name: split tokens joined with spaces, then the scout words joined with spaces. */
export const keywordCandidates = (tokens: string[], words?: string[] | null): string[] => [tokens.join(' '), (words ?? []).join(' ')].map((x) => x.toLowerCase().trim()).filter((x) => x !== '');

/** The keyword candidates of an owned or screened name, from its newest passed form result, else its newest intake words. */
export async function keywordsOfDomain(db: Kysely<Database>, domain: string): Promise<string[]> {
  const f = await db.selectFrom('screening_results').select('fields').where('domain', '=', domain).where('check_id', '=', 'form').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const tokens = (f?.fields as { tokens?: unknown } | undefined)?.tokens;
  const t = Array.isArray(tokens) && tokens.every((x) => typeof x === 'string') ? (tokens as string[]) : [];
  const i = await db.selectFrom('candidate_intake').select('words').where('domain', '=', domain).orderBy('id', 'desc').limit(1).executeTakeFirst(); // M10: a database error is an error, not "unmeasured"
  return keywordCandidates(t, i?.words ?? null);
}

/** The searches of a name for the renewal keep-signal: its measured average monthly searches, or null. */
export async function searchesOfDomain(db: Kysely<Database>, domain: string): Promise<number | null> {
  const d = await demandForKeywords(db, await keywordsOfDomain(db, domain));
  return 'status' in d ? null : d.avg_monthly_searches;
}
