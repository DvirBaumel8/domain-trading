// Google Web Risk (uris.search): does Google list the name as malware, social engineering or unwanted software?
import { z } from 'zod';
import { readJson, SourceError, type Fetch, type SourceErrorCode } from './client.js';

const SOURCE = 'web_risk';
const THREATS = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'] as const;
/** Two lookups a name. Google's first 100,000 a month are free; this keeps one running server under half of that. */
const MAX_LOOKUPS_PER_DAY = 1500;

export interface WebRisk { status: 'clean' | 'flagged' | 'missing_key' | 'error'; threatTypes: string[]; checkedAt: Date; errorCode: SourceErrorCode | null }
export type WebRiskFn = (domain: string) => Promise<WebRisk>;

// strict: an answer of another shape is never "clean"
const Answer = z.strictObject({ threat: z.object({ threatTypes: z.array(z.string()).min(1) }).optional() });

export function createWebRisk(key: string | null, now: () => number, fetchFn: Fetch = fetch): WebRiskFn {
  let day = 0;
  let used = 0;
  const lookup = async (uri: string): Promise<string[]> => {
    const url = new URL('https://webrisk.googleapis.com/v1/uris:search');
    for (const t of THREATS) url.searchParams.append('threatTypes', t);
    url.searchParams.set('uri', uri);
    const parsed = Answer.safeParse(await readJson(fetchFn, { source: SOURCE, url: url.href, headers: { 'x-goog-api-key': key! } }));
    if (!parsed.success) throw new SourceError(SOURCE, 'BAD_RESPONSE', 200);
    return parsed.data.threat?.threatTypes ?? [];
  };
  return async (domain) => {
    const answer = (status: WebRisk['status'], threatTypes: string[] = [], errorCode: SourceErrorCode | null = null): WebRisk => ({ status, threatTypes, checkedAt: new Date(now()), errorCode });
    if (key === null) return answer('missing_key', [], 'KEY_MISSING');
    const today = Math.floor(now() / 86_400_000);
    if (today !== day) { day = today; used = 0; }
    if (used + 2 > MAX_LOOKUPS_PER_DAY) return answer('error', [], 'DAILY_LIMIT');
    used += 2;
    const results = await Promise.allSettled([lookup(`http://${domain}/`), lookup(`https://${domain}/`)]);
    const threats = [...new Set(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))].sort();
    if (threats.length > 0) return answer('flagged', threats); // one hit is enough, even when the other lookup failed
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) return answer('error', [], failed.reason instanceof SourceError ? failed.reason.code : 'BAD_RESPONSE');
    return answer('clean');
  };
}
