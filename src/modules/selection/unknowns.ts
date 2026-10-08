// v2.13.0 (CR-012 part A, T12-2): why a name has an unknown feature. Pure reads of the rows in force plus the stored registry attempts
// (rdap_lookups) for the queried names. Information only: nothing acts on it.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { selectionSettingsByLabel } from './settings.js';
import { loadSplitV2, splitUnread } from './split-v2.js';
import { unknownInputsOf, type TierResult } from './tier.js';
import type { CheckId, ResultRow } from './types.js';

/** At most this many names are listed; `total_n` always counts all of them. */
export const UNKNOWNS_MAX_ENTRIES = 200;
const FEATURE_CHECKS: CheckId[] = ['census', 'ext_dates'];

export interface UnknownLookup { name: string; source: string | null; reason_code: string | null; tries: number; last_try_at: string | null }
export interface UnknownFeature { check: string; reason_code: string | null; detail: Record<string, unknown> | null }
export interface UnknownEntry { domain: string; features: UnknownFeature[] }
export interface Unknowns { total_n: number; truncated: boolean; entries: UnknownEntry[] }
export interface UnknownCounts { total_n: number; by_check_reason: Record<string, number> }

type Latest = Map<CheckId, ResultRow>;
/** A name the tier rules left undecided, though no feature check is unknown (v2.16.0, CR-014 N-3): the inputs that were unknown. */
export type UndecidedMap = Map<string, { unknown_inputs: string[] }>;
interface Pending { domain: string; features: { check: string; reason_code: string | null; row: ResultRow | null; undecided?: { unknown_inputs: string[] } }[] }

/** The inputs that kept a tier row UNKNOWN: its clauses that came out unknown, read against the settings the row was made with. */
async function tierUnknownInputs(db: Kysely<Database>, row: ResultRow, cache: Map<string, Awaited<ReturnType<typeof selectionSettingsByLabel>>>): Promise<string[]> {
  const f = row.fields as { clauses?: unknown; inputs?: unknown };
  if (!f.clauses || !f.inputs) return [];
  if (!cache.has(row.settings_label)) cache.set(row.settings_label, await selectionSettingsByLabel(db, row.settings_label));
  const sel = cache.get(row.settings_label);
  return sel ? unknownInputsOf(f as Pick<TierResult, 'clauses' | 'inputs'>, sel.values.tier) : [];
}

/** The checks of a name whose row in force is UNKNOWN, or (census, ext_dates) anything but PASS. A check with no row yet is not listed. */
function pendingOf(domain: string, latest: Latest, undecided?: UndecidedMap): Pending | null {
  const features: Pending['features'] = [];
  for (const [check, row] of latest) {
    if (row.status === 'UNKNOWN' || (FEATURE_CHECKS.includes(check) && row.status !== 'PASS')) features.push({ check, reason_code: row.reason_code, row });
  }
  features.sort((a, b) => a.row!.id - b.row!.id);
  // An undecided name is listed with its reason even when no feature check is unknown (a name that has an unknown feature already says why).
  const u = undecided?.get(domain);
  if (u && features.length === 0) features.push({ check: 'tier', reason_code: 'DEMAND2_UNDECIDED', row: null, undecided: u });
  return features.length === 0 ? null : { domain, features };
}

interface Q { name: string; source: string | null; reason_code: string | null }
/** The unknown (or undated) queried names inside one census or ext_dates row. */
function lookupsIn(row: ResultRow | null, domain: string): Q[] {
  if (!row) return [];
  const f = row.fields;
  if (row.check_id === 'census' && Array.isArray(f.siblings)) {
    return (f.siblings as { domain: string; status: string; reason_code?: string; source?: string | null }[])
      .filter((s) => s.status === 'unknown' || s.reason_code === 'UNDATED').map((s) => ({ name: s.domain, source: s.source ?? null, reason_code: s.reason_code ?? null }));
  }
  if (row.check_id === 'ext_dates' && Array.isArray(f.extensions)) {
    const sld = domain.replace(/\.com$/, '');
    return (f.extensions as { tld: string; status: string; reason_code?: string; source?: string | null }[])
      .filter((x) => x.status === 'unknown').map((x) => ({ name: `${sld}.${x.tld}`, source: x.source ?? null, reason_code: x.reason_code ?? null }));
  }
  return [];
}

