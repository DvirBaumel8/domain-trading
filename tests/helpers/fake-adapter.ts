import type {
  AccountState, Capabilities, DomainInfo, Quote, RegisterDryRun, RegisterInput, RegisterSuccess, RegistrarAdapter,
} from '../../src/registrars/types.js';
import { RegistrarError } from '../../src/registrars/types.js';

export class FakeAdapter implements RegistrarAdapter {
  readonly capabilities: Capabilities;
  readonly calls: string[] = [];

  constructor(
    readonly name: string,
    private readonly o: { quote?: Partial<Quote>; error?: RegistrarError; hang?: boolean; capabilities?: Partial<Capabilities> } = {},
  ) {
    this.capabilities = {
      canQuote: true, canRegister: true, canManageNs: true, customNs: true,
      prepaid: true, freePrivacy: true, afternicFastTransfer: false, sandbox: false, ...o.capabilities,
    };
  }

  async quote(domain: string, opts: { signal?: AbortSignal } = {}): Promise<Quote> {
    this.calls.push(`quote ${domain}`);
    if (this.o.hang) {
      await new Promise((_r, reject) =>
        opts.signal?.addEventListener('abort', () => reject(new RegistrarError(this.name, 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }))));
    }
    if (this.o.error) throw this.o.error;
    return {
      available: true, premium: false, firstYearCents: 1108, renewalCents: 1108, privacyCentsPerYear: 0,
      currency: 'USD', minDurationYears: 1, raw: { fake: this.name }, ...this.o.quote,
    };
  }

  async accountState(): Promise<AccountState> { this.calls.push('accountState'); throw new Error('not used by /check'); }
  async register(_d: string, _i: RegisterInput): Promise<RegisterSuccess | RegisterDryRun> { throw new Error('not used by /check'); }
  async findDomain(_d: string): Promise<DomainInfo | null> { throw new Error('not used by /check'); }
  async setNameservers(_d: string, _ns: string[]): Promise<void> { throw new Error('not used by /check'); }
  async getNameservers(_d: string): Promise<Set<string>> { throw new Error('not used by /check'); }
  async setAutoRenew(_d: string, _on: boolean): Promise<void> { throw new Error('not used by /check'); }
  async getReceipt(_o: string): Promise<unknown> { throw new Error('not used by /check'); }
}
