import {
  RegistrarError, type AccountState, type Capabilities, type DomainInfo, type Quote, type RegisterDryRun,
  type RegisterInput, type RegisterSuccess, type RegistrarAdapter, type RegistrationRecord,
} from './types.js';

/**
 * GoDaddy is MANAGEMENT-ONLY (CLAUDE.md decisions log; report.md "Import"): it reads a domain we already own and
 * changes its nameservers. It never quotes, registers, renews or touches money. Every other method throws
 * NOT_SUPPORTED without an HTTP call.
 */
export const GODADDY_DEFAULT_BASE = 'https://api.godaddy.com';
// UNVERIFIED (check at G2/G3 contract tests)
export const GODADDY_DOMAIN_PATH = (domain: string): string => `/v3/domains/domain-names/${encodeURIComponent(domain)}`;
// UNVERIFIED (check at G2/G3 contract tests)
export const GODADDY_NS_PATH = (domain: string): string => `${GODADDY_DOMAIN_PATH(domain)}/nameservers`;
// UNVERIFIED (check at G2/G3 contract tests)
export const GODADDY_OPERATION_PATH = (id: string): string => `/v3/domains/operations/${encodeURIComponent(id)}`;

const NAME = 'godaddy';
const DONE = new Set(['SUCCESS', 'DONE']);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const normNs = (n: string) => n.trim().toLowerCase().replace(/\.$/, '');

export interface GoDaddyOptions {
  pat: string; baseUrl?: string; timeoutMs?: number;
  /** Operation polling: production defaults 5 s interval, 5 min timeout. Tests inject a no-op `sleep`. */
  pollIntervalMs?: number; pollTimeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}

interface Reply { status: number; body: unknown; headers: Headers }

export class GoDaddyAdapter implements RegistrarAdapter {
  readonly name = NAME;
  readonly capabilities: Capabilities = {
    canQuote: false, canRegister: false, canManageNs: true, customNs: true,
    prepaid: false, freePrivacy: false, afternicFastTransfer: true, sandbox: false,
  };
  private readonly base: string;

  constructor(private readonly opts: GoDaddyOptions) {
    this.base = (opts.baseUrl ?? GODADDY_DEFAULT_BASE).replace(/\/$/, '');
  }

  private unsupported(what: string): RegistrarError {
    return new RegistrarError(NAME, 'NOT_SUPPORTED', `GoDaddy is management-only here: ${what} is not supported`, { ambiguous: false });
  }

