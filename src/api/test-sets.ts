// v2.5.0 (CR-007 §21): test sets. POST /selection/test-sets (purpose new | rescore), GET /selection/test-sets/{name}, POST .../seal.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { dollarsToCents } from '../money.js';
import { HEARTBEAT_STALE_MS, createRun, type ScreeningWorker } from '../screening/engine.js';
import { analyzeForm } from '../screening/form.js';
import { gateContext, toLabelledRow } from '../screening/replay.js';
import { LABEL_RE, activeSelectionSettings, selectionSettingsByLabel } from '../screening/settings.js';
import { methodApproval } from '../screening/sibling-methods.js';
import {
  LEGACY_TEST_SET_METHOD, TEST_SET_CHECKS, TEST_SET_DEFAULT_MAX_ANSWER_AGE_DAYS, TEST_SET_DEFAULT_METHOD, TEST_SET_LANE, TEST_SET_METHODS, TEST_SET_RUN_HOURS, dayBefore, featuresOfRun, memberHashOf, midnightJerusalem, rescoreReport, splitRoles,
} from '../screening/test-sets.js';
import type { LabelledFeatures } from '../screening/replay.js';
import type { InputName } from '../screening/engine.js';
import { toJerusalemIso } from '../time.js';

export interface TestSetsDeps { db: Kysely<Database>; now: () => number; worker: ScreeningWorker }

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'a calendar date');
const usd = z.number().positive().refine((n) => { try { dollarsToCents(n); return true; } catch { return false; } }, 'a positive USD amount with at most 2 decimals');
const NAME = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

const SourceRow = z.object({
  domain: z.string().min(1).max(253),
  label: z.enum(['sold', 'dropped']),
  as_of: ymd,
  source: z.string().min(1).max(120),
  price_usd: usd.optional(),
  report_lane: z.enum(['expired', 'fresh', 'aged', 'geo']).optional(),
}).strict();
const Filters = z.object({
  min_words: z.number().int().min(1).optional(), max_words: z.number().int().min(1).optional(), max_chars: z.number().int().min(1).optional(),
  exclude_geo: z.boolean().default(true), min_price_usd: z.number().positive().optional(), as_of_from: ymd.optional(), as_of_to: ymd.optional(),
}).strict();
const AnswerAge = z.number().int().min(0).max(30).default(TEST_SET_DEFAULT_MAX_ANSWER_AGE_DAYS);
const NewBody = z.object({
  name: z.string().regex(NAME), purpose: z.literal('new'), sibling_method: z.enum(TEST_SET_METHODS).default(TEST_SET_DEFAULT_METHOD), seed: z.string().min(1).max(64),
  test_share: z.number().gt(0).lt(1).default(0.5), max_answer_age_days: AnswerAge, filters: Filters.default({ exclude_geo: true }),
  rows: z.array(SourceRow).min(1).max(2000),
}).strict();
const RescoreBody = z.object({
  name: z.string().regex(NAME), purpose: z.literal('rescore'), slices: z.array(z.string().min(1).max(60)).min(1).max(20), settings: z.string().regex(LABEL_RE).optional(),
  sibling_method: z.enum(TEST_SET_METHODS).default(TEST_SET_DEFAULT_METHOD), features_as_of: z.enum(['row', 'now']).default('row'), max_answer_age_days: AnswerAge,
}).strict();
const Body = z.discriminatedUnion('purpose', [NewBody, RescoreBody]);

interface Stored { domain: string; label: 'sold' | 'dropped'; as_of: string; source: string; price_usd: number | null; report_lane: 'expired' | 'fresh' | 'aged' | 'geo' | null; role: 'test' | 'dev' | null; kept: boolean; reason: string | null }

