// CR-078 phase 1 (v5.43.0). POST /kb/{sources,authors,claims,evidence,links,questions} (WRITE, bots or data token, Idempotency-Key, { rows (1..1000), dry_run? }, all-or-nothing),
// GET /kb/questions, /kb/questions/{id}/verdict, /kb/claims, /kb/sources, /kb/recheck, /kb/echo-candidates (READ or bots).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { echoCandidates, recheckList, verdictFor } from '../read.js';
import { KB_MAX_ROWS, SCHEMAS, type Kind } from '../rows.js';
import { activeKbSettings } from '../settings.js';
import { databaseBytes, guardDbSize, payloadBytesOf, type DbSizeGuard } from '../size.js';
import type { KbLoadJob } from '../load.js';
import { writeKinds } from '../store.js';

const BODY_LIMIT = 4 * 1024 * 1024;
const ROUTES: { path: string; kind: Kind }[] = [
  { path: 'sources', kind: 'source' }, { path: 'authors', kind: 'author' }, { path: 'claims', kind: 'claim' },
  { path: 'evidence', kind: 'evidence' }, { path: 'links', kind: 'link' }, { path: 'questions', kind: 'question' },
];
const Body = z.object({ rows: z.array(z.unknown()).min(1).max(KB_MAX_ROWS), dry_run: z.boolean().optional() }).strict();
const Page = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) });
const bad = (e: z.ZodError) => new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${e.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
const parse = <T extends z.ZodType>(schema: T, q: unknown): z.infer<T> => { const p = schema.safeParse(q ?? {}); if (!p.success) throw bad(p.error); return p.data; };

export function registerKnowledge(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; dbSize: DbSizeGuard; kbLoad: Pick<KbLoadJob, 'runOnce'> }): void {
  const { db } = deps;

  for (const r of ROUTES) {
    const doc = z.object({ rows: z.array(SCHEMAS[r.kind]).min(1).max(KB_MAX_ROWS), dry_run: z.boolean().optional() }).strict();
    app.post(`/kb/${r.path}`, { config: { openapiBody: doc }, bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const b = Body.parse(req.body ?? {});
      const before = await guardDbSize(db, deps.dbSize, payloadBytesOf(req, b.rows));
      const settings = await activeKbSettings(db);
      const by = req.auth?.name ?? 'unknown';
      const [res] = await writeKinds(db, [{ kind: r.kind, rows: b.rows }], { by, auditId: req.auditId ?? null, now: new Date(deps.now()), settings, dryRun: b.dry_run === true });
      const after = await (deps.dbSize.bytes ?? (() => databaseBytes(db)))();
      req.auditSummary = `kb ${r.path}${b.dry_run ? ' (dry run)' : ''}: ${res!.accepted_n} accepted, ${res!.duplicate_n} duplicate, ${res!.superseded_n} superseded of ${res!.received_n}; db ${before} -> ${after} bytes`;
      const { auto_superseded: _routesNeverAuto, ...out } = res!;
      return reply.code(201).send({ ...out, kind: r.kind, dry_run: b.dry_run === true, rejected_n: 0, db_bytes_before: before, db_bytes_after: after, audit_id: req.auditId ?? null });
    });
  }

  app.get('/kb/questions', async (req) => {
    const p = parse(Page, req.query);
    const qs = await db.selectFrom('kb_questions').selectAll().orderBy('id').limit(p.limit).offset(p.offset).execute();
    const latest = qs.length === 0 ? [] : await db.selectFrom('kb_verdicts').select(['id', 'question_id', 'certainty', 'computed_at', 'settings_version'])
      .where('id', 'in', (q) => q.selectFrom('kb_verdicts').select(sql<number>`max(id)`.as('m')).where('question_id', 'in', qs.map((x) => x.id)).groupBy('question_id')).execute();
    const by = new Map(latest.map((v) => [v.question_id, v]));
    return {
      questions: qs.map((q) => ({
        id: q.id, slug: q.slug, text: q.text, options: q.options, population: q.population, decision_owner: q.decision_owner, created_at: q.created_at.toISOString(),
        latest_verdict: by.has(q.id) ? { id: by.get(q.id)!.id, certainty: by.get(q.id)!.certainty, computed_at: by.get(q.id)!.computed_at.toISOString(), settings_version: by.get(q.id)!.settings_version } : null,
      })),
      limit: p.limit, offset: p.offset,
    };
  });

  app.get<{ Params: { id: string } }>('/kb/questions/:id/verdict', async (req) => {
    const raw = req.params.id;
    let id: number;
    if (/^\d{1,12}$/.test(raw)) id = Number(raw);
    else {
      const q = await db.selectFrom('kb_questions').select('id').where('slug', '=', raw).executeTakeFirst();
      if (!q) throw new AppError(404, 'KB_QUESTION_NOT_FOUND', `No question "${raw.slice(0, 80)}"`);
      id = q.id;
    }
    return verdictFor(db, id, deps.now(), req.auth?.name ?? 'unknown');
  });

  const Claims = z.object({ topic: z.string().regex(/^[a-z_]{2,40}$/).optional(), question: z.string().max(80).optional(), limit: Page.shape.limit, offset: Page.shape.offset }).strict();
  app.get('/kb/claims', async (req) => {
    const p = parse(Claims, req.query);
    let qid: number | undefined;
    if (p.question !== undefined) {
      const q = await db.selectFrom('kb_questions').select('id').where(/^\d+$/.test(p.question) ? 'id' : 'slug', '=', (/^\d+$/.test(p.question) ? Number(p.question) : p.question) as never).executeTakeFirst();
      if (!q) throw new AppError(404, 'KB_QUESTION_NOT_FOUND', `No question "${p.question}"`);
      qid = q.id;
    }
    const rows = await sql<Record<string, unknown>>`
      select c.*, (select count(*)::int from kb_evidence e where e.claim_id = (select id from kb_claims r where r.claim_key = c.claim_key and r.version = 1)) as evidence_n
      from kb_claims c where c.version = (select max(version) from kb_claims m where m.claim_key = c.claim_key)
      ${p.topic ? sql`and c.topic = ${p.topic}` : sql``} ${qid !== undefined ? sql`and ${qid} = any(c.question_ids)` : sql``}
      order by c.id limit ${p.limit} offset ${p.offset}`.execute(db);
    return { claims: rows.rows.map((r) => ({ ...r, created_at: new Date(r.created_at as string).toISOString(), audit_id: undefined })), limit: p.limit, offset: p.offset };
  });

  const Sources = z.object({
    status: z.enum(['lead', 'read', 'graded', 'rejected']).optional(), topic: z.string().regex(/^[a-z_]{2,40}$/).optional(), limit: Page.shape.limit, offset: Page.shape.offset,
  }).strict();
  app.get('/kb/sources', async (req) => {
    const p = parse(Sources, req.query);
    const rows = await sql<Record<string, unknown>>`
      select s.id, s.url, s.version, s.publisher, s.author_id, s.title, s.published_at, s.retrieved_at, s.type, s.access_method, s.access_note, s.reliability, s.reliability_reason,
             s.conflict_of_interest, s.excerpt, s.topics, s.status, s.rejected_reason, s.created_at
      from kb_sources s where s.version = (select max(version) from kb_sources m where m.url_hash = s.url_hash)
      ${p.status ? sql`and s.status = ${p.status}` : sql``} ${p.topic ? sql`and ${p.topic} = any(s.topics)` : sql``}
      order by s.id limit ${p.limit} offset ${p.offset}`.execute(db);
    const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
    return { sources: rows.rows.map((r) => ({ ...r, published_at: iso(r.published_at), retrieved_at: iso(r.retrieved_at), created_at: iso(r.created_at) })), limit: p.limit, offset: p.offset };
  });

  app.get('/kb/recheck', async () => recheckList(db, deps.now()));

  // v5.79.0 (CR-098): what the next kbLoad would do with the repo files not yet loaded, in loader order, rolled back; nothing is kept.
  app.get('/kb/load-preview', async (req) => {
    parse(z.object({}).strict(), req.query);
    return deps.kbLoad.runOnce({ dryRun: true });
  });

  const Echo = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();
  app.get('/kb/echo-candidates', async (req) => echoCandidates(db, parse(Echo, req.query).limit));
}
