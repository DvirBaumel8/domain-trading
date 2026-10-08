// v2.5.0 (CR-007 §21, G-4a/G-4b, CR-008 AC-10): test sets. A set stores a selection of names with their labels and `as_of` dates; DOM computes the
// features itself by a back-test screening run (form, census with a sibling method (bt1@v1, bt1@v2 or bt1@v3), ext_dates) as of each name's date. Pure helpers live here; the routes
// are in src/modules/selection/api/test-sets.ts.
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { addDays, idtMidnightIso, toJerusalemIso } from '../../core/dates.js';
import { latestByCheck } from './derive.js';
import { loadRows } from './engine.js';
import { decideReplayRow, cell, type LabelledFeatures, type LabelledRow } from './replay.js';
import type { SelectionValuesT } from './settings.js';
import type { CheckId, Lane, RunItem } from './types.js';

/** A test-set run's deadline (hours), instead of `run.time_budget_minutes`: about 24 registry lookups per name at polite pacing. */
export const TEST_SET_RUN_HOURS = 48;
export const TEST_SET_METHODS = ['bt1@v1', 'bt1@v2', 'bt1@v3'] as const;
export type TestSetMethod = (typeof TEST_SET_METHODS)[number];
/** Default for a new set (v2.6.0); sets stored before v2.6.0 have no method and read as bt1@v1. */
export const TEST_SET_DEFAULT_METHOD: TestSetMethod = 'bt1@v2';
export const LEGACY_TEST_SET_METHOD: TestSetMethod = 'bt1@v1';
/** v2.7.0: how old a stored registry answer may be and still be reused by a test-set run (days); 0 = always ask again. */
export const TEST_SET_DEFAULT_MAX_ANSWER_AGE_DAYS = 7;
export const TEST_SET_CHECKS: CheckId[] = ['form', 'census', 'ext_dates'];
export const TEST_SET_LANE: Lane = 'S7';

export const midnightJerusalem = idtMidnightIso;
export const dayBefore = (day: string): string => addDays(day, -1);

export const splitKey = (seed: string, domain: string): string => createHash('sha256').update(`${seed}:${domain}`).digest('hex');

