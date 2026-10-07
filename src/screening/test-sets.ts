// v2.5.0 (CR-007 §21, G-4a/G-4b, CR-008 AC-10): test sets. A set stores a selection of names with their labels and `as_of` dates; DOM computes the
// features itself by a back-test screening run (form, census with a sibling method (bt1@v1 or bt1@v2), ext_dates) as of each name's date. Pure helpers live here; the routes
// are in src/api/test-sets.ts.
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { toJerusalemIso } from '../time.js';
import { latestByCheck } from './derive.js';
import { loadRows } from './engine.js';
import { decideReplayRow, cell, type LabelledFeatures, type LabelledRow } from './replay.js';
import type { SelectionValuesT } from './settings.js';
import type { CheckId, Lane, RunItem } from './types.js';

/** A test-set run's deadline (hours), instead of `run.time_budget_minutes`: about 24 registry lookups per name at polite pacing. */
export const TEST_SET_RUN_HOURS = 48;
export const TEST_SET_METHODS = ['bt1@v1', 'bt1@v2'] as const;
export type TestSetMethod = (typeof TEST_SET_METHODS)[number];
/** Default for a new set (v2.6.0); sets stored before v2.6.0 have no method and read as bt1@v1. */
export const TEST_SET_DEFAULT_METHOD: TestSetMethod = 'bt1@v2';
export const LEGACY_TEST_SET_METHOD: TestSetMethod = 'bt1@v1';
export const TEST_SET_CHECKS: CheckId[] = ['form', 'census', 'ext_dates'];
export const TEST_SET_LANE: Lane = 'S7';

/** `YYYY-MM-DD` at 00:00 Asia/Jerusalem as ISO 8601 with its offset (the offset on that day: DST changes happen after midnight). */
export function midnightJerusalem(day: string): string {
  const noon = toJerusalemIso(new Date(`${day}T12:00:00Z`)).slice(-6);
  for (const off of [noon, '+03:00', '+02:00']) {
    const cand = `${day}T00:00:00${off}`;
    if (toJerusalemIso(new Date(cand)) === cand) return cand;
  }
  return `${day}T00:00:00${noon}`;
}

export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

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
  registered_share: number | null; alt_tld_before_n: number | null; n_words: number | null; sld_chars: number | null; is_geo: 0 | 1;
}

type RunRowT = { id: string; input: unknown; gate_plan: unknown };

/** The features DOM computed for each name of a test-set run (null unless the check PASSED; nothing is read as zero). */
export async function featuresOfRun(db: Kysely<Database>, run: RunRowT): Promise<{ byDomain: Map<string, DomFeatures>; done_n: number; names_n: number }> {
  const items = (run.input as { names: RunItem[] }).names;
  const plan = run.gate_plan as Partial<Record<Lane, CheckId[]>>;
  const byItem = new Map<number, Awaited<ReturnType<typeof loadRows>>>();
  for (const r of await loadRows(db, run.id)) (byItem.get(r.item_idx) ?? byItem.set(r.item_idx, []).get(r.item_idx)!).push(r);
  const byDomain = new Map<string, DomFeatures>();
  let done = 0;
  for (const it of items) {
    const latest = latestByCheck(byItem.get(it.idx) ?? []);
    if ((plan[it.lane] ?? []).every((c) => latest.has(c))) done++;
    const form = latest.get('form')?.fields as { word_count?: number; sld_len?: number; city?: string | null; trade?: string | null } | undefined;
    const census = latest.get('census');
    const ext = latest.get('ext_dates');
    const share = census?.status === 'PASS' && typeof census.fields.registered_share === 'number' ? census.fields.registered_share : null;
    const alt = ext?.status === 'PASS' && typeof ext.fields.alt_tld_before_n === 'number' ? ext.fields.alt_tld_before_n : null;
    byDomain.set(it.domain, {
      registered_share: share, alt_tld_before_n: alt,
      n_words: typeof form?.word_count === 'number' ? form.word_count : null, sld_chars: typeof form?.sld_len === 'number' ? form.sld_len : null,
      is_geo: form?.city && form?.trade ? 1 : 0,
    });
  }
  return { byDomain, done_n: done, names_n: items.length };
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
