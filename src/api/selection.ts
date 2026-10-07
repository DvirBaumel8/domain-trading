// Selection settings (CAP-00), versioned lists, and the pure tier + money evaluation (CAP-24, CAP-18).
// Settings drafts and list edits are WRITE; activation and census-list freezing need Dvir's approval_ref.
import { advisoryXactLock } from '../core/locks.js';
import { approvalRefObject } from '../core/validation.js';
import { ymd } from '../core/dates.js';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { memberHashOf } from '../screening/test-sets.js';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { dollarsToCents, formatUsd } from '../core/money.js';
import { currentSettings } from '../pricing/settings.js';
import { requireNamedApproval } from '../screening/approval.js';
import { namesToken } from '../services/approval.js';
import { isCensusListName, isFixedList, listVersion, writeList, FIXED_LISTS } from '../screening/lists.js';
import { keywordCounts } from '../screening/namebio.js';
import { evaluateMoney, syllableCount } from '../screening/money.js';
import {
  LABEL_RE, LANES, activate, deepEqual, activeSelectionSettings, createDraft, listSelectionVersions, selectionSettingsByLabel,
  type HoldoutCheck, type SelectionValuesT,
} from '../screening/settings.js';
import { approveMethod, methodApproval, methodSha, methodSplitSha, splitOfDomain } from '../screening/sibling-methods.js';
import { KNOWN_METHODS, isKnownMethod, loadPools, siblingsBt1, usesSplitV2 } from '../screening/siblings.js';
import { splitV2OfDomain } from '../screening/split-v2.js';
import { buyHoldSteps } from '../screening/hold-steps.js';
import { evaluateTier, type TierFeatures } from '../screening/tier.js';
import {
  GATE_KEYS, cell, csvToUploadRow, decideHoldoutRow, decideReplayRow, gateContext, holdoutCheck as replayHoldoutCheck, laneOf, leakageLint, missingGates,
  holdSuites, parseCsv, profitReport, reportOf, rpl, suiteStatuses, toLabelledRow, type Entry, type GateKey, type LabelledRow,
} from '../screening/replay.js';

export interface SelectionDeps { db: Kysely<Database>; now: () => number; holdoutCheck?: HoldoutCheck }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const Approval = approvalRefObject;

const DraftBody = z.object({
  label: z.string().regex(LABEL_RE, 'label must match ^[a-z0-9][a-z0-9._-]{0,31}$'),
  based_on: z.string().optional(),
  set: z.record(z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'a dotted settings path'), z.unknown()).refine((o) => Object.keys(o).length >= 1, 'set needs at least one path'),
  note: z.string().max(500).optional(),
}).strict();
const ActivateBody = z.object({ approval_ref: Approval.nullable().optional() }).strict();
const Terms = z.array(z.string().max(120));
const ListBody = z.object({ replace: Terms.optional(), add: Terms.optional(), remove: Terms.optional(), note: z.string().max(500).optional(), approval_ref: Approval.nullable().optional() }).strict();

const usd = z.number().positive().refine((n) => { try { dollarsToCents(n); return true; } catch { return false; } }, 'a positive USD amount with at most 2 decimals');
const bit = z.union([z.literal(0), z.literal(1)]);
const EvalBody = z.object({
  lane: z.enum(LANES),
  features: z.object({
    registered_share: z.number().min(0).max(1).nullable().optional(), prior_history: bit.nullable().optional(),
    alt_tld_before_n: z.number().int().nonnegative().nullable().optional(), n_words: z.number().int().nonnegative().nullable().optional(),
    sld_chars: z.number().int().nonnegative().nullable().optional(), is_geo: bit.optional(),
    gform1_pass: bit.nullable().optional(), short: bit.nullable().optional(),
  }).strict(),
  domain: z.string().optional(),
  bin_usd: usd.optional(),
  price_grade: z.enum(['strong', 'weaker']).optional(),
  leads_ab: z.number().int().nonnegative(),
  first_year_usd: usd.optional(), renewal_usd: usd.optional(),
  lander_ns: z.enum(['afternic', 'other']).optional(),
  retail_start: z.number().int().nonnegative().nullable().optional(), retail_end: z.number().int().nonnegative().nullable().optional(),
  form: z.object({
    geo_band_raw: z.number().min(0).max(10).nullable().optional(), sld_len: z.number().int().positive(), word_count: z.number().int().positive(),
    short: bit, syllables: z.number().int().positive().nullable().optional(),
  }).strict().optional(),
  risk_flag: z.boolean().optional(),
  intent_raw: z.number().min(0).max(10).nullable().optional(), timing_raw: z.number().min(0).max(10).nullable().optional(),
  parked_only: z.boolean().optional(),
  settings: z.string().regex(LABEL_RE).optional(),
}).strict();

