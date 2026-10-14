// v5.3.0 (CR-053): POST /lessons (WRITE), GET /lessons, GET /lessons/check, GET /lessons/report (READ), PATCH /lessons/:id (WRITE).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { realYmd } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { addLessons, lessonReport, lessonsForDomain, listLessons, patchLesson, reportMarkdown, SCOUTS, SECTORS, type NewLesson } from '../lessons.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const Item = z.object({
  scout: z.enum(SCOUTS).default('other'),
  sector: z.enum(SECTORS),
  domain: z.string().max(2_000).optional(),
  domains: z.array(z.string().max(253)).max(50).optional(),
  rule: text(20).transform((s) => s.toLowerCase()),
  lesson: text(300),
  recheck_if: text(200).default('never'),
  source_file: text(200).nullish(),
}).strict();
const Body = z.union([Item, z.array(Item).min(1).max(200)]);
const Patch = z.object({ recheck_if: text(200).optional(), superseded_by: text(60).nullable().optional(), lesson: text(300).optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, 'send at least one of recheck_if, superseded_by, lesson');
const ListQuery = z.object({
  sector: z.enum(SECTORS).optional(), since: realYmd.optional(), rule: z.string().min(1).max(20).optional(), q: z.string().min(1).max(200).optional(),
  limit: z.string().regex(/^\d{1,4}$/).transform(Number).pipe(z.number().int().min(1).max(1000)).default(200),
}).strict();
const CheckQuery = z.object({ domain: z.string().min(1).max(253) }).strict();
const ReportQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), format: z.enum(['json', 'md']).default('json') }).strict();

function query<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

function toNew(it: z.infer<typeof Item>): NewLesson {
  const names = [...(it.domain ? it.domain.split(',') : []), ...(it.domains ?? [])].map((s) => s.trim()).filter((s) => s !== '');
  return {
    scout: it.scout, sector: it.sector, domains: [...new Set(names.map(normalizeDomain))], rule: it.rule, lesson: it.lesson,
    recheck_if: it.recheck_if, source_file: it.source_file ?? null,
  };
}

export function registerLessons(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.post('/lessons', { config: { openapiBody: Body } }, async (req, reply) => {
    const body = Body.parse(req.body ?? {});
    const items = (Array.isArray(body) ? body : [body]).map(toNew);
    const results = await addLessons(deps.db, items, { by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null, now: new Date(deps.now()) });
    return reply.code(201).send({ results, audit_id: req.auditId ?? null });
  });

  app.get('/lessons', async (req) => {
    const q = query(ListQuery, req.query);
    const lessons = await listLessons(deps.db, q);
    return { count: lessons.length, lessons };
  });

  app.get('/lessons/check', async (req) => {
    const domain = normalizeDomain(query(CheckQuery, req.query).domain);
    const lessons = await lessonsForDomain(deps.db, domain);
    return { domain, count: lessons.length, lessons };
  });

  app.get('/lessons/report', async (req, reply) => {
    const q = query(ReportQuery, req.query);
    const rep = await lessonReport(deps.db, q.month);
    if (q.format === 'md') return reply.type('text/markdown; charset=utf-8').send(reportMarkdown(rep));
    return rep;
  });

  app.patch('/lessons/:id', { config: { openapiBody: Patch } }, async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(60) }).parse(req.params);
    const patch = Patch.parse(req.body ?? {});
    return { lesson: await patchLesson(deps.db, id, { ...(patch.recheck_if !== undefined && { recheck_if: patch.recheck_if }), ...(patch.superseded_by !== undefined && { superseded_by: patch.superseded_by }), ...(patch.lesson !== undefined && { lesson: patch.lesson }) }, new Date(deps.now())), audit_id: req.auditId ?? null };
  });
}
