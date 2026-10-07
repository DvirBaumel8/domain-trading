import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { formatUsdOrNull } from '../core/money.js';
import type { CheckResult, CheckService } from '../services/check.js';
import type { EvaluatedQuote } from '../services/selection.js';
import { toJerusalemIso } from '../core/dates.js';

function presentQuote(q: EvaluatedQuote) {
  return {
    registrar: q.registrar,
    eligible: q.eligible,
    ...(q.exclusionReason ? { exclusion_reason: q.exclusionReason } : {}),
    ...(q.errorCode ? { error_code: q.errorCode } : {}),
    available: q.available,
    premium: q.premium,
    first_year_cents: q.firstYearCents,
    renewal_cents: q.renewalCents,
    privacy_cents_per_year: q.privacyCentsPerYear,
    two_year_cents: q.twoYearCents,
    first_year: formatUsdOrNull(q.firstYearCents),
    renewal: formatUsdOrNull(q.renewalCents),
    two_year: formatUsdOrNull(q.twoYearCents),
  };
}

export function presentCheck(r: CheckResult) {
  return {
    domain: r.domain,
    check_id: r.checkId,
    checked_at: toJerusalemIso(r.checkedAt),
    availability: r.availability,
    rdap: r.rdap,
    winner: r.winner && {
      registrar: r.winner.registrar,
      first_year: formatUsdOrNull(r.winner.firstYearCents), renewal: formatUsdOrNull(r.winner.renewalCents), two_year: formatUsdOrNull(r.winner.twoYearCents),
      first_year_cents: r.winner.firstYearCents, renewal_cents: r.winner.renewalCents, two_year_cents: r.winner.twoYearCents,
    },
    quotes: r.quotes.map(presentQuote),
    warnings: r.warnings,
  };
}

const Query = z.object({ domain: z.string().min(1) });

export function registerCheck(app: FastifyInstance, service: CheckService): void {
  app.get('/check', async (req) => {
    const q = Query.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'The domain query parameter is required');
    return presentCheck(await service.check(normalizeDomain(q.data.domain)));
  });
}
