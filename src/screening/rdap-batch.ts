// RDAP for the screening checks: a DB cache of lookups (rdap_lookups), the IANA bootstrap (reference_files), and the pacer that
// keeps us under the per-source limits recorded in docs/internal/sources.md.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { RDAP_COM_BASE, type RdapFacts, type RdapLookup } from '../rdap.js';
import { storeEvidence } from './evidence.js';
import type { CheckContext, ScreeningDeps } from './types.js';

/** At most `concurrency` calls in flight and at least `minMsBetween` between two starts. `sleep` is injected (tests pass a no-op). */
export class Pacer {
  private active = 0;
  private waiting: (() => void)[] = [];
  private nextStart = 0;
  constructor(private readonly minMsBetween: number, private readonly concurrency: number, private readonly sleep: (ms: number) => Promise<void>) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      const t = Date.now();
      const start = Math.max(t, this.nextStart);
      this.nextStart = start + this.minMsBetween;
      if (start > t) await this.sleep(start - t);
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot over
      else this.active--;
    }
  }
}

export interface LookupOpts { maxAgeHours: number; baseUrl?: string; evidenceMaxBytes: number; pace: Pacer; now?: () => number; timeoutMs?: number }
export type CachedLookup = RdapLookup & { cached: boolean; evidenceId: number | null };

const MAX_RETRY_AFTER_MS = 10_000;

/**
 * A lookup through the cache. Only `registered` and `not_registered` rows are reused; `unknown` is never an answer. A fresh lookup
 * runs inside the pacer, retries once on a 429 whose Retry-After is at most 10 s, stores its body as evidence and its outcome as a row.
 */
export async function lookupCached(db: Kysely<Database>, deps: ScreeningDeps, domain: string, o: LookupOpts): Promise<CachedLookup> {
  const now = o.now ?? Date.now;
  if (o.maxAgeHours > 0) {
    const row = await db.selectFrom('rdap_lookups').selectAll().where('domain', '=', domain).where('outcome', '!=', 'unknown')
      .where('checked_at', '>=', new Date(now() - o.maxAgeHours * 3_600_000)).orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (row) {
      return {
        outcome: row.outcome as 'registered' | 'not_registered', reasonCode: null, httpStatus: row.http_status, url: '', retrievedAt: row.checked_at,
        body: null, facts: (row.facts as RdapFacts | null) ?? null, cached: true, evidenceId: row.evidence_id === null ? null : Number(row.evidence_id),
      };
    }
  }
  const call = () => deps.rdapLookup(domain, { baseUrl: o.baseUrl, timeoutMs: o.timeoutMs });
  const r = await o.pace.run(async () => {
    let x = await call();
    if (x.reasonCode === 'RATE_LIMITED' && x.retryAfterMs != null && x.retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await deps.sleep(x.retryAfterMs);
      x = await call();
    }
    return x;
  });
  let evidenceId: number | null = null;
  const text = r.body ?? (r.outcome === 'not_registered' ? `HTTP ${r.httpStatus}: no registration found for ${domain}` : null);
  if (text !== null) {
    evidenceId = await storeEvidence(db, { source: 'rdap', url: r.url, retrievedAt: r.retrievedAt, httpStatus: r.httpStatus, contentType: 'application/rdap+json', body: text, text, maxBytes: o.evidenceMaxBytes });
  }
  await db.insertInto('rdap_lookups').values({
    domain, outcome: r.outcome, reason_code: r.reasonCode, http_status: r.httpStatus, facts: r.facts ? JSON.stringify(r.facts) : null,
    evidence_id: evidenceId === null ? null : String(evidenceId), checked_at: new Date(now()),
  }).execute();
  return { ...r, cached: false, evidenceId };
}

// ---- IANA bootstrap ----

export const IANA_RDAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_NAME = 'iana_rdap_dns';
const BOOTSTRAP_MAX_AGE_MS = 7 * 86_400_000;

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/** TLD -> RDAP base (with a trailing slash) from a bootstrap document; throws BootstrapError on any other shape. */
export function parseBootstrap(text: string): { map: Map<string, string>; publication: string | null } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new BootstrapError('The IANA RDAP bootstrap is not JSON');
  }
  const services = (j as { services?: unknown })?.services;
  if (!Array.isArray(services) || services.length === 0) throw new BootstrapError('The IANA RDAP bootstrap has no services');
  const map = new Map<string, string>();
  for (const s of services) {
    if (!Array.isArray(s) || !Array.isArray(s[0]) || !Array.isArray(s[1])) throw new BootstrapError('The IANA RDAP bootstrap has a malformed service entry');
    const urls = (s[1] as unknown[]).filter((u): u is string => typeof u === 'string' && u.startsWith('https://'));
    for (const tld of s[0] as unknown[]) if (typeof tld === 'string' && urls[0]) map.set(tld.toLowerCase(), urls[0].replace(/\/?$/, '/'));
  }
  const pub = (j as { publication?: unknown }).publication;
  return { map, publication: typeof pub === 'string' ? pub : null };
}

