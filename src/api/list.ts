import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../domain-name.js';
import type { ListService } from '../services/list.js';

const ListBodySchema = z.object({
  mode: z.string().nullable().optional(),
  bin: z.number().nullable().optional(),
  floor: z.number().nullable().optional(),
  min_offer: z.number().nullable().optional(),
  lto_max_months: z.number().nullable().optional(),
  category: z.string().nullable().optional(),
  override: z.boolean().optional(),
  override_reason: z.string().nullable().optional(),
  lander: z.string().optional(),
  ns: z.array(z.string()).nullable().optional(),
  display_name: z.string().nullable().optional(),
  dry_run: z.boolean().optional(),
  approval_ref: z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict().nullable().optional(),
}).strict();

export function registerList(app: FastifyInstance, service: ListService): void {
  app.post<{ Params: { domain: string } }>('/list/:domain', async (req) => {
    const domain = normalizeDomain(req.params.domain);
    const body = ListBodySchema.parse(req.body ?? {});
    return service.list(domain, { ...body, mode: body.mode ?? undefined }, { auditId: req.auditId! });
  });
}
