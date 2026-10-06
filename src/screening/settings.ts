// CAP-00 selection settings: one versioned JSON document (selection_settings.values) holds every threshold, the tier
// clauses and the gate list per lane. Code holds mechanics only. Drafts come in by dotted path; activation needs Dvir's
// approval_ref; the priors are locked against API drafts (SEL9-2).
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, SelectionSettingsTable } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { checkTimedApproval } from '../services/approval.js';

export const TIER_FEATURES = ['registered_share', 'prior_history', 'alt_tld_before_n', 'n_words', 'sld_chars', 'is_geo', 'gform1_pass', 'short'] as const;
export const CHECK_IDS = ['form', 'brand_lists', 'typo', 'availability', 'concentration', 'surbl', 'web_risk', 'history', 'tm_us', 'census', 'ext_dates', 'tier', 'namebio', 'quote', 'price', 'pack', 'leads'] as const;
/** Checks that only produce an input feature (a failed lookup makes the feature unknown, it does not stop the run). */
export const FEATURE_CHECK_IDS = ['census', 'ext_dates', 'namebio'] as const;
/** Settings the API can never draft a change to (SEL9-2): only a migration changes them. */
export const LOCKED_PREFIXES = ['tier.p_passive', 'lead.p_lead', 'priors_v91'];
export const LANES = ['S2', 'S3', 'S4', 'S6', 'S7'] as const;
const TIERS = ['A', 'I', 'B', 'G'] as const;
const OPS = ['>=', '<=', '>', '<', '==', '!='] as const;
/** Dotted paths under which a new key may be added (a map, not a fixed object). */
const OPEN_MAPS = ['thresholds', 'tier.clauses', 'run.gates'];

const num = z.number().finite();
const nonneg = z.number().finite().nonnegative();
const int = z.number().int().nonnegative();
const share = z.number().min(0).max(1);
const action = z.enum(['PASS', 'FLAG', 'FAIL']);
const laneObj = <T extends z.ZodType>(t: T) => z.object({ S2: t, S3: t, S4: t, S6: t, S7: t }).strict();
const maxBands = z.array(z.object({ max: num.nullable(), raw: num }).strict()).min(1);
const maxCharBands = z.array(z.object({ max_chars: num.nullable(), raw: num }).strict()).min(1);
const minBands = z.array(z.object({ min: num, raw: num }).strict()).min(1);

const Cond = z.union([
  z.object({ f: z.string(), op: z.enum(OPS), v: z.union([num, z.string().regex(/^\$[A-Za-z0-9_]+$/)]) }).strict(),
  z.object({ tier: z.enum(TIERS) }).strict(),
]);
const Clause = z.union([z.object({ all: z.array(Cond).min(1) }).strict(), z.object({ any: z.array(Cond).min(1) }).strict()]);

