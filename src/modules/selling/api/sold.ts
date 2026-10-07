import { approvalRef, hasAtSign, piiError } from '../../../core/validation.js';
import { isoWithOffset } from '../../../core/dates.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { usdStringToCents } from '../../../core/money.js';
import { EVIDENCE_SOURCES, VENUES, type SoldService } from '../sold.js';

const usd = z.number().refine((n) => Number.isFinite(n) && /^\d+(\.\d{1,2})?$/.test(String(n)) && n <= 10_000_000, 'must be a USD amount with at most 2 decimals and at most 10,000,000');
const positive = usd.refine((n) => n > 0, 'must be > 0');

const SoldSchema = z.object({
  venue: z.enum(VENUES),
  sale_price: positive,
  commission: usd,
  other_fees: usd.optional(),
  sold_at: isoWithOffset,
  payout_fee: usd.optional(),
  transaction_ref: z.string().optional(),
  approval_ref: approvalRef,
  evidence: z.object({ source: z.enum(EVIDENCE_SOURCES), ref: z.string().refine((v) => v.trim().length > 0, 'must not be empty').refine((v) => v.length <= 200, 'at most 200 characters') }).strict().optional(),
  offer_id: z.number().int().positive().optional(),
}).strict();

const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;
const cents = (n: number) => usdStringToCents(String(n));

export function registerSold(app: FastifyInstance, service: SoldService): void {
  app.post<{ Params: { domain: string } }>('/sold/:domain', async (req) => {
    const domain = normalizeDomain(req.params.domain);
    const b = SoldSchema.parse(req.body ?? {});
    if (!b.approval_ref && (!b.transaction_ref || !b.evidence)) {
      throw new AppError(422, 'EVIDENCE_REQUIRED', 'Without approval_ref, transaction_ref and evidence {source, ref} are required');
    }
    if (hasAtSign(b.transaction_ref)) throw piiError('transaction_ref must not contain an email address');
    if (cents(b.commission) + cents(b.other_fees ?? 0) + cents(b.payout_fee ?? 0) > cents(b.sale_price)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'commission + other_fees + payout_fee must not exceed sale_price');
    }
    if (b.evidence) {
      const email = b.evidence.source.endsWith('_email');
      if (email ? !MESSAGE_ID.test(b.evidence.ref) : b.evidence.ref.includes('@')) {
        throw piiError(email ? 'evidence.ref must be a Message-ID like <id@host>' : 'evidence.ref must not contain @');
      }
    }
    return service.sold(domain, {
      venue: b.venue, saleCents: cents(b.sale_price), commissionCents: cents(b.commission), otherFeesCents: cents(b.other_fees ?? 0),
      soldAt: new Date(b.sold_at),
      payoutFeeCents: cents(b.payout_fee ?? 0),
      transactionRef: b.transaction_ref ?? null, approvalRef: b.approval_ref ?? null, evidence: b.evidence ?? null, offerId: b.offer_id ?? null,
    }, { auditId: req.auditId!, recordedBy: req.auth!.name });
  });
}
