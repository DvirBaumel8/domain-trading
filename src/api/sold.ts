import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { usdStringToCents } from '../money.js';
import { ISO_WITH_OFFSET } from '../services/offers.js';
import { EVIDENCE_SOURCES, VENUES, type SoldService } from '../services/sold.js';

const usd = z.number().refine((n) => Number.isFinite(n) && /^\d+(\.\d{1,2})?$/.test(String(n)) && n <= 10_000_000, 'must be a USD amount with at most 2 decimals and at most 10,000,000');
const positive = usd.refine((n) => n > 0, 'must be > 0');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v, 'must be a real date');

const SoldSchema = z.object({
  venue: z.enum(VENUES),
  sale_price: positive,
  commission: usd,
  other_fees: usd.optional(),
  sold_at: z.string().refine((v) => ISO_WITH_OFFSET.test(v) && !Number.isNaN(Date.parse(v)), 'must be ISO 8601 with an offset'),
  payout: z.object({ amount: positive, method: z.string().min(1), fee: usd.optional(), received_on: day.nullable().optional() }).strict().optional(),
  transaction_ref: z.string().optional(),
  approval_ref: z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict().nullable().optional(),
  evidence: z.object({ source: z.enum(EVIDENCE_SOURCES), ref: z.string().refine((v) => v.trim().length > 0, 'must not be empty') }).strict().optional(),
  offer_id: z.number().int().positive().optional(),
}).strict();

const cents = (n: number) => usdStringToCents(String(n));

export function registerSold(app: FastifyInstance, service: SoldService): void {
  app.post<{ Params: { domain: string } }>('/sold/:domain', async (req) => {
    const domain = normalizeDomain(req.params.domain);
    const b = SoldSchema.parse(req.body ?? {});
    if (!b.approval_ref && (!b.transaction_ref || !b.evidence)) {
      throw new AppError(422, 'EVIDENCE_REQUIRED', 'Without approval_ref, transaction_ref and evidence {source, ref} are required');
    }
    if (b.transaction_ref?.includes('@')) throw new AppError(422, 'NO_PII', 'transaction_ref must not contain an email address');
    if (b.payout?.method.includes('@')) throw new AppError(422, 'NO_PII', 'payout.method must not contain an email address');
    if (cents(b.commission) + cents(b.other_fees ?? 0) + cents(b.payout?.fee ?? 0) > cents(b.sale_price)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'commission + other_fees + payout.fee must not exceed sale_price');
    }
    return service.sold(domain, {
      venue: b.venue, saleCents: cents(b.sale_price), commissionCents: cents(b.commission), otherFeesCents: cents(b.other_fees ?? 0),
      soldAt: new Date(b.sold_at),
      payout: b.payout ? { amountCents: cents(b.payout.amount), method: b.payout.method, feeCents: cents(b.payout.fee ?? 0), receivedOn: b.payout.received_on ?? null } : null,
      transactionRef: b.transaction_ref ?? null, approvalRef: b.approval_ref ?? null, evidence: b.evidence ?? null, offerId: b.offer_id ?? null,
    }, { auditId: req.auditId!, recordedBy: req.auth!.name });
  });
}
