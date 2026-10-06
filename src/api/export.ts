import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { VENUES, type Venue } from '../services/export-state.js';
import { SedoTemplateInvalid, type ExportResult, type ExportService } from '../services/export.js';

const QuerySchema = z.object({}).strict();

/** The export is always the full current file: any query parameter (including the removed changed_only) is a 422. */
function noQuery(req: FastifyRequest): void {
  QuerySchema.parse(req.query ?? {});
}

const BodySchema = z.object({
  export_id: z.string().min(1),
  approval_ref: z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict().nullable().optional(),
  uploaded_at: z.unknown().optional(),
  note: z.string().max(500).nullable().optional(),
}).strict();

function send(reply: FastifyReply, r: ExportResult) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${r.filename}"`)
    .header('x-export-id', r.exportId)
    .header('x-pending-changes', String(r.pendingChanges))
    .header('x-manual-delist', r.manualDelist.join(','))
    .header('x-export-warnings', r.warnings.join(';'))
    .send(r.csv);
}

export function registerExport(app: FastifyInstance, service: ExportService): void {
  app.get('/export/afternic.csv', async (req, reply) => {
    noQuery(req);
    return send(reply, await service.afternic());
  });

  app.get('/export/sedo.csv', async (req, reply) => {
    noQuery(req);
    let r;
    try {
      r = await service.sedo();
    } catch (e) {
      if (e instanceof SedoTemplateInvalid) {
        throw new AppError(501, 'SEDO_TEMPLATE_INVALID', `templates/sedo_template.json is invalid: ${e.message}`);
      }
      throw e;
    }
    if (!r) {
      throw new AppError(501, 'SEDO_TEMPLATE_MISSING',
        "Sedo's bulk-upload headers aren't public. Download Sedo's example file from your Sedo account and fill templates/sedo_template.json (see docs/contract/formats.md).");
    }
    return send(reply, r);
  });

  app.post<{ Params: { venue: string } }>('/export/:venue/uploaded', async (req) => {
    const venue = VENUES.find((v) => v === req.params.venue) as Venue | undefined;
    if (!venue) throw new AppError(404, 'NOT_FOUND', 'Unknown venue');
    const body = BodySchema.parse(req.body ?? {});
    return service.confirm(venue, body, { auditId: req.auditId! });
  });
}
