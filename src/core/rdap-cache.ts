// CR-074 (v5.29.0): the one RDAP cache (table rdap_cache) and the rolling 24-hour usage log of the bots' live lookups (lookup_usage).
// The bot routes (GET /rdap/:domain, POST /rdap/batch) and the internal steps share the cache. Only the bot routes use the usage log, so
// the internal daily steps never count against the bot limit. An error answer (TIMEOUT, RATE_LIMITED, SOURCE_ERROR) is never cached.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { chunks } from './chunks.js';
import type { RdapFacts, RdapLookup, RdapLookupFn } from './rdap.js';

export const USAGE_WINDOW_MS = 24 * 3_600_000;
const USAGE_KEEP_MS = 7 * 86_400_000;
const LOCK_KEY = 'lookup_usage:rdap';

export interface CachedAnswer { domain: string; registered: boolean; facts: RdapFacts | null; checkedAt: Date }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The stored answers newer than `ttlMs` for these names (one query). A TTL of 0 or less returns none. */
export async function cacheGetMany(db: Kysely<Database>, domains: string[], ttlMs: number, nowMs: number): Promise<Map<string, CachedAnswer>> {
  const out = new Map<string, CachedAnswer>();
  if (domains.length === 0 || !(ttlMs > 0)) return out;
  const rows = [];
  for (const part of chunks([...new Set(domains)], 5_000)) {
    rows.push(...await db.selectFrom('rdap_cache').selectAll().where('domain', 'in', part).where('registered', 'is not', null)
      .where('checked_at', '>=', new Date(nowMs - ttlMs)).execute());
  }
  for (const r of rows) {
    out.set(r.domain, {
      domain: r.domain, registered: r.registered === true, checkedAt: r.checked_at,
      facts: r.registered === true ? { registrar: r.registrar, created_at: iso(r.created), expires_at: iso(r.expires), updated_at: iso(r.updated_at), statuses: r.statuses, nameservers: r.nameservers } : null,
    });
  }
  return out;
}

/** Stores a definite answer (registered / not_registered). An unknown answer is ignored: nothing is written. */
export async function cachePut(db: Kysely<Database>, domain: string, r: RdapLookup, nowMs: number): Promise<void> {
  if (r.outcome === 'unknown') return;
  const f = r.outcome === 'registered' ? r.facts : null;
  const row = {
    domain, registered: r.outcome === 'registered', created: f?.created_at ?? null, expires: f?.expires_at ?? null, registrar: f?.registrar ?? null,
    statuses: f?.statuses ?? [], nameservers: f?.nameservers ?? [], updated_at: f?.updated_at ?? null, checked_at: new Date(nowMs), reason_code: null,
  };
  await db.insertInto('rdap_cache').values(row)
    .onConflict((oc) => oc.column('domain').doUpdateSet((eb) => ({
      registered: eb.ref('excluded.registered'), created: eb.ref('excluded.created'), expires: eb.ref('excluded.expires'), registrar: eb.ref('excluded.registrar'),
      statuses: eb.ref('excluded.statuses'), nameservers: eb.ref('excluded.nameservers'), updated_at: eb.ref('excluded.updated_at'), checked_at: eb.ref('excluded.checked_at'), reason_code: eb.ref('excluded.reason_code'),
    }))).execute();
}

/** v5.42.0: stores many definite answers with multi-row upserts (500 a statement). Unknown answers are skipped; a repeated domain keeps its last answer. */
export async function cachePutMany(db: Kysely<Database>, entries: Array<{ domain: string; r: RdapLookup }>, nowMs: number): Promise<void> {
  const last = new Map<string, RdapLookup>();
  for (const e of entries) if (e.r.outcome !== 'unknown') last.set(e.domain, e.r);
  const rows = [...last.entries()].map(([domain, r]) => {
    const f = r.outcome === 'registered' ? r.facts : null;
    return {
      domain, registered: r.outcome === 'registered', created: f?.created_at ?? null, expires: f?.expires_at ?? null, registrar: f?.registrar ?? null,
      statuses: f?.statuses ?? [], nameservers: f?.nameservers ?? [], updated_at: f?.updated_at ?? null, checked_at: new Date(nowMs), reason_code: null,
    };
  });
  for (const part of chunks(rows, 500)) {
    await db.insertInto('rdap_cache').values(part)
      .onConflict((oc) => oc.column('domain').doUpdateSet((eb) => ({
        registered: eb.ref('excluded.registered'), created: eb.ref('excluded.created'), expires: eb.ref('excluded.expires'), registrar: eb.ref('excluded.registrar'),
        statuses: eb.ref('excluded.statuses'), nameservers: eb.ref('excluded.nameservers'), updated_at: eb.ref('excluded.updated_at'), checked_at: eb.ref('excluded.checked_at'), reason_code: eb.ref('excluded.reason_code'),
      }))).execute();
  }
}

