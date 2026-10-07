// v2.8.0 (CR-007 §22, G-1): cohorts, the forward test. POST /selection/cohorts, GET /selection/cohorts/{name}, GET /selection/cohorts/report.
// A cohort starts a feature run exactly like a test-set rescore with features_as_of 'now' (a research measurement: it registers nothing in the name registry).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { COHORT_OPEN_DAYS, cohortReport, freezeCohortIfReady, latestOutcomes } from '../drops/cohorts.js';
import { DROP_LIST_NAME_RE, namesDroppingBetween, todayIdt } from '../drops/drop-lists.js';
import { AppError } from '../http/errors.js';
import { HEARTBEAT_STALE_MS, createRun, type InputName, type ScreeningWorker } from '../screening/engine.js';
import { LABEL_RE, selectionSettingsByLabel } from '../screening/settings.js';
import { TEST_SET_CHECKS, TEST_SET_DEFAULT_MAX_ANSWER_AGE_DAYS, TEST_SET_DEFAULT_METHOD, TEST_SET_LANE, TEST_SET_METHODS, TEST_SET_RUN_HOURS, splitKey } from '../screening/test-sets.js';
import { normalizeDomain } from '../domain-name.js';
import { toJerusalemIso } from '../time.js';
import { parseWindow, ymd } from './drop-lists.js';

export interface CohortsDeps { db: Kysely<Database>; now: () => number; worker: ScreeningWorker }

const NameRow = z.object({ domain: z.string().min(1).max(253), expected_drop_date: ymd, source: z.string().min(1).max(120) }).strict();
const FromLists = z.object({ drop_from: ymd, drop_to: ymd, sample_n: z.number().int().min(1).max(200), seed: z.union([z.string().min(1).max(64), z.number().int().min(1).max(64)]) }).strict();
const Body = z.object({
  name: z.string().regex(DROP_LIST_NAME_RE),
  settings: z.array(z.string().regex(LABEL_RE)).min(1).max(3).refine((a) => new Set(a).size === a.length, 'settings labels must be distinct'),
  sibling_method: z.enum(TEST_SET_METHODS).default(TEST_SET_DEFAULT_METHOD),
  names: z.array(NameRow).min(1).max(200).optional(),
  from_drop_lists: FromLists.optional(),
}).strict().refine((b) => (b.names === undefined) !== (b.from_drop_lists === undefined), { message: 'give exactly one of names and from_drop_lists' });
const ReportQuery = z.object({ settings: z.string().regex(LABEL_RE), cohorts: z.string().max(2000).optional() }).strict();

interface Candidate { domain: string; expected: string | null; source: string | null; included: boolean; reason: string | null }