/** Names with an unknown feature from the rows in force (`items`: each name's latest row per check). */
export async function unknownsOf(db: Kysely<Database>, items: { domain: string; latest: Latest }[], undecided?: UndecidedMap): Promise<Unknowns> {
  const all = items.map((i) => pendingOf(i.domain, i.latest, undecided)).filter((p): p is Pending => p !== null);
  const shown = all.slice(0, UNKNOWNS_MAX_ENTRIES);
  const names = new Set<string>();
  for (const p of shown) for (const f of p.features) for (const q of lookupsIn(f.row, p.domain)) names.add(q.name);
  const hist = new Map<string, { tries: number; last: Date }>();
  const list = [...names];
  for (let i = 0; i < list.length; i += 1000) {
    const rows = await db.selectFrom('rdap_lookups').select(['domain']).select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.max('checked_at').as('last')])
      .where('domain', 'in', list.slice(i, i + 1000)).groupBy('domain').execute();
    for (const r of rows) hist.set(r.domain, { tries: Number(r.n), last: r.last as Date });
  }
  const settingsCache = new Map<string, Awaited<ReturnType<typeof selectionSettingsByLabel>>>();
  const tierInputs = new Map<number, string[]>();
  for (const p of shown) for (const f of p.features) if (f.row && f.check === 'tier' && f.row.status === 'UNKNOWN') tierInputs.set(f.row.id, await tierUnknownInputs(db, f.row, settingsCache));
  const entries = shown.map((p): UnknownEntry => ({
    domain: p.domain,
    features: p.features.map((f): UnknownFeature => {
      const lookups = lookupsIn(f.row, p.domain).map((q): UnknownLookup => {
        const h = hist.get(q.name);
        return { name: q.name, source: q.source, reason_code: q.reason_code, tries: h?.tries ?? 0, last_try_at: h ? h.last.toISOString() : null };
      });
      let detail: Record<string, unknown> | null = null;
      if (f.undecided) detail = { unknown_inputs: f.undecided.unknown_inputs };
      else if (f.row && f.check === 'tier' && f.row.status === 'UNKNOWN') detail = { unknown_inputs: tierInputs.get(f.row.id) ?? [] };
      else if (f.row && f.reason_code === 'CENSUS_LIST_SIZE') {
        const fields = f.row.fields;
        let unread: string | null = null;
        try {
          const method = typeof fields.list === 'string' && /^bt1@v\d+$/.test(fields.list) ? fields.list : 'bt1@v2';
          unread = splitUnread(p.domain.replace(/\.com$/, ''), loadSplitV2(method));
        } catch { unread = null; }
        detail = { tokens: Array.isArray(fields.sibling_tokens) ? fields.sibling_tokens : [], size: typeof fields.size === 'number' ? fields.size : null, unread };
      } else if (lookups.length > 0) detail = { lookups };
      return { check: f.check, reason_code: f.reason_code, detail };
    }),
  }));
  return { total_n: all.length, truncated: all.length > shown.length, entries };
}

/** The same reads as counts only (a `new` test set: its names are never shown, R-18). */
export function unknownCounts(items: { domain: string; latest: Latest }[]): UnknownCounts {
  const by: Record<string, number> = {};
  let total = 0;
  for (const i of items) {
    const p = pendingOf(i.domain, i.latest);
    if (!p) continue;
    total++;
    for (const f of p.features) { const k = `${f.check}:${f.reason_code ?? f.row?.status}`; by[k] = (by[k] ?? 0) + 1; }
  }
  return { total_n: total, by_check_reason: by };
}

/** Names (lower-case) with an unknown feature, no diagnostics. */
export const unknownNames = (items: { domain: string; latest: Latest }[]): string[] => items.filter((i) => pendingOf(i.domain, i.latest) !== null).map((i) => i.domain);