const Base = z.object({
  thresholds: z.record(z.string().regex(/^[A-Za-z0-9_]{1,40}$/), num),
  form: z.object({
    geo_bands: maxCharBands,
    unknown_token_fails: z.boolean(),
    ambiguity_margin: nonneg,
    token_costs: z.object({ typed: nonneg, dict3: nonneg, dict2: nonneg }).strict(),
    short_max_words: int, short_max_chars: int, geo_max_words: int, geo_max_chars: int,
    geo_city_one_token: z.boolean(),
    formB_max_words: int,
    legal_terms_list: z.literal('legal'),
    /** FLAG AMBIGUOUS_SPLIT when a split has at least this many dictionary-only 2-letter tokens (animal·it·os). */
    short_token_flag_min: int,
    /** A place name that is also a dictionary word counts as a city only if it is listed here (or in the city_extra list). */
    city_word_allowlist: z.array(z.string().regex(/^[a-z]{2,40}$/)),
  }).strict(),
  typo: z.object({ max_edit_distance: int, top_n: int, max_list_age_days: int }).strict(),
  concentration: z.object({ max_per_attr: int, max_lane_share: share, lane_share_enforced: z.boolean() }).strict(),
  tranche: z.object({ size: int, min_main_lane: int, geo_max: int, required_for_buy: z.boolean() }).strict(),
  surbl: z.object({
    zone: z.string().min(3), control_name: z.string().min(3), blocked_answers: z.array(z.string()),
    list_bits: z.record(z.string().regex(/^\d+$/), z.string()), ns_override: z.array(z.string()), timeout_ms: int,
  }).strict(),
  history: z.object({
    max_fetch_per_name: int, min_ms_between_calls: int, timeout_ms: int, retries: int, min_content_chars: int,
    strong_action: action, weak_action: action, redirect_action: action, forsale_action: action, parked_action: action,
  }).strict(),
  census: z.object({ sibling_count: int.positive(), max_unknown_share: share, as_of_exact_max_days: int }).strict(),
  ext: z.object({ list: z.array(z.string().regex(/^[a-z]{2,10}$/)) }).strict(),
  tier: z.object({
    order: z.array(z.enum(TIERS)).min(1),
    clauses: z.partialRecord(z.enum(TIERS), Clause),
    demand2_pass_tiers: z.array(z.enum(TIERS)),
    p_passive: z.partialRecord(z.enum(TIERS), share),
  }).strict(),
  lead: z.object({ gate_enabled: z.boolean(), ab_min: laneObj(int), p_lead: laneObj(share) }).strict(),
  priors_v91: z.object({ p_passive: laneObj(share) }).strict(),
  money: z.object({ net_factor_afternic: share, net_factor_other: share, hold_years: int.positive() }).strict(),
  lander: z.object({ exception_ab_min: int, exception_retail_end_min: int }).strict(),
  price: z.object({
    forbidden_bands_cents: z.array(z.tuple([int, int])),
    geo_default_grade: z.enum(['strong', 'weaker']),
  }).strict(),
  score: z.object({
    weights: laneObj(z.object({ A: nonneg, B: nonneg, C: nonneg, D: nonneg, E: nonneg, F: nonneg, G: nonneg }).strict()),
    coverage_min: share, coverage_gate: z.boolean(), parked_penalty: nonneg,
    nongeo_len_bands: maxBands, words_bands: maxBands, syllable_bands: maxBands, d_bands: minBands,
    retail_only_max_points: nonneg,
    risk_raw: z.object({ clean: nonneg, flag: nonneg }).strict(),
    forbidden_feature_keys: z.array(z.string().min(1)),
  }).strict(),
  namebio: z.object({ max_cache_age_hours: int, spot_max_per_min: int, attribution: z.string() }).strict(),
  quote: z.object({ max_age_hours: int, manual_max_age_days: int }).strict(),
  web_risk: z.object({ safe_statuses: z.array(int), unsafe_statuses: z.array(int), requires_clean_history: z.boolean() }).strict(),
  freshness_hours: z.record(z.string(), int),
  evidence: z.object({ max_text_bytes: int.positive() }).strict(),
  run: z.object({
    time_budget_minutes: int.positive(), rdap_concurrency: int.positive(), rdap_min_ms_between: int,
    feature_checks: z.array(z.string()),
    gates: z.record(z.string(), z.array(z.string())),
  }).strict(),
  buy_hold: z.boolean(),
  holdout: z.object({
    sold_accept_min: share, drop_reject_min: share, min_n: int, required_suites: z.array(z.string()),
    report_bands: z.array(int), lane_report: z.boolean(), base_rates: z.array(share),
  }).strict(),
  sources: z.object({
    surbl: z.boolean(), tranco: z.boolean(), namebio: z.boolean(), wayback: z.boolean(),
    rdap_com: z.boolean(), rdap_other: z.boolean(), iana_bootstrap: z.boolean(),
  }).strict(),
}).strict();

export type SelectionValuesT = z.infer<typeof Base>;
export type ClauseT = z.infer<typeof Clause>;
export type CondT = z.infer<typeof Cond>;

const isCheckId = (v: string): boolean => (CHECK_IDS as readonly string[]).includes(v);

