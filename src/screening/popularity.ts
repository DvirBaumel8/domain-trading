// CAP-02 TYPO-1 popularity list. Ruling (6 Oct 2026, controller (a)): Tranco has no licence of its own and one upstream provider is
// CC BY-NC 4.0 (gap G-30), so the list used is the **Majestic Million**, whose terms were verified at the primary source
// ("Licensed under a Creative Commons Attribution 3.0 Unported License", docs/internal/sources.md). The module keeps the names the
// plan gave it (`refreshPopularity`, `latestPopularity`) and the settings switch `sources.popularity`; the data is Majestic's top-N, by rank.
// Attribution: "Majestic Million, Majestic (https://majestic.com), CC BY 3.0". The file is never redistributed or committed in full.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { USER_AGENT } from '../rdap.js';
import type { ScreeningDeps } from './types.js';
import type { SelectionValuesT } from './settings.js';

export const POPULARITY_URL = 'https://downloads.majestic.com/majestic_million.csv';
export const POPULARITY_NAME = 'popularity_list';
/** One download per day: a refresh inside this window is skipped. */
const MIN_REFRESH_GAP_MS = 20 * 3_600_000;
const MIN_ROWS = 100;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export class PopularityListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PopularityListError';
  }
}

export interface PopularityRow { rank: number; domain: string; tld: string | null }
/** More malformed rows than this share of the rows read fails the whole download. */
const MAX_MALFORMED_SHARE = 0.01;

/**
 * First `max` data rows of a Majestic CSV; throws PopularityListError on a body that is not that CSV. A malformed row is skipped
 * (counted in `skipped`); more than 1% of the rows read being malformed fails the download.
 */
export function parsePopularityCsv(text: string, max: number): { rows: PopularityRow[]; skipped: number } {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const iRank = header.indexOf('GlobalRank');
  const iDomain = header.indexOf('Domain');
  const iTld = header.indexOf('TLD');
  if (iRank < 0 || iDomain < 0) throw new PopularityListError('The popularity list has no GlobalRank and Domain columns');
  const rows: PopularityRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    if (rows.length >= max) break;
    const c = line.split(',');
    const rank = Number(c[iRank]);
    const domain = (c[iDomain] ?? '').trim().toLowerCase();
    const tld = iTld >= 0 ? (c[iTld] ?? '').trim().toLowerCase() : '';
    if (!Number.isInteger(rank) || rank < 1 || !DOMAIN_RE.test(domain)) { skipped++; continue; }
    rows.push({ rank, domain, tld: /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(tld) ? tld : null });
  }
  if (skipped > 0 && skipped > MAX_MALFORMED_SHARE * (rows.length + skipped)) throw new PopularityListError(`The popularity list has ${skipped} malformed rows out of ${rows.length + skipped}`);
  if (rows.length < Math.min(max, MIN_ROWS)) throw new PopularityListError(`The popularity list has only ${rows.length} rows`);
  return { rows, skipped };
}

/** Country-code second-level suffixes handled as one suffix (a small set; the full public suffix list is not shipped). */
export const CC_SLDS = new Set(['co.uk', 'com.au', 'co.jp', 'gov.uk', 'gov.cn', 'com.br', 'co.in', 'org.uk', 'ac.uk', 'net.au']);

/**
 * The registrable label of a listed host: the label just left of the public suffix (play.google.com -> google, bbc.co.uk -> bbc).
 * The suffix is a ccSLD from the small set above, else the row's TLD column when given, else the last label. null when there is no
 * label left of the suffix, or it is `www` (a host name, not a registrable name: www.gov.uk).
 */
export function registrableLabel(domain: string, tld: string | null): string | null {
  const labels = domain.split('.');
  const two = labels.slice(-2).join('.');
  const suffixLen = CC_SLDS.has(two) ? 2 : tld ? Math.min(tld.split('.').length, labels.length) : 1;
  const label = labels[labels.length - suffixLen - 1];
  return !label || label === 'www' ? null : label;
}

/** Reads a response body until `lines` complete lines are in (then cancels, so the 80 MB file is not downloaded). */
async function readLines(res: Response, lines: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    text += chunk;
    for (let i = chunk.indexOf('\n'); i >= 0; i = chunk.indexOf('\n', i + 1)) n++;
    if (n > lines) { await reader.cancel(); break; }
  }
  const cut = text.lastIndexOf('\n');
  return n > lines && cut >= 0 ? text.slice(0, cut) : text; // drop a partial last line
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Daily refresh. Fail closed: a non-200, empty or non-CSV answer throws and the previous snapshot stays the one served.
 * An unchanged body adds a row pointing at the earlier one (`same_as_id`) instead of a second copy.
 */