/** A stored answer as the lookup result the callers expect. */
export const lookupFromCache = (c: CachedAnswer): RdapLookup => ({
  outcome: c.registered ? 'registered' : 'not_registered', reasonCode: null, httpStatus: c.registered ? 200 : 404, url: '', retrievedAt: c.checkedAt, body: null, facts: c.facts,
});

const fromCache = (c: CachedAnswer): RdapLookup => ({
  outcome: c.registered ? 'registered' : 'not_registered', reasonCode: null, httpStatus: c.registered ? 200 : 404, url: '', retrievedAt: c.checkedAt, body: null, facts: c.facts,
});

/**
 * An internal step's lookup through the cache. `ttlMs` > 0 reads a stored answer first; `fresh` (or ttlMs 0) always asks the registry. Either way a definite
 * live answer fills the cache. Never counts against the bot limit. A failure to read or write the cache never fails the lookup (it falls back to the live call).
 */
export function cachedRdapLookup(db: Kysely<Database>, base: RdapLookupFn, o: { now: () => number; ttlMs: number }): RdapLookupFn {
  return async (domain, opts) => {
    if (o.ttlMs > 0) {
      try {
        const hit = (await cacheGetMany(db, [domain], o.ttlMs, o.now())).get(domain);
        if (hit) return fromCache(hit);
      } catch { /* fall through to the live lookup */ }
    }
    const r = await base(domain, opts);
    try { await cachePut(db, domain, r, o.now()); } catch { /* the cache is an optimisation */ }
    return r;
  };
}

/** The TTL setting in milliseconds. */
export async function cacheTtlMs(db: Kysely<Database>): Promise<number> {
  const s = await db.selectFrom('settings').select('lookups_rdap_ttl_hours').executeTakeFirstOrThrow();
  return s.lookups_rdap_ttl_hours * 3_600_000;
}

export interface Usage { used: number; limit: number; windowStart: Date; nextSlotAt: Date | null }

async function usageOf(db: Kysely<Database>, nowMs: number): Promise<Usage> {
  const windowStart = new Date(nowMs - USAGE_WINDOW_MS);
  const [s, u] = await Promise.all([
    db.selectFrom('settings').select('lookups_rdap_daily_limit').executeTakeFirstOrThrow(),
    sql<{ used: string; oldest: Date | null }>`select count(*)::text as used, min(at) as oldest from lookup_usage where source = 'rdap' and at > ${windowStart} and at <= ${new Date(nowMs)}`.execute(db),
  ]);
  const row = u.rows[0]!;
  return { used: Number(row.used), limit: s.lookups_rdap_daily_limit, windowStart, nextSlotAt: row.oldest ? new Date(row.oldest.getTime() + USAGE_WINDOW_MS) : null };
}

export const readUsage = usageOf;

/**
 * Takes up to `want` live-lookup slots for a bot call, atomically: a transaction under an advisory lock counts the rows of the last 24 hours (UTC timestamps,
 * so no midnight reset), inserts the granted rows and commits before any lookup runs. Two calls at once can never together pass the limit.
 * A slot is spent even if the lookup then times out (the registry was asked). Old rows (7 days) are deleted here.
 */
export async function reserveSlots(db: Kysely<Database>, nowMs: number, want: number, by: string): Promise<{ granted: number; retryAfterS: number; usage: Usage }> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`.execute(trx);
    await sql`delete from lookup_usage where at < ${new Date(nowMs - USAGE_KEEP_MS)}`.execute(trx);
    const u = await usageOf(trx, nowMs);
    const granted = Math.max(0, Math.min(want, u.limit - u.used));
    if (granted > 0) {
      await sql`insert into lookup_usage (source, at, by_token) select 'rdap', ${new Date(nowMs)}, ${by} from generate_series(1, ${granted}::int)`.execute(trx);
    }
    const next = granted > 0 ? await usageOf(trx, nowMs) : u;
    const retryAfterS = next.nextSlotAt ? Math.max(1, Math.ceil((next.nextSlotAt.getTime() - nowMs) / 1000)) : USAGE_WINDOW_MS / 1000;
    return { granted, retryAfterS, usage: next };
  });
}