export function registerTestSets(app: FastifyInstance, deps: TestSetsDeps): void {
  const { db, worker } = deps;
  const now = () => new Date(deps.now());

  /** The run finished (done or partial): the set is `ready`. Computed lazily here; only `computing` moves, never back. */
  const refresh = async (conn: Kysely<Database>, set: { name: string; status: string; run_id: string }): Promise<{ status: string; run: NonNullable<Awaited<ReturnType<typeof loadRun>>> }> => {
    const run = (await loadRun(conn, set.run_id))!;
    if (run.status === 'running' && (!run.heartbeat_at || deps.now() - run.heartbeat_at.getTime() > HEARTBEAT_STALE_MS)) worker.kick(run.id);
    let status = set.status;
    if (status === 'computing' && run.status !== 'running') {
      await conn.updateTable('test_sets').set({ status: 'ready' }).where('name', '=', set.name).where('status', '=', 'computing').execute();
      status = 'ready';
    }
    return { status, run };
  };
  const loadRun = (conn: Kysely<Database>, id: string) => conn.selectFrom('screening_runs').selectAll().where('id', '=', id).executeTakeFirst();

  const requireMethod = async (method: string) => {
    if (!(await methodApproval(db, method))) {
      throw new AppError(409, 'SIBLING_METHOD_NOT_APPROVED', `Sibling method ${method} has no approval recorded (POST /selection/sibling-methods/${method}/approve)`, { method });
    }
  };

  app.post('/selection/test-sets', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    // A new set registers labelled names, so its method must be approved; a rescore registers nothing and may use an unapproved method (v2.6.0).
    if (b.purpose === 'new') await requireMethod(b.sibling_method);
    if (await db.selectFrom('test_sets').select('name').where('name', '=', b.name).executeTakeFirst()) {
      throw new AppError(409, 'TEST_SET_NAME_TAKEN', `A test set named ${b.name} exists`, { name: b.name });
    }
    const active = await activeSelectionSettings(db);
    let stored: Stored[];
    let settingsLabel = active.label;
    let seed: string | null = null;
    let share: number | null = null;
    let filters: object = {};

    if (b.purpose === 'new') {
      const today = toJerusalemIso(now()).slice(0, 10);
      const future = b.rows.filter((r) => r.as_of > today).map((r) => r.domain);
      if (future.length > 0) throw new AppError(422, 'VALIDATION_ERROR', 'as_of must not be in the future', { examples: future.slice(0, 10), count: future.length });
      seed = b.seed; share = b.test_share; filters = b.filters;
      const f = b.filters;
      const ctx = await gateContext(db, active.values);
      const valid: (string | null)[] = b.rows.map((r) => { try { const d = normalizeDomain(r.domain); return d === r.domain ? d : null; } catch { return null; } });
      const have = new Set<string>();
      const cand = [...new Set(valid.filter((d): d is string => d !== null))];
      if (cand.length > 0) {
        for (const x of await db.selectFrom('labelled_names').select('domain').where('domain', 'in', cand).execute()) have.add(x.domain);
        for (const x of await db.selectFrom('test_set_rows').select('domain').where('kept', '=', true).where('domain', 'in', cand).execute()) have.add(x.domain);
      }
      const seen = new Set<string>();
      stored = b.rows.map((r, i): Stored => {
        const base = { domain: r.domain, label: r.label, as_of: r.as_of, source: r.source, price_usd: r.price_usd ?? null, report_lane: r.report_lane ?? null, role: null, kept: false };
        const drop = (reason: string): Stored => ({ ...base, reason });
        const d = valid[i];
        if (d === null || d === undefined) return drop('DOMAIN_INVALID');
        if (seen.has(d)) return drop('DUPLICATE_IN_UPLOAD');
        seen.add(d);
        if (have.has(d)) return drop('ALREADY_REGISTERED');
        const form = analyzeForm(d, TEST_SET_LANE, ctx.lexicon, active.values.form);
        const geo = form.city !== null && form.trade !== null;
        if (form.has_digit || form.has_hyphen || (f.min_words !== undefined && form.word_count < f.min_words) || (f.max_words !== undefined && form.word_count > f.max_words) ||
          (f.max_chars !== undefined && form.sld_len > f.max_chars) || (f.exclude_geo && geo)) return drop('FORM_FILTER');
        if (f.min_price_usd !== undefined && r.label === 'sold' && (r.price_usd === undefined || r.price_usd < f.min_price_usd)) return drop('PRICE_BELOW_MIN');
        if ((f.as_of_from !== undefined && r.as_of < f.as_of_from) || (f.as_of_to !== undefined && r.as_of > f.as_of_to)) return drop('OUTSIDE_WINDOW');
        return { ...base, kept: true, reason: null };
      });
      const kept = stored.filter((s) => s.kept);
      if (kept.length === 0) throw new AppError(422, 'TEST_SET_EMPTY', 'No row is left after the removals; nothing was stored', { removed_n: stored.length, reasons: countBy(stored.map((s) => s.reason!)) });
      const roles = splitRoles(kept.map((k) => k.domain), b.seed, b.test_share);
      for (const k of kept) k.role = roles.get(k.domain)!;
    } else {
      if (b.settings !== undefined) {
        const v = await selectionSettingsByLabel(db, b.settings);
        if (!v) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${b.settings}"`);
        settingsLabel = v.label;
      }
      const rows = (await db.selectFrom('labelled_names').selectAll().where('slice', 'in', b.slices).orderBy('domain').execute()).map(toLabelledRow);
      if (rows.length === 0) throw new AppError(422, 'TEST_SET_EMPTY', 'No registered name is in these slices; nothing was stored', { slices: b.slices });
      const test = rows.filter((r) => r.role === 'test').map((r) => r.domain);
      if (test.length > 0) throw new AppError(422, 'HOLDOUT_CONTAMINATED', 'Test names are never rescored', { domains: test.slice(0, 20), count: test.length });
      const noAsOf = rows.filter((r) => !r.as_of).map((r) => r.domain);
      if (noAsOf.length > 0) throw new AppError(422, 'AS_OF_REQUIRED', 'A rescore needs an as_of for every name', { domains: noAsOf.slice(0, 20), count: noAsOf.length });
      stored = rows.map((r) => ({
        domain: r.domain, label: r.label, as_of: r.as_of!, source: r.source, price_usd: r.price_cents === null ? null : r.price_cents / 100, report_lane: r.report_lane, role: null, kept: true, reason: null,
      }));
    }

    const kept = stored.filter((s) => s.kept);
    // features_as_of 'now': every item is as of the creation instant (the run then reads registration as of today's registry).
    const createdAt = now();
    const asOfNow = b.purpose === 'rescore' && b.features_as_of === 'now';
    const names: InputName[] = kept.map((k) => ({ domain: k.domain, lane: TEST_SET_LANE, census_list: b.sibling_method, as_of: asOfNow ? createdAt.toISOString() : midnightJerusalem(k.as_of) }));
    const run = await createRun(db, { mode: 'full', checks: TEST_SET_CHECKS, names, ...(b.purpose === 'rescore' && b.settings !== undefined && { settings: b.settings }) },
      { createdBy: req.auth!.name, auditId: req.auditId!, now: createdAt, deadlineHours: TEST_SET_RUN_HOURS, allowUnapprovedMethod: b.purpose === 'rescore', testSet: { maxAnswerAgeDays: b.max_answer_age_days, asOfIsNow: asOfNow } }, worker.checks);
    try {
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('test_sets').values({
          name: b.name, purpose: b.purpose, settings_label: settingsLabel, seed, test_share: share === null ? null : String(share), filters: JSON.stringify(filters),
          run_id: run.id, created_at: createdAt, created_by: req.auth!.name, status: 'computing',
          sibling_method: b.sibling_method, features_as_of: b.purpose === 'rescore' ? b.features_as_of : null, max_answer_age_days: b.max_answer_age_days,
        }).execute();
        for (let i = 0; i < stored.length; i += 500) {
          await trx.insertInto('test_set_rows').values(stored.slice(i, i + 500).map((s) => ({
            set_name: b.name, domain: s.domain, label: s.label, as_of: s.as_of, source: s.source, price_usd: s.price_usd === null ? null : String(s.price_usd),
            report_lane: s.report_lane, role: s.role, kept: s.kept, reason: s.reason,
          }))).execute();
        }
      });
    } catch (e) {
      if ((e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'test_sets_pkey') {
        await db.updateTable('screening_runs').set({ status: 'partial', finished_at: now() }).where('id', '=', run.id).execute();
        throw new AppError(409, 'TEST_SET_NAME_TAKEN', `A test set named ${b.name} exists`, { name: b.name });
      }
      throw e;
    }
    worker.kick(run.id);
    return reply.code(202).send({
      name: b.name, purpose: b.purpose, sibling_method: b.sibling_method, max_answer_age_days: b.max_answer_age_days, status: 'computing', run_id: run.id, kept_n: kept.length, removed_n: stored.length - kept.length,
      test_n: kept.filter((k) => k.role === 'test').length, dev_n: kept.filter((k) => k.role === 'dev').length, poll: `/selection/test-sets/${b.name}`,
    });
  });

  app.get<{ Params: { name: string } }>('/selection/test-sets/:name', async (req) => {
    const set = await db.selectFrom('test_sets').selectAll().where('name', '=', req.params.name).executeTakeFirst();
    if (!set) throw new AppError(404, 'TEST_SET_NOT_FOUND', `No test set "${req.params.name}"`);
    const { status, run } = await refresh(db, set);
    const rows = await db.selectFrom('test_set_rows').select(['domain', 'label', 'role', 'kept', 'reason']).where('set_name', '=', set.name).orderBy('id').execute();
    const kept = rows.filter((r) => r.kept);
    const feats = await featuresOfRun(db, run);
    const finished = run.status !== 'running';
    let report: unknown = null;
    if (set.purpose === 'rescore' && finished) {
      const sel = (await selectionSettingsByLabel(db, set.settings_label!))!;
      const labelled = (await db.selectFrom('labelled_names').selectAll().where('domain', 'in', kept.map((k) => k.domain)).execute()).map(toLabelledRow);
      report = rescoreReport(labelled, feats.byDomain, sel.label, sel.values, { features_as_of: set.features_as_of ?? 'row', sibling_method: set.sibling_method ?? LEGACY_TEST_SET_METHOD });
    }
    return {
      name: set.name, purpose: set.purpose, sibling_method: set.sibling_method ?? LEGACY_TEST_SET_METHOD, ...(set.purpose === 'rescore' && { features_as_of: set.features_as_of ?? 'row' }), status, max_answer_age_days: set.max_answer_age_days ?? TEST_SET_DEFAULT_MAX_ANSWER_AGE_DAYS, settings_version: set.settings_label, seed: set.seed, test_share: set.test_share === null ? null : Number(set.test_share),
      filters: set.filters, created_at: set.created_at.toISOString(),
      kept_n: kept.length, removed_n: rows.length - kept.length, test_n: kept.filter((r) => r.role === 'test').length, dev_n: kept.filter((r) => r.role === 'dev').length,
      removed: rows.filter((r) => !r.kept).map((r) => ({ domain: r.domain, reason: r.reason })),
      run: { id: run.id, status: run.status, names_n: feats.names_n, done_n: feats.done_n },
      lookups: feats.lookups,
      timing: { started_at: toJerusalemIso(set.created_at), finished_at: run.finished_at ? toJerusalemIso(run.finished_at) : null, minutes: run.finished_at ? Math.round((run.finished_at.getTime() - set.created_at.getTime()) / 600) / 100 : null },
      features: finished ? { census_known_n: [...feats.byDomain.values()].filter((f) => f.registered_share !== null).length, alt_known_n: [...feats.byDomain.values()].filter((f) => f.alt_tld_before_n !== null).length } : null,
      sealed_at: set.sealed_at ? set.sealed_at.toISOString() : null, member_count: set.member_count, member_hash: set.member_hash, report,
    };
  });

  app.post<{ Params: { name: string } }>('/selection/test-sets/:name/seal', async (req, reply) => {
    z.object({}).strict().parse(req.body ?? {});
    const out = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('test_sets_seal'))`.execute(trx);
      const set = await trx.selectFrom('test_sets').selectAll().where('name', '=', req.params.name).forUpdate().executeTakeFirst();
      if (!set) throw new AppError(404, 'TEST_SET_NOT_FOUND', `No test set "${req.params.name}"`);
      if (set.purpose !== 'new') throw new AppError(409, 'TEST_SET_NOT_SEALABLE', 'Only a test set with purpose new can be sealed; a rescore set registers nothing');
      if (set.status === 'sealed') throw new AppError(409, 'TEST_SET_ALREADY_SEALED', `${set.name} is already sealed`, { sealed_at: set.sealed_at!.toISOString() });
      const { status, run } = await refresh(trx, set);
      if (status !== 'ready') throw new AppError(409, 'TEST_SET_NOT_READY', 'The back-test run has not finished; poll GET /selection/test-sets/' + set.name, { run_id: run.id, run_status: run.status });
      const rows = (await trx.selectFrom('test_set_rows').selectAll().where('set_name', '=', set.name).where('kept', '=', true).orderBy('id').execute());
      const taken = await trx.selectFrom('labelled_names').select(['domain', 'role']).where('domain', 'in', rows.map((r) => r.domain)).execute();
      if (taken.length > 0) {
        throw new AppError(409, 'LABELLED_NAME_CONFLICT', `${taken.length} name(s) of this set were registered since it was made; nothing was registered`, { domains: taken.slice(0, 20).map((t) => t.domain), count: taken.length });
      }
      const { byDomain } = await featuresOfRun(trx, run);
      for (const r of rows) {
        const f = byDomain.get(r.domain)!;
        const input_dates: Record<string, string> = {};
        if (f.registered_share !== null) input_dates.census = dayBefore(r.as_of);
        if (f.alt_tld_before_n !== null) input_dates.ext_dates = dayBefore(r.as_of);
        const features: LabelledFeatures = {
          registered_share: f.registered_share, alt_tld_before_n: f.alt_tld_before_n, n_words: f.n_words, sld_chars: f.sld_chars, is_geo: f.is_geo, input_dates,
        };
        try {
          await trx.insertInto('labelled_names').values({
            domain: r.domain, role: r.role!, label: r.label, source: r.source, slice: set.name, report_lane: r.report_lane,
            price_cents: r.price_usd === null ? null : dollarsToCents(Number(r.price_usd)), as_of: r.as_of, features: JSON.stringify(features),
            created_by: req.auth!.name, audit_id: req.auditId!,
          }).execute();
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError(409, 'LABELLED_NAME_CONFLICT', `${r.domain} was registered by a concurrent call; nothing was registered`, { domain: r.domain });
          throw e;
        }
      }
      const testDomains = rows.filter((r) => r.role === 'test').map((r) => r.domain);
      const hash = memberHashOf(testDomains);
      const upd = await trx.updateTable('test_sets').set({ status: 'sealed', sealed_at: now(), member_count: testDomains.length, member_hash: hash })
        .where('name', '=', set.name).where('status', '=', 'ready').executeTakeFirst();
      if (Number(upd.numUpdatedRows) !== 1) throw new AppError(409, 'TEST_SET_NOT_READY', 'The test set is not ready');
      return { name: set.name, status: 'sealed' as const, registered_n: rows.length, test_n: testDomains.length, dev_n: rows.length - testDomains.length, member_count: testDomains.length, member_hash: hash };
    });
    return reply.code(201).send(out);
  });
}

function countBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}
