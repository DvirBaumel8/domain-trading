import { usdStringToCents } from '../../../core/money.js';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../../core/dates.js';
import { formatUsd } from '../../../core/money.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { closeoutNameChecker } from '../../selection/index.js';
import { buildClassifier, FILTER_CODES } from '../closeouts/filters.js';
import type { PoolScorer } from '../closeouts/score-pool.js';

const Query = z.object({
  date: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)').optional(),
  source: z.enum(['dynadot', 'godaddy', 'all', 'drops']).default('all'),
  /** Integer cents (like every money field), default and cap 4000 (the pool cap). */
  // USD like every other money input ("40" or "10.50"), at most the $40 pool cap; stored and compared in cents
  max_price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be USD with at most 2 decimals').default('40').transform(usdStringToCents).refine((c) => c >= 1 && c <= 4000, 'must be between $0.01 and $40'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

const bad = (p: { error: z.ZodError }) => new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);

type Src = 'godaddy' | 'dynadot';
interface Row { domain: string; source: 'godaddy' | 'dynadot' | 'drops'; price_cents: number | null; ends_at: Date | null; score: number | null; score_reason: string | null }

const MANIFEST: Record<Src, { source: 'godaddy_inventory' | 'dynadot_closeouts'; file: string }> = {
  godaddy: { source: 'godaddy_inventory', file: 'closeout_listings.json.zip' },
  dynadot: { source: 'dynadot_closeouts', file: 'bot_upload' },
};

interface Deps { db: Kysely<Database>; now: () => number; scorer?: PoolScorer }

/**
 * v5.26.0 (CR-072). GET /candidates/closeouts: the day's closeout rows (GoDaddy pool, sealed Dynadot upload) or the kept drop-list names, minus the hard
 * filters, ranked by the engine score stored by the datasave step `scorePool`. Read-only: it never scores, never calls an outside host, there is no POST.
 * (Drops are filtered and scored here, at read time, with the same offline functions: the list is small.)
 */
