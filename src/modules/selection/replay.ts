// CAP-21a replay over labelled features (CR-002 §5 P-3, Amendment A2/A3). Every row goes through the SAME tier / DEMAND-2 code
// (evaluateTier + the selection settings) that live screening uses; nothing here re-implements a rule.
//   diagnostic: tier/DEMAND-2 decisions on a feature table; never counts toward clearing buy_hold.
//   holdout:    DOM recomputes CAP-01 (form) and CAP-02 (brand, big-company lists) from the domain; TM-1, TN-1 and HIST-2 + guard come
//               from the uploaded row with source and date; gates apply per row; a leakage lint must find 0 rows.
import { isYmd } from '../../core/dates.js';
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { matchTerms } from './checks/brand-lists.js';
import { analyzeForm, gform1, isShort } from './form.js';
import { buildLexicon, loadDataLexicon, type Lexicon } from './lexicon.js';
import { currentLists } from './lists.js';
import type { HoldoutCheck, SelectionValuesT } from './settings.js';
import { evaluateTier, type TierFeatures, type TierResult } from './tier.js';

export type Decision = 'accept' | 'reject' | 'undecided';
export type ReplayLane = 'expired' | 'fresh' | 'aged' | 'geo';
export const GATE_KEYS = ['tm_us', 'tn', 'hist2', 'hist2_guard'] as const;
export type GateKey = (typeof GATE_KEYS)[number];
export interface GateResult { result: 'PASS' | 'FAIL' | 'FLAG' | 'UNKNOWN'; source: string; date: string }

export interface LabelledFeatures {
  registered_share?: number | null; prior_history?: 0 | 1 | null; pre_cls?: string | null; alt_tld_before_n?: number | null;
  n_words?: number | null; sld_chars?: number | null; is_geo?: 0 | 1 | null; city_trade_ok?: boolean | null; short?: 0 | 1 | null;
  geo_city?: string | null; geo_trade?: string | null; archive_span_years?: number | null;
  /** v3.3.0 (CR-023 A/B): optional scout lane and verified-sellers count. A row without them is read as S2 (geo) or S7 (otherwise) with no sellers (0). */
  lane?: string | null; sellers_verified_n?: number | null; sellers_unknown_n?: number | null;
  /** Dates (YYYY-MM-DD) of the data each input came from, by input name; used only by the leakage lint. */
  input_dates?: Record<string, string>;
  gates?: Partial<Record<GateKey, GateResult>>;
}
export interface LabelledRow {
  domain: string; role: 'fit' | 'dev' | 'test'; label: 'sold' | 'dropped'; source: string; slice: string;
  report_lane: ReplayLane | null; price_cents: number | null; as_of: string | null; features: LabelledFeatures;
}

const known = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;

// ---------- one row ----------

/**
 * Form gate, then the tier. is_geo: G-FORM-1 fails -> reject. pre_cls 'harmful' -> reject. Otherwise DEMAND-2 decides:
 * PASS -> accept, FAIL -> reject, UNKNOWN -> undecided (a missing feature is never a pass or a fail).
 */
export function decideReplayRow(f: LabelledFeatures, sel: SelectionValuesT): { decision: Decision; tier: TierResult; reason: string } {
  const isGeo = f.is_geo === 1 ? 1 : 0;
  const nWords = f.n_words ?? null;
  const sldChars = f.sld_chars ?? null;
  // city_trade_ok unknown (null / absent) is unknown, not true: only a violated word or length limit decides without it.
  let gf: boolean | null = null;
  if (isGeo === 1 && known(nWords) && known(sldChars)) {
    const limitsOk = gform1(nWords, sldChars, true, true, sel.form);
    gf = f.city_trade_ok === false || !limitsOk ? false : known(f.city_trade_ok) ? true : null;
  }
  const features: TierFeatures = {
    registered_share: f.registered_share ?? null, prior_history: f.prior_history ?? null, alt_tld_before_n: f.alt_tld_before_n ?? null,
    n_words: nWords, sld_chars: sldChars, is_geo: isGeo,
    gform1_pass: gf === null ? null : gf ? 1 : 0,
    short: f.short ?? (known(nWords) && known(sldChars) ? isShort(nWords, sldChars, sel.form) : null),
    lane: f.lane ?? (isGeo === 1 ? 'S2' : 'S7'), sellers_verified_n: f.sellers_verified_n ?? 0, sellers_unknown_n: f.sellers_unknown_n ?? 0,
  };
  const tier = evaluateTier(features, sel.tier, sel.thresholds);
  if (gf === false) return { decision: 'reject', tier, reason: 'G-FORM-1 failed' };
  if (f.pre_cls === 'harmful') return { decision: 'reject', tier, reason: 'harmful prior page class' };
  if (tier.demand2 === 'PASS') return { decision: 'accept', tier, reason: `tier ${tier.fired ?? 'none'} passes DEMAND-2` };
  if (tier.demand2 === 'FAIL') return { decision: 'reject', tier, reason: 'no DEMAND-2 tier applies' };
  return { decision: 'undecided', tier, reason: 'a feature the tier rules need is missing' };
}

