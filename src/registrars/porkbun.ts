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
  async register(_d: string, _i: RegisterInput): Promise<RegisterSuccess | RegisterDryRun> { throw new Error('not implemented'); }
  async findDomain(_d: string): Promise<DomainInfo | null> { throw new Error('not implemented'); }
  async setNameservers(_d: string, _ns: string[]): Promise<void> { throw new Error('not implemented'); }
  async getNameservers(_d: string): Promise<Set<string>> { throw new Error('not implemented'); }
  async setAutoRenew(_d: string, _on: boolean): Promise<void> { throw new Error('not implemented'); }
  async getReceipt(_o: string): Promise<unknown> { throw new Error('not implemented'); }
}
