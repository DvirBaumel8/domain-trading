// v6.7.0 (CR-104): the pre-run gate. GET /auctions/preflight runs the checks PF-01.. below and answers {as_of, data_date, pass, checks_sha256, checks}. It WRITES NOTHING (no row,
// no log): the record of a run is the caller's `preflight.json`, which carries `checks_sha256`. The datasave job runs the same suite as its last step `preflight`.
// STANDING RULE: PREFLIGHT_CHECKS is append-only. Each BUG that a pre-run check could have caught adds the next PF id in its fix release. A check is never removed and its id is
// never reused: it is marked `retired: '<reason>'` and then reports pass with details {retired: reason}. Rules and test ids: docs/internal/auctions.md "Pre-run gate".
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate, toJerusalemIso } from '../../../core/dates.js';
import { coverageRatio } from '../../../core/snapshot-coverage.js';
import type { Database } from '../../../db/types.js';
import { CLOSEOUTS_MAX_PRICE_CENTS, closeoutsFromTable, closeoutsPool, sealedManifest, sortCloseoutRows, type Src } from '../api/closeouts.js';
import { getShortlist } from './shortlist.js';

export const PreflightQuery = z.object({ date: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)').optional() }).strict();

export interface CheckResult { id: string; name: string; pass: boolean; reason_code: string | null; details: Record<string, unknown> }
type Served = Awaited<ReturnType<typeof getShortlist>>;
export interface PreflightSettings { preflight_max_digits: number; preflight_min_coverage_bp: number; preflight_max_age_hours: number }
/** What every check reads: the shortlist as the route serves it (all pages), the settings and the clock. A check may run on a fabricated context (unit tests). */
export interface PreflightCtx { db: Kysely<Database>; nowMs: number; dataDate: string | null; shortlist: Served; settings: PreflightSettings }
export interface PreflightCheck { id: string; name: string; run: (ctx: PreflightCtx) => Promise<Omit<CheckResult, 'id' | 'name'>>; retired?: string }

const ok = (details: Record<string, unknown> = {}) => ({ pass: true, reason_code: null, details });
const fail = (reason_code: string, details: Record<string, unknown>) => ({ pass: false, reason_code, details });
const SAMPLE_N = 10;
/** Null-score reasons that are by design (the row is not an error). NOT_SCORED_YET and SCORE_FAILED on a sealed day are the BUG-063 class. */
export const BY_DESIGN_NULL_SCORE = new Set(['NO_ACTIVE_MODEL']);
const SOURCES: Src[] = ['godaddy', 'dynadot'];

// ---------- PF-01 ----------
export async function pf01UnscoredRows(ctx: PreflightCtx) {
  const bad: Record<string, unknown>[] = [];
  const noted: Record<string, unknown> = {};
  const shortlistNull = ctx.shortlist.rows.filter((r) => r.score === null).map((r) => r.domain);
  if (shortlistNull.length > 0) bad.push({ source: 'shortlist', n: shortlistNull.length, sample: shortlistNull.slice(0, SAMPLE_N) });
  if (ctx.dataDate) {
    for (const s of SOURCES) {
      if (!(await sealedManifest(ctx.db, s, ctx.dataDate))) { noted[s] = 'no sealed snapshot for the date: skipped'; continue; }
      const { t, pool } = closeoutsPool(s, ctx.dataDate, CLOSEOUTS_MAX_PRICE_CENTS);
      const reasons = (await sql<{ reason: string; n: string }>`select coalesce(score_reason, 'NOT_SCORED_YET') as reason, count(*)::text as n from ${sql.table(t)}
        where ${pool} and filter_code is null and score is null group by 1`.execute(ctx.db)).rows.filter((x) => !BY_DESIGN_NULL_SCORE.has(x.reason));
      if (reasons.length === 0) continue;
      const sample = (await sql<{ domain: string }>`select domain from ${sql.table(t)} where ${pool} and filter_code is null and score is null
        and coalesce(score_reason, 'NOT_SCORED_YET') not in (${sql.join([...BY_DESIGN_NULL_SCORE].map((x) => sql.lit(x)))}) order by domain limit ${SAMPLE_N}`.execute(ctx.db)).rows.map((x) => x.domain);
      bad.push({ source: s, n: reasons.reduce((a, x) => a + Number(x.n), 0), by_reason: Object.fromEntries(reasons.map((x) => [x.reason, Number(x.n)])), sample });
    }
  }
  return bad.length > 0 ? fail('UNSCORED_ROWS', { sources: bad, ...noted }) : ok(noted);
}

// ---------- PF-02 ----------
export async function pf02CountsReconcile(ctx: PreflightCtx) {
  const s = ctx.shortlist;
  const terms = { total: s.total, prior_kill_excluded_n: s.prior_kill_excluded_n, ended_n: s.ended_n, prebid_dropped_n: s.prebid_dropped_n, not_stored_n: s.not_stored_n };
  const sum = terms.total + terms.prior_kill_excluded_n + terms.ended_n + terms.prebid_dropped_n + terms.not_stored_n;
  const details = { ...terms, sum, field_n: s.field_n, diff: sum - s.field_n };
  return details.diff === 0 ? ok(details) : fail('COUNTS_DONT_RECONCILE', details);
}

// ---------- PF-03 ----------
const sldOf = (domain: string): string => domain.replace(/\.com$/, '');
export function isJunkName(domain: string, maxDigits: number): boolean {
  const sld = sldOf(domain);
  const digits = (sld.match(/\d/g) ?? []).length;
  return /^\d+$/.test(sld) || (/^[0-9a-f]+$/.test(sld) && digits > 0) || digits > maxDigits;
}
export async function pf03JunkAtTop(ctx: PreflightCtx) {
  const max = ctx.settings.preflight_max_digits;
  const names: { domain: string; source: string; rank: number }[] = [];
  for (const r of ctx.shortlist.rows.slice(0, 50)) if (isJunkName(r.domain, max)) names.push({ domain: r.domain, source: 'shortlist', rank: r.rank });
  if (ctx.dataDate) {
    const parts = [];
    for (const s of SOURCES) if (await sealedManifest(ctx.db, s, ctx.dataDate)) parts.push(...(await closeoutsFromTable(ctx.db, s, ctx.dataDate, CLOSEOUTS_MAX_PRICE_CENTS, 50)).rows);
    sortCloseoutRows(parts).slice(0, 50).forEach((r, i) => { if (isJunkName(r.domain, max)) names.push({ domain: r.domain, source: `closeouts_${r.source}`, rank: i + 1 }); });
  }
  return names.length > 0 ? fail('JUNK_AT_TOP', { max_digits: max, names }) : ok({ max_digits: max });
}

// ---------- PF-04 ----------
/** Independent of the join in getShortlist: the active kills (not 'revoked', not revoked by a later row) of the served names, read straight from auction_kills. A served name with one
 * whose row carries no prior_kill (the re-show marker) was served although a kill blocks it. */
export async function pf04PriorKillServed(ctx: PreflightCtx) {
  const names = ctx.shortlist.rows.map((r) => r.domain);
  if (names.length === 0) return ok({ served_n: 0 });
  const killed = new Set<string>();
  for (let i = 0; i < names.length; i += 5000) {
    const part = names.slice(i, i + 5000);
    const rows = (await sql<{ domain: string }>`select distinct k.domain from auction_kills k where k.domain = any(${part}::text[]) and k.kill_stage <> 'revoked'
      and not exists (select 1 from auction_kills r where r.supersedes = k.id)`.execute(ctx.db)).rows;
    for (const r of rows) killed.add(r.domain);
  }
  const served = ctx.shortlist.rows.filter((r) => killed.has(r.domain) && r.prior_kill === null).map((r) => r.domain);
  return served.length > 0 ? fail('PRIOR_KILL_SERVED', { n: served.length, names: served.slice(0, 50) }) : ok({ served_n: names.length });
}

// ---------- PF-05 ----------
const COVERAGE_SOURCES = ['godaddy_inventory', 'dynadot_closeouts', 'dynadot_aftermarket'] as const;
interface CoverageJson { pages_failed?: unknown; coverage_status?: unknown; coverage_ratio?: unknown; pages_planned?: unknown; pages_ok?: unknown }
/**
 * Fields read from the newest manifest (by updated_at) of each source for the data date (snapshot_manifests.coverage, written by dynadot-pull.ts `coverageVerdict`):
 * `pages_failed` (array of page numbers), `coverage_status` ('OK' | 'LOW_COVERAGE', the flag), `coverage_ratio` (else pages_ok / pages_planned via coverageRatio).
 * Pages failed and no `coverage_status` flag -> COVERAGE_UNFLAGGED. A known ratio under settings.preflight_min_coverage_bp -> COVERAGE_BELOW_MIN (also when flagged:
 * flagging is not enough below the minimum). A source without a manifest or without page lists is noted, not failed (PF-06 handles freshness).
 */
export async function pf05Coverage(ctx: PreflightCtx) {
  if (!ctx.dataDate) return ok({ note: 'no data date' });
  const minBp = ctx.settings.preflight_min_coverage_bp;
  const problems: Record<string, unknown>[] = [];
  const seen: Record<string, unknown> = {};
  let reason: string | null = null;
  for (const source of COVERAGE_SOURCES) {
    const m = await ctx.db.selectFrom('snapshot_manifests').select(['coverage', 'status']).where('source', '=', source).where('data_date', '=', ctx.dataDate).orderBy('updated_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!m) { seen[source] = 'no manifest for the date'; continue; }
    const c = (m.coverage ?? null) as CoverageJson | null;
    const failed = Array.isArray(c?.pages_failed) ? c!.pages_failed.length : 0;
    const flag = typeof c?.coverage_status === 'string' ? c.coverage_status : null;
    const ratio = typeof c?.coverage_ratio === 'number' ? c.coverage_ratio : coverageRatio(c);
    seen[source] = { pages_failed_n: failed, coverage_status: flag, coverage: ratio };
    if (failed > 0 && flag === null) { reason ??= 'COVERAGE_UNFLAGGED'; problems.push({ source, code: 'COVERAGE_UNFLAGGED', pages_failed: failed, coverage: ratio }); }
    else if (ratio !== null && ratio * 10_000 < minBp) { reason ??= 'COVERAGE_BELOW_MIN'; problems.push({ source, code: 'COVERAGE_BELOW_MIN', pages_failed: failed, coverage: ratio, min_coverage: minBp / 10_000 }); }
  }
  return reason ? fail(reason, { problems, sources: seen }) : ok({ sources: seen, min_coverage: minBp / 10_000 });
}

// ---------- PF-06 ----------
/** The shortlist read is stale when as_of (now) is more than settings.preflight_max_age_hours after its generated_at. newest_seal_at (newest sealed godaddy / dynadot manifest of the date) is shown for the reader. */
export async function pf06StaleAsOf(ctx: PreflightCtx) {
  const gen = ctx.shortlist.generated_at;
  if (!ctx.dataDate || gen === null) return fail('STALE_AS_OF', { reason: 'no shortlist', data_date: ctx.dataDate });
  const seal = (await ctx.db.selectFrom('snapshot_manifests').select((eb) => eb.fn.max('sealed_at').as('s')).where('data_date', '=', ctx.dataDate).where('source', 'in', [...COVERAGE_SOURCES]).executeTakeFirst())?.s;
  const ageH = Math.round(((ctx.nowMs - Date.parse(gen)) / 3_600_000) * 100) / 100;
  const details = { as_of: toJerusalemIso(new Date(ctx.nowMs)), generated_at: gen, newest_seal_at: seal ? toJerusalemIso(new Date(seal as Date)) : null, age_h: ageH, max_age_h: ctx.settings.preflight_max_age_hours };
  return ageH > ctx.settings.preflight_max_age_hours ? fail('STALE_AS_OF', details) : ok(details);
}

/** Append-only and ordered. Never reuse an id; retire a check with `retired: reason`. */
export const PREFLIGHT_CHECKS: PreflightCheck[] = [
  { id: 'PF-01', name: 'Every served shortlist and closeouts row has a score or a by-design reason', run: pf01UnscoredRows },
  { id: 'PF-02', name: 'Shortlist counts reconcile with the field', run: pf02CountsReconcile },
  { id: 'PF-03', name: 'No junk names in the top 50', run: pf03JunkAtTop },
  { id: 'PF-04', name: 'No served name has an active prior kill', run: pf04PriorKillServed },
  { id: 'PF-05', name: 'Source coverage is complete or flagged, and above the minimum', run: pf05Coverage },
  { id: 'PF-06', name: 'The shortlist is fresh', run: pf06StaleAsOf },
];

export async function runChecks(ctx: PreflightCtx, checks: PreflightCheck[] = PREFLIGHT_CHECKS): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of checks) out.push(c.retired !== undefined ? { id: c.id, name: c.name, pass: true, reason_code: null, details: { retired: c.retired } } : { id: c.id, name: c.name, ...(await c.run(ctx)) });
  return out;
}