export interface GateContext { lexicon: Lexicon; lists: Record<string, { version: number; terms: string[] }> }
export interface RowOutcome {
  row: LabelledRow; before: Decision; after: Decision; reason: string; gates: Record<string, 'pass' | 'fail' | 'unknown' | 'flag'>; lane: ReplayLane | 'unknown'; leaks: boolean | null;
}

export const laneOf = (r: Pick<LabelledRow, 'report_lane' | 'features'>): ReplayLane | 'unknown' =>
  r.report_lane ?? (r.features.is_geo === 1 ? 'geo' : r.features.prior_history === 1 ? 'expired' : r.features.prior_history === 0 ? 'fresh' : 'unknown');

/** Holdout mode (gates in `notAssessed` are skipped): recompute CAP-01 and CAP-02 from the domain, merge the recomputed form fields, apply the supplied TM/TN/HIST gates. */
export function decideHoldoutRow(row: LabelledRow, sel: SelectionValuesT, ctx: GateContext, notAssessed: readonly GateKey[] = []): RowOutcome {
  const f = row.features;
  const isGeo = f.is_geo === 1;
  const form = analyzeForm(row.domain, isGeo ? 'S2' : 'S3', ctx.lexicon, sel.form, { city: f.geo_city ?? undefined, trade: f.geo_trade ?? undefined });
  const merged: LabelledFeatures = { ...f, n_words: form.word_count, sld_chars: form.sld_len, short: undefined, city_trade_ok: form.city !== null && form.trade !== null };
  if (form.status === 'FAIL' && (form.reason_code === 'HAS_DIGIT' || form.reason_code === 'HAS_HYPHEN')) { merged.n_words = null; merged.sld_chars = null; }
  const base = decideReplayRow(merged, sel);
  const gates: RowOutcome['gates'] = { form: form.status === 'FAIL' ? 'fail' : form.status === 'FLAG' ? 'flag' : 'pass' };

  const tokens = form.tokens.length > 0 ? form.tokens : [form.sld];
  const geoTok = form.token_types.map((t) => t === 'city' || t === 'state');
  for (const name of ['brand', 'bigco'] as const) {
    const list = ctx.lists[name];
    gates[name] = !list ? 'unknown' : matchTerms(tokens, geoTok, list.terms).length > 0 ? 'fail' : 'pass';
  }
  // A gate the suite definition leaves out (v2.5.0 `gates_not_assessed`) is neither applied nor makes the row undecided.
  for (const k of GATE_KEYS.filter((x) => !notAssessed.includes(x))) {
    const g = f.gates?.[k];
    gates[k] = !g ? 'unknown' : g.result === 'FAIL' ? 'fail' : g.result === 'UNKNOWN' ? 'unknown' : g.result === 'FLAG' ? 'flag' : 'pass';
  }
  let after: Decision = base.decision;
  const vals = Object.values(gates);
  if (vals.includes('fail')) after = 'reject';
  else if (base.decision === 'accept' && vals.includes('unknown')) after = 'undecided';
  return { row, before: base.decision, after, reason: base.reason, gates, lane: laneOf(row), leaks: rowLeaks(row) };
}

/** Whether any dated input of the row is dated at or after its as_of (strict `<` is the rule). null: the row can't be checked. */
export function rowLeaks(r: LabelledRow): boolean | null {
  if (!r.as_of) return null;
  const dates = [...Object.values(r.features.input_dates ?? {}), ...GATE_KEYS.map((k) => r.features.gates?.[k]?.date).filter((d): d is string => !!d)];
  if (dates.length === 0) return null;
  return dates.some((d) => d >= r.as_of!);
}

