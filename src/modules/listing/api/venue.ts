// v3.7.0 (CR-031 C): POST /listings/{domain}/venue. Records a listing made by hand on a venue (or its removal there), as shown on the venue. Append-only.
// The service never calls a venue; this only keeps what the bots saw. The walk-away is never accepted (strict schemas refuse any unknown field).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { isIsoWithOffset, isRealDate, toJerusalemIso } from '../../../core/dates.js';
import { dollarsToCents, pair } from '../../../core/money.js';
import { assertNoteNoPii } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';

const FUTURE_SKEW_MS = 5 * 60_000;

const Shown = z.object({
  mode: z.string().regex(/^[a-z_]{1,30}$/, 'mode is lower-case letters and underscores'),
  price_usd: z.number().nullable().optional(),
  min_offer_usd: z.number().nullable().optional(),
}).strict();

const VenueBody = z.object({
  venue: z.enum(['afternic', 'sedo']),
  listed_at: z.string(),
  shown: Shown.optional(),
  evidence: z.object({ source: z.string().min(1).max(100), ref: z.string().min(1).max(300) }).strict().optional(),
  note: z.string().max(500).nullable().optional(),
  delisted: z.boolean().optional(),
}).strict();

const cents = (n: number | null | undefined, field: string): number | null => {
  if (n == null) return null;
  try { return dollarsToCents(n); } catch { throw new AppError(422, 'VALIDATION_ERROR', `${field} must be a positive USD amount with at most 2 decimals`); }
};

export function registerVenue(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.post<{ Params: { domain: string } }>('/listings/:domain/venue', { config: { openapiBody: VenueBody } }, async (req, reply) => {
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const b = VenueBody.parse(req.body ?? {});
    if (!isIsoWithOffset(b.listed_at) || !isRealDate(b.listed_at.slice(0, 10))) throw new AppError(422, 'VALIDATION_ERROR', 'listed_at must be a real ISO 8601 time with an offset');
    const listedAt = new Date(b.listed_at);
    if (listedAt.getTime() > deps.now() + FUTURE_SKEW_MS) throw new AppError(422, 'VALIDATION_ERROR', 'listed_at must not be in the future');
    assertNoteNoPii(b.note);
    const delisted = b.delisted === true;
    if (!b.shown && !delisted) throw new AppError(422, 'VALIDATION_ERROR', 'shown {mode, price_usd, min_offer_usd} is required unless delisted is true');
    const d = await deps.db.selectFrom('domains').select(['id', 'status']).where('domain', '=', domain).executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    const price = cents(b.shown?.price_usd, 'shown.price_usd');
    const minOffer = cents(b.shown?.min_offer_usd, 'shown.min_offer_usd');
    const row = await deps.db.insertInto('venue_listings').values({
      domain, venue: b.venue, listed_at: listedAt, delisted, mode: b.shown?.mode ?? 'delisted', price_cents: price, min_offer_cents: minOffer,
      evidence: b.evidence ? JSON.stringify(b.evidence) : null, note: b.note ?? null, token_name: req.auth?.name ?? null, audit_id: req.auditId ?? null,
    }).returningAll().executeTakeFirstOrThrow();
    return reply.code(201).send({
      id: row.id, domain, venue: row.venue, listed_at: toJerusalemIso(row.listed_at), delisted: row.delisted,
      shown: delisted && !b.shown ? null : { mode: row.mode, ...pair('price', row.price_cents), ...pair('min_offer', row.min_offer_cents) },
      evidence: row.evidence, note: row.note, audit_id: row.audit_id,
    });
  });
}
