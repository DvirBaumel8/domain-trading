import { formatUsd } from '../money.js';
import type { RdapStatus } from '../rdap.js';
import type { Capabilities, Quote, RegistrarError } from '../registrars/types.js';

export const ADAPTER_ORDER: readonly string[] = ['porkbun', 'dynadot', 'namecom'];

export type ExclusionReason =
  | 'NO_CUSTOM_NAMESERVERS' | 'NO_AVAILABILITY_ACCESS' | 'REGISTRAR_NOT_ALLOWED' | 'ADAPTER_ERROR'
  | 'NOT_AVAILABLE' | 'PREMIUM' | 'NOT_USD' | 'MULTI_YEAR_MINIMUM' | 'NO_FIRST_YEAR_PRICE' | 'NO_RENEWAL_PRICE';

export interface QuoteOutcome { registrar: string; capabilities: Capabilities; quote: Quote | null; error: RegistrarError | null }

export interface EvaluatedQuote {
  registrar: string; capabilities: Capabilities;
  available: boolean | null; premium: boolean | null;
  firstYearCents: number | null; renewalCents: number | null; privacyCentsPerYear: number | null; twoYearCents: number | null;
  eligible: boolean; exclusionReason: ExclusionReason | null; errorCode: string | null; raw: unknown;
}

export function twoYearCents(firstYear: number, renewal: number, privacyPerYear: number): number {
  return firstYear + renewal + 2 * privacyPerYear; // first year + exactly ONE renewal
}

function preCallExclusion(caps: Capabilities, registrar: string, allowed: readonly string[]): ExclusionReason | null {
  if (!caps.customNs) return 'NO_CUSTOM_NAMESERVERS';
  if (!caps.canQuote || !caps.canRegister) return 'NO_AVAILABILITY_ACCESS';
  if (!allowed.includes(registrar)) return 'REGISTRAR_NOT_ALLOWED';
  return null;
}

export function shouldCall(caps: Capabilities, registrar: string, allowed: readonly string[]): boolean {
  return preCallExclusion(caps, registrar, allowed) === null;
}

export function evaluateQuote(o: QuoteOutcome, allowed: readonly string[]): EvaluatedQuote {
  const q = o.quote;
  const base: EvaluatedQuote = {
    registrar: o.registrar, capabilities: o.capabilities,
    available: q?.available ?? null, premium: q?.premium ?? null,
    firstYearCents: q?.firstYearCents ?? null, renewalCents: q?.renewalCents ?? null,
    privacyCentsPerYear: q?.privacyCentsPerYear ?? null, twoYearCents: null,
    eligible: false, exclusionReason: null, errorCode: o.error?.code ?? null,
    raw: q?.raw ?? (o.error ? { error: { code: o.error.code } } : null),
  };
  const exclude = (r: ExclusionReason): EvaluatedQuote => ({ ...base, exclusionReason: r });

  const pre = preCallExclusion(o.capabilities, o.registrar, allowed);
  if (pre) return exclude(pre);
  if (o.error || !q) return exclude('ADAPTER_ERROR');
  if (!q.available) return exclude('NOT_AVAILABLE');
  if (q.premium) return exclude('PREMIUM');
  if (q.currency !== 'USD') return exclude('NOT_USD');
  if (q.minDurationYears !== null && q.minDurationYears !== 1) return exclude('MULTI_YEAR_MINIMUM');
  if (q.firstYearCents === null) return exclude('NO_FIRST_YEAR_PRICE');
  if (q.renewalCents === null) return exclude('NO_RENEWAL_PRICE');
  return {
    ...base,
    twoYearCents: twoYearCents(q.firstYearCents, q.renewalCents, q.privacyCentsPerYear),
    eligible: true,
  };
}

function orderIndex(registrar: string): number {
  const i = ADAPTER_ORDER.indexOf(registrar);
  return i === -1 ? ADAPTER_ORDER.length : i;
}

function byAdapterOrder(a: { registrar: string }, b: { registrar: string }): number {
  return orderIndex(a.registrar) - orderIndex(b.registrar) || a.registrar.localeCompare(b.registrar);
}

export function sortByAdapterOrder<T extends { registrar: string }>(xs: T[]): T[] {
  return [...xs].sort(byAdapterOrder);
}

export function pickWinner(
  evals: EvaluatedQuote[],
  caps: { maxFirstYearCents?: number; maxTwoYearCents?: number } = {},
): EvaluatedQuote | null {
  const candidates = evals.filter(
    (e) =>
      e.eligible &&
      (caps.maxFirstYearCents === undefined || e.firstYearCents! <= caps.maxFirstYearCents) &&
      (caps.maxTwoYearCents === undefined || e.twoYearCents! <= caps.maxTwoYearCents),
  );
  candidates.sort(
    (a, b) =>
      a.twoYearCents! - b.twoYearCents! ||
      Number(b.capabilities.prepaid) - Number(a.capabilities.prepaid) ||
      Number(b.capabilities.afternicFastTransfer) - Number(a.capabilities.afternicFastTransfer) ||
      byAdapterOrder(a, b),
  );
  return candidates[0] ?? null;
}

export function overallAvailability(rdap: RdapStatus, evals: EvaluatedQuote[]): 'available' | 'taken' | 'unknown' {
  const answers = evals.filter((e) => e.available !== null).map((e) => e.available);
  const saysYes = answers.includes(true);
  const saysNo = answers.includes(false);
  const disagree = (saysYes && saysNo) || (rdap === 'registered' && saysYes) || (rdap === 'not_registered' && saysNo);
  if (disagree) return 'unknown';
  if (rdap === 'registered' || saysNo) return 'taken';
  if (rdap === 'not_registered' && saysYes) return 'available';
  return 'unknown';
}

export function firstYearWarning(evals: EvaluatedQuote[], winner: EvaluatedQuote | null): string | null {
  if (!winner) return null;
  const cheapest = sortByAdapterOrder(evals.filter((e) => e.eligible))
    .sort((a, b) => a.firstYearCents! - b.firstYearCents!)[0];
  if (!cheapest || cheapest.registrar === winner.registrar || cheapest.firstYearCents! >= winner.firstYearCents!) return null;
  return `Cheapest first year (${cheapest.registrar} ${formatUsd(cheapest.firstYearCents!)}) is not cheapest over 2 years`;
}
