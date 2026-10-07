import { idtDay } from '../core/dates.js';
// v2.13.0 (CR-012 part E): records per domain. POST /candidates/{domain}/records (WRITE), GET /candidates/{domain}/records (READ).
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { HistoryManual, TmManual, phraseKey, priorPhraseOf } from '../screening/checks/manual.js';
import { ymd } from './drop-lists.js';

import { DAILY_LIST_DEFAULT_LIMIT, DAILY_LIST_MAX_LIMIT, buildDailyList, readDailyList } from '../screening/daily-list.js';
import type { ScreeningWorker } from '../screening/engine.js';
import { IntakeBody, takeIntake } from '../screening/intake.js';
import { RECORD_FRESH_DAYS, RECORD_KINDS, freshUntil, isFresh, type RecordKind } from '../screening/domain-records.js';

/** The record shapes are exactly the manual shapes (the same zod schemas as POST /screening/runs/{id}/manual). */
const parseRecord = (kind: RecordKind, record: unknown) => (kind === 'tm_us' ? TmManual.parse(record) : HistoryManual.parse(record));

export interface CandidatesDeps { db: Kysely<Database>; now: () => number; worker: ScreeningWorker }
/** Manual rebuilds of today's list allowed per IDT day (the daily step does not count). */
export const DAILY_REBUILD_MAX_PER_DAY = 6;

const Body = z.object({
  kind: z.enum(RECORD_KINDS), record: z.unknown(), checked_by: z.string().trim().min(1).max(80),
  evidence_url: z.string().url().max(500).refine((u) => u.startsWith('https://'), 'an https URL').optional(), note: z.string().max(500).optional(),
  // v2.16.0 (CR-014 N-2): when the check was done (ISO with offset); default now.
  checked_at: z.iso.datetime({ offset: true }).optional(),
}).strict();
const DailyQuery = z.object({ date: ymd.optional(), limit: z.coerce.number().int().min(1).max(DAILY_LIST_MAX_LIMIT).default(DAILY_LIST_DEFAULT_LIMIT) }).strict();
const Query = z.object({ kind: z.enum(RECORD_KINDS).optional() }).strict();

export function registerCandidates(app: FastifyInstance, deps: CandidatesDeps): void {
  const { db } = deps;

  // v2.14.0 (CR-012 part C): a scout sends names. WRITE or intake token (the scope hook allows an intake token on this route and on POST /selection/drop-lists only).
  app.post('/candidates/intake', { bodyLimit: 512 * 1024 }, async (req) => {
    const body = IntakeBody.parse(req.body ?? {});
    return takeIntake(db, body, { tokenName: req.auth!.name, auditId: req.auditId ?? null, now: new Date(deps.now()) });
  });

  // v2.14.0 (CR-012 part B): the day's candidate list, as built once by the daily step (newest build of the day).
  app.get('/candidates/daily', async (req) => {
    const q = DailyQuery.safeParse(req.query ?? {});
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: date (YYYY-MM-DD) and limit (1..25) are the only parameters', { issues: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return readDailyList(db, q.data.date ?? idtDay(deps.now()), q.data.limit);
  });

  // v2.16.0 (CR-015 I-4): rebuild today's list now (a record posted after the daily step is judged at once). Same rules as the daily step: the day's first order is kept,
  // changes are marked. It waits for nothing (the daily step already did) and reads only the database. At most 6 per IDT day.
  app.post('/candidates/daily/rebuild', async (req, reply) => {
    z.object({}).strict().parse(req.body ?? {});
    const today = idtDay(deps.now());
    // The count and the build run under one advisory lock (the build commits its row before the lock is released), so two calls cannot both take the last slot.
    const out = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('daily_rebuild'))`.execute(trx);
      const used = Number((await trx.selectFrom('daily_candidate_lists').select(sql<string>`count(*)`.as('n')).where('day', '=', today).where('built_by', '=', 'rebuild').executeTakeFirstOrThrow()).n);
      if (used >= DAILY_REBUILD_MAX_PER_DAY) {
        throw new AppError(429, 'RATE_LIMITED', `At most ${DAILY_REBUILD_MAX_PER_DAY} rebuilds of the daily list per day`, { max_per_day: DAILY_REBUILD_MAX_PER_DAY, day: today });
      }
      const built = await buildDailyList({ db, worker: deps.worker, now: deps.now, noWait: true, builtBy: 'rebuild' });
      return { ...built, rebuilds_today: used + 1, rebuilds_left_today: DAILY_REBUILD_MAX_PER_DAY - used - 1 };
    });
    return reply.code(201).send(out);
  });

  app.post<{ Params: { domain: string } }>('/candidates/:domain/records', async (req, reply) => {
    const domain = normalizeDomain(req.params.domain);
    const b = Body.parse(req.body ?? {});
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
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: only kind=tm_us|history is accepted');
    let sel = db.selectFrom('domain_records').selectAll().where('domain', '=', domain);
    if (q.data.kind) sel = sel.where('kind', '=', q.data.kind);
    const rows = await sel.orderBy('checked_at', 'desc').orderBy('id', 'desc').execute();
    const nowMs = deps.now();
    return {
      domain, freshness_days: RECORD_FRESH_DAYS,
      records: rows.map((r) => {
        const kind = r.kind as RecordKind;
        return {
          id: Number(r.id), kind, record: r.record, checked_by: r.checked_by, checked_at: r.checked_at.toISOString(), evidence_url: r.evidence_url, note: r.note,
          created_at: r.created_at.toISOString(), created_by: r.created_by, source_run_id: r.source_run_id,
          fresh_until: freshUntil(kind, r.checked_at).toISOString(), fresh: isFresh(kind, r.checked_at, nowMs),
        };
      }),
    };
  });
}
