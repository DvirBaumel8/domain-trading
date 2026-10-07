// Google Web Risk, Lookup API only (CR-007 G-6): GET v1/uris:search. The Update API is never used (a static test checks src/).
// The key travels in the `x-goog-api-key` header, never in a URL, and is never logged. A monthly counter (api_usage) stops the service at
// WEB_RISK_MONTHLY_CAP lookups per UTC calendar month, so the free tier can never turn into a bill.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export const WEB_RISK_MONTHLY_CAP = 10_000;
export const WEB_RISK_SOURCE = 'web_risk';
const ENDPOINT = 'https://webrisk.googleapis.com/v1/uris:search';
const TIMEOUT_MS = 8000;
const THREATS = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'];

export type WebRiskResult =
  | { kind: 'match'; threatTypes: string[]; expireTime: string | null }
  | { kind: 'clean' }
  | { kind: 'unknown'; reason: 'QUOTA' | 'QUOTA_CAP' | 'SOURCE_ERROR'; httpStatus: number | null; error: WebRiskError | null };

/** Google's error body, parsed (v2.6.0, CR-009 N-3): `error.status`, the first `error.details[].reason`, else `error.message` cut to 200 chars. Never the key. */
export interface WebRiskError { status: string | null; reason: string | null; message: string | null }

export function parseWebRiskError(text: string): WebRiskError | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  const e = (j as { error?: unknown } | null)?.error;
  if (typeof e !== 'object' || e === null) return null;
  const x = e as { status?: unknown; message?: unknown; details?: unknown };
  const reasons = Array.isArray(x.details) ? x.details.map((d) => (d as { reason?: unknown } | null)?.reason).filter((r): r is string => typeof r === 'string') : [];
  const reason = reasons[0] ?? null;
  return {
    status: typeof x.status === 'string' ? x.status.slice(0, 80) : null, reason: reason === null ? null : reason.slice(0, 120),
    message: reason === null && typeof x.message === 'string' ? x.message.slice(0, 200) : null,
  };
}
const unknownOf = (reason: 'QUOTA' | 'QUOTA_CAP' | 'SOURCE_ERROR', httpStatus: number | null = null, error: WebRiskError | null = null): WebRiskResult => ({ kind: 'unknown', reason, httpStatus, error });

export const utcMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** Counts one lookup for the month; returns the new count. Atomic, so concurrent callers never share a number. */
async function takeLookup(db: Kysely<Database>, month: string): Promise<number> {
  const r = await db.insertInto('api_usage').values({ source: WEB_RISK_SOURCE, month, calls: 1 })
    .onConflict((oc) => oc.columns(['source', 'month']).doUpdateSet((eb) => ({ calls: eb('api_usage.calls', '+', 1) })))
    .returning('calls').executeTakeFirstOrThrow();
  return r.calls;
}

export async function webRiskLookup(
  deps: { db: Kysely<Database>; fetch: typeof fetch; apiKey: string; now: () => number },
  domain: string,
): Promise<WebRiskResult> {
  // The count is taken before the call: a call that then fails still counts (the cap is a ceiling on attempts).
  if ((await takeLookup(deps.db, utcMonth(deps.now()))) > WEB_RISK_MONTHLY_CAP) return unknownOf('QUOTA_CAP');
  const q = [...THREATS.map((t) => `threatTypes=${t}`), `uri=${encodeURIComponent(`http://${domain}/`)}`].join('&');
  let httpStatus: number | null = null;
  try {
    const res = await deps.fetch(`${ENDPOINT}?${q}`, { headers: { 'x-goog-api-key': deps.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    httpStatus = res.status;
    if (res.status !== 200) {
      const text = (await res.text().catch(() => '')).slice(0, 4000);
      const error = parseWebRiskError(text);
      // 429 is a quota answer; 403 only when the error body says so (otherwise it is a key or permission problem).
      const quota = res.status === 429 || (res.status === 403 && /quota|rateLimit|RESOURCE_EXHAUSTED/i.test(text));
      return unknownOf(quota ? 'QUOTA' : 'SOURCE_ERROR', res.status, error);
    }
    const body: unknown = JSON.parse(await res.text());
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return unknownOf('SOURCE_ERROR', httpStatus);
    const threat = (body as { threat?: unknown }).threat;
    if (threat === undefined) return { kind: 'clean' };
    if (typeof threat !== 'object' || threat === null) return unknownOf('SOURCE_ERROR', httpStatus);
    const t = threat as { threatTypes?: unknown; expireTime?: unknown };
    if (!Array.isArray(t.threatTypes) || t.threatTypes.length === 0 || !t.threatTypes.every((x) => typeof x === 'string')) return unknownOf('SOURCE_ERROR', httpStatus);
    return { kind: 'match', threatTypes: t.threatTypes as string[], expireTime: typeof t.expireTime === 'string' ? t.expireTime : null };
  } catch {
    return unknownOf('SOURCE_ERROR', httpStatus);
  }
}
