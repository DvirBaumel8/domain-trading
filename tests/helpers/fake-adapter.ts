import type {
  AccountState, Capabilities, DomainInfo, Quote, RegisterDryRun, RegisterInput, RegisterSuccess, RegistrarAdapter, RegistrationRecord,
} from '../../src/modules/registrars/types.js';
import { RegistrarError } from '../../src/modules/registrars/types.js';

type Maybe<T> = T | RegistrarError;
const isErr = (v: unknown): v is RegistrarError => v instanceof RegistrarError;

export interface FakeOptions {
  quote?: Partial<Quote>;
  /** nth quote call (0-based) uses quoteSeq[n] if present, else `quote`. */
  quoteSeq?: Partial<Quote>[];
  error?: RegistrarError;
  hang?: boolean;
  capabilities?: Partial<Capabilities>;
  account?: Maybe<Partial<AccountState>>;
  /** nth dry run (0-based) → result overrides or an error. */
  dryRun?: (n: number) => Maybe<Partial<RegisterDryRun>> | undefined;
  /** nth REAL register call (0-based) → 'ok' or an error. Default 'ok'. */
  register?: (n: number, input: RegisterInput) => 'ok' | RegistrarError | Error;
  /** When a real register returns an ambiguous error, the registrar still charged (Porkbun-style replay on same key). */
  chargesOnAmbiguous?: boolean;
  /** The domain is already in the account before any register call. */
  alreadyOwned?: boolean;
  /** Overrides findDomain entirely. */
  findDomain?: (domain: string, n: number) => Maybe<DomainInfo | null> | Error;
  domainInfo?: Partial<DomainInfo>;
  /** Override findRegistration (null = no invoice). */
  findRegistration?: Maybe<RegistrationRecord | null>;
  receipt?: Maybe<unknown>;
  setNs?: RegistrarError;
  /** setNameservers resolves with this result instead of void (e.g. { pending: true }). */
  setNsResult?: { pending: boolean };
  getNs?: string[];
  getNsError?: RegistrarError;
  /** Runs inside setNameservers, before it returns. */
  onSetNs?: () => Promise<void>;
  setAutoRenew?: RegistrarError;
  /** autoRenew value findDomain reports after setAutoRenew (default: what was set). */
  autoRenewAfter?: boolean | null;
}

export class FakeAdapter implements RegistrarAdapter {
  readonly capabilities: Capabilities;
  readonly calls: string[] = [];
  /** Real charges made (what the registrar billed). */
  charges = 0;
  realRegisterCalls = 0;
  readonly registerKeys: string[] = [];
  private quoteCalls = 0;
  private dryRuns = 0;
  private findCalls = 0;
  private readonly owned = new Map<string, { orderId: string; chargedCents: number }>();
  private readonly byKey = new Map<string, RegisterSuccess>();
  private readonly autoRenew = new Map<string, boolean>();
  private readonly ns = new Map<string, string[]>();

  constructor(readonly name: string, private readonly o: FakeOptions = {}) {
    this.capabilities = {
      canQuote: true, canRegister: true, canManageNs: true, customNs: true,
      prepaid: true, freePrivacy: true, afternicFastTransfer: false, sandbox: false, ...o.capabilities,
    };
    if (o.alreadyOwned) this.owned.set('*', { orderId: 'ord-prior', chargedCents: 1108 });
  }

  isOwned(domain: string): boolean {
    return this.owned.has(domain) || this.owned.has('*');
  }