// ---------- report ----------

export interface Counts {
  sold: { n: number; accepted: number; rejected: number; undecided: number; accept_rate: number | null };
  dropped: { n: number; accepted: number; rejected: number; undecided: number; reject_rate: number | null };
  precision_at: Record<string, number | null>;
  meets_thresholds: boolean;
}

const rate = (k: number, n: number): number | null => (n === 0 ? null : k / n);

/** Rates use n including undecided: an undecided name is never an accept or a reject. */
export function cell(decisions: { label: 'sold' | 'dropped'; d: Decision }[], h: SelectionValuesT['holdout']): Counts {
  const sold = decisions.filter((x) => x.label === 'sold');
  const dropped = decisions.filter((x) => x.label === 'dropped');
  const c = (xs: typeof sold, d: Decision) => xs.filter((x) => x.d === d).length;
  const s = rate(c(sold, 'accept'), sold.length);
  const r = rate(c(dropped, 'reject'), dropped.length);
  const precision_at: Record<string, number | null> = {};
  for (const b of h.base_rates) {
    precision_at[String(b)] = s === null || r === null ? null : (s * b + (1 - r) * (1 - b) === 0 ? null : (s * b) / (s * b + (1 - r) * (1 - b)));
  }
  return {
    sold: { n: sold.length, accepted: c(sold, 'accept'), rejected: c(sold, 'reject'), undecided: c(sold, 'undecided'), accept_rate: s },
    dropped: { n: dropped.length, accepted: c(dropped, 'accept'), rejected: c(dropped, 'reject'), undecided: c(dropped, 'undecided'), reject_rate: r },
    precision_at,
    meets_thresholds: meets({ sold: { n: sold.length, accept_rate: s }, dropped: { n: dropped.length, reject_rate: r } }, h),
  };
}

export const meets = (c: { sold: { n: number; accept_rate: number | null }; dropped: { n: number; reject_rate: number | null } }, h: SelectionValuesT['holdout']): boolean =>
  c.sold.accept_rate !== null && c.dropped.reject_rate !== null &&
  c.sold.accept_rate >= h.sold_accept_min && c.dropped.reject_rate >= h.drop_reject_min && c.sold.n >= h.min_n && c.dropped.n >= h.min_n;

export interface Entry { row: LabelledRow; d: Decision; lane: ReplayLane | 'unknown' }
const group = <T>(xs: T[], key: (x: T) => string): Record<string, T[]> => {
  const out: Record<string, T[]> = {};
  for (const x of xs) (out[key(x)] ??= []).push(x);
  return out;
};

/** `report_bands` are USD edges (1000, 2500): <$1,000, $1,000 to <$2,500, $2,500 and up. Dropped names have no price, so a band covers sold names only. */
export function bandLabels(edges: number[]): string[] {
  const e = [...edges].sort((a, b) => a - b);
  return [`<$${e[0]}`, ...e.slice(1).map((x, i) => `$${e[i]}-<$${x}`), `>=$${e[e.length - 1]}`];
}
export function bandOf(priceCents: number, edges: number[]): string {
  const e = [...edges].sort((a, b) => a - b);
  const labels = bandLabels(e);
  const i = e.findIndex((x) => priceCents < x * 100);
  return labels[i === -1 ? e.length : i]!;
}

export interface ReplayReport {
  pooled: Counts;
  by_slice: Record<string, Counts>;
  by_band: Record<string, Counts['sold']>;
  by_lane: Record<string, Counts>;
  history_types: Record<string, { sold: Record<Decision, number>; dropped: Record<Decision, number> }>;
}

export function reportOf(entries: Entry[], sel: SelectionValuesT): ReplayReport {
  const h = sel.holdout;
  const dec = (xs: Entry[]) => xs.map((e) => ({ label: e.row.label, d: e.d }));
  const by = (key: (e: Entry) => string) => Object.fromEntries(Object.entries(group(entries, key)).map(([k, xs]) => [k, cell(dec(xs), h)]));
  const by_band: ReplayReport['by_band'] = {};
  const soldPriced = entries.filter((e) => e.row.label === 'sold' && e.row.price_cents !== null);
  for (const [k, xs] of Object.entries(group(soldPriced, (e) => bandOf(e.row.price_cents!, h.report_bands)))) by_band[k] = cell(dec(xs), h).sold;
  const history_types: ReplayReport['history_types'] = {};
  for (const e of entries) {
    const t = (history_types[e.row.features.pre_cls || 'unknown'] ??= { sold: { accept: 0, reject: 0, undecided: 0 }, dropped: { accept: 0, reject: 0, undecided: 0 } });
    t[e.row.label][e.d]++;
  }
  return { pooled: cell(dec(entries), h), by_slice: by((e) => e.row.slice), by_band, by_lane: by((e) => e.lane), history_types };
}

