import { approvalRef } from '../core/validation.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../domain-name.js';
import type { ListService } from '../services/list.js';

const ListBodySchema = z.object({
  mode: z.string().nullable().optional(),
  bin: z.number().nullable().optional(),
  floor: z.number().nullable().optional(),
  walkaway: z.number().nullable().optional(),
  min_offer: z.number().nullable().optional(),
  lto_max_months: z.number().nullable().optional(),
  pricing_exception: z.boolean().nullable().optional(),
  pricing_exception_reason: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  price_grade: z.enum(['strong', 'weaker']).nullable().optional(),
  replan: z.boolean().optional(),
  pricing_hold: z.boolean().nullable().optional(),
  pricing_hold_reason: z.string().nullable().optional(),
  override: z.boolean().optional(),
  override_reason: z.string().nullable().optional(),
  lander: z.string().optional(),
  ns: z.array(z.string()).nullable().optional(),
  display_name: z.string().nullable().optional(),
  dry_run: z.boolean().optional(),
  approval_ref: approvalRef,
}).strict();

export function registerList(app: FastifyInstance, service: ListService): void {
  app.post<{ Params: { domain: string } }>('/list/:domain', async (req) => {
    const domain = normalizeDomain(req.params.domain);
    const body = ListBodySchema.parse(req.body ?? {});
    return service.list(domain, body, { auditId: req.auditId! });
  });
}