export const SelectionValues = Base.superRefine((v, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  const order = v.tier.order;
  if (new Set(order).size !== order.length) bad(['tier', 'order'], 'tier order must not repeat a tier');
  for (const t of order) {
    if (!v.tier.clauses[t]) bad(['tier', 'clauses', t], `tier ${t} is in order but has no clause`);
    if (v.tier.p_passive[t] === undefined) bad(['tier', 'p_passive', t], `tier ${t} has no p_passive`);
  }
  for (const t of Object.keys(v.tier.clauses)) if (!order.includes(t as (typeof TIERS)[number])) bad(['tier', 'clauses', t], `clause ${t} is not in tier order`);
  for (const t of v.tier.demand2_pass_tiers) if (!order.includes(t)) bad(['tier', 'demand2_pass_tiers'], `${t} is not in tier order`);
  for (const [name, clause] of Object.entries(v.tier.clauses) as [string, ClauseT][]) {
    const at = order.indexOf(name as (typeof TIERS)[number]);
    const conds = 'all' in clause ? clause.all : clause.any;
    conds.forEach((c, i) => {
      const path = ['tier', 'clauses', name, 'all' in clause ? 'all' : 'any', i];
      if ('tier' in c) {
        const ref = order.indexOf(c.tier);
        if (ref < 0 || ref >= at) bad(path, `{"tier":"${c.tier}"} must refer to an earlier tier than ${name}`);
        return;
      }
      if (!(TIER_FEATURES as readonly string[]).includes(c.f)) bad([...path, 'f'], `unknown tier feature "${c.f}"`);
      if (typeof c.v === 'string' && v.thresholds[c.v.slice(1)] === undefined) bad([...path, 'v'], `unknown threshold ${c.v}`);
    });
  }
  for (const [lane, w] of Object.entries(v.score.weights)) {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 1e-9) bad(['score', 'weights', lane], `weights of ${lane} must sum to 100 (they sum to ${sum})`);
  }
  if (!v.run.gates.default) bad(['run', 'gates', 'default'], 'run.gates needs a default list');
  for (const [lane, ids] of Object.entries(v.run.gates)) {
    if (lane !== 'default' && !(LANES as readonly string[]).includes(lane)) bad(['run', 'gates', lane], `unknown lane ${lane}`);
    for (const id of ids) if (!isCheckId(id)) bad(['run', 'gates', lane], `unknown check id "${id}"`);
  }
  for (const id of v.run.feature_checks) {
    if (!isCheckId(id)) bad(['run', 'feature_checks'], `unknown check id "${id}"`);
    else if (!(FEATURE_CHECK_IDS as readonly string[]).includes(id)) bad(['run', 'feature_checks'], `"${id}" is not a feature check (only ${FEATURE_CHECK_IDS.join(', ')} may be feature checks)`);
  }
  if (v.thresholds.registered_share_min === undefined) bad(['thresholds', 'registered_share_min'], 'required');
  if (v.price.forbidden_bands_cents.some(([a, b]) => a > b)) bad(['price', 'forbidden_bands_cents'], 'a band must be [low, high]');
});

/** Major cities that are also dictionary words in the committed SCOWL list (chicago, tulsa, phoenix). From the CR-001 reference lex.py, minus names that are mostly common words (mobile, bend, mesa, buffalo ...). */
const MAJOR_CITY_WORDS = `
akron albany albuquerque amarillo anaheim anchorage arlington asheville atlanta austin bakersfield baltimore
berlin billings birmingham boise boston brisbane brooklyn burbank charleston charlotte chattanooga chesapeake
cheyenne chicago cincinnati cleveland columbia columbus dallas dayton denver detroit dublin durham edmonton
eugene evansville fargo fayetteville fremont fresno gilbert glendale greensboro hartford henderson hollywood
houston huntsville indianapolis irvine irving jackson jacksonville knoxville lansing laredo lexington lincoln
london louisville lubbock madison malibu manchester manhattan melbourne memphis miami milwaukee minneapolis
modesto montgomery montreal napa naples nashville newark norfolk oakland olympia omaha ontario orlando ottawa
oxnard paris pasadena peoria perth philadelphia phoenix pittsburgh plano portland raleigh richmond riverside
rochester rockford sacramento salem sarasota savannah scottsdale seattle shreveport spokane springfield
stockton syracuse tacoma tallahassee tampa toledo topeka toronto tucson tulsa vancouver washington wichita
worcester yonkers
`.trim().split(/\s+/);