/** Diagnostic replay: decisions straight from the features (no gates). */
export function replayReport(rows: LabelledRow[], sel: SelectionValuesT): ReplayReport {
  return reportOf(rows.map((row) => ({ row, d: decideReplayRow(row.features, sel).decision, lane: laneOf(row) })), sel);
}

export interface LeakageLint { rows_checked: number; rows_leaking: number; rows_without_as_of: number; rows_without_dated_inputs: number }
export function leakageLint(rows: LabelledRow[]): LeakageLint {
  const out: LeakageLint = { rows_checked: 0, rows_leaking: 0, rows_without_as_of: 0, rows_without_dated_inputs: 0 };
  for (const r of rows) {
    if (!r.as_of) { out.rows_without_as_of++; continue; }
    const l = rowLeaks(r);
    if (l === null) { out.rows_without_dated_inputs++; continue; }
    out.rows_checked++;
    if (l) out.rows_leaking++;
  }
  return out;
}

// ---------- profit (Amendment A3) ----------

export interface ProfitReport {
  accepted_sold: number; accepted_dropped: number; cost_cents: number; cost_per_name_cents: number; net_factor: number;
  as_computed: ProfitFigure; without_top3: ProfitFigure; bin_capped: ProfitFigure; bin_price_cents: number;
}
interface ProfitFigure { gross_cents: number; net_cents: number; profit_cents: number; break_even_base_rate: number | null }

/** Needs a price on every sold row. Cost = every accepted name (sold or dropped) held `money.hold_years`. */
export function profitReport(entries: Entry[], sel: SelectionValuesT): ProfitReport {
  const sold = entries.filter((e) => e.row.label === 'sold');
  const missing = sold.filter((e) => e.row.price_cents === null).map((e) => e.row.domain);
  if (sold.length === 0 || missing.length > 0) {
    throw new AppError(422, 'PROFIT_REPORT_INCOMPLETE', 'A profit report needs sale_price_usd on every sold row', { sold_without_price: missing.length, examples: missing.slice(0, 10), sold_rows: sold.length });
  }
  const acc = sold.filter((e) => e.d === 'accept').map((e) => e.row.price_cents!).sort((a, b) => b - a);
  const accDropped = entries.filter((e) => e.row.label === 'dropped' && e.d === 'accept').length;
  const c = cell(entries.map((e) => ({ label: e.row.label, d: e.d })), sel.holdout);
  const factor = sel.money.net_factor_afternic;
  const cost = (acc.length + accDropped) * sel.profit.cost_per_name_year_cents * sel.money.hold_years;
  const s = c.sold.accept_rate;
  const r = c.dropped.reject_rate;
  const figure = (prices: number[]): ProfitFigure => {
    const gross = prices.reduce((a, b) => a + b, 0);
    const net = Math.round(gross * factor);
    // Break-even base sale rate b: the precision p(b) = s·b / (s·b + (1−r)(1−b)) at which the yearly expected net sale value of an accepted
    // name (p × mean net price) equals its yearly cost. p* = cost / value; solving p(b) = p* gives b = p*(1−r) / (s(1−p*) + p*(1−r)).
    let be: number | null = null;
    if (prices.length > 0 && s !== null && r !== null) {
      const p = sel.profit.cost_per_name_year_cents / ((net / prices.length));
      if (p > 0 && p < 1) { const den = s * (1 - p) + p * (1 - r); be = den === 0 ? null : (p * (1 - r)) / den; }
      else if (p >= 1) be = 1;
    }
    return { gross_cents: gross, net_cents: net, profit_cents: net - cost, break_even_base_rate: be };
  };
  const cap = sel.profit.bin_price_cents;
  return {
    accepted_sold: acc.length, accepted_dropped: accDropped, cost_cents: cost, cost_per_name_cents: sel.profit.cost_per_name_year_cents * sel.money.hold_years, net_factor: factor,
    as_computed: figure(acc), without_top3: figure(acc.slice(3)), bin_capped: figure(acc.map((p) => Math.min(p, cap))), bin_price_cents: cap,
  };
}

