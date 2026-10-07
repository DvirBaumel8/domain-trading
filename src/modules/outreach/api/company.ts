// v2.10.0 (CR-011 part B): the company document and the forbidden-terms list (the block list's own data).
import { advisoryXactLock } from '../../../core/locks.js';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { checkText } from '../blocklist.js';
import { unifiedDiff } from '../review/diff.js';
import { sha256 } from '../review/packet.js';

export interface CompanyDeps { db: Kysely<Database>; now: () => number; secretValues: string[] }

const DocBody = z.object({ text: z.string().min(1).max(65536) }).strict();
const TermBody = z.object({ term: z.string().trim().min(2).max(200), category: z.literal('listed_term').optional() }).strict();

const RetireBody = z.object({ reason: z.string().trim().min(1).max(200).optional() }).strict();

export function registerCompany(app: FastifyInstance, deps: CompanyDeps): void {
  const { db } = deps;

  // A 64 KB document with JSON escapes can pass the 64 KB default body limit; this route allows more.
  app.post('/company/document', { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const b = DocBody.parse(req.body ?? {});
    const blocked = await checkText(db, b.text, { secretValues: deps.secretValues });
    if (!blocked.ok) throw new AppError(422, 'TEXT_BLOCKED', 'The text is refused by the block list', { category: blocked.category });
    const hash = sha256(b.text);
    const out = await db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, 'company_document');
      const last = await trx.selectFrom('company_documents').select(['version', 'sha256', 'created_at']).orderBy('version', 'desc').limit(1).executeTakeFirst();
      if (last && last.sha256 === hash) return { changed: false, row: last };
      const row = await trx.insertInto('company_documents').values({ sha256: hash, text: b.text, created_by: req.auth!.name, audit_id: req.auditId, created_at: new Date(deps.now()) })
        .returning(['version', 'sha256', 'created_at']).executeTakeFirstOrThrow();
      return { changed: true, row };
    });
    return reply.code(out.changed ? 201 : 200).send({ version: out.row.version, sha256: out.row.sha256, created_at: out.row.created_at, changed: out.changed });
  });

  app.get('/company/document/versions', async () => {
    const rows = await sql<{ version: number; sha256: string; created_at: Date; created_by: string; bytes: number }>`
      select version, sha256, created_at, created_by, octet_length(text)::int as bytes from company_documents order by version desc`.execute(db);
    return { versions: rows.rows };
  });

  app.get('/company/document/versions/:n', async (req) => {
    const n = Number((req.params as { n: string }).n);
    const notFound = () => new AppError(404, 'DOCUMENT_VERSION_NOT_FOUND', 'No such document version', { version: (req.params as { n: string }).n });
    if (!/^\d{1,9}$/.test((req.params as { n: string }).n) || n < 1) throw notFound();
    const v = await db.selectFrom('company_documents').selectAll().where('version', '=', n).executeTakeFirst();
    if (!v) throw notFound();
    let diff: string | null = null;
    if (n > 1) {
      const prev = await db.selectFrom('company_documents').select('text').where('version', '=', n - 1).executeTakeFirst();
      diff = prev ? unifiedDiff(prev.text, v.text, `v${n - 1}`, `v${n}`) : null;
    }
    return { version: v.version, sha256: v.sha256, created_at: v.created_at, text: v.text, diff };
  });

  app.post('/company/forbidden-terms', async (req, reply) => {
    const b = TermBody.parse(req.body ?? {});
    const row = await db.insertInto('forbidden_terms').values({ term: b.term, created_by: req.auth!.name, created_at: new Date(deps.now()) })
      .returning(['id', 'category', 'created_at']).executeTakeFirstOrThrow();
    return reply.code(201).send(row);
  });

  app.get('/company/forbidden-terms', async () => {
    const terms = await db.selectFrom('forbidden_terms as t').leftJoin('forbidden_term_retirements as r', 'r.term_id', 't.id')
      .select(['t.id', 't.category', 't.created_at', 'r.at as retired_at']).orderBy('t.id').execute();
    return { terms };
  });

  // v2.15.0 (CR-013 R-4): a retired term no longer blocks. Append-only: the term row stays, one retirement row records who, when and why.
  app.post<{ Params: { id: string } }>('/company/forbidden-terms/:id/retire', async (req) => {
    const b = RetireBody.parse(req.body ?? {});
    const raw = req.params.id;
    const notFound = () => new AppError(404, 'TERM_NOT_FOUND', 'No such forbidden term', { id: raw });
    if (!/^\d{1,9}$/.test(raw)) throw notFound();
    const id = Number(raw);
    if (!(await db.selectFrom('forbidden_terms').select('id').where('id', '=', id).executeTakeFirst())) throw notFound();
    try {
      const row = await db.insertInto('forbidden_term_retirements').values({ term_id: id, at: new Date(deps.now()), by: req.auth!.name, audit_id: req.auditId, reason: b.reason ?? null })
        .returning(['term_id', 'at', 'by', 'reason']).executeTakeFirstOrThrow();
      req.auditSummary = `forbidden term ${id} retired`;
      return { id: row.term_id, retired_at: row.at, retired_by: row.by, reason: row.reason };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'TERM_ALREADY_RETIRED', 'This term is already retired', { id });
      throw e;
    }
  });
}