  async quote(domain: string, opts: { signal?: AbortSignal } = {}): Promise<Quote> {
    this.calls.push(`quote ${domain}`);
    const n = this.quoteCalls++;
    if (this.o.hang) {
      await new Promise((_r, reject) =>
        opts.signal?.addEventListener('abort', () => reject(new RegistrarError(this.name, 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }))));
    }
    if (this.o.error) throw this.o.error;
    return {
      available: true, premium: false, firstYearCents: 1108, renewalCents: 1108, privacyCentsPerYear: 0,
      currency: 'USD', minDurationYears: 1, raw: { fake: this.name }, ...this.o.quote, ...this.o.quoteSeq?.[n],
    };
  }

  async accountState(): Promise<AccountState> {
    this.calls.push('accountState');
    if (isErr(this.o.account)) throw this.o.account;
    return { balanceCents: 100_000, spendLimitRemainingCents: 10_000, autoTopupEnabled: false, ...this.o.account };
  }

  async register(domain: string, input: RegisterInput): Promise<RegisterSuccess | RegisterDryRun> {
    this.calls.push(`register ${domain} dry=${input.dryRun} key=${input.idempotencyKey} cost=${input.costCents}`);
    if (input.dryRun) {
      const r = this.o.dryRun?.(this.dryRuns++);
      if (isErr(r)) throw r;
      return {
        kind: 'dry_run', wouldSucceed: true, costCents: input.costCents, durationYears: 1, balanceCents: 100_000,
        shortfallCents: null, withinMonthlySpendLimit: true, raw: {}, ...r,
      };
    }
    this.registerKeys.push(input.idempotencyKey);
    const replay = this.byKey.get(input.idempotencyKey);
    if (replay) return replay; // Porkbun replays the same key within 24 h
    const n = this.realRegisterCalls++;
    const outcome = this.o.register?.(n, input) ?? 'ok';
    if (outcome === 'ok') return this.charge(domain, input);
    if (isErr(outcome) && outcome.ambiguous && this.o.chargesOnAmbiguous) this.charge(domain, input);
    throw outcome;
  }

  private charge(domain: string, input: RegisterInput): RegisterSuccess {
    this.charges += 1;
    const res: RegisterSuccess = {
      kind: 'registered', orderId: `ord-${this.charges}`, chargedCents: input.costCents, balanceCents: 50_000,
      raw: { orderId: this.charges },
    };
    this.owned.set(domain, { orderId: res.orderId, chargedCents: input.costCents });
    this.byKey.set(input.idempotencyKey, res);
    return res;
  }

  async findDomain(domain: string): Promise<DomainInfo | null> {
    this.calls.push(`findDomain ${domain}`);
    const n = this.findCalls++;
    if (this.o.findDomain) {
      const r = this.o.findDomain(domain, n);
      if (r instanceof Error) throw r;
      return r;
    }
    if (!this.isOwned(domain)) return null;
    const set = this.autoRenew.get(domain);
    return {
      expiryDate: '2027-10-05', whoisPrivacy: true,
      autoRenew: this.o.autoRenewAfter !== undefined && set !== undefined ? this.o.autoRenewAfter : (set ?? true),
      apiAccess: true, ns: this.ns.get(domain) ?? null, ...this.o.domainInfo,
    };
  }

  async findRegistration(domain: string, _opts: { since: string }): Promise<RegistrationRecord | null> {
    this.calls.push(`findRegistration ${domain}`);
    if (this.o.findRegistration !== undefined) {
      if (isErr(this.o.findRegistration)) throw this.o.findRegistration;
      return this.o.findRegistration;
    }
    const rec = this.owned.get(domain) ?? this.owned.get('*');
    if (!rec) return null;
    return { orderId: rec.orderId, chargedCents: rec.chargedCents, expiryDate: '2027-10-05', invoiceDate: '2026-10-05', raw: { invoice: { id: rec.orderId } } };
  }

  async setNameservers(domain: string, ns: string[]): Promise<void | { pending: boolean }> {
    this.calls.push(`setNameservers ${domain} ${ns.join(',')}`);
    if (this.o.setNs) throw this.o.setNs;
    await this.o.onSetNs?.();
    this.ns.set(domain, ns);
    return this.o.setNsResult;
  }

  async getNameservers(domain: string): Promise<Set<string>> {
    this.calls.push(`getNameservers ${domain}`);
    if (this.o.getNsError) throw this.o.getNsError;
    return new Set(this.o.getNs ?? this.ns.get(domain) ?? []);
  }

  async setAutoRenew(domain: string, on: boolean): Promise<void> {
    this.calls.push(`setAutoRenew ${domain} ${on}`);
    if (this.o.setAutoRenew) throw this.o.setAutoRenew;
    this.autoRenew.set(domain, on);
  }

  async getReceipt(orderId: string): Promise<unknown> {
    this.calls.push(`getReceipt ${orderId}`);
    if (isErr(this.o.receipt)) throw this.o.receipt;
    return this.o.receipt ?? { invoice: { id: orderId, total_cents: 1108 } };
  }
}