const parsedBySha = new Map<string, Map<string, string>>(); // body sha256 -> parsed map (in-process)

type FileRow = Awaited<ReturnType<typeof latestBootstrap>>;
/** The newest bootstrap row (it may point at an identical older row via same_as_id). */
async function latestBootstrap(db: Kysely<Database>) {
  return db.selectFrom('reference_files').selectAll().where('name', '=', BOOTSTRAP_NAME).orderBy('fetched_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}
async function bodyOf(db: Kysely<Database>, row: NonNullable<FileRow>): Promise<Buffer | null> {
  if (row.body_gz) return row.body_gz;
  if (row.same_as_id === null) return null;
  const src = await db.selectFrom('reference_files').select('body_gz').where('id', '=', row.same_as_id).executeTakeFirst();
  return src?.body_gz ?? null;
}

/**
 * The RDAP base for a TLD. `com` is Verisign's (fixed). Others come from the IANA bootstrap kept in reference_files, fetched on demand
 * when the newest copy is older than 7 days. A failed refresh keeps serving the old copy; with no copy at all it throws BootstrapError
 * (the caller answers UNKNOWN, not "no registry"). null = the bootstrap has no entry for the TLD. `enabled` false returns null.
 */
export async function rdapBaseFor(db: Kysely<Database>, deps: ScreeningDeps, tld: string, o: { enabled: boolean; now?: () => number }): Promise<string | null> {
  if (!o.enabled) return null;
  const t = tld.toLowerCase();
  if (t === 'com') return RDAP_COM_BASE;
  const now = o.now ?? Date.now;
  let row = await latestBootstrap(db);
  if (!row || now() - row.fetched_at.getTime() > BOOTSTRAP_MAX_AGE_MS) {
    try {
      const res = await deps.fetch(IANA_RDAP_URL, { headers: { accept: 'application/json', 'user-agent': 'domain-trading-api/1.1.0 (+https://github.com/DvirBaumel8/domain-trading)' }, signal: AbortSignal.timeout(10_000) });
      if (res.status !== 200) throw new BootstrapError(`IANA bootstrap HTTP ${res.status}`);
      const text = await res.text();
      const { publication } = parseBootstrap(text);
      const sha = createHash('sha256').update(text, 'utf8').digest('hex');
      const same = row && row.sha256 === sha ? row : null;
      const sameId = same ? (same.body_gz ? same.id : same.same_as_id) : null;
      const ins = await db.insertInto('reference_files').values({
        name: BOOTSTRAP_NAME, source_url: IANA_RDAP_URL, fetched_at: new Date(now()), data_date: publication ? publication.slice(0, 10) : null,
        sha256: sha, bytes: Buffer.byteLength(text, 'utf8'), body_gz: sameId ? null : gzipSync(Buffer.from(text, 'utf8')), same_as_id: sameId,
      }).returning('id').executeTakeFirstOrThrow();
      row = await db.selectFrom('reference_files').selectAll().where('id', '=', ins.id).executeTakeFirstOrThrow();
    } catch (e) {
      if (!row) throw e instanceof BootstrapError ? e : new BootstrapError(`IANA bootstrap unavailable: ${String((e as Error).message ?? e).slice(0, 120)}`);
      // keep the stale copy
    }
  }
  const key = row!.sha256;
  let map = parsedBySha.get(key);
  if (!map) {
    const body = await bodyOf(db, row!);
    if (!body) throw new BootstrapError('The stored IANA RDAP bootstrap has no body');
    map = parseBootstrap(gunzipSync(body).toString('utf8')).map;
    parsedBySha.set(key, map);
  }
  return map.get(t) ?? null;
}

/** One pacer per run (the first check to need it creates it from `run.rdap_*`), shared by availability, census and ext_dates. */
export function sharedPacer(ctx: CheckContext): Pacer {
  const hit = ctx.shared.get('rdap_pacer') as Pacer | undefined;
  if (hit) return hit;
  const p = new Pacer(ctx.settings.run.rdap_min_ms_between, ctx.settings.run.rdap_concurrency, ctx.deps.sleep);
  ctx.shared.set('rdap_pacer', p);
  return p;
}
