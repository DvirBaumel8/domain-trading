// v2.13.0 (CR-012 part E): records per domain. POST /candidates/{domain}/records (WRITE), GET /candidates/{domain}/records (READ).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { HistoryManual, TmManual } from '../screening/checks/manual.js';
import { RECORD_FRESH_DAYS, RECORD_KINDS, freshUntil, isFresh, type RecordKind } from '../screening/domain-records.js';

/** The record shapes are exactly the manual shapes (the same zod schemas as POST /screening/runs/{id}/manual). */
const parseRecord = (kind: RecordKind, record: unknown) => (kind === 'tm_us' ? TmManual.parse(record) : HistoryManual.parse(record));

export interface CandidatesDeps { db: Kysely<Database>; now: () => number }

const Body = z.object({
  kind: z.enum(RECORD_KINDS), record: z.unknown(), checked_by: z.string().trim().min(1).max(80),
  evidence_url: z.string().url().max(500).refine((u) => u.startsWith('https://'), 'an https URL').optional(), note: z.string().max(500).optional(),
}).strict();
const Query = z.object({ kind: z.enum(RECORD_KINDS).optional() }).strict();

export function registerCandidates(app: FastifyInstance, deps: CandidatesDeps): void {
  const { db } = deps;

  app.post<{ Params: { domain: string } }>('/candidates/:domain/records', async (req, reply) => {
    const domain = normalizeDomain(req.params.domain);
    const b = Body.parse(req.body ?? {});
    // A history record carries its own `checked_by`; the top-level one fills it in when the record has none.
    const raw = b.kind === 'history' && b.record !== null && typeof b.record === 'object' && !Array.isArray(b.record) && (b.record as Record<string, unknown>).checked_by === undefined
      ? { ...(b.record as Record<string, unknown>), checked_by: b.checked_by } : b.record;
    const rec = parseRecord(b.kind, raw);
    const at = new Date(deps.now());
    const row = await db.insertInto('domain_records').values({
      domain, kind: b.kind, record: JSON.stringify(rec), checked_by: b.checked_by, checked_at: at, evidence_url: b.evidence_url ?? null, note: b.note ?? null,
      created_at: at, created_by: req.auth!.name, audit_id: req.auditId ?? null, source_run_id: null,
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
