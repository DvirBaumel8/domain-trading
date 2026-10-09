import { idtDay, nextIdtMidnight, toJerusalemIso } from '../../../core/dates.js';
// v2.13.0 (CR-012 part E): records per domain. POST /candidates/{domain}/records (WRITE), GET /candidates/{domain}/records (READ).
import { advisoryXactLock } from '../../../core/locks.js';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { hasAtSign, piiError } from '../../../core/validation.js';
import { AppError } from '../../../http/errors.js';
import { HistoryManual, SELLERS_KIND, SellersList, TmManual, activeSelectionSettings, phraseKey, priorPhraseOf, sellersFresh, sellersFreshHours, sellersFreshUntil } from '../../selection/index.js';
import { ymd } from './drop-lists.js';

import { DAILY_LIST_DEFAULT_LIMIT, DAILY_LIST_MAX_LIMIT, buildDailyList, readDailyList } from '../daily-list.js';
import type { ScreeningWorker } from '../../selection/index.js';
import { IntakeBody, planOnDemand, takeIntake } from '../intake.js';
import { RECORD_FRESH_DAYS, RECORD_KINDS, freshUntil, isFresh, type RecordKind } from '../../selection/index.js';

/** The record shapes are exactly the manual shapes (the same zod schemas as POST /screening/runs/{id}/manual). */
const parseRecord = (kind: RecordKind, record: unknown) => (kind === 'tm_us' ? TmManual.parse(record) : HistoryManual.parse(record));

/** What POST /candidates/screen needs of the job queue (the ops module is above this one, so app.ts passes it in). */
export interface ScreenQueue {
  enqueue(job: 'screen', opts: { trigger: 'manual'; triggeredBy: string; params: unknown }): Promise<{ runId: string; skipped: boolean }>;
  kick(): void;
}
export interface CandidatesDeps { db: Kysely<Database>; now: () => number; worker: ScreeningWorker; queue?: () => ScreenQueue }
/** Manual rebuilds of today's list allowed per IDT day (the daily step does not count). */
export const DAILY_REBUILD_MAX_PER_DAY = 6;

const RECORD_KINDS_ALL = [...RECORD_KINDS, SELLERS_KIND] as const; // v3.3.0 (CR-023 B): `sellers` is a record kind of its own (its window is the setting freshness_hours.sellers)
const Body = z.object({
  kind: z.enum(RECORD_KINDS_ALL), record: z.unknown(), checked_by: z.string().trim().min(1).max(80),
  evidence_url: z.string().url().max(500).refine((u) => u.startsWith('https://'), 'an https URL').optional(), note: z.string().max(500).optional(),
  // v2.16.0 (CR-014 N-2): when the check was done (ISO with offset); default now.
  checked_at: z.iso.datetime({ offset: true }).optional(),
}).strict();
/** v3.3.0 (CR-021): `max_names` caps the names of one on-demand run (the allowance still applies). */
export const ScreenBody = z.object({
  max_names: z.number().int().min(1).max(100).optional(),
  /** v3.4.0 (CR-026): screen only these names; a screened name goes in again only when the settings version or its records changed since its last screening. */
  domains: z.array(z.string().trim().min(1).max(253)).min(1).max(30).optional(),
}).strict();
const DailyQuery = z.object({ date: ymd.optional(), limit: z.coerce.number().int().min(1).max(DAILY_LIST_MAX_LIMIT).default(DAILY_LIST_DEFAULT_LIMIT) }).strict();
const Query = z.object({ kind: z.enum(RECORD_KINDS_ALL).optional() }).strict();