const gateRes = z.object({ result: z.enum(['PASS', 'FAIL', 'FLAG', 'UNKNOWN']), source: z.string().min(1).max(200), date: ymd }).strict();
const UploadRow = z.object({
  domain: z.string().min(1).max(253),
  role: z.enum(['fit', 'dev', 'test']),
  label: z.enum(['sold', 'dropped']),
  source: z.string().min(1).max(120),
  slice: z.string().min(1).max(60),
  report_lane: z.enum(['expired', 'fresh', 'aged', 'geo']).optional(),
  price_usd: usd.optional(),
  as_of: ymd.nullable().optional(),
  features: z.object({
    registered_share: z.number().min(0).max(1).nullable().optional(), prior_history: bit.nullable().optional(), pre_cls: z.string().max(40).nullable().optional(),
    alt_tld_before_n: z.number().int().nonnegative().nullable().optional(), n_words: z.number().int().nonnegative().nullable().optional(),
    sld_chars: z.number().int().nonnegative().nullable().optional(), is_geo: bit.optional(), city_trade_ok: z.boolean().nullable().optional(), short: bit.nullable().optional(),
    geo_city: z.string().max(60).nullable().optional(), geo_trade: z.string().max(60).nullable().optional(), archive_span_years: z.number().nonnegative().nullable().optional(),
    input_dates: z.record(z.string().min(1).max(40), ymd).optional(),
    gates: z.object({ tm_us: gateRes.optional(), tn: gateRes.optional(), hist2: gateRes.optional(), hist2_guard: gateRes.optional() }).strict().optional(),
  }).strict(),
}).strict();

/** Case-insensitive search for a forbidden gate-feature key anywhere in the raw body (SEL5-2). */
function findForbidden(v: unknown, keys: Set<string>, path = ''): string | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const r = findForbidden(v[i], keys, `${path}[${i}]`); if (r) return r; }
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const here = path ? `${path}.${k}` : k;
      if (keys.has(k.toLowerCase())) return here;
      const r = findForbidden(x, keys, here);
      if (r) return r;
    }
  }
  return null;
}

