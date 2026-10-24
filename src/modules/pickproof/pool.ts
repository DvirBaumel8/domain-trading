// CR-073 R-1: the frozen pool of a pick day D = the closeouts of data date D-1 (GoDaddy datasave_pool + sealed Dynadot closeouts), .com, <= $40,
// minus sales-graded names, sorted by domain, one row per domain. Frozen when first materialised: the rows go to pickproof_pool and the sha256 to
// pickproof_days, so a later change or prune of the datasave rows changes nothing. Reads the datasave tables through Kysely (no module import except
// selection's name checker for the two-word split).
import { sql, type Kysely, type Transaction } from 'kysely';
import { addDays } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { closeoutNameChecker } from '../selection/index.js';
import { byteOrder, seedOfPool } from './draw.js';
import { CURRENT_RECIPE, sha256Hex, type RecipeVersion } from './recipe.js';
import { twoWordSplitV2 } from './two-word.js';

export type Db = Kysely<Database> | Transaction<Database>;
export const CLOSEOUTS_FILE = 'closeout_listings.json.zip';
const INSERT_BATCH = 5_000;

export interface PoolRow { domain: string; source: 'godaddy' | 'dynadot'; price_cents: number; passes_k1: boolean; is_two_word: boolean }
export interface DayRow {
  day: string; data_date: string; pool_sha256: string; seed: number; k: number; pool_n: number; sources: Record<string, unknown>;
  deadline: Date; arms: Record<string, { n: number; sha256: string; short: boolean }> | null; sealed_at: Date | null; recipe_version: RecipeVersion;
}

export const deadlineOf = (day: string, hourUtc: number): Date => new Date(`${day}T${String(hourUtc).padStart(2, '0')}:00:00Z`);

export async function pickproofSettings(db: Db) {
  const s = await db.selectFrom('settings').select(['pickproof_k', 'pickproof_deadline_hour_utc', 'pickproof_pool_max_price_cents', 'pickproof_labels_max_per_run', 'pickproof_pool_keep_days']).executeTakeFirstOrThrow();
  return { k: s.pickproof_k, deadlineHourUtc: s.pickproof_deadline_hour_utc, maxPriceCents: s.pickproof_pool_max_price_cents, labelsMaxPerRun: s.pickproof_labels_max_per_run, poolKeepDays: s.pickproof_pool_keep_days };
}

export async function getDay(db: Db, day: string): Promise<DayRow | null> {
  const r = await db.selectFrom('pickproof_days').selectAll().where('day', '=', day).executeTakeFirst();
  if (!r) return null;
  return { day: r.day, data_date: r.data_date, pool_sha256: r.pool_sha256, seed: Number(r.seed), k: r.k, pool_n: r.pool_n, sources: r.sources as Record<string, unknown>, deadline: r.deadline, arms: (r.arms as DayRow['arms']) ?? null, sealed_at: r.sealed_at, recipe_version: r.recipe_version as RecipeVersion };
}

