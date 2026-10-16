// v5.8.0 (CR-059): POST /portfolio/import, the Line 2 (S8 aftermarket) import. Dvir bought an existing .com on a registrar website (closeout, fixed price or public auction);
// this records it (domain row with lane S8, purchase ledger row, plan) without any registrar or marketplace call except the read-only lookup of an enabled adapter.
// The logic is `importDomain` (also the admin `import-domain` command); the caps (price, slots) come from the settings row (migration only).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { checkApproval } from '../../../core/approval.js';
import { dollarsToCents } from '../../../core/money.js';
import { approvalRef } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import type { RegistrarAdapter } from '../../registrars/index.js';
import { ImportInputError, importDomain } from '../admin/import-domain.js';

export const S8_SOURCES = ['closeout', 'fixed', 'auction'] as const;
/** Backorder / catch services: never a registrar or a source of an S8 name (Dvir, 14 Oct 2026). */
const BACKORDER = ['namejet', 'snapnames', 'dropcatch'];
const isBackorder = (v: string): boolean => BACKORDER.includes(v.toLowerCase().replace(/[^a-z0-9]/g, ''));

const Usd = z.number().positive();
const ImportBody = z.object({
  domain: z.string().min(1),
  approval_ref: approvalRef,
  lane: z.literal('S8'),
  registrar: z.string().trim().min(1).max(40),
  source: z.string().trim().min(1).max(40),
  price_paid: Usd,
  buy_date: z.string(),
  expiry_date: z.string().optional(),
  category: z.string().nullable().optional(),
  price_grade: z.enum(['strong', 'weaker']).nullable().optional(),
  comps_value: Usd.optional(),
  bin_override: z.number().int().positive().optional(),
  floor_override: z.number().int().positive().optional(),
  pricing_evidence: z.unknown().optional(),
  renewal_price: Usd.optional(),
  order: z.string().trim().min(1).max(80).optional(),
  deal_id: z.string().regex(/^D-\d{3,}$/).nullable().optional(),
  dry_run: z.boolean().optional(),
}).strict();

/** The whole-dollar amounts a text names as `$3,488`, `$3488`, `$3,488.00` or `$3488.00` (in cents); `$13,488` or `$34,880` is not `$3,488`. */
export function namedAmountsCents(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d|,\d|\.\d)/g)) {
    out.add(Number(m[1]!.replace(/,/g, '')) * 100 + Number(m[2] ?? 0));
  }
  return out;
}

function cents(n: number, field: string): number {
  try {
    return dollarsToCents(n);
  } catch {
    throw new AppError(422, 'VALIDATION_ERROR', `${field} must be a positive USD amount with at most 2 decimals`);
  }
}

export function registerPortfolioImport(app: FastifyInstance, deps: { db: Kysely<Database>; adapters: RegistrarAdapter[]; now: () => number }): void {
  app.post('/portfolio/import', { config: { openapiBody: ImportBody } }, async (req, reply) => {
    const b = ImportBody.parse(req.body ?? {});
    const now = new Date(deps.now());
    const domain = normalizeDomain(b.domain);
    const cfg = await deps.db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
    const appr = checkApproval(b.approval_ref ?? null, domain, now, cfg.approval_max_age_hours);
    if (!appr.ok) throw new AppError(422, appr.code, appr.reason);

    if (isBackorder(b.source) || isBackorder(b.registrar)) {
      throw new AppError(400, 'BACKORDER_SOURCE_REFUSED', 'NameJet, SnapNames and DropCatch (backorder and catch services) are not accepted as a registrar or a source');
    }
    if (!(S8_SOURCES as readonly string[]).includes(b.source)) {
      throw new AppError(400, 'S8_SOURCE_INVALID', 'source must be closeout, fixed or auction', { allowed: [...S8_SOURCES] });
    }
    if (!domain.endsWith('.com') || domain.split('.').length !== 2) throw new AppError(422, 'VALIDATION_ERROR', 'Only .com names');

    // CR-060: an approved BIN / floor must be named in Dvir's approval line
    const named = namedAmountsCents(String(b.approval_ref?.text));
    for (const [field, v] of [['bin_override', b.bin_override], ['floor_override', b.floor_override]] as const) {
      if (v !== undefined && !named.has(v)) {
        throw new AppError(422, 'APPROVAL_INVALID', `approval_ref.text must name the ${field} price ($${(v / 100).toLocaleString('en-US')}) as a dollar amount`, { override: field, [`${field}_cents`]: v });
      }
    }
    if (b.bin_override !== undefined && b.floor_override !== undefined && b.floor_override > b.bin_override) {
      throw new AppError(422, 'VALIDATION_ERROR', 'floor_override must not be above bin_override');
    }

    const registrar = b.registrar.toLowerCase();
    const manual = !deps.adapters.some((a) => a.name === registrar);
    const dollars = (n: number | undefined, f: string) => (n === undefined ? undefined : (cents(n, f) / 100).toFixed(2));
    let r;
    try {
      r = await importDomain(deps.db, {
        domain, registrar, buyDate: b.buy_date, cost: dollars(b.price_paid, 'price_paid')!, order: b.order, deal: b.deal_id ?? undefined,
        category: b.category ?? undefined, grade: b.price_grade ?? undefined, evidence: b.pricing_evidence as { comps?: unknown; rationale?: unknown } | null | undefined,
        approvalText: String(b.approval_ref?.text), approvalAt: String(b.approval_ref?.approved_at),
        manual, expiry: b.expiry_date, renewalPrice: dollars(b.renewal_price, 'renewal_price'),
        lane: 'S8', s8Source: b.source, compsValueCents: b.comps_value === undefined ? undefined : cents(b.comps_value, 'comps_value'),
        binOverrideCents: b.bin_override, floorOverrideCents: b.floor_override,
        dryRun: b.dry_run === true, auditId: req.auditId ?? undefined,
      }, { adapters: deps.adapters, now });
    } catch (e) {
      if (e instanceof ImportInputError) throw new AppError(422, 'VALIDATION_ERROR', e.message);
      throw e;
    }
    return reply.code(b.dry_run === true ? 200 : 201).send({ ...r, audit_id: req.auditId ?? null });
  });
}
