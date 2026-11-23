export interface Capabilities {
  canQuote: boolean; canRegister: boolean; canManageNs: boolean; customNs: boolean;
  prepaid: boolean; freePrivacy: boolean; afternicFastTransfer: boolean; sandbox: boolean;
}
export interface Quote {
  available: boolean; premium: boolean;
  firstYearCents: number | null; renewalCents: number | null; privacyCentsPerYear: number;
  currency: string; minDurationYears: number | null; raw: unknown;
}
export interface RegistrarAdapter {
  readonly name: string;
  readonly capabilities: Capabilities;
  quote(domain: string, opts?: { signal?: AbortSignal }): Promise<Quote>;
}

/** Codes for outcomes where the registrar may or may not have acted (never retry a purchase with a new key). */
export const AMBIGUOUS_CODES: readonly string[] = ['REGISTRAR_TIMEOUT', 'REGISTRAR_NETWORK', 'REGISTRAR_HTTP_5XX', 'REGISTRAR_BAD_RESPONSE', 'IDEMPOTENCY_KEY_IN_USE'];

export class RegistrarError extends Error {
  readonly httpStatus: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly ambiguous: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    readonly registrar: string,
    readonly code: string,
    message: string,
    opts: { httpStatus?: number; retryAfterSeconds?: number; ambiguous?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'RegistrarError';
    this.httpStatus = opts.httpStatus;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.ambiguous = opts.ambiguous ?? AMBIGUOUS_CODES.includes(code);
    this.details = opts.details ?? {};
  }
}