export const DEFAULT_SELECTION_VALUES: SelectionValuesT = {
  thresholds: { registered_share_min: 0.5, registered_share_min_B: 0.6, form_B_max_words: 2, alt_tld_before_min: 1 },
  form: {
    geo_bands: [{ max_chars: 12, raw: 10 }, { max_chars: 16, raw: 7 }, { max_chars: 20, raw: 4 }, { max_chars: null, raw: 1 }],
    unknown_token_fails: true, ambiguity_margin: 2, token_costs: { typed: 1, dict3: 2, dict2: 3 },
    short_max_words: 2, short_max_chars: 12, geo_max_words: 2, geo_max_chars: 16, geo_city_one_token: true,
    formB_max_words: 2, legal_terms_list: 'legal', short_token_flag_min: 2, city_word_allowlist: MAJOR_CITY_WORDS,
  },
  typo: { max_edit_distance: 1, top_n: 10000, max_list_age_days: 7 },
  concentration: { max_per_attr: 2, max_lane_share: 0.4, lane_share_enforced: false },
  tranche: { size: 15, min_main_lane: 10, geo_max: 3, required_for_buy: true },
  surbl: { zone: 'multi.surbl.org', control_name: 'test.surbl.org', blocked_answers: ['127.0.0.1'], list_bits: { '8': 'PH', '16': 'MW', '64': 'ABUSE', '128': 'CR' }, ns_override: [], timeout_ms: 3000 },
  history: {
    max_fetch_per_name: 6, min_ms_between_calls: 1000, timeout_ms: 20000, retries: 1, min_content_chars: 200,
    strong_action: 'FAIL', weak_action: 'FLAG', redirect_action: 'FLAG', forsale_action: 'PASS', parked_action: 'PASS',
  },
  census: { sibling_count: 20, max_unknown_share: 0.25, as_of_exact_max_days: 365 },
  ext: { list: ['net', 'org', 'co', 'io', 'ai', 'info', 'us'] },
  tier: {
    order: ['A', 'I', 'B', 'G'],
    clauses: {
      A: { all: [{ f: 'registered_share', op: '>=', v: '$registered_share_min' }, { f: 'prior_history', op: '==', v: 1 }] },
      I: { any: [{ tier: 'A' }, { f: 'alt_tld_before_n', op: '>=', v: '$alt_tld_before_min' }] },
      B: { all: [{ f: 'registered_share', op: '>=', v: '$registered_share_min_B' }, { f: 'n_words', op: '<=', v: '$form_B_max_words' }] },
      G: { all: [{ f: 'is_geo', op: '==', v: 1 }, { f: 'gform1_pass', op: '==', v: 1 }] },
    },
    demand2_pass_tiers: ['I', 'B', 'G'],
    p_passive: { A: 0.02, I: 0.02, B: 0.01, G: 0.01 },
  },
  lead: {
    gate_enabled: false,
    ab_min: { S2: 8, S3: 5, S4: 5, S6: 5, S7: 5 },
    p_lead: { S2: 0.005, S3: 0.002, S4: 0.002, S6: 0.003, S7: 0.002 },
  },
  priors_v91: { p_passive: { S2: 0.005, S3: 0.004, S4: 0.004, S6: 0.005, S7: 0.004 } },
  money: { net_factor_afternic: 0.85, net_factor_other: 0.75, hold_years: 2 },
  lander: { exception_ab_min: 30, exception_retail_end_min: 20 },
  price: { forbidden_bands_cents: [[80000, 99900], [195000, 199900]], geo_default_grade: 'strong' },
  score: {
    weights: {
      S2: { A: 15, B: 30, C: 5, D: 10, E: 10, F: 5, G: 25 },
      S3: { A: 15, B: 20, C: 15, D: 10, E: 25, F: 10, G: 5 },
      S4: { A: 15, B: 20, C: 15, D: 10, E: 25, F: 10, G: 5 },
      S6: { A: 15, B: 25, C: 10, D: 10, E: 20, F: 5, G: 15 },
      S7: { A: 10, B: 20, C: 5, D: 15, E: 10, F: 5, G: 35 },
    },
    coverage_min: 0.7, coverage_gate: false, parked_penalty: 0,
    nongeo_len_bands: [{ max: 8, raw: 10 }, { max: 12, raw: 7 }, { max: 16, raw: 4 }, { max: null, raw: 1 }],
    words_bands: [{ max: 1, raw: 10 }, { max: 2, raw: 8 }, { max: 3, raw: 5 }, { max: null, raw: 2 }],
    syllable_bands: [{ max: 3, raw: 10 }, { max: 5, raw: 7 }, { max: 7, raw: 4 }, { max: null, raw: 1 }],
    d_bands: [{ min: 30, raw: 9 }, { min: 10, raw: 6 }, { min: 0, raw: 2 }],
    retail_only_max_points: 10,
    risk_raw: { clean: 10, flag: 5 },
    forbidden_feature_keys: ['govalue_usd', 'estibot_value', 'humbleworth_usd', 'alexa_rank', 'appraisal_usd'],
  },
  namebio: { max_cache_age_hours: 48, spot_max_per_min: 4, attribution: 'Data from NameBio' },
  quote: { max_age_hours: 24, manual_max_age_days: 30 },
  web_risk: { safe_statuses: [1, 6], unsafe_statuses: [2, 3], requires_clean_history: true },
  freshness_hours: { availability: 1, surbl: 24, typo: 24, history: 168, census: 720, ext_dates: 168, namebio: 24, quote: 24, web_risk: 168, tm_us: 168 },
  evidence: { max_text_bytes: 32768 },
  run: {
    time_budget_minutes: 30, rdap_concurrency: 2, rdap_min_ms_between: 250,
    feature_checks: ['census', 'ext_dates', 'namebio'],
    gates: {
      default: ['form', 'brand_lists', 'typo', 'availability', 'concentration', 'surbl', 'web_risk', 'history', 'tm_us', 'census', 'ext_dates', 'tier', 'namebio', 'quote', 'price'],
      S2: ['form', 'brand_lists', 'typo', 'availability', 'concentration', 'surbl', 'web_risk', 'history', 'tm_us', 'tier', 'namebio', 'quote', 'price'],
    },
  },
  buy_hold: true,
  holdout: { sold_accept_min: 0.7, drop_reject_min: 0.75, min_n: 50, required_suites: ['BT10-1', 'BT10-9', 'BT10-11'], report_bands: [1000, 2500], lane_report: true, base_rates: [0.01, 0.02] },
  // Enabled only where docs/internal/sources.md recorded the terms as enabled (Task 1); NameBio is off (unreadable terms).
  sources: { surbl: true, tranco: true, namebio: false, wayback: true, rdap_com: true, rdap_other: true, iana_bootstrap: true },
};

