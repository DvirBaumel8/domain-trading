import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AfternicPushService } from '../afternic-sync.js';

const BodySchema = z.object({
  domains: z.array(z.string().min(1).max(253)).min(1).max(100).optional(),
  dry_run: z.boolean().optional(),
}).strict();

/** v5.61.0: POST /export/afternic/push (WRITE only, audited, idempotent): makes Afternic show the plan through the seller API. */
export function registerAfternicPush(app: FastifyInstance, service: AfternicPushService): void {
  app.post('/export/afternic/push', { config: { openapiBody: BodySchema } }, async (req) => {
    const body = BodySchema.parse(req.body ?? {});
    const r = await service.push(body, { auditId: req.auditId! });
    req.auditSummary = `afternic push${r.dry_run ? ' (dry run)' : ''}: ${r.pushed.length} changed, ${r.unchanged.length} equal, ${r.failed.length} failed${r.upload.recorded ? ', upload recorded' : ''}`;
    return r;
  });
}
