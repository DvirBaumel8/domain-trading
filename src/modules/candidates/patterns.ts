// v4.0.0 (CR-044 item 4): the sales-pattern scan. Gavriel uploads recent sales as CSV (domain, price_usd, date, venue); the service clusters them for the scouts.
// It fetches nothing (NameBio blocks bots; no source allows an automated pull). The split is the frozen bt1@v3 split; the default filter is $1k-$5k .com.
import type { Kysely } from 'kysely';
import { dollarsToCents } from '../../core/money.js';
import { isRealDate } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { loadSplitV2, splitClasses, splitV2 } from '../selection/index.js';

export const PATTERN_METHOD = 'bt1@v3';
const PATTERN_MAX_ROWS = 2000;
const PATTERN_HEADER = ['domain', 'price_usd', 'date', 'venue'];

export interface SaleRow { domain: string; price_cents: number; sold_on: string; venue: string | null }

/** One CSV line into fields (double quotes, doubled quotes inside). */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** The rows of an uploaded CSV; the header must be exactly domain,price_usd,date,venue. Every bad row is listed (422 PATTERN_CSV_INVALID), nothing is stored on any error. */
export function parseSalesCsv(csv: string): SaleRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new AppError(422, 'PATTERN_CSV_INVALID', 'The CSV is empty');
  const head = fields(lines[0]!).map((h) => h.toLowerCase());
  if (head.join(',') !== PATTERN_HEADER.join(',')) throw new AppError(422, 'PATTERN_CSV_INVALID', `The header must be exactly ${PATTERN_HEADER.join(',')}`, { got: head });
  if (lines.length - 1 > PATTERN_MAX_ROWS) throw new AppError(422, 'PATTERN_CSV_INVALID', `At most ${PATTERN_MAX_ROWS} rows per upload`);
  if (lines.length === 1) throw new AppError(422, 'PATTERN_CSV_INVALID', 'The CSV has no rows');
  const rows: SaleRow[] = [];
  const errors: { line: number; error: string }[] = [];
  lines.slice(1).forEach((l, i) => {
    const f = fields(l);
    const line = i + 2;
    try {
      if (f.length !== 4) throw new Error('4 fields expected');
      const domain = f[0]!.trim().toLowerCase();
      if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) throw new Error('domain must be a domain name');
      const usd = Number(f[1]!.replace(/^\$/, '').replace(/,/g, ''));
      if (!Number.isFinite(usd) || usd <= 0) throw new Error('price_usd must be a positive number');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f[2]!) || !isRealDate(f[2]!)) throw new Error('date must be a real YYYY-MM-DD');
      rows.push({ domain, price_cents: dollarsToCents(usd), sold_on: f[2]!, venue: f[3]! === '' ? null : f[3]!.slice(0, 40) });
    } catch (e) {
      errors.push({ line, error: (e as Error).message });
    }
  });
  if (errors.length > 0) throw new AppError(422, 'PATTERN_CSV_INVALID', `${errors.length} row(s) are invalid`, { errors: errors.slice(0, 50) });
  return rows;
}

export async function storeSales(db: Kysely<Database>, rows: SaleRow[], by: { token: string | null; auditId: string | null }): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const up = await trx.insertInto('sales_pattern_uploads').values({ rows_n: rows.length, token_name: by.token, audit_id: by.auditId }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('sales_pattern_rows').values(rows.map((r) => ({ upload_id: up.id, domain: r.domain, price_cents: r.price_cents, sold_on: r.sold_on, venue: r.venue }))).execute();
    return up.id;
  });
}

const lengthBand = (n: number): string => (n <= 8 ? '1-8' : n <= 12 ? '9-12' : n <= 16 ? '13-16' : '17+');
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); };

export interface Cluster { value: string; n: number; median_price_cents: number; examples: string[] }
function cluster(rows: { domain: string; price_cents: number }[], key: (r: { domain: string; price_cents: number }) => string): Cluster[] {
  const g = new Map<string, typeof rows>();
  for (const r of rows) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
  return [...g].map(([value, rs]) => ({ value, n: rs.length, median_price_cents: median(rs.map((r) => r.price_cents)), examples: rs.slice(0, 3).map((r) => r.domain) }))
    .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value));
}

/** The clusters of the rows of one upload within the filter. A name the split cannot read is counted as unsplit and left out of the word-based clusters. */
export function clusterSales(rows: SaleRow[], f: { minCents: number; maxCents: number; tld: string }) {
  const kept = rows.filter((r) => r.price_cents >= f.minCents && r.price_cents <= f.maxCents && r.domain.endsWith(`.${f.tld}`));
  const table = loadSplitV2(PATTERN_METHOD);
  const classes = splitClasses(PATTERN_METHOD);
  const withTokens = kept.map((r) => {
    const sld = r.domain.slice(0, r.domain.length - f.tld.length - 1);
    return { ...r, sld, tokens: splitV2(sld, table) };
  });
  const split = withTokens.filter((r) => r.tokens.length > 0);
  const tokenCount = new Map<string, number>();
  for (const r of split) for (const t of new Set(r.tokens)) tokenCount.set(t, (tokenCount.get(t) ?? 0) + 1);
  const cls = (t: string) => (t.length ? (classes.get(t) === 'city' ? 'city' : classes.get(t) === 'special' ? 'special' : 'word') : 'word');
  const byDomain = new Map(split.map((r) => [r.domain, r]));
  return {
    rows_in_upload: rows.length, rows_after_filter: kept.length, rows_split: split.length, rows_unsplit: kept.length - split.length,
    by_word_count: cluster(split, (r) => String(byDomain.get(r.domain)!.tokens.length)),
    by_structure: cluster(split, (r) => byDomain.get(r.domain)!.tokens.map(cls).join('+')),
    by_length_band: cluster(withTokens, (r) => lengthBand(withTokens.find((x) => x.domain === r.domain)!.sld.length)),
    topic_tokens: [...tokenCount].map(([token, n]) => ({ token, n })).sort((a, b) => b.n - a.n || a.token.localeCompare(b.token)).slice(0, 25),
  };
}