// ---------- database ----------

export interface ActiveSettings { id: number; label: string; values: SelectionValuesT; activatedAt: Date }
export interface SettingsVersion { id: number; label: string; values: SelectionValuesT; createdAt: Date; createdBy: string; basedOn: string | null; note: string | null; active: boolean; activatedAt: Date | null; approvalText: string | null }

export type HoldoutCheck = (db: Kysely<Database>, settingsId: number, values: SelectionValuesT) => Promise<{ pass: boolean; suites: unknown[] }>;
/** Task 9 replaces this with the CAP-21a holdout report; until then the hold can never be cleared. */
export const noHoldoutYet: HoldoutCheck = async () => ({ pass: false, suites: [] });

type Row = Selectable<SelectionSettingsTable>;
const parse = (raw: unknown, label: string): SelectionValuesT => {
  const r = SelectionValues.safeParse(raw);
  if (!r.success) throw new AppError(500, 'SELECTION_SETTINGS_INVALID', `Stored selection settings ${label} no longer validate`, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
};

export async function activeSelectionSettings(db: Kysely<Database>): Promise<ActiveSettings> {
  const r = await db.selectFrom('selection_settings').selectAll().where('activation_seq', 'is not', null).orderBy('activation_seq', 'desc').limit(1).executeTakeFirst();
  if (!r) throw new AppError(500, 'SELECTION_SETTINGS_MISSING', 'No selection settings version is active');
  return { id: r.id, label: r.label, values: parse(r.values, r.label), activatedAt: r.activated_at! };
}

async function activeId(db: Kysely<Database>): Promise<number | null> {
  const r = await db.selectFrom('selection_settings').select('id').where('activation_seq', 'is not', null).orderBy('activation_seq', 'desc').limit(1).executeTakeFirst();
  return r?.id ?? null;
}

async function toVersion(db: Kysely<Database>, r: Row, activeIdValue: number | null): Promise<SettingsVersion> {
  const based = r.based_on_id === null ? null : (await db.selectFrom('selection_settings').select('label').where('id', '=', r.based_on_id).executeTakeFirst())?.label ?? null;
  return {
    id: r.id, label: r.label, values: parse(r.values, r.label), createdAt: r.created_at, createdBy: r.created_by, basedOn: based, note: r.note,
    active: r.id === activeIdValue, activatedAt: r.activated_at, approvalText: r.activation_approval_text,
  };
}

export async function selectionSettingsByLabel(db: Kysely<Database>, label: string): Promise<SettingsVersion | null> {
  const r = await db.selectFrom('selection_settings').selectAll().where('label', '=', label).executeTakeFirst();
  return r ? toVersion(db, r, await activeId(db)) : null;
}

export async function listSelectionVersions(db: Kysely<Database>): Promise<Omit<SettingsVersion, 'values'>[]> {
  const rows = await db.selectFrom('selection_settings').selectAll().orderBy('id').execute();
  const act = await activeId(db);
  const byId = new Map(rows.map((r) => [r.id, r.label]));
  return rows.map((r) => ({
    id: r.id, label: r.label, createdAt: r.created_at, createdBy: r.created_by, basedOn: r.based_on_id === null ? null : byId.get(r.based_on_id) ?? null,
    note: r.note, active: r.id === act, activatedAt: r.activated_at, approvalText: r.activation_approval_text,
  }));
}

// ---------- drafts ----------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

export function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (isObj(cur)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/** Applies one dotted-path assignment to a copy of `doc`. A path must already exist, except a new key in an open map. */
function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: unknown = doc;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    const here = segs.slice(0, i).join('.');
    if (Array.isArray(cur)) {
      const idx = /^\d+$/.test(seg) ? Number(seg) : -1;
      if (idx < 0 || idx >= cur.length) throw new AppError(422, 'SETTINGS_KEY_UNKNOWN', `Unknown settings path: ${path}`, { path });
      if (last) cur[idx] = value;
      else cur = cur[idx];
    } else if (isObj(cur)) {
      if (!(seg in cur) && !OPEN_MAPS.includes(here)) throw new AppError(422, 'SETTINGS_KEY_UNKNOWN', `Unknown settings path: ${path}`, { path });
      if (last) cur[seg] = value;
      else cur = cur[seg];
    } else throw new AppError(422, 'SETTINGS_KEY_UNKNOWN', `Unknown settings path: ${path}`, { path });
  }
}

