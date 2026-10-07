import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { requestHash } from '../http/idempotency.js';
import { dollarsToCents } from '../money.js';
import type { BuyService } from '../services/buy.js';

const Listing = z.object({
  mode: z.string(),
  bin: z.number().nullable().optional(),
  floor: z.number().nullable().optional(),
  walkaway: z.number().nullable().optional(),
  min_offer: z.number().nullable().optional(),
  lto_max_months: z.number().int().nullable().optional(),
  pricing_exception: z.boolean().nullable().optional(),
  pricing_exception_reason: z.string().nullable().optional(),
}).strict();

const BuyBody = z.object({
  domain: z.string().min(1),
  max_price: z.number(),
  max_two_year_price: z.number().nullable().optional(),
  approval_ref: z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict().nullable().optional(),
  deal_id: z.string().regex(/^D-\d{3,}$/).nullable().optional(),
  category: z.string().nullable().optional(),
  price_grade: z.enum(['strong', 'weaker']).nullable().optional(),
  pricing_evidence: z.unknown().optional(),
  expected_settings_version: z.number().int().nullable().optional(),
  proposed_listing: Listing.nullable().optional(),
  override: z.boolean().optional(),
  override_reason: z.string().nullable().optional(),
  registrar: z.string().nullable().optional(),
  dry_run: z.union([z.boolean(), z.literal('strict')]).optional(),
  auto_list: z.boolean().optional(),
}).strict();

function cents(n: number, field: string): number {
  try {
    return dollarsToCents(n);
  } catch {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} must be a positive USD amount with at most 2 decimals`);
  }
}

export function registerBuy(app: FastifyInstance, service: BuyService): void {
  app.post('/buy', async (req, reply) => {
    const b = BuyBody.parse(req.body);
    const domain = normalizeDomain(b.domain);
    const r = await service.buy(
      {
        domain,
        maxPriceCents: cents(b.max_price, 'max_price'),
        maxTwoYearCents: b.max_two_year_price == null ? null : cents(b.max_two_year_price, 'max_two_year_price'),
        approval: b.approval_ref ?? null,
        dealId: b.deal_id ?? null,
        category: b.category ?? null,
        priceGrade: b.price_grade ?? null,
        pricingEvidence: b.pricing_evidence ?? null,
        expectedSettingsVersion: b.expected_settings_version ?? null,
        proposedListing: b.proposed_listing ?? null,
        override: b.override ?? false,
        overrideReason: b.override_reason ?? null,
        registrar: b.registrar ?? null,
        dryRun: b.dry_run === true || b.dry_run === 'strict',
        strictDry: b.dry_run === 'strict',
        autoList: b.auto_list ?? true,
        requestBody: req.body,
      },
      {
        idempotencyKey: req.headers['idempotency-key'] as string,
        requestHash: requestHash(req.method, req.url, req.body),
        auditId: req.auditId!,
      },
    );
    return reply.code(r.status).send(r.body);
  });
}
