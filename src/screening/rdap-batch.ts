// RDAP for the screening checks: a DB cache of lookups (rdap_lookups), the IANA bootstrap (reference_files), and the pacer that
// keeps us under the per-source limits recorded in docs/internal/sources.md.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { RDAP_COM_BASE, USER_AGENT, type RdapFacts, type RdapLookup } from '../rdap.js';
import { storeEvidence } from './evidence.js';
import type { CheckContext, ScreeningDeps } from './types.js';

export const TEST_SET_RDAP_CONCURRENCY = 4;
export const TEST_SET_RDAP_MIN_MS = 250;
/** Adaptive slow-down (v2.7.0): each 429 or refusal doubles the gap up to this cap; after two of them concurrency drops to 1. */
export const RDAP_MAX_MIN_MS = 4000;
/** v2.11.1 circuit breaker: after this many refusals in a row from one host (within one pacer's life) that host is not asked again; lookups return UNKNOWN RATE_LIMITED at once. */
export const HOST_BREAKER_REFUSALS = 5;

/** At most `concurrency` calls in flight and at least `minMsBetween` between two starts. `sleep` is injected (tests pass a no-op). `slowDown()` halves the rate. */
export class Pacer {
  private active = 0;
  private waiting: (() => void)[] = [];
  private nextStart = 0;
  private halvings = 0;
  /** How many times the rate was halved (a 429 or a refusal was seen). */
  slowdowns = 0;
  private streak = 0;
  private breaker = false;
  private readonly baseGap: number;
  private readonly baseConcurrency: number;
  constructor(private minMsBetween: number, private concurrency: number, private readonly sleep: (ms: number) => Promise<void>, private readonly clock: () => number = Date.now) {
    this.baseGap = minMsBetween;
    this.baseConcurrency = concurrency;
  }

  /** True once HOST_BREAKER_REFUSALS refusals came in a row: the host is not asked again until `reset()` (a run's own pacer: for the rest of that run). */
  get breakerOpen(): boolean { return this.breaker; }

  /** Back to the base rate with the breaker closed (a shared host pacer, when no screening run is going any more). */
  reset(): void {
    this.breaker = false; this.streak = 0; this.halvings = 0; this.slowdowns = 0; this.minMsBetween = this.baseGap; this.concurrency = this.baseConcurrency;
  }

  get minGapMs(): number { return this.minMsBetween; }
  get maxConcurrency(): number { return this.concurrency; }

  /** Halve the rate: double the minimum gap (cap RDAP_MAX_MIN_MS); after the second halving, one call at a time. */
  slowDown(): void {
    this.slowdowns++;
    if (++this.streak >= HOST_BREAKER_REFUSALS) this.breaker = true;
    this.halvings++;
    this.minMsBetween = Math.min(Math.max(this.minMsBetween, 1) * 2, RDAP_MAX_MIN_MS);
    if (this.halvings >= 2) this.concurrency = 1;
  }

  /** A lookup that was not refused ends the refusal streak (no effect once the breaker is open). */
  noteNotRefused(): void { if (!this.breakerOpen) this.streak = 0; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      const t = this.clock();
      const start = Math.max(t, this.nextStart);
      this.nextStart = start + this.minMsBetween;
      if (start > t) await this.sleep(start - t);
      return await fn();
    } finally {
      this.active--;
      while (this.waiting.length > 0 && this.active < this.concurrency) {
        this.active++;
        this.waiting.shift()!(); // hand the slot over
      }
    }
  }
}

export interface LookupOpts {
  maxAgeHours: number; baseUrl?: string; evidenceMaxBytes: number; pace: Pace; now?: () => number; timeoutMs?: number; /** ms epoch: past it no query is sent (UNKNOWN TIMEOUT). */ deadline?: number; /** v2.9.0: when it returns true no query is sent (the run was cancelled). */ isCancelled?: () => boolean;
  /** v2.7.0 date safety: a stored answer is reusable only if checked_at >= max(now - maxAge, notBefore). */
  notBefore?: Date;
  /** v2.7.0: stored answers read in one query by `prefetchStored`; a domain absent from the map has no reusable answer (no per-lookup query). */
  prefetched?: Map<string, StoredLookup>;
}
export type CachedLookup = RdapLookup & { cached: boolean; evidenceId: number | null; /** When the answer was read (the stored row's checked_at); provenance in v2.7.0. */ checkedAt: Date; /** 429s / refusals this lookup met (v2.7.0). */ rateLimited: number; /** v2.9.0: the RDAP host that answered (the stored answer's host when reused); null when unknown (answers stored before v2.9.0, or no query made). */ source: string | null };

export type StoredLookup = { outcome: string; http_status: number | null; checked_at: Date; facts: unknown; evidence_id: string | null; source?: string | null };

