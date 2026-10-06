// CAP-11 NameBio keyword counts (G8, a score feature, never a gate).
//
// STATUS: DISABLED (controller ruling (b), 6 Oct 2026). NameBio's site blocks automated access (HTTP 403, Cloudflare) and its terms
// could not be read at the primary source (docs/internal/sources.md, gap G-29), so `sources.namebio` is false and **no fetcher is
// built**: `refreshNameBio` is a stub that never makes a request. The parser and the cache reader below exist so that a file a human
// provides (once the terms are verified) can be served from `reference_files` without any change to the checks. The CSV header here
// is a documented PLACEHOLDER (the real one was not readable); `parseRetailStats` fails loudly on any other header.
import { gunzipSync } from 'node:zlib';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { SelectionValuesT } from './settings.js';
import type { ScreeningDeps } from './types.js';

export const NAMEBIO_NAME = 'namebio_retailstats';
const REQUIRED = ['keyword', 'start_count', 'end_count', 'exact_count'] as const;

export interface KeywordStats { keyword: string; start_count: number | null; end_count: number | null; exact_count: number | null; avg_price_cents?: number | null }

const count = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** keyword -> counts. Throws when the header lacks a required column (a changed export must stop the refresh, never be guessed). */
export function parseRetailStats(csv: string): Map<string, KeywordStats> {
  const lines = csv.split(/\r?\n/).filter((l) => l !== '');
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  const miss = REQUIRED.filter((c) => !header.includes(c));
  if (miss.length > 0) throw new Error(`NameBio CSV header lacks required column(s): ${miss.join(', ')}`);
  const at = (c: string) => header.indexOf(c);
  const iPrice = at('avg_price_usd');
  const out = new Map<string, KeywordStats>();
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const keyword = (c[at('keyword')] ?? '').trim().toLowerCase();
    if (!keyword) continue;
    const price = iPrice >= 0 ? count(c[iPrice]) : undefined;
    out.set(keyword, {
      keyword, start_count: count(c[at('start_count')]), end_count: count(c[at('end_count')]), exact_count: count(c[at('exact_count')]),
      ...(price !== undefined && { avg_price_cents: price === null ? null : price * 100 }),
    });
  }
  return out;
}

/** Disabled stub: never fetches. Returns why nothing was done. */
export async function refreshNameBio(_db: Kysely<Database>, _deps: ScreeningDeps, s: SelectionValuesT):
  Promise<{ cache_date: string; rows: number; same_as_previous: boolean } | { skipped: true; reason: string }> {
  return { skipped: true, reason: s.sources.namebio ? 'NO_FETCHER' : 'SOURCE_DISABLED' };
}

export interface KeywordCounts {
  cache_date: string | null; stale: boolean; source: 'nightly_csv'; attribution: string; stats: Record<string, KeywordStats | null>;
}

/** Counts for keywords from the newest cached file only (never a request to NameBio). No cache is `stale: true` with every count null. */
export async function keywordCounts(db: Kysely<Database>, keywords: string[], s: SelectionValuesT, now: () => number = Date.now): Promise<KeywordCounts> {
  const base = { source: 'nightly_csv' as const, attribution: s.namebio.attribution };
  const none = Object.fromEntries(keywords.map((k) => [k, null]));
  const row = await db.selectFrom('reference_files').selectAll().where('name', '=', NAMEBIO_NAME).orderBy('fetched_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (!row) return { ...base, cache_date: null, stale: true, stats: none };
  let gz = row.body_gz;
  if (!gz && row.same_as_id !== null) gz = (await db.selectFrom('reference_files').select('body_gz').where('id', '=', row.same_as_id).executeTakeFirst())?.body_gz ?? null;
  if (!gz) return { ...base, cache_date: null, stale: true, stats: none };
  const map = parseRetailStats(gunzipSync(gz).toString('utf8'));
  const date = String(row.data_date ?? row.fetched_at.toISOString()).slice(0, 10);
  const stale = now() - row.fetched_at.getTime() > s.namebio.max_cache_age_hours * 3_600_000;
  return { ...base, cache_date: date, stale, stats: Object.fromEntries(keywords.map((k) => [k, map.get(k.toLowerCase()) ?? null])) };
}