  /** One HTTP call. The PAT travels only in the Authorization header and never appears in an error. */
  private async http(method: 'GET' | 'PUT', path: string, body?: Json): Promise<Reply> {
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${this.opts.pat}` };
    if (body) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      const n = (err as Error).name;
      if (n === 'TimeoutError' || n === 'AbortError') throw new RegistrarError(NAME, 'REGISTRAR_TIMEOUT', 'GoDaddy did not answer in time', { ambiguous: true });
      throw new RegistrarError(NAME, 'REGISTRAR_NETWORK', 'Could not reach GoDaddy', { ambiguous: true });
    }
    let parsed: unknown = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch (err) {
      const n = (err as Error).name;
      if (n === 'TimeoutError' || n === 'AbortError') throw new RegistrarError(NAME, 'REGISTRAR_TIMEOUT', 'GoDaddy did not answer in time', { ambiguous: true });
      parsed = null;
    }
    if (res.status >= 500) throw new RegistrarError(NAME, 'REGISTRAR_HTTP_5XX', `GoDaddy HTTP ${res.status}`, { httpStatus: res.status, ambiguous: true });
    return { status: res.status, body: parsed, headers: res.headers };
  }

  private bad(message: string, httpStatus?: number): RegistrarError {
    return new RegistrarError(NAME, 'REGISTRAR_BAD_RESPONSE', message, { httpStatus, ambiguous: true });
  }

  /** A definite 4xx: the code comes from the body (never the message), else a generic one. */
  private reject(r: Reply): RegistrarError {
    const code = isObj(r.body) && typeof r.body.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(r.body.code)
      ? r.body.code
      : r.status === 401 ? 'UNAUTHORIZED' : r.status === 429 ? 'RATE_LIMIT_EXCEEDED' : `GODADDY_HTTP_${r.status}`;
    const retry = Number(r.headers.get('retry-after'));
    return new RegistrarError(NAME, code, `GoDaddy error ${code}`, {
      httpStatus: r.status, ambiguous: false, retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
    });
  }

  async findDomain(domain: string): Promise<DomainInfo | null> {
    const r = await this.http('GET', GODADDY_DOMAIN_PATH(domain));
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw this.reject(r);
    if (!isObj(r.body)) throw this.bad('Unexpected domain response', r.status);
    const d = r.body;
    const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
    const ns = Array.isArray(d.nameServers) ? d.nameServers.filter((n): n is string => typeof n === 'string').map(normNs).sort() : null;
    return {
      expiryDate: date(d.expiresAt ?? d.expires),
      whoisPrivacy: typeof d.privacy === 'boolean' ? d.privacy : null,
      autoRenew: typeof d.renewAuto === 'boolean' ? d.renewAuto : null,
      apiAccess: true,
      ns,
    };
  }

  async getNameservers(domain: string): Promise<Set<string>> {
    const info = await this.findDomain(domain);
    if (!info) throw new RegistrarError(NAME, 'DOMAIN_NOT_FOUND', 'Domain is not in this GoDaddy account');
    if (!info.ns) throw this.bad('Domain response without nameservers');
    return new Set(info.ns);
  }

  async setNameservers(domain: string, ns: string[]): Promise<{ pending: boolean }> {
    const r = await this.http('PUT', GODADDY_NS_PATH(domain), { nameServers: ns });
    if (r.status !== 202 && r.status !== 200 && r.status !== 204) throw r.status >= 400 ? this.reject(r) : this.bad('Unexpected nameserver response', r.status);
    if (r.status !== 202) return { pending: false };
    const id = this.operationId(r);
    if (!id) return { pending: true }; // accepted but untrackable

    const interval = this.opts.pollIntervalMs ?? 5_000;
    const timeout = this.opts.pollTimeoutMs ?? 300_000;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const now = this.opts.now ?? Date.now;
    const deadline = now() + timeout;
    for (;;) {
      // After an accepted PUT, a failed poll is not a failed change: report it as still pending.
      let p: Reply;
      try {
        p = await this.http('GET', GODADDY_OPERATION_PATH(id));
      } catch (e) {
        if (e instanceof RegistrarError) return { pending: true };
        throw e;
      }
      if (p.status < 200 || p.status >= 300) return { pending: true };
      const status = isObj(p.body) && typeof p.body.status === 'string' ? p.body.status.toUpperCase() : '';
      if (DONE.has(status)) return { pending: false };
      if (status === 'FAILED') {
        const c = isObj(p.body) && typeof p.body.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(p.body.code) ? p.body.code : 'GODADDY_OPERATION_FAILED';
        throw new RegistrarError(NAME, c, 'GoDaddy reported the nameserver change as failed', { ambiguous: false });
      }
      if (now() >= deadline) return { pending: true };
      await sleep(interval);
      if (now() >= deadline) return { pending: true };
    }
  }

  private operationId(r: Reply): string | null {
    if (isObj(r.body)) {
      for (const k of ['operationId', 'id']) {
        const v = r.body[k];
        if (typeof v === 'string' && v) return v;
        if (typeof v === 'number') return String(v);
      }
    }
    const m = /\/operations\/([^/?#]+)/.exec(r.headers.get('location') ?? '');
    return m?.[1] ?? null;
  }

  async quote(_domain: string, _opts?: { signal?: AbortSignal }): Promise<Quote> { throw this.unsupported('price quotes'); }
  async accountState(): Promise<AccountState> { throw this.unsupported('account state'); }
  async register(_domain: string, _input: RegisterInput): Promise<RegisterSuccess | RegisterDryRun> { throw this.unsupported('buying'); }
  async setAutoRenew(_domain: string, _on: boolean): Promise<void> { throw this.unsupported('auto-renew changes'); }
  async getReceipt(_orderId: string): Promise<unknown> { throw this.unsupported('receipts'); }
  async findRegistration(_domain: string, _opts: { since: string }): Promise<RegistrationRecord | null> { throw this.unsupported('registration lookup'); }
}
