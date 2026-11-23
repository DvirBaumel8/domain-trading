import { randomBytes } from 'node:crypto';
import type { RdapFn, RdapStatus } from '../core/rdap.js';
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
      allowed: readonly string[]; adapters: RegistrarAdapter[]; rdap: RdapFn; now: () => number;
      quoteTimeoutMs?: number; log?: { warn(obj: object, msg: string): void };
    },
  ) {}

  /** `domain` must already be normalised. Answers are reused for a minute. */
  async check(domain: string): Promise<CheckResult> {
    const now = this.deps.now();
    const hit = this.cache.get(domain);
    if (hit && hit.expires > now) return hit.result;
    const { allowed } = this.deps;
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

    for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
    this.cache.set(domain, { expires: now + CACHE_MS, result });
    return result;
  }

  private async quoteOne(a: RegistrarAdapter, domain: string, allowed: readonly string[], timeoutMs: number): Promise<QuoteOutcome> {
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
}