export const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function applySet(base: SelectionValuesT, set: Record<string, unknown>): SelectionValuesT {
  const doc = clone(base) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(set)) setPath(doc, path, clone(value));
  const r = SelectionValues.safeParse(doc);
  if (!r.success) {
    throw new AppError(422, 'SETTINGS_INVALID', 'The resulting settings are not valid', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  for (const prefix of LOCKED_PREFIXES) {
    if (!deepEqual(getPath(r.data, prefix), getPath(base, prefix))) {
      throw new AppError(422, 'SETTINGS_KEY_LOCKED', `${prefix} is locked: priors change only by migration (SEL9-2)`, { path: prefix });
    }
  }
  return r.data;
}

export async function createDraft(
  db: Kysely<Database>,
  i: { label: string; basedOn?: string; set: Record<string, unknown>; note?: string; createdBy: string; auditId: string },
): Promise<{ label: string; values: SelectionValuesT; basedOn: string }> {
  return db.transaction().execute(async (trx) => {
    const base = i.basedOn === undefined
      ? await activeSelectionSettings(trx).then(async (a) => (await selectionSettingsByLabel(trx, a.label))!)
      : await selectionSettingsByLabel(trx, i.basedOn);
    if (!base) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${i.basedOn}"`);
    const values = applySet(base.values, i.set);
    // Equal to a non-active base is allowed: it is how an older version is brought back (a new label, then activated).
    if (deepEqual(values, base.values) && base.active) throw new AppError(422, 'SETTINGS_NO_CHANGE', 'The draft is identical to the active version');
    try {
      await trx.insertInto('selection_settings').values({
        label: i.label, values: JSON.stringify(values), based_on_id: base.id, note: i.note ?? null, created_by: i.createdBy, audit_id: i.auditId,
      }).execute();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'SETTINGS_LABEL_TAKEN', `Label "${i.label}" is already used`);
      throw e;
    }
    return { label: i.label, values, basedOn: base.label };
  });
}

