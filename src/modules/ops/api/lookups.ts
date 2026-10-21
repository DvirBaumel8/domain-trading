// CR-074 (v5.29.0). The bots' RDAP lookup service: GET /rdap/:domain, POST /rdap/batch (a read-only POST: READ scope or higher, no Idempotency-Key, no audit row;
// src/http/methods.ts READ_ONLY_POSTS) and GET /lookups/usage. One cache (rdap_cache, TTL lookups_rdap_ttl_hours) shared with the internal steps; the rolling
// 24-hour limit (lookups_rdap_daily_limit) counts only the live lookups of these routes. An error is never a zero: registered is null with a reason_code.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { cacheGetMany, cachePut, cacheTtlMs, readUsage, reserveSlots, USAGE_WINDOW_MS, type CachedAnswer } from '../../../core/rdap-cache.js';
import type { RdapLookupFn } from '../../../core/rdap.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';

export const RDAP_BATCH_MAX = 500;
const LIVE_CONCURRENCY = 4;

const FreshQuery = z.object({ fresh: z.enum(['true', 'false']).optional() }).strict();
export const BatchBody = z.object({ domains: z.array(z.string().min(1).max(253)).min(1).max(RDAP_BATCH_MAX), fresh: z.boolean().optional() }).strict();

export interface RdapRow {
  domain: string; registered: boolean | null; created: string | null; expires: string | null; registrar: string | null; status: string[];
  checked_at: string; cache_age_s: number; source: 'rdap'; reason_code?: string;
}

const iso = (d: Date): string => d.toISOString();

function cachedRow(domain: string, c: CachedAnswer, nowMs: number): RdapRow {
  return {
    domain, registered: c.registered, created: c.facts?.created_at ?? null, expires: c.facts?.expires_at ?? null, registrar: c.facts?.registrar ?? null,
    status: c.facts?.statuses ?? [], checked_at: iso(c.checkedAt), cache_age_s: Math.max(0, Math.floor((nowMs - c.checkedAt.getTime()) / 1000)), source: 'rdap',
  };
}
const noAnswer = (domain: string, reason: string, nowMs: number): RdapRow => ({
  domain, registered: null, created: null, expires: null, registrar: null, status: [], checked_at: iso(new Date(nowMs)), cache_age_s: 0, source: 'rdap', reason_code: reason,
});

interface LookupsDeps { db: Kysely<Database>; now: () => number; rdapLookup: RdapLookupFn }

export function registerLookups(app: FastifyInstance, deps: LookupsDeps): void {
  const { db } = deps;

  /** One live lookup whose slot is already reserved; fills the cache with a definite answer, never with an error. */
  const live = async (domain: string): Promise<RdapRow> => {
    const r = await deps.rdapLookup(domain);
    const t = deps.now();
    if (r.outcome === 'unknown') return noAnswer(domain, r.reasonCode ?? 'SOURCE_ERROR', t);
    await cachePut(db, domain, r, t);
    return cachedRow(domain, { domain, registered: r.outcome === 'registered', facts: r.outcome === 'registered' ? r.facts : null, checkedAt: new Date(t) }, t);
  };

  const limitError = (retryAfterS: number) => new AppError(429, 'LOOKUP_LIMIT', 'The rolling 24-hour limit of live RDAP lookups is used up; cached answers are still served', { retry_after_s: retryAfterS });

  app.get<{ Params: { domain: string } }>('/rdap/:domain', async (req, reply) => {
    const q = FreshQuery.safeParse(req.query ?? {});
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${q.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
    const domain = normalizeDomain(req.params.domain);
    const now = deps.now();
    if (q.data.fresh !== 'true') {
      const hit = (await cacheGetMany(db, [domain], await cacheTtlMs(db), now)).get(domain);
      if (hit) return cachedRow(domain, hit, now);
    }
    const slot = await reserveSlots(db, now, 1, req.auth?.name ?? 'unknown');
    if (slot.granted < 1) {
      reply.header('retry-after', String(slot.retryAfterS));
      throw limitError(slot.retryAfterS);
    }
    return live(domain);
  });

  app.post('/rdap/batch', { config: { openapiBody: BatchBody } }, async (req, reply) => {
    const p = BatchBody.safeParse(req.body ?? {});
    if (!p.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid request: ${p.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`);
    const names = p.data.domains.map((d) => normalizeDomain(d));
    const unique = [...new Set(names)];
    const now = deps.now();
    const hits = p.data.fresh === true ? new Map<string, CachedAnswer>() : await cacheGetMany(db, unique, await cacheTtlMs(db), now);
    const needed = unique.filter((d) => !hits.has(d));
    const slot = needed.length > 0 ? await reserveSlots(db, now, needed.length, req.auth?.name ?? 'unknown') : null;
    const granted = slot?.granted ?? 0;
    const toAsk = needed.slice(0, granted);
    const limited = needed.slice(granted);
    // Nothing could be answered at all: no cached row and no slot. Only then is the whole call a 429.
    if (hits.size === 0 && granted === 0 && needed.length > 0) {
      reply.header('retry-after', String(slot!.retryAfterS));
      throw limitError(slot!.retryAfterS);
    }
    const byDomain = new Map<string, RdapRow>();
    for (const [d, c] of hits) byDomain.set(d, cachedRow(d, c, now));
    const queue = [...toAsk];
    await Promise.all(Array.from({ length: Math.min(LIVE_CONCURRENCY, queue.length) }, async () => {
      for (let d = queue.shift(); d !== undefined; d = queue.shift()) byDomain.set(d, await live(d));
    }));
    for (const d of limited) byDomain.set(d, noAnswer(d, 'LOOKUP_LIMIT', now));
    const rows = names.map((d) => byDomain.get(d)!);
    return {
      count: rows.length, cached_n: hits.size, live_n: toAsk.length, limit_hit: limited.length > 0,
      ...(limited.length > 0 && { retry_after_s: slot!.retryAfterS }), rows,
    };
  });

  app.get('/lookups/usage', async () => {
    const u = await readUsage(db, deps.now());
    return {
      source: 'rdap', used: u.used, limit: u.limit, remaining: Math.max(0, u.limit - u.used), window_hours: USAGE_WINDOW_MS / 3_600_000, window_start: iso(u.windowStart),
      resets_gradually: true, next_slot_at: u.nextSlotAt ? iso(u.nextSlotAt) : null,
    };
  });
}