/** All served rows of the date, as GET /auctions/shortlist serves them (pages of 10,000). */
async function shortlistAllPages(db: Kysely<Database>, date: string | undefined, nowMs: number): Promise<Served> {
  const first = await getShortlist(db, { date, limit: 10_000, offset: 0 }, nowMs);
  const rows = [...first.rows];
  while (rows.length < first.total && rows.length % 10_000 === 0) {
    const next = await getShortlist(db, { date: first.data_date ?? undefined, limit: 10_000, offset: rows.length }, nowMs);
    if (next.rows.length === 0) break;
    rows.push(...next.rows);
  }
  return { ...first, rows };
}

/** GET /auctions/preflight and the datasave step `preflight`. Read-only. */
export async function runPreflight(db: Kysely<Database>, nowMs: number, q: z.infer<typeof PreflightQuery> = {}) {
  const shortlist = await shortlistAllPages(db, q.date, nowMs);
  const settings = await db.selectFrom('settings').select(['preflight_max_digits', 'preflight_min_coverage_bp', 'preflight_max_age_hours']).executeTakeFirstOrThrow();
  const checks = await runChecks({ db, nowMs, dataDate: shortlist.data_date, shortlist, settings });
  return {
    as_of: toJerusalemIso(new Date(nowMs)), data_date: shortlist.data_date, pass: checks.every((c) => c.pass),
    checks_sha256: createHash('sha256').update(JSON.stringify(checks)).digest('hex'), checks,
  };
}