// ---------- holdout gate columns ----------

/** Every dated feature needs the date of the data it came from (else the leakage lint can't clear it). */
const DATED: [feature: keyof LabelledFeatures, input: string][] = [
  ['registered_share', 'census'], ['alt_tld_before_n', 'ext_dates'], ['prior_history', 'history'], ['pre_cls', 'history'], ['archive_span_years', 'history'],
];

/** Holdout rows need the four gate results (source and date) and an input date for every non-null dated feature. */
export function missingGates(rows: LabelledRow[], notAssessed: readonly GateKey[] = []): { domain: string; missing: string[] }[] {
  const out: { domain: string; missing: string[] }[] = [];
  for (const r of rows) {
    const miss: string[] = GATE_KEYS.filter((k) => !notAssessed.includes(k)).filter((k) => { const g = r.features.gates?.[k]; return !g || !g.source || !isYmd(g.date); });
    for (const [feat, input] of DATED) {
      const col = `input_dates.${input}`;
      if (known(r.features[feat]) && !isYmd(r.features.input_dates?.[input] ?? '') && !miss.includes(col)) miss.push(col);
    }
    if (miss.length > 0) out.push({ domain: r.domain, missing: miss });
  }
  return out;
}

export async function gateContext(db: Kysely<Database>, sel: SelectionValuesT): Promise<GateContext> {
  const lists = await currentLists(db, ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra', 'brand', 'bigco']);
  return { lists, lexicon: buildLexicon(loadDataLexicon(), lists, { cityOneToken: sel.form.geo_city_one_token, cityWordAllowlist: sel.form.city_word_allowlist }) };
}

// ---------- the registry rows ----------

export const rpl = (): string => `rpl_${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`;

export function toLabelledRow(r: { domain: string; role: LabelledRow['role']; label: LabelledRow['label']; source: string; slice: string; report_lane: LabelledRow['report_lane']; price_cents: number | null; as_of: string | null; features: unknown }): LabelledRow {
  return { domain: r.domain, role: r.role, label: r.label, source: r.source, slice: r.slice, report_lane: r.report_lane, price_cents: r.price_cents, as_of: r.as_of, features: r.features as LabelledFeatures };
}

// ---------- hold-clearing ----------

export interface SuiteStatus {
  suite: string; replay_id: string | null; pass: boolean; sold_accept_rate: number | null; drop_reject_rate: number | null; n_sold: number; n_dropped: number;
  definition_version: number | null; failed_before: boolean; variants_scored: number;
}

/** A holdout replay's judged cell (`pooled` or `lane:<lane>`) from its stored report. */
export const judgedOf = (report: unknown): Counts => (report as { judged: Counts }).judged;

/**
 * The suites that clear `buy_hold` (v2.5.0): those whose LATEST definition has `clears_hold`; when none has, `holdout.required_suites`.
 */
export async function holdSuites(db: Kysely<Database>, holdout: SelectionValuesT['holdout']): Promise<{ suites: string[]; source: 'clears_hold' | 'required_suites' }> {
  const defs = await db.selectFrom('holdout_suites').select(['suite', 'version', 'clears_hold']).orderBy('suite').orderBy('version', 'desc').execute();
  const latest = new Map<string, boolean>();
  for (const d of defs) if (!latest.has(d.suite)) latest.set(d.suite, d.clears_hold === true);
  const clearing = [...latest].filter(([, c]) => c).map(([suite]) => suite);
  return clearing.length > 0 ? { suites: clearing, source: 'clears_hold' } : { suites: holdout.required_suites, source: 'required_suites' };
}

/**
 * Per hold suite (see holdSuites), for one settings version: a FAILING holdout replay sticks (no latest-wins; a re-run or a changed definition never
 * erases it). Otherwise the suite passes only when its latest definition version has a passing replay (judged again by the ACTIVE
 * version's `holdout` settings, with 0 leaking rows). Diagnostic replays are never considered. `variants_scored`: how many settings
 * versions have a holdout replay of the suite (the pre-registered variants).
 */
export async function suiteStatuses(db: Kysely<Database>, settingsId: number, holdout: SelectionValuesT['holdout']): Promise<SuiteStatus[]> {
  const out: SuiteStatus[] = [];
  for (const suite of (await holdSuites(db, holdout)).suites) {
    const def = await db.selectFrom('holdout_suites').select(['id', 'version']).where('suite', '=', suite).orderBy('version', 'desc').limit(1).executeTakeFirst();
    const runs = await db.selectFrom('replay_runs').select(['id', 'report', 'leakage_rows', 'suite_def_id']).where('suite', '=', suite).where('mode', '=', 'holdout').where('settings_id', '=', settingsId)
      .orderBy('created_at').orderBy('id').execute();
    const variants = Number((await db.selectFrom('replay_runs').select(db.fn.count<number>('settings_id').distinct().as('n')).where('suite', '=', suite).where('mode', '=', 'holdout').executeTakeFirstOrThrow()).n);
    const judge = (r: (typeof runs)[number]) => r.leakage_rows === 0 && meets(judgedOf(r.report), holdout);
    const failing = runs.find((r) => !judge(r));
    const passing = def ? runs.filter((r) => r.suite_def_id === def.id).find(judge) : undefined;
    const shown = failing ?? passing ?? runs[runs.length - 1];
    const c = shown ? judgedOf(shown.report) : null;
    out.push({
      suite, replay_id: shown?.id ?? null, pass: !failing && !!passing,
      sold_accept_rate: c?.sold.accept_rate ?? null, drop_reject_rate: c?.dropped.reject_rate ?? null, n_sold: c?.sold.n ?? 0, n_dropped: c?.dropped.n ?? 0,
      definition_version: def?.version ?? null, failed_before: !!failing, variants_scored: variants,
    });
  }
  return out;
}

export const holdoutCheck: HoldoutCheck = async (db, settingsId, _values, holdout) => {
  const suites = await suiteStatuses(db, settingsId, holdout);
  return { pass: suites.length > 0 && suites.every((s) => s.pass), suites };
};

// ---------- CSV upload ----------

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): Record<string, string>[] {
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/**
 * CSV row -> upload row. Columns: domain, label, slice, role (as in features.csv), optional source (default: slice), report_lane,
 * sale_price_usd, as_of, registered_share, prior_history, pre_cls, alt_tld_before_n, n_words, sld_chars, geo_city, geo_trade,
 * archive_span_years, census_date (the date the census was measured), and for each gate g in tm_us, tn, hist2, hist2_guard:
 * g_result, g_source, g_date. An empty cell is unknown (null); nothing is imputed.
 */
export function csvToUploadRow(c: Record<string, string>): Record<string, unknown> {
  const n = (k: string): number | null => (c[k] === undefined || c[k] === '' ? null : Number(c[k]));
  const s = (k: string): string | null => (c[k] === undefined || c[k] === '' ? null : c[k]);
  const geo = !!(s('geo_city') || s('geo_trade'));
  const features: Record<string, unknown> = {
    registered_share: n('registered_share'), prior_history: n('prior_history'), pre_cls: s('pre_cls'), alt_tld_before_n: n('alt_tld_before_n'),
    n_words: n('n_words'), sld_chars: n('sld_chars'), is_geo: n('is_geo') !== null ? n('is_geo') : geo ? 1 : 0,
  };
  if (geo || features.is_geo === 1) Object.assign(features, { city_trade_ok: !!(s('geo_city') && s('geo_trade')), geo_city: s('geo_city'), geo_trade: s('geo_trade') });
  if (s('archive_span_years') !== null) features.archive_span_years = n('archive_span_years');
  const dates = Object.fromEntries((['census', 'ext_dates', 'history'] as const).flatMap((k) => (s(`${k}_date`) !== null ? [[k, s(`${k}_date`)]] : [])));
  if (Object.keys(dates).length > 0) features.input_dates = dates;
  const gates: Record<string, unknown> = {};
  for (const g of GATE_KEYS) if (s(`${g}_result`) !== null) gates[g] = { result: s(`${g}_result`), source: s(`${g}_source`) ?? '', date: s(`${g}_date`) ?? '' };
  if (Object.keys(gates).length > 0) features.gates = gates;
  const price = n('sale_price_usd');
  return {
    domain: c.domain, role: c.role, label: c.label, source: s('source') ?? c.slice, slice: c.slice, ...(s('report_lane') && { report_lane: s('report_lane') }),
    ...(price !== null && { price_usd: price }), as_of: s('as_of'), features,
  };
}
