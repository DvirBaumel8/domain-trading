import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import type { PayoutsService } from '../services/payouts.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => { const t = Date.parse(`${v}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v; }, 'must be a real date');
const Body = z.object({
  received_on: day,
  approval_ref: z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict().nullable().optional(),
}).strict();

export function registerPayouts(app: FastifyInstance, service: PayoutsService): void {
  app.post<{ Params: { id: string } }>('/payouts/:id/received', async (req) => {
    if (!/^[1-9]\d{0,17}$/.test(req.params.id)) throw new AppError(404, 'PAYOUT_NOT_FOUND', 'No such payout');
    const b = Body.parse(req.body ?? {});
    return service.markReceived(Number(req.params.id), b.received_on);
  });
}
