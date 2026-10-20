// v3.7.0 (CR-031 C): POST /listings/{domain}/venue. Records a listing made by hand on a venue (or its removal there), as shown on the venue. Append-only.
// The service never calls a venue; this only keeps what the bots saw. The walk-away is never accepted (strict schemas refuse any unknown field).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { isIsoWithOffset, isRealDate, toJerusalemIso } from '../../../core/dates.js';
import { apiCents, pair, usdStringToCents } from '../../../core/money.js';
import { assertNoteNoPii } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { changedColumns } from '../export-state.js';
import { isValidDisplayName } from '../../../domain-name.js';

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
  // v5.27.0 (CR-076): what the record is. A WRITE call is `ours_confirmed` unless it says `unknown`; `observed_public` has its own route (POST /listings/{domain}/observed).
  provenance: z.enum(['ours_confirmed', 'unknown']).optional(),
}).strict();

// v5.27.0 (CR-076 R-2): a public sighting. No `provenance` key: the strict schema refuses it (422), the row is always `observed_public`.
const ObservedBody = z.object({
  venue: z.enum(['afternic', 'sedo']),
  price_usd: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/, 'price_usd must be a USD amount string like "1488" or "1488.00"'),
  url: z.string().min(1).max(500).regex(/^https?:\/\/\S+$/, 'url must be an http(s) URL'),
  seen_at: z.string(),
  dry_run: z.boolean().optional(),
}).strict();

const DisplayNameBody = z.object({ display_name: z.string().min(1).max(100) }).strict();

const cents = (n: number | null | undefined, field: string): number | null => (n == null ? null : apiCents(n, field));

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
      evidence: b.evidence ? JSON.stringify(b.evidence) : null, note: b.note ?? null, provenance: b.provenance ?? 'ours_confirmed', token_name: req.auth?.name ?? null, audit_id: req.auditId ?? null,
    }).returningAll().executeTakeFirstOrThrow();
    return reply.code(201).send({
      id: row.id, domain, venue: row.venue, listed_at: toJerusalemIso(row.listed_at), delisted: row.delisted,
      shown: delisted && !b.shown ? null : { mode: row.mode, ...pair('price', row.price_cents), ...pair('min_offer', row.min_offer_cents) },
      evidence: row.evidence, note: row.note, provenance: row.provenance, audit_id: row.audit_id,
    });
  });

  // v5.27.0 (CR-076 R-2): log a sighting on a public page. Touches only venue_listings: never the listing, the price, an export, the plan, listing_history or listed_venues.
  app.post<{ Params: { domain: string } }>('/listings/:domain/observed', { config: { openapiBody: ObservedBody } }, async (req, reply) => {
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const b = ObservedBody.parse(req.body ?? {});
    if (!isIsoWithOffset(b.seen_at) || !isRealDate(b.seen_at.slice(0, 10))) throw new AppError(422, 'VALIDATION_ERROR', 'seen_at must be a real ISO 8601 time with an offset');
    const seenAt = new Date(b.seen_at);
    if (seenAt.getTime() > deps.now() + FUTURE_SKEW_MS) throw new AppError(422, 'VALIDATION_ERROR', 'seen_at must not be in the future');
    const priceCents = usdStringToCents(b.price_usd);
    if (priceCents <= 0) throw new AppError(422, 'VALIDATION_ERROR', 'price_usd must be above zero');
    const d = await deps.db.selectFrom('domains').select(['id', 'status']).where('domain', '=', domain).executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    const out = { domain, venue: b.venue, provenance: 'observed_public' as const, ...pair('seen_price', priceCents), seen_url: b.url, seen_at: toJerusalemIso(seenAt) };
    if (b.dry_run === true) {
      req.auditSummary = `observed ${domain} on ${b.venue} (dry run)`;
      return reply.code(200).send({ dry_run: true, ...out, id: null, audit_id: req.auditId ?? null });
    }
    const row = await deps.db.insertInto('venue_listings').values({
      domain, venue: b.venue, listed_at: seenAt, mode: 'observed', price_cents: null, min_offer_cents: null, evidence: null, note: null,
      provenance: 'observed_public', seen_price_cents: priceCents, seen_url: b.url, seen_at: seenAt, token_name: req.auth?.name ?? null, audit_id: req.auditId ?? null,
    }).returning('id').executeTakeFirstOrThrow();
    req.auditSummary = `observed ${domain} on ${b.venue}`;
    return reply.code(201).send({ id: row.id, ...out, audit_id: req.auditId ?? null });
  });

  // v5.27.0 (CR-076 R-5): set the capitalised name for the marketplace files. Same letters only. It is in the export rows, so a listed name is flagged for the next export like any plan change.
  app.post<{ Params: { domain: string } }>('/portfolio/:domain/display-name', { config: { openapiBody: DisplayNameBody } }, async (req, reply) => {
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const b = DisplayNameBody.parse(req.body ?? {});
    const d = await deps.db.selectFrom('domains').select(['id', 'status']).where('domain', '=', domain).executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    if (!isValidDisplayName(domain, b.display_name)) throw new AppError(422, 'DISPLAY_NAME_MISMATCH', 'display_name must be the domain with different ASCII capitalisation only', { domain, display_name: b.display_name });
    const now = new Date(deps.now());
    const result = await deps.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('domains').select(['id', 'status', 'display_name', 'export_pending_since']).where('id', '=', d.id).forUpdate().executeTakeFirstOrThrow();
      if (cur.display_name === b.display_name) return { changed: false, flagged: false };
      const flag = cur.status === 'listed';
      await trx.updateTable('domains').set({ display_name: b.display_name, ...(flag ? changedColumns(cur, now) : {}), updated_at: now }).where('id', '=', cur.id).execute();
      return { changed: true, flagged: flag };
    });
    req.auditSummary = `display name ${domain} = ${b.display_name}${result.changed ? '' : ' (unchanged)'}`;
    return reply.code(200).send({ domain, display_name: b.display_name, changed: result.changed, export_pending: result.flagged, audit_id: req.auditId ?? null });
  });
}