/** Stable id of the RDAP host behind a query URL: `verisign_rdap` for Verisign (.com/.net), else the hostname. null for an empty or unreadable URL. */
export function rdapSourceOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'rdap.verisign.com' ? 'verisign_rdap' : host || null;
  } catch {
    return null;
  }
}

const MAX_RETRY_AFTER_MS = 10_000;

const cutoffOf = (nowMs: number, maxAgeHours: number, notBefore?: Date): Date | null => {
  if (!(maxAgeHours > 0)) return null;
  return new Date(Math.max(nowMs - maxAgeHours * 3_600_000, notBefore?.getTime() ?? -Infinity));
};

/** One query for the newest reusable stored answer of each domain (registered / not_registered, checked_at at or after the cutoff). */
export async function prefetchStored(db: Kysely<Database>, domains: string[], o: { maxAgeHours: number; notBefore?: Date; now?: () => number }): Promise<Map<string, StoredLookup>> {
  const out = new Map<string, StoredLookup>();
  const cutoff = cutoffOf((o.now ?? Date.now)(), o.maxAgeHours, o.notBefore);
  if (cutoff === null || domains.length === 0) return out;
  const rows = await db.selectFrom('rdap_lookups').select(['domain', 'outcome', 'http_status', 'checked_at', 'facts', 'evidence_id', 'source']).where('domain', 'in', domains)
    .where('outcome', '!=', 'unknown').where('checked_at', '>=', cutoff).orderBy('checked_at', 'desc').orderBy('id', 'desc').execute();
  for (const r of rows) if (!out.has(r.domain)) out.set(r.domain, r);
  return out;
}

const refused = (x: RdapLookup): boolean => x.reasonCode === 'RATE_LIMITED' || x.httpStatus === 429 || x.httpStatus === 403;

/**
 * A lookup through the cache. Only `registered` and `not_registered` rows are reused; `unknown` is never an answer. A stored answer is
 * reused only within the age limit and not before `notBefore`, and never goes through the pacer. A fresh lookup runs inside the pacer,
 * retries once on a 429 whose Retry-After is at most 10 s, slows the pacer down on a 429 or refusal, stores its body as evidence and its outcome as a row.
 */
export async function lookupCached(db: Kysely<Database>, deps: ScreeningDeps, domain: string, o: LookupOpts): Promise<CachedLookup> {
  const now = o.now ?? Date.now;
  const cutoff = cutoffOf(now(), o.maxAgeHours, o.notBefore);
  if (cutoff !== null) {
    const row: StoredLookup | undefined = o.prefetched
      ? o.prefetched.get(domain)
      : await db.selectFrom('rdap_lookups').selectAll().where('domain', '=', domain).where('outcome', '!=', 'unknown')
        .where('checked_at', '>=', cutoff).orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (row) {
      return {
        outcome: row.outcome as 'registered' | 'not_registered', reasonCode: null, httpStatus: row.http_status, url: '', retrievedAt: row.checked_at,
        body: null, facts: (row.facts as RdapFacts | null) ?? null, cached: true, evidenceId: row.evidence_id === null ? null : Number(row.evidence_id), checkedAt: row.checked_at, rateLimited: 0, source: row.source ?? null,
      };
    }
  }
  const late = (): CachedLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: '', retrievedAt: new Date(now()), body: null, facts: null, cached: false, evidenceId: null, checkedAt: new Date(now()), rateLimited: 0, source: null });
  if ((o.deadline !== undefined && now() > o.deadline) || o.isCancelled?.()) return late();
  const open = (): CachedLookup => ({ outcome: 'unknown', reasonCode: 'RATE_LIMITED', httpStatus: null, url: '', retrievedAt: new Date(now()), body: null, facts: null, cached: false, evidenceId: null, checkedAt: new Date(now()), rateLimited: 1, source: null });
  if (o.pace.breakerOpen) return open(); // v2.11.1: the host refused HOST_BREAKER_REFUSALS times in a row; no call, no wait, no row
  const call = () => deps.rdapLookup(domain, { baseUrl: o.baseUrl, timeoutMs: o.timeoutMs });
  let skipped = false;
  let broken = false;
  let limited = 0;
  const r = await o.pace.run(async () => {
    if ((o.deadline !== undefined && now() > o.deadline) || o.isCancelled?.()) { skipped = true; return late(); } // checked again after the wait in the pacer queue
    if (o.pace.breakerOpen) { broken = true; return late(); } // opened while this lookup waited in the queue
    let x = await call();
    if (refused(x)) { limited++; o.pace.slowDown(); } else o.pace.noteNotRefused();
    if (x.reasonCode === 'RATE_LIMITED' && x.retryAfterMs != null && x.retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await deps.sleep(x.retryAfterMs);
      if (o.pace.breakerOpen) return x;
      x = await call();
      if (refused(x)) { limited++; o.pace.slowDown(); } else o.pace.noteNotRefused();
    }
    return x;
  });
  if (broken) return open();
  if (skipped) return late();
  let evidenceId: number | null = null;
  const text = r.body ?? (r.outcome === 'not_registered' ? `HTTP ${r.httpStatus}: no registration found for ${domain}` : null);
  if (text !== null) {
    evidenceId = await storeEvidence(db, { source: 'rdap', url: r.url, retrievedAt: r.retrievedAt, httpStatus: r.httpStatus, contentType: 'application/rdap+json', body: text, text, maxBytes: o.evidenceMaxBytes });
  }
  const checkedAt = new Date(now());
  await db.insertInto('rdap_lookups').values({
    domain, outcome: r.outcome, reason_code: r.reasonCode, http_status: r.httpStatus, facts: r.facts ? JSON.stringify(r.facts) : null,
    evidence_id: evidenceId === null ? null : String(evidenceId), checked_at: checkedAt, source: rdapSourceOf(r.url),
  }).execute();
  return { ...r, cached: false, evidenceId, checkedAt, rateLimited: limited, source: rdapSourceOf(r.url) };
}