export function registerCloseouts(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;
  const sealedManifest = (s: Src, date: string) => db.selectFrom('snapshot_manifests').select(['sha256', 'data_date']).where('source', '=', MANIFEST[s].source).where('data_date', '=', date).where('file_name', '=', MANIFEST[s].file).where('status', '=', 'complete').where('sealed_at', 'is not', null).executeTakeFirst();
  const newestDate = async (s: Src): Promise<string | null> => (await db.selectFrom('snapshot_manifests').select((eb) => eb.fn.max('data_date').as('d')).where('source', '=', MANIFEST[s].source).where('file_name', '=', MANIFEST[s].file).where('status', '=', 'complete').where('sealed_at', 'is not', null).executeTakeFirst())?.d ?? null;

  /** pool_n, filtered_by and the ranked rows (best `limit`) of one source and day. */
  async function fromTable(s: Src, date: string, maxPrice: number, limit: number) {
    const t = s === 'godaddy' ? 'datasave_pool' : 'dynadot_rows';
    const base = s === 'godaddy' ? sql`data_date = ${date}::date and source = 'godaddy_closeouts'` : sql`data_date = ${date}::date and kind = 'closeouts'`;
    const pool = sql`${base} and domain like '%.com' and price_cents <= ${maxPrice}`;
    const counts = (await sql<{ code: string | null; n: string }>`select filter_code as code, count(*)::text as n from ${sql.table(t)} where ${pool} group by 1`.execute(db)).rows;
    const filtered: Record<string, number> = {};
    let poolN = 0;
    let rankedN = 0;
    for (const c of counts) { poolN += Number(c.n); if (c.code) filtered[c.code] = Number(c.n); else rankedN += Number(c.n); }
    const rows = (await sql<{ domain: string; price_cents: number; ends_at: Date | null; score: string | null; score_reason: string | null; scored_at: Date | null }>`
      select domain, price_cents, ends_at, score::text as score, score_reason, scored_at from ${sql.table(t)} where ${pool} and filter_code is null
      order by score desc nulls last, price_cents asc, domain asc limit ${limit}`.execute(db)).rows;
    return {
      poolN, rankedN, filtered,
      rows: rows.map((r): Row => ({ domain: r.domain, source: s, price_cents: r.price_cents, ends_at: r.ends_at, score: r.score === null ? null : Number(r.score), score_reason: r.score === null ? (r.score_reason ?? 'NOT_SCORED_YET') : null })),
    };
  }

  async function fromDrops(date: string, limit: number) {
    const lists = await db.selectFrom('drop_lists').select('name').where('list_date', '=', date).execute();
    const kept = lists.length === 0 ? [] : await db.selectFrom('drop_list_rows').select('domain').distinct().where('list_name', 'in', lists.map((l) => l.name)).where('kept', '=', true).execute();
    const domains = [...new Set(kept.map((r) => r.domain.trim().toLowerCase()).filter((d) => d.endsWith('.com')))];
    const classifier = await buildClassifier(db);
    const filtered: Record<string, number> = {};
    const open: string[] = [];
    for (const d of domains) {
      const c = classifier.classify(d).code;
      if (c) filtered[c] = (filtered[c] ?? 0) + 1; else open.push(d);
    }
    let scores = new Map<string, number>();
    let reason: string | null = null;
    if (!deps.scorer) reason = 'NO_ACTIVE_MODEL';
    else if (open.length > 0) {
      try {
        const r = await deps.scorer.scoreOffline(open);
        if (!r) reason = 'NO_ACTIVE_MODEL'; else scores = r.scores;
      } catch { reason = 'SCORE_FAILED'; }
    }
    const rows = open.map((d): Row => ({ domain: d, source: 'drops', price_cents: null, ends_at: null, score: scores.get(d) ?? null, score_reason: scores.has(d) ? null : (reason ?? 'SCORE_FAILED') }));
    return { poolN: domains.length, rankedN: open.length, filtered, rows };
  }

  app.get('/candidates/closeouts', async (req) => {
    const p = Query.safeParse(req.query);
    if (!p.success) throw bad(p);
    const q = p.data;
    const missing = (what: string, extra: Record<string, unknown> = {}) => new AppError(409, 'SNAPSHOT_MISSING', `No sealed snapshot for ${what}; this is not an empty list`, { source: q.source, ...(q.date ? { date: q.date } : {}), ...extra });
    let date = q.date;
    let parts: { key: Src | 'drops'; r: { poolN: number; rankedN: number; filtered: Record<string, number>; rows: Row[] }; sha: string | null }[] = [];
    if (q.source === 'drops') {
      if (!date) date = (await db.selectFrom('drop_lists').select((eb) => eb.fn.max('list_date').as('d')).where('kept_n', '>', 0).executeTakeFirst())?.d ?? undefined;
      if (!date) throw missing('a drop list');
      const lists = await db.selectFrom('drop_lists').select('name').where('list_date', '=', date).execute();
      if (lists.length === 0) throw missing(`a drop list of ${date}`);
      parts = [{ key: 'drops', r: await fromDrops(date, q.limit), sha: null }];
    } else {
      const wanted: Src[] = q.source === 'all' ? ['godaddy', 'dynadot'] : [q.source];
      if (!date) {
        const newest = (await Promise.all(wanted.map(newestDate))).filter((d): d is string => d !== null).sort();
        date = newest[newest.length - 1];
        if (!date) throw missing(`${q.source} closeouts`);
      }
      for (const s of wanted) {
        const m = await sealedManifest(s, date);
        if (!m) continue;
        parts.push({ key: s, r: await fromTable(s, date, q.max_price, q.limit), sha: m.sha256 });
      }
      if (parts.length === 0) throw missing(`${q.source} closeouts of ${date}`, { date });
    }
    const merged = parts.flatMap((x) => x.r.rows).sort((a, b) => (a.score === null ? 1 : 0) - (b.score === null ? 1 : 0) || (b.score ?? 0) - (a.score ?? 0) || (a.price_cents ?? 0) - (b.price_cents ?? 0) || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
    const top = merged.slice(0, q.limit);
    // words: the selection split of each returned name (no outside call)
    const names = top.length ? await closeoutNameChecker(db, { bigcoNames: [], tmKills: [] }) : null;
    const filteredBy: Record<string, number> = Object.fromEntries(FILTER_CODES.map((c) => [c, 0]));
    for (const x of parts) for (const [c, n] of Object.entries(x.r.filtered)) filteredBy[c] = (filteredBy[c] ?? 0) + n;
    const poolN = parts.reduce((s, x) => s + x.r.poolN, 0);
    const rankedN = parts.reduce((s, x) => s + x.r.rankedN, 0);
    const sha = q.source === 'all' ? Object.fromEntries(parts.map((x) => [x.key, x.sha])) : (parts[0]!.sha);
    return {
      date, source: q.source, max_price_cents: q.max_price, limit: q.limit,
      rows: top.map((r, i) => ({
        domain: r.domain, source: r.source, price_cents: r.price_cents, price: r.price_cents === null ? null : formatUsd(r.price_cents), ends_at: r.ends_at?.toISOString() ?? null,
        score: r.score, ...(r.score === null ? { score_reason: r.score_reason } : {}), rank: i + 1, filters_passed: true, words: names ? names.check(r.domain).words : [],
      })),
      summary: { pool_n: poolN, filtered_by: filteredBy, ranked_n: rankedN, returned_n: top.length, snapshot_sha256: sha, ...(q.source === 'all' ? { sources_present: parts.map((x) => x.key) } : {}) },
    };
  });
}