/** Kept domains in ascending sha256(`seed:domain`) order: the first Math.round(share * n) are `test`, the rest `dev`. */
export function splitRoles(domains: string[], seed: string, testShare: number): Map<string, 'test' | 'dev'> {
  const sorted = [...domains].map((d) => ({ d, k: splitKey(seed, d) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const nTest = Math.round(testShare * sorted.length);
  return new Map(sorted.map((x, i) => [x.d, i < nTest ? 'test' : 'dev']));
}

export const memberHashOf = (domains: string[]): string => createHash('sha256').update([...domains].sort().join('\n')).digest('hex');

/** Wilson score interval, z = 1.96, 4 decimals. null when n is 0. */
export function wilson95(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  const r = (x: number) => Math.round(x * 10_000) / 10_000;
  return [r(Math.max(0, centre - half)), r(Math.min(1, centre + half))];
}

export interface DomFeatures {
  registered_share: number | null; alt_tld_before_n: number | null; n_words: number | null; sld_chars: number | null; is_geo: 0 | 1 | null;
}

type RunRowT = { id: string; input: unknown; gate_plan: unknown };

/** The features DOM computed for each name of a test-set run (null unless the check PASSED; nothing is read as zero). */
export interface LookupCounts { fresh: number; reused: number; unknown: number; rate_limited: number }

/** v2.7.0: the registry lookups behind a run's census and ext_dates results, read from the per-sibling / per-extension `reused` flags (`rate_limited_n` is summed). */
function countLookups(rows: { fields: Record<string, unknown> }[], into: LookupCounts): void {
  for (const r of rows) {
    const f = r.fields;
    for (const list of [f.siblings, f.extensions]) {
      if (!Array.isArray(list)) continue;
      for (const x of list as { status?: string; reused?: boolean }[]) {
        if (x.status === 'unknown') into.unknown++;
        else if (x.reused === true) into.reused++;
        else into.fresh++;
      }
    }
    if (typeof f.rate_limited_n === 'number') into.rate_limited += f.rate_limited_n;
  }
}

/** v2.9.0 (F-4): the lookup totals of a run from the census and ext_dates row in force for each name (shared by the test-set and the screening-run GET). */
export function lookupsOf(latestPerName: Iterable<Map<CheckId, { fields: Record<string, unknown> }>>): LookupCounts {
  const lookups: LookupCounts = { fresh: 0, reused: 0, unknown: 0, rate_limited: 0 };
  for (const latest of latestPerName) countLookups([latest.get('census'), latest.get('ext_dates')].filter((x): x is NonNullable<typeof x> => x !== undefined), lookups);
  return lookups;
}

export async function featuresOfRun(db: Kysely<Database>, run: RunRowT): Promise<{ byDomain: Map<string, DomFeatures>; done_n: number; names_n: number; lookups: LookupCounts; latest: { domain: string; latest: Map<CheckId, Awaited<ReturnType<typeof loadRows>>[number]> }[] }> {
  const items = (run.input as { names: RunItem[] }).names;
  const plan = run.gate_plan as Partial<Record<Lane, CheckId[]>>;
  const byItem = new Map<number, Awaited<ReturnType<typeof loadRows>>>();
  for (const r of await loadRows(db, run.id)) (byItem.get(r.item_idx) ?? byItem.set(r.item_idx, []).get(r.item_idx)!).push(r);
  const byDomain = new Map<string, DomFeatures>();
  let done = 0;
  const perName: Map<CheckId, Awaited<ReturnType<typeof loadRows>>[number]>[] = [];
  const perDomain: { domain: string; latest: Map<CheckId, Awaited<ReturnType<typeof loadRows>>[number]> }[] = [];
  for (const it of items) {
    const latest = latestByCheck(byItem.get(it.idx) ?? []);
    if ((plan[it.lane] ?? []).every((c) => latest.has(c))) done++;
    const formRow = latest.get('form');
    const form = formRow?.fields as { word_count?: number; sld_len?: number; city?: string | null; trade?: string | null } | undefined;
    const census = latest.get('census');
    const ext = latest.get('ext_dates');
    perName.push(latest);
    perDomain.push({ domain: it.domain, latest });
    const share = census?.status === 'PASS' && typeof census.fields.registered_share === 'number' ? census.fields.registered_share : null;
    const alt = ext?.status === 'PASS' && typeof ext.fields.alt_tld_before_n === 'number' ? ext.fields.alt_tld_before_n : null;
    byDomain.set(it.domain, {
      registered_share: share, alt_tld_before_n: alt,
      n_words: typeof form?.word_count === 'number' ? form.word_count : null, sld_chars: typeof form?.sld_len === 'number' ? form.sld_len : null,
      // v2.16.0: unknown (null), not 0, when the form check did not PASS (or did not run).
      is_geo: formRow?.status === 'PASS' || formRow?.status === 'PASS_WITH_NOTE' ? (form?.city && form?.trade ? 1 : 0) : null,
    });
  }
  return { byDomain, done_n: done, names_n: items.length, lookups: lookupsOf(perName), latest: perDomain };
}

export interface RescoreReport {
  settings_version: string;
  sold: ReturnType<typeof cell>['sold'] & { wilson95: [number, number] | null };
  dropped: ReturnType<typeof cell>['dropped'] & { wilson95: [number, number] | null };
  features_unknown_n: number; rows_changed_vs_registered: number; as_of_reconstructed: true;
  features_as_of: 'row' | 'now'; sibling_method: string;
}

/**
 * Decisions of the registered rows under `sel`, with DOM's own registered_share, alt_tld_before_n, n_words, sld_chars and is_geo
 * (null stays unknown) in place of the uploaded ones; every other uploaded feature is kept so the tier sees the same inputs.
 */
export function rescoreReport(
  rows: LabelledRow[], feats: Map<string, DomFeatures>, label: string, sel: SelectionValuesT, meta: { features_as_of: 'row' | 'now'; sibling_method: string } = { features_as_of: 'row', sibling_method: LEGACY_TEST_SET_METHOD },
): RescoreReport {
  const dec: { label: 'sold' | 'dropped'; d: ReturnType<typeof decideReplayRow>['decision'] }[] = [];
  let unknown = 0;
  let changed = 0;
  for (const r of rows) {
    const f = feats.get(r.domain);
    const own: LabelledFeatures = {
      ...r.features,
      registered_share: f?.registered_share ?? null, alt_tld_before_n: f?.alt_tld_before_n ?? null,
      n_words: f?.n_words ?? null, sld_chars: f?.sld_chars ?? null, is_geo: f?.is_geo ?? 0,
    };
    if (own.registered_share === null || own.alt_tld_before_n === null) unknown++;
    const d = decideReplayRow(own, sel).decision;
    if (d !== decideReplayRow(r.features, sel).decision) changed++;
    dec.push({ label: r.label, d });
  }
  const c = cell(dec, sel.holdout);
  return {
    settings_version: label,
    sold: { ...c.sold, wilson95: wilson95(c.sold.accepted, c.sold.n) },
    dropped: { ...c.dropped, wilson95: wilson95(c.dropped.rejected, c.dropped.n) },
    features_unknown_n: unknown, rows_changed_vs_registered: changed, as_of_reconstructed: true,
    features_as_of: meta.features_as_of, sibling_method: meta.sibling_method,
  };
}

type Features = Awaited<ReturnType<typeof featuresOfRun>>;
const FEATURES_CACHE_MAX = 16;
const featuresCache = new Map<string, { key: string; feats: Features }>();

/** Forgets every cached feature set (tests). */
export function clearFeaturesCache(): void { featuresCache.clear(); }

/** The run's result rows as a cheap fingerprint: any new row (or a deleted one) changes it. */
async function rowsFingerprint(db: Kysely<Database>, runId: string): Promise<string> {
  const r = await sql<{ n: string; m: string | null }>`select count(*) as n, max(id) as m from screening_results where run_id = ${runId}`.execute(db);
  return `${r.rows[0]!.n}:${r.rows[0]!.m ?? 0}`;
}

/** featuresOfRun for a FINISHED run, remembered per run id in memory until the run's rows change (a recompute or a manual record appends a row). */
export async function cachedFeaturesOfRun(db: Kysely<Database>, run: RunRowT): Promise<Features> {
  const key = await rowsFingerprint(db, run.id);
  const hit = featuresCache.get(run.id);
  if (hit && hit.key === key) return hit.feats;
  const feats = await featuresOfRun(db, run);
  featuresCache.delete(run.id);
  featuresCache.set(run.id, { key, feats });
  while (featuresCache.size > FEATURES_CACHE_MAX) featuresCache.delete(featuresCache.keys().next().value!);
  return feats;
}

/**
 * Progress of a run that is still going, from one aggregate query (no result rows are loaded): `done_n` as featuresOfRun counts it. Features, lookups
 * and unknowns are only computed once the run has finished, so here they are empty.
 */
export async function progressOfRun(db: Kysely<Database>, run: RunRowT): Promise<Features> {
  const items = (run.input as { names: RunItem[] }).names;
  const plan = run.gate_plan as Partial<Record<Lane, CheckId[]>>;
  const rows = await sql<{ item_idx: number; checks: string[] }>`select item_idx, array_agg(distinct check_id) as checks from screening_results where run_id = ${run.id} group by item_idx`.execute(db);
  const have = new Map(rows.rows.map((r) => [r.item_idx, new Set(r.checks)]));
  let done = 0;
  for (const it of items) if ((plan[it.lane] ?? []).every((c) => have.get(it.idx)?.has(c))) done++;
  return { byDomain: new Map(), done_n: done, names_n: items.length, lookups: { fresh: 0, reused: 0, unknown: 0, rate_limited: 0 }, latest: [] };
}