/**
 * Which stored answers a check may reuse (v2.7.0). Test-set runs use `max_answer_age_days` instead of the settings' freshness_hours;
 * with an explicit as_of (a full run) an answer read before that as_of is never reused, except for a features_as_of 'now' set,
 * where only the age limit counts. Live runs: the settings' freshness only.
 */
export function answerPolicy(ctx: CheckContext, kind: 'census' | 'ext_dates'): { maxAgeHours: number; notBefore?: Date } {
  const ts = ctx.run.testSet;
  const maxAgeHours = ts ? ts.maxAnswerAgeDays * 24 : ctx.settings.freshness_hours[kind] ?? 0;
  const notBefore = ctx.run.mode === 'full' && ctx.item.as_of && !ts?.asOfIsNow ? new Date(ctx.item.as_of) : undefined;
  return { maxAgeHours, ...(notBefore && !Number.isNaN(notBefore.getTime()) && { notBefore }) };
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
async function latestBootstrap(db: Kysely<Database>, id?: string) {
  // metadata only: the gzipped body is fetched when the parsed map is not cached in-process (v2.16.0)
  return db.selectFrom('reference_files').select(['id', 'name', 'source_url', 'fetched_at', 'data_date', 'sha256', 'bytes', 'same_as_id', sql<boolean>`body_gz is not null`.as('has_body')])
    .where('name', '=', BOOTSTRAP_NAME).$if(id !== undefined, (q) => q.where('id', '=', id!)).orderBy('fetched_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
}
async function bodyOf(db: Kysely<Database>, row: NonNullable<FileRow>): Promise<Buffer | null> {
  const id = row.has_body ? row.id : row.same_as_id;
  if (id === null) return null;
  const src = await db.selectFrom('reference_files').select('body_gz').where('id', '=', id).executeTakeFirst();
  return src?.body_gz ?? null;
}

/**
 * The RDAP base for a TLD. `com` is Verisign's (fixed). Others come from the IANA bootstrap kept in reference_files, fetched on demand
 * when the newest copy is older than 7 days. A failed refresh keeps serving the old copy; with no copy at all it throws BootstrapError
 * (the caller answers UNKNOWN, not "no registry"). null = the bootstrap has no entry for the TLD. `enabled` false returns null.
 */
const failedAt = new WeakMap<ScreeningDeps, number>(); // per app: when the last bootstrap refresh failed
export const BOOTSTRAP_COOLDOWN_MINUTES = 60;

export async function rdapBaseFor(db: Kysely<Database>, deps: ScreeningDeps, tld: string, o: { enabled: boolean; now?: () => number; cooldownMinutes?: number }): Promise<string | null> {
  if (!o.enabled) return null;
  const t = tld.toLowerCase();
  if (t === 'com') return RDAP_COM_BASE;
  const now = o.now ?? Date.now;
  let row = await latestBootstrap(db);
  const cooling = failedAt.has(deps) && now() - failedAt.get(deps)! < (o.cooldownMinutes ?? BOOTSTRAP_COOLDOWN_MINUTES) * 60_000;
  if ((!row || now() - row.fetched_at.getTime() > BOOTSTRAP_MAX_AGE_MS) && cooling && !row) throw new BootstrapError('IANA bootstrap unavailable (refresh failed; not retrying yet)');
  if ((!row || now() - row.fetched_at.getTime() > BOOTSTRAP_MAX_AGE_MS) && !cooling) {
    try {
      const res = await deps.fetch(IANA_RDAP_URL, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (res.status !== 200) throw new BootstrapError(`IANA bootstrap HTTP ${res.status}`);
      const text = await res.text();
      const { publication } = parseBootstrap(text);
      const sha = createHash('sha256').update(text, 'utf8').digest('hex');
      const same = row && row.sha256 === sha ? row : null;
      const sameId = same ? (same.has_body ? same.id : same.same_as_id) : null;
      const ins = await db.insertInto('reference_files').values({
        name: BOOTSTRAP_NAME, source_url: IANA_RDAP_URL, fetched_at: new Date(now()), data_date: publication ? publication.slice(0, 10) : null,
        sha256: sha, bytes: Buffer.byteLength(text, 'utf8'), body_gz: sameId ? null : gzipSync(Buffer.from(text, 'utf8')), same_as_id: sameId,
      }).returning('id').executeTakeFirstOrThrow();
      row = await latestBootstrap(db, ins.id);
      failedAt.delete(deps);
    } catch (e) {
      failedAt.set(deps, now());
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

/** What lookupCached needs from a pacer. */
export interface Pace {
  run<T>(fn: () => Promise<T>): Promise<T>;
  slowDown(): void;
  noteNotRefused(): void;
  readonly breakerOpen: boolean;
  readonly minGapMs: number;
  readonly maxConcurrency: number;
}

/**
 * The effective pacer of one run for one host: the process-wide host pacer (shared by every run) and, for a run whose own limit is stricter,
 * a per-run gate on top. The effective rate is the stricter of the two; refusals slow both; the breaker is open when either is.
 */
export class LayeredPacer implements Pace {
  constructor(private readonly host: Pacer, private readonly gate: Pacer | null) {}
  run<T>(fn: () => Promise<T>): Promise<T> { return this.gate ? this.gate.run(() => this.host.run(fn)) : this.host.run(fn); }
  slowDown(): void { this.host.slowDown(); this.gate?.slowDown(); }
  noteNotRefused(): void { this.host.noteNotRefused(); this.gate?.noteNotRefused(); }
  get breakerOpen(): boolean { return this.host.breakerOpen || (this.gate?.breakerOpen ?? false); }
  get minGapMs(): number { return Math.max(this.host.minGapMs, this.gate?.minGapMs ?? 0); }
  get maxConcurrency(): number { return Math.min(this.host.maxConcurrency, this.gate?.maxConcurrency ?? Infinity); }
  get slowdowns(): number { return this.host.slowdowns; }
}

// Process-wide: one pacer per RDAP host, at the polite test-set ceiling. A different `sleep` means a different app instance (tests); it gets its own pacer.
const hostPacers = new Map<string, { sleep: (ms: number) => Promise<void>; pacer: Pacer }>();

/** The shared pacer of an RDAP host. */
export function hostPacer(host: string, sleep: (ms: number) => Promise<void>): Pacer {
  const hit = hostPacers.get(host);
  if (hit && hit.sleep === sleep) return hit.pacer;
  const pacer = new Pacer(TEST_SET_RDAP_MIN_MS, TEST_SET_RDAP_CONCURRENCY, sleep);
  hostPacers.set(host, { sleep, pacer });
  return pacer;
}

/**
 * Called when no screening run is going any more in an app (its sleep identifies it): the shared host pacers go back to the base rate with the
 * breaker closed, so a run that starts later is not held back by an earlier run's refusals (the state is shared only while runs overlap).
 */
export function settleHostPacers(sleep: (ms: number) => Promise<void>): void {
  for (const e of hostPacers.values()) if (e.sleep === sleep) e.pacer.reset();
}

/** Forgets every shared host pacer (tests). */
export function resetHostPacers(): void { hostPacers.clear(); }

/**
 * The pacer of this run for an RDAP host: the shared host pacer (4 in flight, 250 ms between starts), plus a per-run gate with the settings'
 * `run.rdap_min_ms_between` / `run.rdap_concurrency` when the run is not a test-set run and its limit is stricter.
 */
export function pacerFor(ctx: CheckContext, baseUrl: string = RDAP_COM_BASE): LayeredPacer {
  const host = new URL(baseUrl).host;
  const key = `rdap_pacer:${host}`;
  const hit = ctx.shared.get(key) as LayeredPacer | undefined;
  if (hit) return hit;
  const shared = hostPacer(host, ctx.deps.sleep);
  const r = ctx.settings.run;
  const stricter = r.rdap_min_ms_between > TEST_SET_RDAP_MIN_MS || r.rdap_concurrency < TEST_SET_RDAP_CONCURRENCY;
  const p = new LayeredPacer(shared, ctx.run.testSet || !stricter ? null : new Pacer(r.rdap_min_ms_between, r.rdap_concurrency, ctx.deps.sleep));
  ctx.shared.set(key, p);
  return p;
}
