import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { redact } from '../../core/redact.js';
import type { RdapFn, RdapStatus } from '../../core/rdap.js';
import { RegistrarError, type RegistrarAdapter } from './types.js';
import {
  evaluateQuote, firstYearWarning, overallAvailability, pickWinner, shouldCall, sortByAdapterOrder,
  type EvaluatedQuote, type QuoteOutcome,
} from './selection.js';

export interface CheckResult {
  domain: string; checkId: string; checkedAt: Date;
  availability: 'available' | 'taken' | 'unknown'; rdap: RdapStatus;
  winner: EvaluatedQuote | null; quotes: EvaluatedQuote[]; warnings: string[];
}

const CACHE_MS = 60_000;

export class CheckService {
  private readonly cache = new Map<string, { expires: number; result: CheckResult }>();

  constructor(
    private readonly deps: {
      db: Kysely<Database>; adapters: RegistrarAdapter[]; rdap: RdapFn; now: () => number;
      quoteTimeoutMs?: number; log?: { warn(obj: object, msg: string): void };
    },
  ) {}

  /** `domain` must already be normalised. /buy passes useCache:false. */
  async check(domain: string, opts: { useCache?: boolean } = {}): Promise<CheckResult> {
    const now = this.deps.now();
    if (opts.useCache !== false) {
      const hit = this.cache.get(domain);
      if (hit && hit.expires > now) return hit.result;
    }
    const settings = await this.deps.db.selectFrom('settings').select('allowed_registrars').executeTakeFirstOrThrow();
    const allowed = settings.allowed_registrars;
    const timeoutMs = this.deps.quoteTimeoutMs ?? 8000;

    const [rdap, outcomes] = await Promise.all([
      this.deps.rdap(domain, { timeoutMs }),
      Promise.all(this.deps.adapters.map((a) => this.quoteOne(a, domain, allowed, timeoutMs))),
    ]);

    const quotes = sortByAdapterOrder(outcomes.map((o) => evaluateQuote(o, allowed)));
    const availability = overallAvailability(rdap, quotes);
    const winner = availability === 'available' ? pickWinner(quotes) : null;
    const warning = firstYearWarning(quotes, winner);
    const result: CheckResult = {
      domain, checkId: `chk_${randomBytes(12).toString('hex')}`, checkedAt: new Date(now),
      availability, rdap, winner, quotes, warnings: warning ? [warning] : [],
    };

    if (quotes.length > 0) {
      await this.deps.db
        .insertInto('quotes')
        .values(quotes.map((q) => ({
          check_id: result.checkId, domain, registrar: q.registrar, quoted_at: result.checkedAt,
          available: q.available, premium: q.premium,
          first_year_cents: q.firstYearCents, renewal_cents: q.renewalCents,
          privacy_cents_per_year: q.privacyCentsPerYear, two_year_cents: q.twoYearCents,
          eligible: q.eligible, exclusion_reason: q.exclusionReason,
          raw: JSON.stringify(redact(q.raw)),
        })))
        .execute();
    }

    if (opts.useCache !== false) {
      for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
      this.cache.set(domain, { expires: now + CACHE_MS, result });
    }
    return result;
  }

  private async quoteOne(a: RegistrarAdapter, domain: string, allowed: string[], timeoutMs: number): Promise<QuoteOutcome> {
    const base = { registrar: a.name, capabilities: a.capabilities };
    if (!shouldCall(a.capabilities, a.name, allowed)) return { ...base, quote: null, error: null };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return { ...base, quote: await a.quote(domain, { signal: ac.signal }), error: null };
    } catch (e) {
      const error = e instanceof RegistrarError ? e : new RegistrarError(a.name, 'ADAPTER_FAILED', 'Adapter threw', { ambiguous: true });
      this.deps.log?.warn({ registrar: a.name, code: error.code }, 'quote failed');
      return { ...base, quote: null, error };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drop a cached answer (after a purchase changes the domain's state). */
  invalidate(domain: string): void {
    this.cache.delete(domain);
  }
}
