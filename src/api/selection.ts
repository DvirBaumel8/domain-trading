// Selection settings (CAP-00), versioned lists, and the pure tier + money evaluation (CAP-24, CAP-18).
// Settings drafts and list edits are WRITE; activation and census-list freezing need Dvir's approval_ref.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { dollarsToCents, formatUsd } from '../money.js';
import { currentSettings } from '../pricing/settings.js';
import { checkTimedApproval } from '../services/approval.js';
import { isCensusListName, isFixedList, listVersion, writeList, FIXED_LISTS } from '../screening/lists.js';
import { evaluateMoney, syllableCount } from '../screening/money.js';
import {
  LABEL_RE, LANES, activate, activeSelectionSettings, createDraft, listSelectionVersions, noHoldoutYet, selectionSettingsByLabel,
  type HoldoutCheck, type SelectionValuesT,
} from '../screening/settings.js';
import { evaluateTier, type TierFeatures } from '../screening/tier.js';

export interface SelectionDeps { db: Kysely<Database>; now: () => number; holdoutCheck?: HoldoutCheck }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const Approval = z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict();

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
  const holdoutCheck = deps.holdoutCheck ?? noHoldoutYet;

  async function requireApproval(ref: unknown, what: string): Promise<void> {
    if (ref === undefined || ref === null) throw new AppError(422, 'APPROVAL_REQUIRED', `${what} needs approval_ref (Dvir's words)`);
    const lim = await db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
    const a = checkTimedApproval(ref as { text?: unknown; approved_at?: unknown }, now(), lim.approval_max_age_hours);
    if (!a.ok) throw new AppError(422, a.code, a.reason);
  }

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

  app.post<{ Params: { name: string } }>('/selection/lists/:name', async (req, reply) => {
    const body = ListBody.parse(req.body ?? {});
    const { name } = req.params;
    if (!isFixedList(name) && !isCensusListName(name)) {
      throw new AppError(422, 'LIST_NAME_INVALID', 'Unknown list name', { name, fixed: FIXED_LISTS, census: 'bt1_<sld> or s6_regime_audit' });
    }
    // A census list is frozen per name and version; Gavriel authors it, Dvir approves it (CR-001 §2, ruling R3).
    if (isCensusListName(name)) await requireApproval(body.approval_ref, 'Freezing a census list');
    const active = await activeSelectionSettings(db);
    const r = await writeList(db, name, { replace: body.replace, add: body.add, remove: body.remove, note: body.note }, {
      createdBy: req.auth!.name, auditId: req.auditId!, settings: active.values,
    });
    return reply.code(201).send(r);
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
}