/** The pool rows of D before they are frozen (pure given the tables). Throws 409 SNAPSHOT_MISSING without a sealed GoDaddy closeouts snapshot of D-1. */
export async function buildPool(db: Db, day: string, maxPriceCents: number): Promise<{ rows: PoolRow[]; sources: Record<string, unknown>; dataDate: string }> {
  const dataDate = addDays(day, -1);
  const gd = await db.selectFrom('snapshot_manifests').select(['sha256', 'rows']).where('source', '=', 'godaddy_inventory').where('data_date', '=', dataDate).where('file_name', '=', CLOSEOUTS_FILE).where('status', '=', 'complete').where('sealed_at', 'is not', null).executeTakeFirst();
  if (!gd) throw new AppError(409, 'SNAPSHOT_MISSING', `No sealed GoDaddy closeouts snapshot for data date ${dataDate}, so the pool of ${day} cannot be frozen`, { date: day, data_date: dataDate, source: 'godaddy' });
  // v5.31.0 (CR-073a): do not freeze between the download and scorePool of the same run, or passes_k1 would be false for every unprocessed row
  const pending = Number((await db.selectFrom('datasave_pool').select((eb) => eb.fn.countAll<string>().as('n')).where('data_date', '=', dataDate).where('source', '=', 'godaddy_closeouts').where('scored_at', 'is', null).executeTakeFirstOrThrow()).n);
  if (pending > 0) throw new AppError(409, 'POOL_NOT_READY', `${pending} closeout rows of data date ${dataDate} have not passed the daily filter step yet, so the pool of ${day} cannot be frozen; try again after the daily save finishes`, { date: day, data_date: dataDate, pending_n: pending });
  // v5.35.0: the datasave rows of D-1 are kept 3 days; a late freeze after they are gone would freeze an empty pool, so it is refused
  const stored = Number((await db.selectFrom('datasave_pool').select((eb) => eb.fn.countAll<string>().as('n')).where('data_date', '=', dataDate).where('source', '=', 'godaddy_closeouts').executeTakeFirstOrThrow()).n);
  if (stored === 0 && (gd.rows ?? 0) > 0) throw new AppError(410, 'POOL_SOURCE_PRUNED', `The closeout rows of data date ${dataDate} were already deleted by retention, so the pool of ${day} can no longer be frozen`, { date: day, data_date: dataDate });
  const dy = await db.selectFrom('snapshot_manifests').select(['sha256', 'rows']).where('source', '=', 'dynadot_closeouts').where('data_date', '=', dataDate).where('file_name', '=', 'bot_upload').where('status', '=', 'complete').where('sealed_at', 'is not', null).executeTakeFirst();

  const raw = (await sql<{ domain: string; price_cents: number; source: 'godaddy' | 'dynadot'; filter_code: string | null; scored: boolean }>`
    select lower(domain) as domain, price_cents, 'godaddy' as source, filter_code, (scored_at is not null) as scored from datasave_pool
      where data_date = ${dataDate}::date and source = 'godaddy_closeouts' and lower(domain) like '%.com' and price_cents <= ${maxPriceCents}
    union all
    select lower(domain) as domain, price_cents, 'dynadot' as source, filter_code, (scored_at is not null) as scored from dynadot_rows
      where ${dy ? sql`true` : sql`false`} and data_date = ${dataDate}::date and kind = 'closeouts' and price_cents is not null and lower(domain) like '%.com' and price_cents <= ${maxPriceCents}
  `.execute(db)).rows;

  const graded = new Set<string>();
  for (const r of await db.selectFrom('engine_sales').select('domain').distinct().execute()) graded.add(r.domain.toLowerCase());
  for (const r of await db.selectFrom('market_names').select('name').distinct().where('outcome', '=', 'sold').execute()) graded.add(r.name.toLowerCase());

  // one row per domain: the lowest price wins, then the source in byte order ('dynadot' before 'godaddy'; v5.30.0 doc fix, G-117)
  raw.sort((a, b) => byteOrder(a.domain, b.domain) || a.price_cents - b.price_cents || byteOrder(a.source, b.source));
  const kept: typeof raw = [];
  const excluded = new Set<string>();
  for (const r of raw) {
    if (graded.has(r.domain)) { excluded.add(r.domain); continue; }
    if (kept.length > 0 && kept[kept.length - 1]!.domain === r.domain) continue;
    kept.push(r);
  }

  // two-word (pickproof-v2, v5.33.0): two common words of 3+ letters (two-word.ts) and the form check does not fail the name (SPELL-1).
  // v1 (the form check's own split into exactly two tokens) took abbreviations such as dhs + ar; days frozen under v1 keep their stored flag.
  const checker = await closeoutNameChecker(db as Kysely<Database>, { bigcoNames: [], tmKills: [] });
  const rows: PoolRow[] = kept.map((r) => {
    const sld = r.domain.slice(0, -4);
    const two = twoWordSplitV2(sld) !== null && checker.check(r.domain).code !== 'SPELL-1';
    return { domain: r.domain, source: r.source, price_cents: r.price_cents, passes_k1: r.filter_code === null && r.scored, is_two_word: two };
  });
  const sources = {
    godaddy: { manifest_sha256: gd.sha256, rows: rows.filter((r) => r.source === 'godaddy').length },
    dynadot: dy ? { status: 'sealed', manifest_sha256: dy.sha256, rows: rows.filter((r) => r.source === 'dynadot').length } : { status: 'missing', manifest_sha256: null, rows: 0 },
    // v5.30.0 (CR-073a): the names removed as sales-graded, so the pool can be rebuilt from the snapshot files alone
    excluded_sales_graded: [...excluded].sort(byteOrder),
  };
  return { rows, sources, dataDate };
}

export const poolSha = (rows: readonly PoolRow[]): string => sha256Hex(JSON.stringify(rows.map((r) => [r.domain, r.source, r.price_cents])));

/** The day row, frozen on first use. Call inside a transaction that holds the day's advisory lock. */
export async function ensureDay(db: Transaction<Database>, day: string, frozenBy?: 'datasave'): Promise<DayRow> {
  const have = await getDay(db, day);
  if (have) return have;
  const st = await pickproofSettings(db);
  const built = await buildPool(db, day, st.maxPriceCents);
  const { rows, dataDate } = built;
  // v5.35.0: a day frozen by the datasave step (no bot used it in time) says so; the pool, hash and draw are computed the same way
  const sources = frozenBy ? { ...built.sources, frozen_by: frozenBy } : built.sources;
  const sha = poolSha(rows);
  await db.insertInto('pickproof_days').values({
    day, data_date: dataDate, pool_sha256: sha, seed: seedOfPool(sha), k: st.k, pool_n: rows.length, sources: JSON.stringify(sources), deadline: deadlineOf(day, st.deadlineHourUtc), recipe_version: CURRENT_RECIPE,
  }).execute();
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const part = rows.slice(i, i + INSERT_BATCH);
    await sql`insert into pickproof_pool (day, domain, source, price_cents, passes_k1, is_two_word)
      select ${day}::date, * from unnest(${part.map((r) => r.domain)}::text[], ${part.map((r) => r.source)}::text[], ${part.map((r) => r.price_cents)}::int[], ${part.map((r) => r.passes_k1)}::boolean[], ${part.map((r) => r.is_two_word)}::boolean[])`.execute(db);
  }
  return (await getDay(db, day))!;
}

/** Serialises everything that touches one pick day. */
export const lockDay = (db: Transaction<Database>, day: string) => sql`select pg_advisory_xact_lock(hashtext(${`pickproof:${day}`}))`.execute(db);
