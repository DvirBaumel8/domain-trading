// The routes that read outside sources. GET only. A missing key is 503, a failing source is 502: never an empty or good answer.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pair } from '../core/money.js';
import { toJerusalemIso } from '../core/dates.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import type { Config } from '../config.js';
import type { State } from '../state.js';
import { afternicListings, afternicSales } from './afternic.js';
import { auctionLookup, MAX_NAMES } from './auctions.js';
import { SourceError, type Fetch } from './client.js';
import { domainStatuses } from './domain-status.js';
import { trademarkStatus } from './tsdr.js';

const details = (e: SourceError) => ({ source: e.source, reason: e.code, http_status: e.httpStatus, source_code: e.sourceCode });

export function registerSources(app: FastifyInstance, deps: { config: Config; state: State; now: () => number; fetchFn: Fetch }): void {
  const { config: { sources: keys, porkbun }, state, fetchFn } = deps;
  const checkedAt = () => ({ checked_at: toJerusalemIso(new Date(deps.now())) });
  const read = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      app.log.warn(details(e), 'source failed');
      throw e.code === 'KEY_MISSING'
        ? new AppError(503, 'SOURCE_KEY_MISSING', `No key is set for ${e.source}`, details(e))
        : new AppError(502, 'SOURCE_ERROR', `${e.source} did not give a usable answer`, details(e));
    }
  };

  app.get('/registrar-status', async () => {
    const rows = await domainStatuses(state.domains, { porkbun, godaddyPat: keys.godaddyPat }, fetchFn);
    return {
      ...checkedAt(),
      domains: rows.map(({ domain, registrar, status, error }) => {
        const recorded = state.domains.find((d) => d.domain === domain)!.expiry_date;
        return {
          domain, registrar, status: error ? (error.code === 'KEY_MISSING' ? 'missing_key' : 'error') : 'ok', error: error && details(error),
          expiry_date: status?.expiryDate ?? null, recorded_expiry_date: recorded, expiry_matches: status && status.expiryDate === recorded,
          auto_renew: status?.autoRenew ?? null, locked: status?.locked ?? null, nameservers: status?.nameservers ?? null,
        };
      }),
    };
  });

  app.get('/listings', async () => {
    const rows = await read(() => afternicListings(keys.afternic, fetchFn));
    return { ...checkedAt(), listings: rows.map(({ buy_now_cents, floor_cents, min_offer_cents, ...r }) => ({ ...r, ...pair('buy_now', buy_now_cents), ...pair('floor', floor_cents), ...pair('min_offer', min_offer_cents) })) };
  });

  app.get('/sales', async () => {
    const rows = await read(() => afternicSales(keys.afternic, fetchFn));
    return { ...checkedAt(), sales: rows.map(({ price_cents, commission_cents, ...r }) => ({ ...r, ...pair('price', price_cents), ...pair('commission', commission_cents) })) };
  });

  app.get('/auctions', async (req) => {
    const q = z.object({ domains: z.string().min(1) }).safeParse(req.query);
    const names = q.success ? [...new Set(q.data.domains.split(',').map((d) => normalizeDomain(d.trim())))] : [];
    if (names.length === 0 || names.length > MAX_NAMES) throw new AppError(400, 'VALIDATION_ERROR', `domains: 1 to ${MAX_NAMES} names, separated by commas`);
    const rows = await read(() => auctionLookup(names, keys.godaddyAuctions, fetchFn));
    return { ...checkedAt(), auctions: rows.map(({ price_cents, next_bid_cents, renewal_cents, transfer_cents, ...r }) => ({ ...r, ...pair('price', price_cents), ...pair('next_bid', next_bid_cents), ...pair('renewal', renewal_cents), ...pair('transfer', transfer_cents) })) };
  });

  app.get<{ Params: { serial: string } }>('/trademarks/:serial', async (req) => {
    if (!/^\d{8}$/.test(req.params.serial)) throw new AppError(400, 'VALIDATION_ERROR', 'serial: 8 digits');
    return { ...checkedAt(), ...(await read(() => trademarkStatus(req.params.serial, keys.uspto, fetchFn))) };
  });
}
