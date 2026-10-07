// v2.10.0 (CR-011 part B): the company document and the forbidden-terms list (the block list's own data).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { checkText } from '../services/blocklist.js';
import { unifiedDiff } from '../services/review/diff.js';
import { sha256 } from '../services/review/packet.js';

export interface CompanyDeps { db: Kysely<Database>; now: () => number; secretValues: string[] }

const DocBody = z.object({ text: z.string().min(1).max(65536) }).strict();
const TermBody = z.object({ term: z.string().trim().min(2).max(200), category: z.literal('listed_term').optional() }).strict();

export function registerCompany(app: FastifyInstance, deps: CompanyDeps): void {
  const { db } = deps;

  // A 64 KB document with JSON escapes can pass the 64 KB default body limit; this route allows more.
  app.post('/company/document', { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const b = DocBody.parse(req.body ?? {});
    const blocked = await checkText(db, b.text, { secretValues: deps.secretValues });
    if (!blocked.ok) throw new AppError(422, 'TEXT_BLOCKED', 'The text is refused by the block list', { category: blocked.category });
    const hash = sha256(b.text);
    const out = await db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext('company_document'))`.execute(trx);
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
    const terms = await db.selectFrom('forbidden_terms').select(['id', 'category', 'created_at']).orderBy('id').execute();
    return { terms };
  });
}
