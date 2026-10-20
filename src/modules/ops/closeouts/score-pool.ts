// v5.26.0 (CR-072 Q1): the datasave step `scorePool`. For every unprocessed row of the closeouts pool (datasave_pool) and of the sealed Dynadot closeouts
// upload (dynadot_rows kind closeouts) it stores the first failed hard filter (`filter_code`, see filters.ts) and, for the rows that passed, the active
// engine model's score (`Scorer.scoreOffline`: ZERO outside calls). A row that cannot be scored keeps `score` null with a `score_reason`.
// Idempotent: processed rows (`scored_at` set) are not touched again, except rows that passed the filters while no model existed (NO_ACTIVE_MODEL),
// which are scored once a model exists. A later run therefore also picks up a Dynadot upload sealed after the first run, and rows left by a failed batch.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { idtDay } from '../../../core/dates.js';
import { buildClassifier, FILTER_CODES } from './filters.js';

export interface PoolScorer { scoreOffline(domains: string[], asOf?: string): Promise<{ model_version: string; scores: Map<string, number> } | null>; activeModel(): Promise<{ id: string } | null> }
export interface ScorePoolDeps { db: Kysely<Database>; now: () => number; scorer?: PoolScorer; log?: { warn: (obj: unknown, msg?: string) => void } }

const PAGE = 5_000;
const SCORE_BATCH = 2_000;

interface Target { table: 'datasave_pool' | 'dynadot_rows'; sourceKey: string; where: (day: string) => ReturnType<typeof sql> }
const TARGETS: Target[] = [
  { table: 'datasave_pool', sourceKey: 'godaddy', where: (d) => sql`data_date = ${d}::date and source = 'godaddy_closeouts'` },
  { table: 'dynadot_rows', sourceKey: 'dynadot', where: (d) => sql`data_date = ${d}::date and kind = 'closeouts'` },
];

export interface ScorePoolSummary {
  status: 'ok' | 'no_model' | 'skipped'; model_version: string | null; rows_processed_n: number; rows_filtered_n: number; rows_scored_n: number; score_failed_n: number;
  by_source: Record<string, { days: string[]; rows_processed_n: number }>; filtered_by: Record<string, number>; elapsed_ms: number; reason?: string;
}

export async function scorePool(deps: ScorePoolDeps): Promise<ScorePoolSummary> {
  const { db } = deps;
  const t0 = Date.now();
  const model = deps.scorer ? await deps.scorer.activeModel() : null;
  const classifier = await buildClassifier(db);
  const asOf = idtDay(deps.now());
  const out: ScorePoolSummary = { status: model ? 'ok' : 'no_model', model_version: model?.id ?? null, rows_processed_n: 0, rows_filtered_n: 0, rows_scored_n: 0, score_failed_n: 0, by_source: {}, filtered_by: Object.fromEntries(FILTER_CODES.map((c) => [c, 0])), elapsed_ms: 0 };
  const pending = model
    ? sql`(scored_at is null or (score_reason = 'NO_ACTIVE_MODEL' and filter_code is null))`
    : sql`scored_at is null`;
  for (const t of TARGETS) {
    const days = (await sql<{ d: string }>`select distinct data_date::text as d from ${sql.table(t.table)} where ${pending} order by 1`.execute(db)).rows.map((r) => r.d);
    const done: string[] = [];
    let n = 0;
    for (const day of days) {
      // a Dynadot day is scored only when its upload is sealed (the endpoint serves only sealed days)
      if (t.table === 'dynadot_rows') {
        const sealed = await db.selectFrom('snapshot_manifests').select('id').where('source', '=', 'dynadot_closeouts').where('data_date', '=', day).where('file_name', '=', 'bot_upload').where('sealed_at', 'is not', null).executeTakeFirst();
        if (!sealed) continue;
      }
      let last = '';
      for (;;) {
        const page = (await sql<{ domain: string }>`select domain from ${sql.table(t.table)} where ${t.where(day)} and ${pending} and domain > ${last} order by domain limit ${PAGE}`.execute(db)).rows.map((r) => r.domain);
        if (page.length === 0) break;
        last = page[page.length - 1]!;
        const codes = new Map<string, string | null>();
        for (const d of page) codes.set(d, classifier.classify(d).code);
        const passed = page.filter((d) => codes.get(d) === null);
        const scores = new Map<string, number>();
        let failed = false;
        if (model && deps.scorer && passed.length > 0) {
          for (let i = 0; i < passed.length; i += SCORE_BATCH) {
            try {
              const r = await deps.scorer.scoreOffline(passed.slice(i, i + SCORE_BATCH), asOf);
              if (r) for (const [k, v] of r.scores) scores.set(k, v);
            } catch (e) {
              failed = true;
              deps.log?.warn({ err: e instanceof Error ? e.message : String(e), table: t.table, day }, 'scorePool batch failed');
            }
          }
        }
        const dom = page, fc = page.map((d) => codes.get(d) ?? null);
        const sc = page.map((d) => (scores.has(d) ? String(scores.get(d)) : null));
        const reason = page.map((d) => {
          if (codes.get(d) !== null) return null;
          if (!model) return 'NO_ACTIVE_MODEL';
          return scores.has(d) ? null : 'SCORE_FAILED';
        });
        // a batch that threw stays pending (scored_at null) so the next run retries it; every other row is processed now
        const stamp = page.map((d) => (failed && codes.get(d) === null && !scores.has(d) ? false : true));
        await sql`update ${sql.table(t.table)} x set filter_code = v.fc, score = v.sc::numeric, score_reason = v.sr, model_version = ${model?.id ?? null},
            scored_at = case when v.st then ${new Date(deps.now())}::timestamptz else null end
          from unnest(${dom}::text[], ${fc}::text[], ${sc}::text[], ${reason}::text[], ${stamp}::boolean[]) as v(domain, fc, sc, sr, st)
          where ${t.where(day)} and x.domain = v.domain`.execute(db);
        for (const d of page) {
          const c = codes.get(d);
          if (c) { out.rows_filtered_n++; out.filtered_by[c] = (out.filtered_by[c] ?? 0) + 1; }
          else if (scores.has(d)) out.rows_scored_n++;
          else if (model) out.score_failed_n++;
        }
        out.rows_processed_n += page.length;
        n += page.length;
        if (failed) break; // do not loop on the same failing rows within this run
      }
      done.push(day);
    }
    out.by_source[t.sourceKey] = { days: done, rows_processed_n: n };
  }
  out.elapsed_ms = Date.now() - t0;
  return out;
}