export function registerCohorts(app: FastifyInstance, deps: CohortsDeps): void {
  const { db, worker } = deps;

  const view = async (name: string) => {
    const c = await db.selectFrom('cohorts').selectAll().where('name', '=', name).executeTakeFirst();
    if (!c) throw new AppError(404, 'COHORT_NOT_FOUND', `No cohort "${name}"`);
    const run = (await db.selectFrom('screening_runs').selectAll().where('id', '=', c.run_id).executeTakeFirst())!;
    if (run.status === 'running' && (!run.heartbeat_at || deps.now() - run.heartbeat_at.getTime() > HEARTBEAT_STALE_MS)) worker.kick(run.id);
    const frozen = c.status === 'frozen' || (await freezeCohortIfReady(db, name, deps.now()));
    return { c, run, status: frozen ? 'frozen' : 'computing' };
  };

  app.post('/selection/cohorts', async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    if (await db.selectFrom('cohorts').select('name').where('name', '=', b.name).executeTakeFirst()) throw new AppError(409, 'COHORT_NAME_TAKEN', `A cohort named ${b.name} exists`, { name: b.name });
    for (const label of b.settings) {
      if (!(await selectionSettingsByLabel(db, label))) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${label}"`);
    }
    const nowMs = deps.now();
    const today = todayIdt(nowMs);
    let cands: { domain: string; expected: string; source: string }[];
    let source: object;
    if (b.names) {
      cands = b.names.map((n) => ({ domain: n.domain, expected: n.expected_drop_date, source: n.source }));
      source = { kind: 'names', sibling_method: b.sibling_method };
    } else {
      const f = b.from_drop_lists!;
      const { from, to } = parseWindow({ drop_from: f.drop_from, drop_to: f.drop_to });
      const seed = String(f.seed);
      const pool = (await namesDroppingBetween(db, nowMs, from, to)).filter((n) => n.status === 'pending_delete' || n.status === 'redemption');
      const sampled = pool.map((n) => ({ n, k: splitKey(seed, n.domain) })).sort((p, q) => (p.k < q.k ? -1 : p.k > q.k ? 1 : 0)).slice(0, f.sample_n).map((x) => x.n);
      cands = sampled.map((n) => ({ domain: n.domain, expected: n.expected_drop_date, source: `drop_list:${n.list_name}` }));
      source = { kind: 'from_drop_lists', drop_from: from, drop_to: to, sample_n: f.sample_n, seed, sibling_method: b.sibling_method };
    }

    const valid = cands.map((c) => { try { return normalizeDomain(c.domain); } catch { return null; } });
    const open = new Set<string>();
    const cand = [...new Set(valid.filter((d): d is string => d !== null))];
    if (cand.length > 0) {
      const since = new Date(nowMs - COHORT_OPEN_DAYS * 86_400_000);
      for (const x of await db.selectFrom('cohort_names as n').innerJoin('cohorts as c', 'c.name', 'n.cohort').select('n.domain').where('n.included', '=', true).where('n.domain', 'in', cand).where('c.created_at', '>=', since).execute()) open.add(x.domain);
    }
    const seen = new Set<string>();
    const stored: Candidate[] = cands.map((c, i): Candidate => {
      const d = valid[i];
      const base = { expected: c.expected, source: c.source };
      if (d === null || d === undefined) return { ...base, domain: c.domain, included: false, reason: 'DOMAIN_INVALID' };
      if (seen.has(d)) return { ...base, domain: d, included: false, reason: 'DUPLICATE_IN_UPLOAD' };
      seen.add(d);
      if (c.expected <= today) return { ...base, domain: d, included: false, reason: 'LATE' };
      if (open.has(d)) return { ...base, domain: d, included: false, reason: 'IN_OPEN_COHORT' };
      return { ...base, domain: d, included: true, reason: null };
    });
    const included = stored.filter((s) => s.included);
    const excluded: Record<string, number> = {};
    for (const s of stored) if (s.reason) excluded[s.reason] = (excluded[s.reason] ?? 0) + 1;
    if (b.from_drop_lists && cands.length === 0) {
      const w = parseWindow({ drop_from: b.from_drop_lists.drop_from, drop_to: b.from_drop_lists.drop_to });
      throw new AppError(422, 'COHORT_EMPTY', 'No name with a pending drop falls in the window; nothing was stored', { reason: 'NO_PENDING_NAMES_IN_WINDOW', drop_from: w.from, drop_to: w.to, excluded });
    }
    if (included.length === 0) throw new AppError(422, 'COHORT_EMPTY', 'No name is left after the exclusions; nothing was stored', { excluded });

    const createdAt = new Date(nowMs);
    const names: InputName[] = included.map((k) => ({ domain: k.domain, lane: TEST_SET_LANE, census_list: b.sibling_method, as_of: createdAt.toISOString() }));
    const run = await createRun(db, { mode: 'full', checks: TEST_SET_CHECKS, names },
      { createdBy: req.auth!.name, auditId: req.auditId!, now: createdAt, deadlineHours: TEST_SET_RUN_HOURS, allowUnapprovedMethod: true, testSet: { maxAnswerAgeDays: TEST_SET_DEFAULT_MAX_ANSWER_AGE_DAYS, asOfIsNow: true } }, worker.checks);
    try {
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('cohorts').values({
          name: b.name, created_at: createdAt, created_by: req.auth!.name, settings_labels: b.settings, source: JSON.stringify(source), run_id: run.id, status: 'computing',
        }).execute();
        for (let i = 0; i < stored.length; i += 500) {
          await trx.insertInto('cohort_names').values(stored.slice(i, i + 500).map((s) => ({ cohort: b.name, domain: s.domain, expected_drop_date: s.expected, source: s.source, included: s.included, reason: s.reason }))).execute();
        }
      });
    } catch (e) {
      if ((e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'cohorts_pkey') {
        await db.updateTable('screening_runs').set({ status: 'partial', finished_at: new Date(deps.now()) }).where('id', '=', run.id).execute();
        throw new AppError(409, 'COHORT_NAME_TAKEN', `A cohort named ${b.name} exists`, { name: b.name });
      }
      throw e;
    }
    worker.kick(run.id);
    return reply.code(202).send({ name: b.name, status: 'computing', run_id: run.id, included_n: included.length, excluded, poll: `/selection/cohorts/${b.name}` });
  });

  // Registered before :name so that "report" is never read as a cohort name (static routes win in Fastify, but keep the order obvious).
  app.get('/selection/cohorts/report', async (req) => {
    const p = ReportQuery.safeParse(req.query ?? {});
    if (!p.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid query: settings is required; cohorts is an optional comma-separated list (${p.error.issues.map((i) => i.path.join('.') || i.message).join(', ')})`);
    if (!(await selectionSettingsByLabel(db, p.data.settings))) throw new AppError(404, 'SETTINGS_NOT_FOUND', `No selection settings version "${p.data.settings}"`);
    let only: string[] | undefined;
    if (p.data.cohorts !== undefined) {
      only = p.data.cohorts.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
      if (only.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'cohorts must name at least one cohort');
      const have = new Set((await db.selectFrom('cohorts').select('name').where('name', 'in', only).execute()).map((c) => c.name));
      const missing = only.filter((x) => !have.has(x));
      if (missing.length > 0) throw new AppError(404, 'COHORT_NOT_FOUND', `No cohort "${missing[0]}"`, { names: missing });
      // lazily freeze the named cohorts whose run has finished
      for (const n of only) await freezeCohortIfReady(db, n, deps.now());
    }
    return cohortReport(db, p.data.settings, only);
  });

  app.get<{ Params: { name: string } }>('/selection/cohorts/:name', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    const { c, run, status } = await view(req.params.name);
    const names = await db.selectFrom('cohort_names').selectAll().where('cohort', '=', c.name).orderBy('id').execute();
    const included = names.filter((n) => n.included);
    const decisions = await db.selectFrom('cohort_decisions').select(['domain', 'settings_label', 'decision', 'tier', 'late']).where('cohort', '=', c.name).execute();
    const outcomes = await latestOutcomes(db, [c.name]);
    const excluded: Record<string, number> = {};
    for (const n of names) if (n.reason) excluded[n.reason] = (excluded[n.reason] ?? 0) + 1;
    const rr = (domain: string, kind: string) => {
      const o = outcomes.get(`${c.name}\t${domain}\t${kind}`);
      return o ? { result: o.result, created_at: o.created_at_registry ? toJerusalemIso(o.created_at_registry) : null, registrar: o.registrar } : null;
    };
    const report: Record<string, unknown> = {};
    if (status === 'frozen') for (const label of c.settings_labels) report[label] = await cohortReport(db, label, [c.name]);
    return {
      name: c.name, status, created_at: toJerusalemIso(c.created_at), created_by: c.created_by, settings: c.settings_labels, source: c.source,
      run: { id: run.id, status: run.status }, included_n: included.length, excluded_n: names.length - included.length, excluded,
      excluded_names: names.filter((n) => !n.included).map((n) => ({ domain: n.domain, reason: n.reason })),
      names: included.map((n) => {
        const o = outcomes.get(`${c.name}\t${n.domain}\tdrop`);
        return {
          domain: n.domain, expected_drop_date: n.expected_drop_date, source: n.source,
          decisions: Object.fromEntries(decisions.filter((d) => d.domain === n.domain).map((d) => [d.settings_label, { decision: d.decision, tier: d.tier, late: d.late }])),
          drop: o ? { result: o.result, checked_at: toJerusalemIso(o.checked_at) } : null,
          rereg: { d30: rr(n.domain, 'rereg30'), d60: rr(n.domain, 'rereg60'), d90: rr(n.domain, 'rereg90') },
        };
      }),
      report,
    };
  });
}
