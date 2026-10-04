import { z } from 'zod';
import { usdStringToCents } from '../money.js';
import {
  RegistrarError, type AccountState, type Capabilities, type DomainInfo, type Quote, type RegisterDryRun,
  type RegisterInput, type RegisterSuccess, type RegistrarAdapter,
} from './types.js';

export const PORKBUN_DEFAULT_BASE = 'https://api.porkbun.com/api/json/v3';
const NAME = 'porkbun';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const normNs = (n: string) => n.trim().toLowerCase().replace(/\.$/, '');
const flag = (v: unknown): boolean | null => (v === 1 || v === '1' ? true : v === 0 || v === '0' ? false : null);

const CheckResponse = z.object({
  avail: z.enum(['yes', 'no']),
  price: z.string().optional(),
  premium: z.enum(['yes', 'no']),
  minDuration: z.number().int().optional(),
  additional: z.object({ renewal: z.object({ price: z.string() }).optional() }).optional(),
});

/** Numeric/limit fields worth keeping from an error body. Never the message text for branching. */
function errorDetails(obj: Json): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['cost', 'balance', 'shortfall', 'ttlRemaining', 'limitSource']) if (k in obj) out[k] = obj[k];
  return out;
}

export class PorkbunAdapter implements RegistrarAdapter {
  readonly name = NAME;
  readonly capabilities: Capabilities;
  private readonly base: string;

  constructor(private readonly opts: { apiKey: string; secretKey: string; baseUrl?: string; timeoutMs?: number }) {
    this.base = (opts.baseUrl ?? PORKBUN_DEFAULT_BASE).replace(/\/$/, '');
    this.capabilities = {
      canQuote: true, canRegister: true, canManageNs: true, customNs: true,
      prepaid: true, freePrivacy: true, afternicFastTransfer: true,
      sandbox: opts.apiKey.startsWith('pk1_sb_'),
    };
  }

  private bad(message: string, httpStatus?: number): RegistrarError {
    return new RegistrarError(NAME, 'REGISTRAR_BAD_RESPONSE', message, { httpStatus, ambiguous: true });
  }