export function registerCandidates(app: FastifyInstance, deps: CandidatesDeps): void {
  const { db } = deps;

  // v2.14.0 (CR-012 part C): a scout sends names. WRITE or intake token (the scope hook allows an intake token on this route and on POST /selection/drop-lists only).
  app.post('/candidates/intake', { config: { openapiBody: IntakeBody }, bodyLimit: 512 * 1024 }, async (req) => {
    const body = IntakeBody.parse(req.body ?? {});
    const out = await takeIntake(db, body, { tokenName: req.auth!.name, auditId: req.auditId ?? null, now: new Date(deps.now()) });
    // v3.3.0 (CR-022 A): the audit row says which names came with the scout's own words (the request body is kept in the audit row too).
    const withWords = body.names.filter((n) => n.words).map((n) => `${n.domain.trim().toLowerCase()}=${n.words!.join('+')}`);
    req.auditSummary = `intake: ${out.accepted.length} accepted, ${out.duplicates.length} duplicate, ${out.removed.length} removed${withWords.length ? `; scout words: ${withWords.join(', ')}`.slice(0, 400) : ''}`;
    return out;
  });

  // v3.3.0 (CR-021): screen the waiting intake names now, under the on-demand allowance, then rebuild the day's list. A queue job `screen` (steps onDemandScreen, buildDailyList),
  // so it shows on GET /jobs/runs. No outside review, no other daily step; nothing here buys, spends or touches the buy hold.
  app.post('/candidates/screen', { config: { openapiBody: ScreenBody } }, async (req, reply) => {
    const b = ScreenBody.parse(req.body ?? {});
    const nowMs = deps.now();
    // No interleaving with a daily run or another screening run (409, never silent).
    const open = await db.selectFrom('job_queue_runs as r').select(['r.id', 'r.job']).where('r.job', 'in', ['daily', 'screen'])
      .where((eb) => eb.exists(eb.selectFrom('job_steps as s').select('s.id').whereRef('s.run_id', '=', 'r.id').where('s.status', 'in', ['queued', 'running'])))
      .orderBy('r.created_at').limit(1).executeTakeFirst();
    if (open) throw new AppError(409, 'ALREADY_RUNNING', `A ${open.job} run is still going; try again when it has finished`, { run_id: open.id, job: open.job });
    let domains: string[] | undefined;
    if (b.domains) {
      try { domains = [...new Set(b.domains.map((d) => normalizeDomain(d)))]; } catch (e) { throw new AppError(422, 'VALIDATION_ERROR', `domains: ${e instanceof Error ? e.message : 'invalid domain'}`, { field: 'domains' }); }
    }
    const plan = await planOnDemand(db, nowMs, b.max_names ?? null, domains);
    const allowance = (used: number) => ({ daily_max: plan.allowance.daily_max, used_today: used, remaining: Math.max(0, plan.allowance.daily_max - used) });
    if (plan.allowance.remaining <= 0) {
      throw new AppError(409, 'ON_DEMAND_SCREEN_CAP', 'The on-demand screening allowance of today is used up', { ...plan.allowance, next_allowed_at: toJerusalemIso(nextIdtMidnight(nowMs)) });
    }
    if (plan.names_n === 0) {
      // Nothing waiting: no run, no allowance used; the list is rebuilt anyway (it reads the database only).
      await db.transaction().execute(async (trx) => {
        await advisoryXactLock(trx, 'daily_rebuild');
        await buildDailyList({ db, worker: deps.worker, now: deps.now, noWait: true, builtBy: 'auto' });
      });
      req.auditSummary = 'screen: no names waiting';
      return reply.code(200).send({ run_id: null, names_n: 0, skipped: domains ? plan.skipped : 'NO_NAMES', allowance: allowance(plan.allowance.used_today) });
    }
    const queue = deps.queue?.();
    if (!queue) throw new Error('job queue not wired');
    const r = await queue.enqueue('screen', { trigger: 'manual', triggeredBy: req.auth!.name, params: { max_names: b.max_names ?? null, ...(domains && { domains }) } });
    if (r.skipped) throw new AppError(409, 'ALREADY_RUNNING', 'A screen run is still going; try again when it has finished', { run_id: r.runId, job: 'screen' });
    queue.kick();
    req.auditSummary = `screen: ${plan.names_n} queued${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ''}`;
    return reply.code(202).send({ run_id: r.runId, names_n: plan.names_n, skipped: plan.skipped, allowance: allowance(plan.allowance.used_today + plan.new_n) });
  });

  // v2.14.0 (CR-012 part B): the day's candidate list, as built once by the daily step (newest build of the day).
  app.get('/candidates/daily', async (req) => {
    const q = DailyQuery.safeParse(req.query ?? {});
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: date (YYYY-MM-DD) and limit (1..25) are the only parameters', { issues: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return readDailyList(db, q.data.date ?? idtDay(deps.now()), q.data.limit);
  });

  // v2.16.0 (CR-015 I-4): rebuild today's list now (a record posted after the daily step is judged at once). Same rules as the daily step: the day's first order is kept,
  // changes are marked. It waits for nothing (the daily step already did) and reads only the database. At most 6 per IDT day.
  app.post('/candidates/daily/rebuild', { config: { openapiNoBody: true, openapiStatus: 201 } }, async (req, reply) => {
    z.object({}).strict().parse(req.body ?? {});
    const today = idtDay(deps.now());
    // The count and the build run under one advisory lock (the build commits its row before the lock is released), so two calls cannot both take the last slot.
    const out = await db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, 'daily_rebuild');
      const used = Number((await trx.selectFrom('daily_candidate_lists').select(sql<string>`count(*)`.as('n')).where('day', '=', today).where('built_by', '=', 'rebuild').executeTakeFirstOrThrow()).n);
      if (used >= DAILY_REBUILD_MAX_PER_DAY) {
        throw new AppError(429, 'RATE_LIMITED', `At most ${DAILY_REBUILD_MAX_PER_DAY} rebuilds of the daily list per day`, { max_per_day: DAILY_REBUILD_MAX_PER_DAY, day: today });
      }
      const built = await buildDailyList({ db, worker: deps.worker, now: deps.now, noWait: true, builtBy: 'rebuild' });
      return { ...built, rebuilds_today: used + 1, rebuilds_left_today: DAILY_REBUILD_MAX_PER_DAY - used - 1 };
    });
    return reply.code(201).send(out);
  });

  app.post<{ Params: { domain: string } }>('/candidates/:domain/records', { config: { openapiBody: Body } }, async (req, reply) => {
    const domain = normalizeDomain(req.params.domain);
    const b = Body.parse(req.body ?? {});
    if (b.kind === SELLERS_KIND) {
      // v3.3.0 (CR-023 B): a list of up to 10 {name, url} (same shape as on intake), fresh for freshness_hours.sellers; the newer of intake and record wins at screening.
      const list = SellersList.parse(b.record);
      list.forEach((e, entry) => { if (hasAtSign(e.name) || hasAtSign(e.url)) throw piiError(`record[${entry}] must not contain an email address or '@'`, { field: 'sellers', entry }); });
      const nowMs = deps.now();
      const hours = sellersFreshHours((await activeSelectionSettings(db)).values);
      let at = new Date(nowMs);
      if (b.checked_at !== undefined) {
        const c = new Date(b.checked_at);
        if (c.getTime() > nowMs + 60_000) throw new AppError(422, 'CHECKED_AT_INVALID', 'checked_at is in the future');
        if (!sellersFresh(c, hours, nowMs)) throw new AppError(422, 'CHECKED_AT_INVALID', `checked_at is older than the sellers freshness window (${hours} hours)`, { freshness_hours: hours });
        at = c;
      }
      const row = await db.insertInto('domain_records').values({
        domain, kind: SELLERS_KIND, record: JSON.stringify(list), checked_by: b.checked_by, checked_at: at, evidence_url: b.evidence_url ?? null, note: b.note ?? null,
        created_at: new Date(nowMs), created_by: req.auth!.name, audit_id: req.auditId ?? null, source_run_id: null,
      }).returning(['id', 'created_at', 'checked_at']).executeTakeFirstOrThrow();
      return reply.code(201).send({ id: Number(row.id), domain, kind: b.kind, created_at: row.created_at.toISOString(), fresh_until: sellersFreshUntil(row.checked_at, hours).toISOString() });
    }
    // A history record carries its own `checked_by`; the top-level one fills it in when the record has none.
    const raw = b.kind === 'history' && b.record !== null && typeof b.record === 'object' && !Array.isArray(b.record) && (b.record as Record<string, unknown>).checked_by === undefined
      ? { ...(b.record as Record<string, unknown>), checked_by: b.checked_by } : b.record;
    const rec = parseRecord(b.kind, raw);
    const nowMs = deps.now();
    // v2.16.0 (CR-014 N-1): a US trademark record needs its evidence link and must list the name's own exact phrase.
    if (b.kind === 'tm_us') {
      if (b.evidence_url === undefined) throw new AppError(422, 'VALIDATION_ERROR', 'Request body is invalid', { issues: [{ path: 'evidence_url', message: 'evidence_url (https) is required for tm_us' }] });
      const phrase = priorPhraseOf(domain.split('.')[0]!);
      if (!(rec as z.infer<typeof TmManual>).phrases_queried.map(phraseKey).includes(phrase)) {
        throw new AppError(422, 'VALIDATION_ERROR', `record.phrases_queried must include the name's exact phrase "${phrase}"`, { missing_phrase: phrase });
      }
    }
    // v2.16.0 (CR-014 N-2): an optional checked_at, not in the future and inside the kind's freshness window.
    let at = new Date(nowMs);
    if (b.checked_at !== undefined) {
      const c = new Date(b.checked_at);
      if (c.getTime() > nowMs + 60_000) throw new AppError(422, 'CHECKED_AT_INVALID', 'checked_at is in the future');
      if (c.getTime() <= nowMs - RECORD_FRESH_DAYS[b.kind] * 86_400_000) {
        throw new AppError(422, 'CHECKED_AT_INVALID', `checked_at is older than the ${b.kind} freshness window (${RECORD_FRESH_DAYS[b.kind]} days)`, { freshness_days: RECORD_FRESH_DAYS[b.kind] });
      }
      at = c;
    }
    const row = await db.insertInto('domain_records').values({
      domain, kind: b.kind, record: JSON.stringify(rec), checked_by: b.checked_by, checked_at: at, evidence_url: b.evidence_url ?? null, note: b.note ?? null,
      created_at: new Date(nowMs), created_by: req.auth!.name, audit_id: req.auditId ?? null, source_run_id: null,
    }).returning(['id', 'created_at', 'checked_at']).executeTakeFirstOrThrow();
    return reply.code(201).send({ id: Number(row.id), domain, kind: b.kind, created_at: row.created_at.toISOString(), fresh_until: freshUntil(b.kind, row.checked_at).toISOString() });
  });

  app.get<{ Params: { domain: string } }>('/candidates/:domain/records', async (req) => {
    const domain = normalizeDomain(req.params.domain);
    const q = Query.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: only kind=tm_us|history|sellers is accepted');
    let sel = db.selectFrom('domain_records').selectAll().where('domain', '=', domain);
    if (q.data.kind) sel = sel.where('kind', '=', q.data.kind);
    const rows = await sel.orderBy('checked_at', 'desc').orderBy('id', 'desc').execute();
    const nowMs = deps.now();
    const sellersHours = sellersFreshHours((await activeSelectionSettings(db)).values);
    return {
      domain, freshness_days: RECORD_FRESH_DAYS, freshness_hours: { sellers: sellersHours },
      records: rows.map((r) => {
        const kind = r.kind;
        const [until, fresh] = kind === SELLERS_KIND ? [sellersFreshUntil(r.checked_at, sellersHours), sellersFresh(r.checked_at, sellersHours, nowMs)] : [freshUntil(kind, r.checked_at), isFresh(kind, r.checked_at, nowMs)];
        return {
          id: Number(r.id), kind, record: r.record, checked_by: r.checked_by, checked_at: r.checked_at.toISOString(), evidence_url: r.evidence_url, note: r.note,
          created_at: r.created_at.toISOString(), created_by: r.created_by, source_run_id: r.source_run_id,
          fresh_until: until.toISOString(), fresh,
        };
      }),
    };
  });
}
