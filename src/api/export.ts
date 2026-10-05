import type { FastifyInstance } from 'fastify';
import { AppError } from '../http/errors.js';
import { SedoTemplateInvalid, type ExportService } from '../services/export.js';

export function registerExport(app: FastifyInstance, service: ExportService): void {
  app.get('/export/afternic.csv', async (_req, reply) => {
    const r = await service.afternic();
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('x-manual-delist', r.delist.join(','))
      .header('x-export-warnings', r.warnings.join(';'))
      .send(r.csv);
  });

  app.get('/export/sedo.csv', async (_req, reply) => {
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
        "Sedo's bulk-upload headers aren't public. Download Sedo's example file from your Sedo account and fill templates/sedo_template.json (see docs/specs/export-csv.md).");
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('x-export-warnings', r.warnings.join(';'))
      .send(r.csv);
  });
}