  /** One HTTP call. Returns the SUCCESS body or throws RegistrarError. Keys travel only in headers. */
  protected async call(
    method: 'GET' | 'POST',
    path: string,
    o: { body?: Json; idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<Json> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'X-API-Key': this.opts.apiKey,
      'X-Secret-API-Key': this.opts.secretKey,
    };
    if (method === 'POST') headers['content-type'] = 'application/json';
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15_000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method, headers, signal, body: method === 'POST' ? JSON.stringify(o.body ?? {}) : undefined,
      });
    } catch (err) {
      const n = (err as Error).name;
      if (n === 'TimeoutError' || n === 'AbortError') {
        throw new RegistrarError(NAME, 'REGISTRAR_TIMEOUT', 'Porkbun did not answer in time', { ambiguous: true });
      }
      throw new RegistrarError(NAME, 'REGISTRAR_NETWORK', 'Could not reach Porkbun', { ambiguous: true });
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await res.text());
    } catch (err) {
      const n = (err as Error).name;
      if (n === 'TimeoutError' || n === 'AbortError') {
        throw new RegistrarError(NAME, 'REGISTRAR_TIMEOUT', 'Porkbun did not answer in time', { ambiguous: true });
      }
      parsed = null;
    }
    if (isObj(parsed) && parsed.status === 'SUCCESS' && res.ok) return parsed;
    if (isObj(parsed) && parsed.status === 'ERROR') {
      const code = typeof parsed.code === 'string' && parsed.code ? parsed.code : 'UNKNOWN_REGISTRAR_ERROR';
      const retry = Number(res.headers.get('retry-after'));
      throw new RegistrarError(NAME, code, `Porkbun error ${code}`, {
        httpStatus: res.status,
        ambiguous: res.status >= 500 || undefined,
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
        details: errorDetails(parsed),
      });
    }
    if (res.status >= 500) {
      throw new RegistrarError(NAME, 'REGISTRAR_HTTP_5XX', `Porkbun HTTP ${res.status}`, { httpStatus: res.status, ambiguous: true });
    }
    throw this.bad(`Unexpected Porkbun response (HTTP ${res.status})`, res.status);
  }

  async quote(domain: string, o: { signal?: AbortSignal } = {}): Promise<Quote> {
    const body = await this.call('POST', `/domain/checkDomain/${encodeURIComponent(domain)}`, { signal: o.signal });
    const r = CheckResponse.safeParse(body.response);
    if (!r.success) throw this.bad('Unexpected checkDomain shape');
    try {
      return {
        available: r.data.avail === 'yes',
        premium: r.data.premium === 'yes',
        firstYearCents: r.data.price !== undefined ? usdStringToCents(r.data.price) : null,
        renewalCents: r.data.additional?.renewal ? usdStringToCents(r.data.additional.renewal.price) : null,
        privacyCentsPerYear: 0,
        currency: 'USD',
        minDurationYears: r.data.minDuration ?? null,
        raw: body,
      };
    } catch {
      throw this.bad('Unparseable price in checkDomain');
    }
  }

  async accountState(): Promise<AccountState> {
    const [bal, api] = await Promise.all([this.call('GET', '/account/balance'), this.call('GET', '/account/apiSettings')]);
    const settings = isObj(api.settings) ? api.settings : {};
    const spend = isObj(api.spendLimit) ? api.spendLimit : {};
    return {
      balanceCents: Number.isSafeInteger(bal.balance) ? (bal.balance as number) : null,
      spendLimitRemainingCents: Number.isSafeInteger(spend.remaining) ? (spend.remaining as number) : null,
      autoTopupEnabled: typeof settings.autoTopup === 'boolean' ? settings.autoTopup : null,
    };
  }

  // Implemented in Task 3.
  async register(domain: string, input: RegisterInput): Promise<RegisterSuccess | RegisterDryRun> {
    if (!Number.isInteger(input.costCents) || input.costCents <= 0) {
      throw new RegistrarError(NAME, 'INVALID_COST', 'cost must be a positive integer number of cents');
    }
    const body: Json = { cost: input.costCents, agreeToTerms: 'yes', whoisPrivacy: true };
    if (input.dryRun) body.dryRun = true;
    const r = await this.call('POST', `/domain/create/${encodeURIComponent(domain)}`, {
      body, idempotencyKey: input.idempotencyKey,
    });
    const isDry = r.dryRun === true;
    if (input.dryRun !== isDry) {
      // Asked for a dry run and got a real answer (or vice versa): a charge may have happened.
      throw this.bad(input.dryRun ? 'Dry run answered as a real registration' : 'Registration answered as a dry run');
    }
    if (isDry) {
      if (r.duration !== 1) {
        throw new RegistrarError(NAME, 'MULTI_YEAR_TERM', `Registry minimum term is ${String(r.duration)} years; only 1-year registrations are allowed`);
      }
      return {
        kind: 'dry_run',
        wouldSucceed: r.wouldSucceed === true,
        costCents: typeof r.cost === 'number' ? r.cost : input.costCents,
        durationYears: 1,
        balanceCents: typeof r.balance === 'number' ? r.balance : null,
        shortfallCents: typeof r.shortfall === 'number' ? r.shortfall : null,
        withinMonthlySpendLimit: typeof r.withinMonthlySpendLimit === 'boolean' ? r.withinMonthlySpendLimit : null,
        raw: r,
      };
    }
    if ((typeof r.orderId !== 'number' && typeof r.orderId !== 'string') || typeof r.cost !== 'number') {
      throw this.bad('Registration success without orderId/cost');
    }
    return {
      kind: 'registered',
      orderId: String(r.orderId),
      chargedCents: r.cost,
      balanceCents: typeof r.balance === 'number' ? r.balance : null,
      raw: r,
    };
  }

  async findDomain(domain: string): Promise<DomainInfo | null> {
    let r: Json;
    try {
      r = await this.call('GET', `/domain/get/${encodeURIComponent(domain)}`);
    } catch (e) {
      if (e instanceof RegistrarError && e.code === 'DOMAIN_NOT_FOUND') return null; // S7: only this code means "not ours"
      throw e;
    }
    const d = isObj(r.domain) ? r.domain : {};
    const exp = typeof d.expireDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d.expireDate) ? d.expireDate.slice(0, 10) : null;
    let ns: string[] | null = null;
    try {
      ns = [...(await this.getNameservers(domain))].sort();
    } catch (e) {
      if (!(e instanceof RegistrarError && e.code === 'API_ACCESS_DISABLED')) throw e;
    }
    return { expiryDate: exp, whoisPrivacy: flag(d.whoisPrivacy), autoRenew: flag(d.autoRenew), apiAccess: flag(d.apiAccess), ns };
  }

  async setNameservers(domain: string, ns: string[]): Promise<void> {
    await this.call('POST', `/domain/updateNs/${encodeURIComponent(domain)}`, { body: { ns } });
  }

  async getNameservers(domain: string): Promise<Set<string>> {
    const r = await this.call('POST', `/domain/getNs/${encodeURIComponent(domain)}`);
    if (!Array.isArray(r.ns)) throw this.bad('getNs without ns array');
    return new Set(r.ns.filter((n): n is string => typeof n === 'string').map(normNs));
  }

  async setAutoRenew(domain: string, on: boolean): Promise<void> {
    const r = await this.call('POST', `/domain/updateAutoRenew/${encodeURIComponent(domain)}`, { body: { status: on ? 'on' : 'off' } });
    const results = isObj(r.results) ? r.results : {};
    const mine = results[domain];
    if (isObj(mine) && mine.status !== 'SUCCESS') {
      throw new RegistrarError(NAME, 'AUTO_RENEW_UPDATE_FAILED', 'Porkbun did not change auto-renew for this domain');
    }
  }

  async getReceipt(orderId: string): Promise<unknown> {
    return this.call('GET', `/account/invoice/${encodeURIComponent(orderId)}`);
  }
}