export async function refreshPopularity(db: Kysely<Database>, deps: ScreeningDeps, s: SelectionValuesT, now: () => number = Date.now):
  Promise<{ list_id: string; list_date: string; rows: number; malformed_skipped: number } | { skipped: true; reason: string }> {
  if (!s.sources.popularity) return { skipped: true, reason: 'SOURCE_DISABLED' };
  const last = await newestRow(db);
  if (last && now() - last.fetched_at.getTime() < MIN_REFRESH_GAP_MS) return { skipped: true, reason: 'fetched within the last 20 hours' };
  const res = await deps.fetch(POPULARITY_URL, { headers: { 'user-agent': USER_AGENT, accept: 'text/csv' }, signal: AbortSignal.timeout(60_000) });
  if (res.status !== 200) throw new PopularityListError(`The popularity list answered HTTP ${res.status}`);
  const text = await readLines(res, s.typo.top_n + 1);
  const { rows, skipped } = parsePopularityCsv(text, s.typo.top_n);
  const lm = res.headers.get('last-modified');
  const parsed = lm ? new Date(lm) : null;
  const listDate = parsed && !Number.isNaN(parsed.getTime()) ? dayOf(parsed) : dayOf(new Date(now()));
  const body = rows.map((r) => `${r.rank},${r.domain},${r.tld ?? ''}`).join('\n');
  const sha = createHash('sha256').update(body, 'utf8').digest('hex');
  const same = last && last.sha256 === sha ? last : null;
  const sameId = same ? (same.body_gz ? same.id : same.same_as_id) : null;
  await db.insertInto('reference_files').values({
    name: POPULARITY_NAME, source_url: POPULARITY_URL, fetched_at: new Date(now()), data_date: listDate, sha256: sha,
    bytes: Buffer.byteLength(body, 'utf8'), body_gz: sameId ? null : gzipSync(Buffer.from(body, 'utf8')), same_as_id: sameId,
  }).execute();
  return { list_id: `majestic-${listDate}`, list_date: listDate, rows: rows.length, malformed_skipped: skipped };
}

async function newestRow(db: Kysely<Database>) {
  return db.selectFrom('reference_files').selectAll().where('name', '=', POPULARITY_NAME).orderBy('fetched_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}

export interface PopularityList { listId: string; listDate: string; fetchedAt: Date; rows: number; slds: string[]; ranks: Map<string, number> }
let cached: { key: string; list: PopularityList } | null = null; // only the newest snapshot is kept

/** The newest snapshot, parsed (distinct registrable labels, the first rank wins), cached in-process. null: none yet. */
export async function latestPopularity(db: Kysely<Database>): Promise<PopularityList | null> {
  const row = await newestRow(db);
  if (!row) return null;
  const key = `${row.id}:${row.sha256}:${row.fetched_at.getTime()}`;
  if (cached?.key === key) return cached.list;
  let bodyRow: { body_gz: Buffer | null } | undefined = row;
  if (!row.body_gz && row.same_as_id !== null) bodyRow = await db.selectFrom('reference_files').select('body_gz').where('id', '=', row.same_as_id).executeTakeFirst();
  if (!bodyRow?.body_gz) return null;
  const ranks = new Map<string, number>();
  let n = 0;
  for (const line of gunzipSync(bodyRow.body_gz).toString('utf8').split('\n')) {
    const [rank, domain, tld] = line.split(',');
    if (!domain) continue;
    n++;
    const sld = registrableLabel(domain, tld || null);
    if (sld && !ranks.has(sld)) ranks.set(sld, Number(rank));
  }
  const date = row.data_date instanceof Date ? dayOf(row.data_date) : String(row.data_date ?? dayOf(row.fetched_at)).slice(0, 10);
  const list: PopularityList = { listId: `majestic-${date}`, listDate: date, fetchedAt: row.fetched_at, rows: n, slds: [...ranks.keys()], ranks };
  cached = { key, list };
  return list;
}

/**
 * Optimal-string-alignment (Damerau, adjacent transposition) distance, or null when it is more than `max`.
 * Exits at once on a length gap over `max` and as soon as a whole DP row is over `max`.
 */
export function editDistanceWithin(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  if (a === b) return 0;
  const n = a.length, m = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return null;
    prev2 = prev;
    prev = cur;
  }
  return prev[m]! <= max ? prev[m]! : null;
}
