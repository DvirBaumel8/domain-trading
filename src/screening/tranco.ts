// CAP-02 TYPO-1 popularity list. Ruling (6 Oct 2026, controller (a)): Tranco has no licence of its own and one upstream provider is
// CC BY-NC 4.0 (gap G-30), so the list used is the **Majestic Million**, whose terms were verified at the primary source
// ("Licensed under a Creative Commons Attribution 3.0 Unported License", docs/internal/sources.md). The module keeps the names the
// plan gave it (`refreshTranco`, `latestTranco`) and the settings switch `sources.tranco`; the data is Majestic's top-N, by rank.
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

/** First `max` data rows of a Majestic CSV as `rank,domain` text; throws PopularityListError on a body that is not that CSV. */
export function parsePopularityCsv(text: string, max: number): { rows: { rank: number; domain: string }[] } {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const iRank = header.indexOf('GlobalRank');
  const iDomain = header.indexOf('Domain');
  if (iRank < 0 || iDomain < 0) throw new PopularityListError('The popularity list has no GlobalRank and Domain columns');
  const rows: { rank: number; domain: string }[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    if (rows.length >= max) break;
    const c = line.split(',');
    const rank = Number(c[iRank]);
    const domain = (c[iDomain] ?? '').trim().toLowerCase();
    if (!Number.isInteger(rank) || rank < 1 || !DOMAIN_RE.test(domain)) throw new PopularityListError(`The popularity list has a malformed row: "${line.slice(0, 60)}"`);
    rows.push({ rank, domain });
  }
  if (rows.length < Math.min(max, MIN_ROWS)) throw new PopularityListError(`The popularity list has only ${rows.length} rows`);
  return { rows };
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
export async function refreshTranco(db: Kysely<Database>, deps: ScreeningDeps, s: SelectionValuesT, now: () => number = Date.now):
  Promise<{ list_id: string; list_date: string; rows: number } | { skipped: true; reason: string }> {
  if (!s.sources.tranco) return { skipped: true, reason: 'SOURCE_DISABLED' };
  const last = await newestRow(db);
  if (last && now() - last.fetched_at.getTime() < MIN_REFRESH_GAP_MS) return { skipped: true, reason: 'fetched within the last 20 hours' };
  const res = await deps.fetch(POPULARITY_URL, { headers: { 'user-agent': USER_AGENT, accept: 'text/csv' }, signal: AbortSignal.timeout(60_000) });
  if (res.status !== 200) throw new PopularityListError(`The popularity list answered HTTP ${res.status}`);
  const text = await readLines(res, s.typo.top_n + 1);
  const { rows } = parsePopularityCsv(text, s.typo.top_n);
  const lm = res.headers.get('last-modified');
  const parsed = lm ? new Date(lm) : null;
  const listDate = parsed && !Number.isNaN(parsed.getTime()) ? dayOf(parsed) : dayOf(new Date(now()));
  const body = rows.map((r) => `${r.rank},${r.domain}`).join('\n');
  const sha = createHash('sha256').update(body, 'utf8').digest('hex');
  const same = last && last.sha256 === sha ? last : null;
  const sameId = same ? (same.body_gz ? same.id : same.same_as_id) : null;
  await db.insertInto('reference_files').values({
    name: POPULARITY_NAME, source_url: POPULARITY_URL, fetched_at: new Date(now()), data_date: listDate, sha256: sha,
    bytes: Buffer.byteLength(body, 'utf8'), body_gz: sameId ? null : gzipSync(Buffer.from(body, 'utf8')), same_as_id: sameId,
  }).execute();
  return { list_id: `majestic-${listDate}`, list_date: listDate, rows: rows.length };
}

async function newestRow(db: Kysely<Database>) {
  return db.selectFrom('reference_files').selectAll().where('name', '=', POPULARITY_NAME).orderBy('fetched_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}

export interface PopularityList { listId: string; listDate: string; fetchedAt: Date; slds: string[]; ranks: Map<string, number> }
const cache = new Map<string, PopularityList>(); // by reference_files row (id, hash, fetch time)

/** The newest snapshot, parsed (distinct SLDs, the first rank wins), cached in-process by row id. null: none yet. */
export async function latestTranco(db: Kysely<Database>): Promise<PopularityList | null> {
  const row = await newestRow(db);
  if (!row) return null;
  const key = `${row.id}:${row.sha256}:${row.fetched_at.getTime()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let bodyRow: { body_gz: Buffer | null } | undefined = row;
  if (!row.body_gz && row.same_as_id !== null) bodyRow = await db.selectFrom('reference_files').select('body_gz').where('id', '=', row.same_as_id).executeTakeFirst();
  if (!bodyRow?.body_gz) return null;
  const ranks = new Map<string, number>();
  for (const line of gunzipSync(bodyRow.body_gz).toString('utf8').split('\n')) {
    const i = line.indexOf(',');
    if (i < 0) continue;
    const sld = line.slice(i + 1).split('.')[0]!;
    if (sld && !ranks.has(sld)) ranks.set(sld, Number(line.slice(0, i)));
  }
  const date = row.data_date instanceof Date ? dayOf(row.data_date) : String(row.data_date ?? dayOf(row.fetched_at)).slice(0, 10);
  const out: PopularityList = { listId: `majestic-${date}`, listDate: date, fetchedAt: row.fetched_at, slds: [...ranks.keys()], ranks };
  cache.set(key, out);
  return out;
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
