import { z } from 'zod';
import { usdStringToCents } from '../core/money.js';
import { RegistrarError, type Capabilities, type Quote, type RegistrarAdapter } from './types.js';

export const PORKBUN_DEFAULT_BASE = 'https://api.porkbun.com/api/json/v3';
/** A price above this is nonsense, not a quote. */
const MAX_PRICE_CENTS = 2_147_483_647;

const NAME = 'porkbun';

/** Every Porkbun operation the app calls. It only reads prices: nothing here can buy, renew or move money (founder rules 6, 12). */
export const PORKBUN_ENDPOINTS = {
  checkDomain: { method: 'POST', path: '/domain/checkDomain/{domain}' },
} as const satisfies Record<string, { method: 'GET' | 'POST'; path: string }>;
export type PorkbunEndpoint = keyof typeof PORKBUN_ENDPOINTS;

function expandPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing path param: ${k}`);
    return encodeURIComponent(v);
  });
}

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
  private async call(
    endpoint: PorkbunEndpoint,
    o: { params?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<Json> {
    const { method, path: template } = PORKBUN_ENDPOINTS[endpoint];
    const path = expandPath(template, o.params ?? {});
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'X-API-Key': this.opts.apiKey,
      'X-Secret-API-Key': this.opts.secretKey,
    };
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15_000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method, headers, signal, body: '{}',
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
    const body = await this.call('checkDomain', { params: { domain }, signal: o.signal });
    const r = CheckResponse.safeParse(body.response);
    if (!r.success) throw this.bad('Unexpected checkDomain shape');
    try {
      const cap = (c: number | null) => (c !== null && c > MAX_PRICE_CENTS ? null : c);
      return {
        available: r.data.avail === 'yes',
        premium: r.data.premium === 'yes',
        firstYearCents: cap(r.data.price !== undefined ? usdStringToCents(r.data.price) : null),
        renewalCents: cap(r.data.additional?.renewal ? usdStringToCents(r.data.additional.renewal.price) : null),
        privacyCentsPerYear: 0,
        currency: 'USD',
        minDurationYears: r.data.minDuration ?? null,
        raw: body,
      };
    } catch {
      throw this.bad('Unparseable price in checkDomain');
    }
  }
}
