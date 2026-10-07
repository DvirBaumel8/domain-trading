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
  | { kind: 'unknown'; reason: 'QUOTA' | 'QUOTA_CAP' | 'SOURCE_ERROR' };

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
  if ((await takeLookup(deps.db, utcMonth(deps.now()))) > WEB_RISK_MONTHLY_CAP) return { kind: 'unknown', reason: 'QUOTA_CAP' };
  const q = [...THREATS.map((t) => `threatTypes=${t}`), `uri=${encodeURIComponent(`http://${domain}/`)}`].join('&');
  try {
    const res = await deps.fetch(`${ENDPOINT}?${q}`, { headers: { 'x-goog-api-key': deps.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429) {
      void res.body?.cancel().catch(() => {});
      return { kind: 'unknown', reason: 'QUOTA' };
    }
    if (res.status === 403) {
      // 403 is a quota answer only when the error body says so (otherwise it is a key or permission problem).
      const text = (await res.text().catch(() => '')).slice(0, 4000);
      return { kind: 'unknown', reason: /quota|rateLimit|RESOURCE_EXHAUSTED/i.test(text) ? 'QUOTA' : 'SOURCE_ERROR' };
    }
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      return { kind: 'unknown', reason: 'SOURCE_ERROR' };
    }
    const body: unknown = JSON.parse(await res.text());
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { kind: 'unknown', reason: 'SOURCE_ERROR' };
    const threat = (body as { threat?: unknown }).threat;
    if (threat === undefined) return { kind: 'clean' };
    if (typeof threat !== 'object' || threat === null) return { kind: 'unknown', reason: 'SOURCE_ERROR' };
    const t = threat as { threatTypes?: unknown; expireTime?: unknown };
    if (!Array.isArray(t.threatTypes) || t.threatTypes.length === 0 || !t.threatTypes.every((x) => typeof x === 'string')) return { kind: 'unknown', reason: 'SOURCE_ERROR' };
    return { kind: 'match', threatTypes: t.threatTypes as string[], expireTime: typeof t.expireTime === 'string' ? t.expireTime : null };
  } catch {
    return { kind: 'unknown', reason: 'SOURCE_ERROR' };
  }
}
