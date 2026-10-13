// v4.2.0 (CR-044 item 3): POST /demand/keywords (WRITE, the monthly Keyword Planner export as base64) and GET /demand/keywords?keyword= (READ, the latest values).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { toJerusalemIso } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { KEYWORD_MAX_FILE_BYTES, latestKeyword, parseKeywordExport, storeKeywordUpload } from '../demand.js';

const Body = z.object({
  file_base64: z.string().min(1).max(Math.ceil((KEYWORD_MAX_FILE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/\r\n]+=*\s*$/, 'file_base64 must be base64'),
  location: z.string().trim().min(1).max(60).optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM').optional(),
}).strict();
const Query = z.object({ keyword: z.string().trim().min(1).max(200) }).strict();

export function registerDemand(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.post('/demand/keywords', { config: { openapiBody: Body }, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    const file = Buffer.from(b.file_base64.replace(/\s+/g, ''), 'base64');
    if (file.length > KEYWORD_MAX_FILE_BYTES) throw new AppError(422, 'KEYWORD_CSV_INVALID', `The file is larger than ${KEYWORD_MAX_FILE_BYTES} bytes`);
    const parsed = parseKeywordExport(file);
    const stored = await storeKeywordUpload(deps.db, parsed, { now: new Date(deps.now()), by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null, location: b.location ?? null, month: b.month ?? null });
    return reply.code(201).send({ ...stored, audit_id: req.auditId ?? null });
  });

  app.get('/demand/keywords', async (req) => {
    const q = Query.parse(req.query ?? {});
    const v = await latestKeyword(deps.db, q.keyword);
    if (!v) throw new AppError(404, 'KEYWORD_NOT_FOUND', `No keyword upload has "${q.keyword}"`);
    return {
      keyword: v.keyword, avg_monthly_searches: v.avg_monthly_searches, competition_index: v.competition_index,
      three_month_change: v.three_month_change, yoy_change: v.yoy_change,
      upload_id: v.upload_id, uploaded_at: toJerusalemIso(v.uploaded_at), date_range_line: v.date_range_line, location: v.location, month: v.month,
    };
  });
}