export function registerSelection(app: FastifyInstance, deps: SelectionDeps): void {
  const { db } = deps;
  const now = () => new Date(deps.now());
  const holdoutCheck = deps.holdoutCheck ?? replayHoldoutCheck;

  app.get('/selection/settings', async (req) => {
    const q = z.object({ label: z.string().optional() }).strict().safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: only label is accepted');
    if (q.data.label !== undefined) {
      const v = await selectionSettingsByLabel(db, q.data.label);
      if (!v) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${q.data.label}"`);
      return {
        label: v.label, values: v.values, created_at: iso(v.createdAt), created_by: v.createdBy, based_on: v.basedOn, note: v.note,
        active: v.active, activated_at: iso(v.activatedAt), approval_text: v.approvalText,
      };
    }
    const a = await activeSelectionSettings(db);
    const versions = await listSelectionVersions(db);
    const act = versions.find((v) => v.active)!;
    return {
      active: { label: a.label, values: a.values, activated_at: iso(a.activatedAt), approval_text: act.approvalText },
      versions: versions.map((v) => ({ label: v.label, created_at: iso(v.createdAt), created_by: v.createdBy, based_on: v.basedOn, active: v.active })),
    };
  });

  app.post('/selection/settings', async (req, reply) => {
    const body = DraftBody.parse(req.body ?? {});
    const r = await createDraft(db, { label: body.label, basedOn: body.based_on, set: body.set, note: body.note, createdBy: req.auth!.name, auditId: req.auditId! });
    return reply.code(201).send({ label: r.label, values: r.values, based_on: r.basedOn });
  });

  app.post<{ Params: { label: string } }>('/selection/settings/:label/activate', async (req) => {
    const body = ActivateBody.parse(req.body ?? {});
    const r = await activate(db, {
      label: req.params.label, approvalRef: body.approval_ref, now: now(), createdBy: req.auth!.name, auditId: req.auditId!, holdoutCheck,
    });
    return { active: r.label, activated_at: r.activatedAt.toISOString() };
  });

  const listName = (name: string) => {
    if (!isFixedList(name) && !isCensusListName(name)) throw new AppError(404, 'LIST_NOT_FOUND', `No list named "${name}"`);
  };

  app.get<{ Params: { name: string } }>('/selection/lists/:name', async (req) => {
    const q = z.object({ version: z.coerce.number().int().min(1).optional() }).strict().safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'version must be a whole number of at least 1');
    listName(req.params.name);
    const r = await listVersion(db, req.params.name, q.data.version);
    if (!r) throw new AppError(404, 'LIST_NOT_FOUND', `No list "${req.params.name}"${q.data.version ? ` version ${q.data.version}` : ''}`);
    return { name: r.name, version: r.version, terms: r.terms, created_at: iso(r.created_at), created_by: r.created_by };
  });

  // NameBio keyword counts from the nightly cache only: this route never calls NameBio (CAP-11 #4, SEL9-13).
  app.get('/selection/namebio', async (req) => {
    const q = z.object({ keywords: z.string() }).strict().safeParse(req.query);
    const kws = q.success ? [...new Set(q.data.keywords.split(',').map((k) => k.trim().toLowerCase()).filter((k) => k !== ''))] : [];
    if (!q.success || kws.length < 1 || kws.length > 50 || kws.some((k) => !/^[a-z0-9-]{1,60}$/.test(k))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'keywords must be 1 to 50 comma-separated words (letters, digits, hyphen)');
    }
    const sel = (await activeSelectionSettings(db)).values;
    const attribution = sel.namebio.attribution;
    if (!sel.sources.namebio) {
      return { cache_date: null, data_as_of: null, source: 'nightly_csv', attribution, stale: true, status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED', keywords: Object.fromEntries(kws.map((k) => [k, null])) };
    }
    const r = await keywordCounts(db, kws, sel, deps.now);
    const keywords = Object.fromEntries(kws.map((k) => { const x = r.stats[k] ?? null; return [k, x && { start_count: x.start_count, end_count: x.end_count, exact_count: x.exact_count }]; }));
    const base = { cache_date: r.cache_date, data_as_of: r.cache_date, source: r.source, attribution: r.attribution, keywords };
    return r.cache_date === null || r.stale ? { ...base, stale: true, status: 'UNKNOWN', reason_code: 'STALE_DATA' } : { ...base, stale: false };
  });

  app.post<{ Params: { name: string } }>('/selection/lists/:name', async (req, reply) => {
    const body = ListBody.parse(req.body ?? {});
    const { name } = req.params;
    if (!isFixedList(name) && !isCensusListName(name)) {
      throw new AppError(422, 'LIST_NAME_INVALID', 'Unknown list name', { name, fixed: FIXED_LISTS, census: 'bt1_<sld> or s6_regime_audit' });
    }
    // A census list is frozen per name and version; Gavriel authors it, Dvir approves it (CR-001 §2, ruling R3).
    let approvalText: string | undefined;
    if (isCensusListName(name)) {
      const target = name.startsWith('bt1_') ? [`${name.slice(4)}.com`, name.slice(4)] : [];
      approvalText = (await requireNamedApproval(db, body.approval_ref, now(), 'Freezing a census list', [name, ...target])).text;
    }
    const active = await activeSelectionSettings(db);
    const r = await writeList(db, name, { replace: body.replace, add: body.add, remove: body.remove, note: body.note }, {
      createdBy: req.auth!.name, auditId: req.auditId!, settings: active.values, approvalText,
    });
    return reply.code(201).send(r);
  });

  // CR-008 C-2: the frozen sibling method (read: pools, approval, siblings for a name or a split; approve: Dvir's line naming the version).
  const MethodQuery = z.object({ domain: z.string().min(1).max(253).optional(), tokens: z.string().min(1).max(300).optional() }).strict();
  app.get<{ Params: { method: string } }>('/selection/sibling-methods/:method', async (req) => {
    const method = req.params.method;
    if (!isKnownMethod(method)) throw new AppError(404, 'SIBLING_METHOD_NOT_FOUND', `No sibling method "${method}"`, { known: Object.keys(KNOWN_METHODS) });
    const q = MethodQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: only domain or tokens is accepted');
    if (q.data.domain !== undefined && q.data.tokens !== undefined) throw new AppError(400, 'VALIDATION_ERROR', 'Send domain or tokens, not both');
    let tokens: string[] | null = null;
    if (q.data.tokens !== undefined) {
      tokens = q.data.tokens.split(',');
      if (tokens.length < 2 || tokens.some((t) => !/^[a-z]{1,40}$/.test(t))) throw new AppError(400, 'VALIDATION_ERROR', 'tokens must be at least 2 comma-separated lower-case words (letters only)');
    } else if (q.data.domain !== undefined) {
      tokens = usesSplitV2(method) ? splitV2OfDomain(normalizeDomain(q.data.domain), method) : (await splitOfDomain(db, q.data.domain, (await activeSelectionSettings(db)).values)).tokens;
    }
    const pools = loadPools(method);
    const ap = await methodApproval(db, method);
    const list = tokens === null ? null : siblingsBt1(tokens, pools);
    return {
      method, pools_sha256: methodSha(method), split_sha256: methodSplitSha(method), pools, approved: ap !== null, approval_text: ap?.text ?? null, approved_at: ap ? ap.approvedAt.toISOString() : null,
      ...(tokens !== null && { siblings: { tokens, list: list!, size: list!.length } }),
    };
  });

  app.post<{ Params: { method: string } }>('/selection/sibling-methods/:method/approve', async (req, reply) => {
    const body = z.object({ approval_ref: Approval.nullable().optional() }).strict().parse(req.body ?? {});
    const a = await approveMethod(db, req.params.method, body.approval_ref, now(), { createdBy: req.auth!.name, auditId: req.auditId! });
    return reply.code(201).send({ method: req.params.method, approved: true, approval_text: a.text, approved_at: a.approvedAt.toISOString() });
  });

  app.post('/selection/evaluate', async (req) => {
    const raw = req.body ?? {};
    const wanted = typeof (raw as { settings?: unknown }).settings === 'string' ? (raw as { settings: string }).settings : undefined;
    const active = await activeSelectionSettings(db);
    const target = wanted === undefined || wanted === active.label ? null : await selectionSettingsByLabel(db, wanted);
    if (wanted !== undefined && wanted !== active.label && !target) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${wanted}"`);
    const forbidden = new Set([...active.values.score.forbidden_feature_keys, ...(target?.values.score.forbidden_feature_keys ?? [])].map((k) => k.toLowerCase()));
    const hit = findForbidden(raw, forbidden);
    if (hit) throw new AppError(422, 'FORBIDDEN_FEATURE', 'Appraisal and traffic-rank values are not allowed as gate features (SEL5-2)', { path: hit });
    const b = EvalBody.parse(raw);

    const sel: SelectionValuesT = target ? target.values : active.values;
    const label = target ? target.label : active.label;
    const pricing = await currentSettings(db, now());
    const warnings: string[] = [];
    if (pricing.allowedBinsCents === null) warnings.push('PRICING_V3_MISSING');

    const geo = b.lane === 'S2';
    const grade = geo ? (b.price_grade ?? sel.price.geo_default_grade) : null;
    let binCents: number;
    if (b.bin_usd !== undefined) binCents = dollarsToCents(b.bin_usd);
    else if (geo) binCents = grade === 'strong' ? pricing.geoBinStrongCents : pricing.geoBinWeakerCents;
    else if (pricing.nongeoDefaultBinCents !== null) binCents = pricing.nongeoDefaultBinCents;
    else throw new AppError(422, 'BIN_REQUIRED', 'No bin_usd was sent and the current pricing settings have no default non-geo BIN');

    let sld: string | null = null;
    if (b.domain !== undefined) sld = normalizeDomain(b.domain).slice(0, -'.com'.length);
    const f = b.features;
    const features: TierFeatures = {
      registered_share: f.registered_share ?? null, prior_history: f.prior_history ?? null, alt_tld_before_n: f.alt_tld_before_n ?? null,
      n_words: f.n_words ?? null, sld_chars: f.sld_chars ?? null, is_geo: f.is_geo ?? (geo ? 1 : 0), gform1_pass: f.gform1_pass ?? null, short: f.short ?? null,
    };
    const tier = evaluateTier(features, sel.tier, sel.thresholds);

    const syl = (v: number | null | undefined): number | null => v ?? (sld ? syllableCount(sld) : null);
    const form = b.form
      ? { geoBandRaw: b.form.geo_band_raw ?? null, sldLen: b.form.sld_len, wordCount: b.form.word_count, short: b.form.short, syllables: syl(b.form.syllables) }
      : features.sld_chars !== null && features.n_words !== null
        ? { geoBandRaw: null, sldLen: features.sld_chars, wordCount: features.n_words, short: (features.short ?? 0) as 0 | 1, syllables: syl(null) }
        : null;

    const money = evaluateMoney({
      lane: b.lane, tier: tier.tier, binCents, priceGrade: grade, leadsAB: b.leads_ab,
      firstYearCents: b.first_year_usd === undefined ? null : dollarsToCents(b.first_year_usd),
      renewalCents: b.renewal_usd === undefined ? null : dollarsToCents(b.renewal_usd),
      landerNs: b.lander_ns ?? 'afternic', retailEnd: b.retail_end ?? null, retailStart: b.retail_start ?? null, form,
      riskFlag: b.risk_flag ?? false, intentRaw: b.intent_raw ?? null, timingRaw: b.timing_raw ?? null, extBusinessRaw: null, parkedOnly: b.parked_only,
    }, sel, pricing, label);

    return {
      settings_version: label,
      backtest: target !== null,
      pricing_version: pricing.version,
      bin_cents: binCents,
      tier,
      money: {
        ...money,
        display: {
          bin: formatUsd(binCents), floor: formatUsd(money.floor_cents), net_price: formatUsd(money.net_price_cents),
          lifetime_cost: money.lifetime_cost_cents === null ? null : formatUsd(money.lifetime_cost_cents),
          ev: money.ev_cents === null ? null : formatUsd(money.ev_cents),
        },
      },
      warnings,
    };
  });

  // ---------- CAP-21a: name registry, replay, buy-hold report ----------

  // 200 rows with gate results exceed the 64 KB default body limit.
  app.post('/selection/labelled-names', { bodyLimit: 1024 * 1024 }, async (req) => {
    const raw = (req.body ?? {}) as { rows?: unknown; csv?: unknown };
    let rowsIn: unknown[];
    if (typeof raw.csv === 'string' && raw.rows === undefined) {
      try { rowsIn = parseCsv(raw.csv).map(csvToUploadRow); } catch { throw new AppError(422, 'VALIDATION_ERROR', 'csv could not be read'); }
    } else if (Array.isArray(raw.rows) && raw.csv === undefined) rowsIn = raw.rows;
    else throw new AppError(422, 'VALIDATION_ERROR', 'Send either rows (JSON) or csv (text), not both');
    if (rowsIn.length < 1 || rowsIn.length > 200) throw new AppError(422, 'VALIDATION_ERROR', 'Send 1 to 200 rows per call');
    const bad: { index: number; domain: string | null; message: string }[] = [];
    const parsed: { row: z.infer<typeof UploadRow>; domain: string }[] = [];
    rowsIn.forEach((r, index) => {
      const p = UploadRow.safeParse(r);
      const d = (r as { domain?: unknown })?.domain;
      if (!p.success) { bad.push({ index, domain: typeof d === 'string' ? d : null, message: p.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ') }); return; }
      try { parsed.push({ row: p.data, domain: normalizeDomain(p.data.domain) }); } catch (e) { bad.push({ index, domain: p.data.domain, message: e instanceof AppError ? e.message : 'invalid domain' }); }
    });
    if (bad.length > 0) throw new AppError(422, 'ROWS_INVALID', 'Some rows are invalid; nothing was recorded', { rows: bad });

    const toDb = ({ row, domain }: (typeof parsed)[number]) => ({
      domain, role: row.role, label: row.label, source: row.source, slice: row.slice, report_lane: row.report_lane ?? null,
      price_cents: row.price_usd === undefined ? null : dollarsToCents(row.price_usd), as_of: row.as_of ?? null, features: row.features,
    });
    return db.transaction().execute(async (trx) => {
      let inserted = 0;
      let duplicates = 0;
      const conflicts: { domain: string; existing_role: string }[] = [];
      const seen = new Map<string, ReturnType<typeof toDb>>();
      const existing = new Map((await trx.selectFrom('labelled_names').selectAll().where('domain', 'in', parsed.map((p) => p.domain)).execute()).map((e) => [e.domain, e]));
      for (const p of parsed) {
        const v = toDb(p);
        const have = seen.get(v.domain) ?? existing.get(v.domain);
        if (have) {
          const same = have.role === v.role && have.label === v.label && have.source === v.source && have.slice === v.slice && have.report_lane === v.report_lane &&
            have.price_cents === v.price_cents && have.as_of === v.as_of && deepEqual(have.features, v.features);
          if (same) duplicates++; else conflicts.push({ domain: v.domain, existing_role: have.role });
          continue;
        }
        seen.set(v.domain, v);
        try {
          await trx.insertInto('labelled_names').values({ ...v, features: JSON.stringify(v.features), created_by: req.auth!.name, audit_id: req.auditId! }).execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError(409, 'LABELLED_NAME_CONFLICT', `${v.domain} was recorded by a concurrent upload; retry to see it as a duplicate or a conflict`, { domain: v.domain });
          throw e;
        }
        inserted++;
      }
      return { inserted, duplicates, conflicts };
    });
  });

  const SuiteBody = z.object({
    suite: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/),
    slices: z.array(z.string().min(1)).min(1).optional(),
    sources: z.array(z.string().min(1)).min(1).optional(),
    cell: z.string().regex(/^(pooled|lane:(expired|fresh|aged|geo))$/).default('pooled'),
    gates_not_assessed: z.array(z.enum(GATE_KEYS)).refine((a) => new Set(a).size === a.length, 'no gate twice').default([]),
    clears_hold: z.boolean().default(false),
    approval_ref: Approval.nullable().optional(),
  }).strict().refine((b) => b.slices !== undefined || b.sources !== undefined, 'a suite needs slices and/or sources');

  // A suite is frozen BEFORE any holdout scoring: which names it scores and which cell is judged. Versioned, append-only.
  app.post('/selection/holdout-suites', async (req, reply) => {
    const b = SuiteBody.parse(req.body ?? {});
    const approval = await requireNamedApproval(db, b.approval_ref, now(), 'Freezing a holdout suite', [b.suite]);
    // v2.5.0: the approval must also name every gate the suite leaves out, and say "clears hold" when the suite clears buy_hold.
    const missingGatesNamed = b.gates_not_assessed.filter((g) => !namesToken(approval.text, g));
    const missingPhrase = b.clears_hold && !/clears hold/i.test(approval.text);
    if (missingGatesNamed.length > 0 || missingPhrase) {
      throw new AppError(422, 'APPROVAL_INVALID', 'approval_ref.text must name every gate in gates_not_assessed and, for clears_hold, contain "clears hold"', {
        ...(missingGatesNamed.length > 0 && { gates_not_named: missingGatesNamed }), ...(missingPhrase && { missing_phrase: 'clears hold' }),
      });
    }
    const row = await db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, 'holdout_suites');
      // No definition shopping: once any holdout replay of the suite exists its definition is final.
      const scored = await trx.selectFrom('replay_runs').select('id').where('suite', '=', b.suite).where('mode', '=', 'holdout').limit(1).executeTakeFirst();
      if (scored) throw new AppError(409, 'SUITE_ALREADY_SCORED', `${b.suite} already has a holdout replay (${scored.id}); its definition can no longer change`, { replay_id: scored.id });
      const mine = await selectionOf(trx, b);
      if (mine.domains.length === 0) throw new AppError(422, 'SUITE_EMPTY', 'The selection contains no test names');
      const laneRows = b.cell === 'pooled' ? mine.rows : mine.rows.filter((r) => laneOf(r) === b.cell.slice('lane:'.length));
      if (!laneRows.some((r) => r.label === 'sold') || !laneRows.some((r) => r.label === 'dropped')) {
        throw new AppError(422, 'SUITE_EMPTY', `The judged cell ${b.cell} needs at least one sold and one dropped test name`, { sold: laneRows.filter((r) => r.label === 'sold').length, dropped: laneRows.filter((r) => r.label === 'dropped').length });
      }
      // Suites are disjoint: no name may be scored by two suites (against each other suite's latest frozen definition, on today's registry).
      const mineSet = new Set(mine.domains);
      const others = [...new Set((await trx.selectFrom('holdout_suites').select('suite').where('suite', '<>', b.suite).execute()).map((x) => x.suite))];
      for (const other of others) {
        const od = await trx.selectFrom('holdout_suites').selectAll().where('suite', '=', other).orderBy('version', 'desc').limit(1).executeTakeFirst();
        if (!od) continue;
        const shared = (await selectionOf(trx, { slices: od.slices ?? undefined, sources: od.sources ?? undefined })).domains.filter((d) => mineSet.has(d));
        if (shared.length > 0) throw new AppError(409, 'SUITE_OVERLAP', `${b.suite} shares ${shared.length} name(s) with ${other}; suites must be disjoint`, { other_suite: other, count: shared.length, examples: shared.slice(0, 5) });
      }
      const last = await trx.selectFrom('holdout_suites').select('version').where('suite', '=', b.suite).orderBy('version', 'desc').limit(1).executeTakeFirst();
      return trx.insertInto('holdout_suites').values({
        suite: b.suite, version: (last?.version ?? 0) + 1, slices: b.slices ?? null, sources: b.sources ?? null, cell: b.cell,
        member_hash: memberHashOf(mine.domains), member_count: mine.domains.length, gates_not_assessed: b.gates_not_assessed, clears_hold: b.clears_hold,
        created_by: req.auth!.name, approval_text: approval.text, approval_at: approval.approvedAt, audit_id: req.auditId!,
      }).returningAll().executeTakeFirstOrThrow();
    });
    return reply.code(201).send(suiteView(row));
  });

  /** The registered names a suite selects by slice/source (any role); `domains` is the sorted test-row subset that is scored. */
  const selectionOf = async (conn: Kysely<Database>, sel: { slices?: string[]; sources?: string[] }) => {
    let q = conn.selectFrom('labelled_names').selectAll().orderBy('domain');
    if (sel.slices) q = q.where('slice', 'in', sel.slices);
    if (sel.sources) q = q.where('source', 'in', sel.sources);
    const all = (await q.execute()).map(toLabelledRow);
    const rows = all.filter((r) => r.role === 'test');
    return { all, rows, domains: rows.map((r) => r.domain) };
  };

  const suiteView = (r: { suite: string; version: number; slices: string[] | null; sources: string[] | null; member_hash: string; member_count: number; cell: string; created_at: Date; created_by: string; approval_text: string; gates_not_assessed?: string[] | null; clears_hold?: boolean | null }) => ({
    suite: r.suite, version: r.version, slices: r.slices, sources: r.sources, member_hash: r.member_hash, member_count: r.member_count, cell: r.cell,
    gates_not_assessed: r.gates_not_assessed ?? [], clears_hold: r.clears_hold ?? false, created_at: r.created_at.toISOString(), created_by: r.created_by, approval_text: r.approval_text,
  });

  app.get('/selection/holdout-suites', async () => {
    const rows = await db.selectFrom('holdout_suites').selectAll().orderBy('suite').orderBy('version').execute();
    return { suites: rows.map(suiteView) };
  });

  const latestSuite = (suite: string) => db.selectFrom('holdout_suites').selectAll().where('suite', '=', suite).orderBy('version', 'desc').limit(1).executeTakeFirst();

  const ReplayBody = z.object({
    suite: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
    mode: z.enum(['diagnostic', 'holdout']),
    settings: z.string().regex(LABEL_RE).optional(),
    slices: z.array(z.string().min(1)).min(1).optional(),
    sources: z.array(z.string().min(1)).min(1).optional(),
    roles: z.array(z.enum(['fit', 'dev', 'test'])).min(1).optional(),
    domains: z.array(z.string()).min(1).max(5000).optional(),
    profit: z.boolean().optional(),
  }).strict();

  app.post('/selection/replays', async (req, reply) => {
    const b = ReplayBody.parse(req.body ?? {});
    if (b.mode === 'holdout' && (b.slices || b.sources || b.roles || b.domains || b.profit !== undefined)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'A holdout replay takes only suite, mode and settings: the frozen suite definition selects the names');
    }
    const active = await activeSelectionSettings(db);
    const ver = b.settings === undefined || b.settings === active.label ? await selectionSettingsByLabel(db, active.label) : await selectionSettingsByLabel(db, b.settings);
    if (!ver) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${b.settings}"`);
    const sel = ver.values;
    let def: Awaited<ReturnType<typeof latestSuite>> = undefined;
    let q = db.selectFrom('labelled_names').selectAll().orderBy('domain');
    let filter: Record<string, unknown>;
    if (b.mode === 'holdout') {
      // v2.5.0: a suite is valid when it has a frozen definition. Without one: a required suite is SUITE_NOT_DEFINED, any other id SUITE_UNKNOWN.
      def = await latestSuite(b.suite);
      if (!def) {
        if (!active.values.holdout.required_suites.includes(b.suite)) {
          throw new AppError(422, 'SUITE_UNKNOWN', `${b.suite} has no frozen definition and is not one of holdout.required_suites`, { required_suites: active.values.holdout.required_suites });
        }
        throw new AppError(422, 'SUITE_NOT_DEFINED', `Suite ${b.suite} has no frozen definition; freeze it (POST /selection/holdout-suites) before any holdout scoring`);
      }
      if (def.slices) q = q.where('slice', 'in', def.slices);
      if (def.sources) q = q.where('source', 'in', def.sources);
      filter = { suite_version: def.version, slices: def.slices, sources: def.sources, cell: def.cell, gates_not_assessed: def.gates_not_assessed ?? [], clears_hold: def.clears_hold ?? false };
    } else {
      const domains = b.domains?.map((d) => normalizeDomain(d));
      if (b.slices) q = q.where('slice', 'in', b.slices);
      if (b.sources) q = q.where('source', 'in', b.sources);
      if (b.roles) q = q.where('role', 'in', b.roles);
      if (domains) q = q.where('domain', 'in', domains);
      filter = { slices: b.slices ?? null, sources: b.sources ?? null, roles: b.roles ?? null, domains: domains ?? null, profit: b.profit ?? false };
    }
    const rows: LabelledRow[] = (await q.execute()).map(toLabelledRow);
    if (rows.length === 0) throw new AppError(422, 'REPLAY_EMPTY', 'No registered name matches the filters');
    // Checked on the whole selection before anything else: fit and dev names never enter a holdout, and test names are never peeked at.
    if (b.mode === 'holdout') {
      const tainted = rows.filter((r) => r.role !== 'test').map((r) => r.domain);
      if (tainted.length > 0) {
        throw new AppError(422, 'HOLDOUT_CONTAMINATED', 'A holdout suite may select only names registered as test; these are fit or dev names (CR-002 CAP-21)', { domains: tainted.slice(0, 50), count: tainted.length });
      }
    } else {
      const peeked = rows.filter((r) => r.role === 'test').map((r) => r.domain);
      if (peeked.length > 0) {
        throw new AppError(422, 'HOLDOUT_CONTAMINATED', 'Test rows are scored only by holdout replays', { domains: peeked.slice(0, 50), count: peeked.length });
      }
    }

    if (b.mode === 'holdout' && def) {
      const domains = rows.map((r) => r.domain);
      if (domains.length !== def.member_count || memberHashOf(domains) !== def.member_hash) {
        throw new AppError(409, 'SUITE_MEMBERSHIP_CHANGED', `The names ${b.suite} selects are not the names frozen with its definition; nothing was scored`, { frozen_count: def.member_count, current_count: domains.length });
      }
    }

    let entries: Entry[];
    let before: Entry[] | null = null;
    let gatesApplied = false;
    let notAssessed: GateKey[] = [];
    if (b.mode === 'holdout') {
      const noAsOf = rows.filter((r) => !r.as_of).map((r) => r.domain);
      if (noAsOf.length > 0) throw new AppError(422, 'AS_OF_REQUIRED', 'A holdout replay needs an as_of for every name', { domains: noAsOf.slice(0, 50), count: noAsOf.length });
      notAssessed = (def?.gates_not_assessed ?? []) as GateKey[];
      const miss = missingGates(rows, notAssessed);
      if (miss.length > 0) {
        throw new AppError(422, 'REPLAY_INVALID_NO_GATES', 'A holdout replay needs TM-1, TN-1 and HIST-2 + guard results (with source and date) and an input date for every dated feature, on every row (except the gates the suite leaves out)', { required: [...GATE_KEYS.filter((k) => !notAssessed.includes(k)), 'input_dates.census', 'input_dates.ext_dates', 'input_dates.history'], rows: miss.slice(0, 20), count: miss.length });
      }
      const first = await db.selectFrom('replay_runs').select('created_at').where('suite', '=', b.suite).where('mode', '=', 'holdout').orderBy('created_at').limit(1).executeTakeFirst();
      if (first && ver.createdAt > first.created_at) {
        throw new AppError(409, 'VARIANT_NOT_PREREGISTERED', `Settings "${ver.label}" were created after the first holdout replay of ${b.suite}; variants must be recorded before test slices are scored`, { suite: b.suite, settings: ver.label });
      }
      const ctx = await gateContext(db, sel);
      const outs = rows.map((r) => decideHoldoutRow(r, sel, ctx, notAssessed));
      entries = outs.map((o) => ({ row: o.row, d: o.after, lane: o.lane }));
      before = outs.map((o) => ({ row: o.row, d: o.before, lane: o.lane }));
      gatesApplied = true;
    } else {
      entries = rows.map((row) => ({ row, d: decideReplayRow(row.features, sel).decision, lane: laneOf(row) }));
    }
    const lint = leakageLint(rows);
    const rep = reportOf(entries, sel);
    const cellName = def ? def.cell : 'pooled';
    const judged = cellName === 'pooled' ? rep.pooled : rep.by_lane[cellName.slice('lane:'.length)] ?? cell([], sel.holdout);
    const report: Record<string, unknown> = {
      mode: b.mode, gates_applied: gatesApplied, counts_toward_buy_hold: b.mode === 'holdout',
      ...rep, judged_cell: cellName, judged,
      ...(b.mode === 'holdout' && {
        gates_not_assessed: notAssessed,
        // Accepted rows of the judged cell (sold accepted + dropped accepted) that a gate left out could still have turned into rejects.
        accepts_at_risk: notAssessed.length === 0 ? 0 : judged.sold.accepted + judged.dropped.accepted,
      }),
      ...(before && { before_gates: { pooled: cell(before.map((e) => ({ label: e.row.label, d: e.d })), sel.holdout) } }),
      leakage_lint: lint,
    };
    if (b.profit) report.profit = profitReport(entries, sel);
    const pass = b.mode === 'holdout' && judged.meets_thresholds && lint.rows_leaking === 0 && lint.rows_without_dated_inputs === 0;
    const id = rpl();
    await db.insertInto('replay_runs').values({
      id, suite: b.suite, mode: b.mode, settings_id: (await db.selectFrom('selection_settings').select('id').where('label', '=', ver.label).executeTakeFirstOrThrow()).id,
      settings_label: ver.label, suite_def_id: def?.id ?? null, filter: JSON.stringify(filter), report: JSON.stringify(report), leakage_rows: lint.rows_leaking, pass, created_by: req.auth!.name, audit_id: req.auditId!,
    }).execute();
    return reply.code(201).send({ replay_id: id, suite: b.suite, mode: b.mode, settings_version: ver.label, gates_applied: gatesApplied, report, pass });
  });

  app.get<{ Params: { id: string } }>('/selection/replays/:id', async (req) => {
    const r = await db.selectFrom('replay_runs').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!r) throw new AppError(404, 'REPLAY_NOT_FOUND', `No replay ${req.params.id}`);
    return {
      replay_id: r.id, suite: r.suite, mode: r.mode, settings_version: r.settings_label, filter: r.filter, report: r.report, leakage_rows: r.leakage_rows,
      pass: r.pass, created_at: r.created_at.toISOString(), created_by: r.created_by,
    };
  });

  app.get('/selection/buy-hold', async (req) => {
    const q = z.object({ settings: z.string().regex(LABEL_RE).optional() }).strict().safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: only settings is accepted');
    const active = await activeSelectionSettings(db);
    const target = q.data.settings === undefined || q.data.settings === active.label ? null : await selectionSettingsByLabel(db, q.data.settings);
    if (q.data.settings !== undefined && q.data.settings !== active.label && !target) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${q.data.settings}"`);
    const label = target ? target.label : active.label;
    const id = (await db.selectFrom('selection_settings').select('id').where('label', '=', label).executeTakeFirstOrThrow()).id;
    // The ACTIVE version's holdout settings judge every version (they are locked, so equal in all of them).
    const suites = await suiteStatuses(db, id, active.values.holdout);
    const hold = await holdSuites(db, active.values.holdout);
    const targetValues = target ? target.values : active.values;
    // Clearable only for a version that actually clears the hold (its own buy_hold is false).
    return { buy_hold: active.values.buy_hold, settings_version: label, target_buy_hold: targetValues.buy_hold, required_suites: suites, hold_suites: hold.suites, hold_suites_source: hold.source, clearable: !targetValues.buy_hold && suites.length > 0 && suites.every((x) => x.pass), ...(await buyHoldSteps(db, active)) };
  });
}