export async function activate(
  db: Kysely<Database>,
  i: { label: string; approvalRef: unknown; now: Date; createdBy: string; auditId: string; holdoutCheck: HoldoutCheck },
): Promise<{ label: string; activatedAt: Date }> {
  const limits = await db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
  const ref = isObj(i.approvalRef) ? i.approvalRef : null;
  if (i.approvalRef === undefined || i.approvalRef === null) throw new AppError(422, 'APPROVAL_REQUIRED', "Activating selection settings needs approval_ref (Dvir's words)");
  const a = checkTimedApproval(ref, i.now, limits.approval_max_age_hours);
  if (!a.ok) throw new AppError(422, a.code, a.reason);
  const approvalText = String((ref as { text: string }).text);

  return db.transaction().execute(async (trx) => {
    // The latest activation row is the lock: two concurrent activations run one after the other.
    const cur = await trx.selectFrom('selection_settings').selectAll().where('activation_seq', 'is not', null).orderBy('activation_seq', 'desc').limit(1).forUpdate().executeTakeFirst();
    const target = await trx.selectFrom('selection_settings').selectAll().where('label', '=', i.label).forUpdate().executeTakeFirst();
    if (!target) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${i.label}"`);
    if (cur && cur.id === target.id) throw new AppError(409, 'SETTINGS_ALREADY_ACTIVE', `"${i.label}" is already the active version`);
    if (target.activation_seq !== null) {
      throw new AppError(409, 'SETTINGS_ALREADY_ACTIVATED', `"${i.label}" was activated before; draft a new version based on it to bring it back`);
    }
    const values = parse(target.values, target.label);
    if (cur && parse(cur.values, cur.label).buy_hold && !values.buy_hold) {
      const h = await i.holdoutCheck(trx, target.id, values);
      if (!h.pass) throw new AppError(409, 'HOLDOUT_NOT_PASSED', 'buy_hold can be cleared only when every required holdout suite passes', { suites: h.suites });
    }
    const seq = (cur?.activation_seq ?? 0) + 1;
    await trx.updateTable('selection_settings').set({
      activation_seq: seq, activated_at: i.now, activation_approval_text: approvalText, activation_approval_at: a.approvedAt,
      activated_by: i.createdBy, activation_audit_id: i.auditId,
    }).where('id', '=', target.id).execute();
    return { label: i.label, activatedAt: i.now };
  });
}
