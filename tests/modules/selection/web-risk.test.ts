// v2.3.0 (CR-007 G-6): the web_risk check uses the Google Web Risk Lookup API when GOOGLE_WEB_RISK_API_KEY is set (MSW; the key is fake).
import { afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../../src/config.js';
import { WEB_RISK_MONTHLY_CAP } from '../../../src/modules/selection/web-risk.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { screeningHarness } from '../../helpers/screening.js';
import { mswServer } from '../../setup/network.js';

const KEY = 'wr_fake_key_0000000000000000';
const HOST = 'https://webrisk.googleapis.com/v1/uris:search';
let app: FastifyInstance | undefined;
let lastDomain = '';
afterEach(async () => app?.close());

const seen: { url: URL; key: string | null }[] = [];
const serve = (fn: () => Response | Promise<Response>) => {
  seen.length = 0;
  mswServer.use(http.get(HOST, ({ request }) => { seen.push({ url: new URL(request.url), key: request.headers.get('x-goog-api-key') }); return fn(); }));
};

/** A finished run of one name: web_risk only (plus history when asked), requires_clean_history off unless asked. */
let n = 0;
async function run(o: { key?: string | null; cleanHistory?: boolean; withHistory?: boolean } = {}) {
  const domain = `site${++n}.com`;
  lastDomain = domain;
  const x = await screeningHarness({ screening: o.key === null ? {} : { webRiskApiKey: o.key ?? KEY } });
  app = x.app;
  if (o.cleanHistory === false) await x.post('/selection/settings', { label: 'v1d', set: { 'web_risk.requires_clean_history': false } });
  const checks = o.withHistory ? ['web_risk', 'history'] : ['web_risk'];
  const r = await x.runDone({ checks, names: [{ domain, lane: 'S3' }], ...(o.cleanHistory === false && { mode: 'full', settings: 'v1d' }) });
  return r.body.names[0].results.find((q: any) => q.check === 'web_risk');
}

describe('web_risk check with the Lookup API', () => {
  it('a match: FAIL UNSAFE with the threat types; the key is in the x-goog-api-key header only, never in the URL', async () => {
    serve(() => HttpResponse.json({ threat: { threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING'], expireTime: '2026-10-07T00:00:00Z' } }));
    const r = await run();
    expect(r).toMatchObject({ status: 'FAIL', reason_code: 'UNSAFE', upstream_calls: 1, fields: { source: 'web_risk_api', threat_types: ['MALWARE', 'SOCIAL_ENGINEERING'] } });
    expect(r.fields.checked_at).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe(KEY);
    expect(seen[0]!.url.href).not.toContain(KEY);
    expect(seen[0]!.url.searchParams.getAll('threatTypes')).toEqual(['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE']);
    expect(seen[0]!.url.searchParams.get('uri')).toBe(`http://${lastDomain}/`);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('{} is no match: PASS when history need not be clean', async () => {
    serve(() => HttpResponse.json({}));
    expect(await run({ cleanHistory: false })).toMatchObject({ status: 'PASS', reason_code: null, fields: { source: 'web_risk_api', threat_types: [] } });
  });

  it('{} is no match: PASS even with requires_clean_history on and no final history (CR-001 CAP-06: the history condition is the interim source only)', async () => {
    serve(() => HttpResponse.json({}));
    expect(await run()).toMatchObject({ status: 'PASS', reason_code: null, fields: { source: 'web_risk_api', threat_types: [] } });
  });

  it.each([
    ['a 429', () => HttpResponse.json({ error: { code: 429 } }, { status: 429 }), 'QUOTA'],
    ['a 403 that says quota', () => HttpResponse.json({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, { status: 403 }), 'QUOTA'],
    ['a plain 403', () => HttpResponse.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }), 'SOURCE_ERROR'],
    ['a 500', () => new HttpResponse('boom', { status: 500 }), 'SOURCE_ERROR'],
    ['an unreadable 200 body', () => new HttpResponse('<html>', { status: 200 }), 'SOURCE_ERROR'],
    ['a network error', () => HttpResponse.error(), 'SOURCE_ERROR'],
  ])('%s is UNKNOWN with its reason code', async (_n, answer, code) => {
    serve(answer);
    expect(await run()).toMatchObject({ status: 'UNKNOWN', reason_code: code });
  });

  it('QUOTA_CAP: at the monthly cap no call is made and the answer is UNKNOWN QUOTA_CAP', async () => {
    await db.insertInto('api_usage').values({ source: 'web_risk', month: '2026-10', calls: WEB_RISK_MONTHLY_CAP }).execute();
    serve(() => HttpResponse.json({}));
    const r = await run();
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'QUOTA_CAP', upstream_calls: 0 });
    expect(seen).toHaveLength(0);
    expect((await db.selectFrom('api_usage').select('calls').executeTakeFirstOrThrow()).calls).toBe(WEB_RISK_MONTHLY_CAP + 1);
  });

  it('the counter is per UTC month: a full September does not stop October', async () => {
    await db.insertInto('api_usage').values({ source: 'web_risk', month: '2026-09', calls: WEB_RISK_MONTHLY_CAP }).execute();
    serve(() => HttpResponse.json({}));
    await run({ cleanHistory: false });
    expect(seen).toHaveLength(1);
    const rows = await db.selectFrom('api_usage').select(['month', 'calls']).orderBy('month').execute();
    expect(rows).toEqual([{ month: '2026-09', calls: WEB_RISK_MONTHLY_CAP }, { month: '2026-10', calls: 1 }]);
  });

  it('without a key: MANUAL_REQUIRED exactly as before, no call; the manual route is the fallback', async () => {
    serve(() => HttpResponse.json({}));
    const r = await run({ key: null });
    expect(r).toMatchObject({ status: 'MANUAL_REQUIRED', reason_code: 'MANUAL_SOURCE', fields: { source: 'transparency_report_interim' } });
    expect(seen).toHaveLength(0);
  });

  it('the key is a secret in the config (leak tests and log redaction) and empty means unset', () => {
    const c = loadConfig(testEnv({ GOOGLE_WEB_RISK_API_KEY: KEY }));
    expect(c.webRiskApiKey).toBe(KEY);
    expect(c.secretValues).toContain(KEY);
    expect(loadConfig(testEnv({ GOOGLE_WEB_RISK_API_KEY: '' })).webRiskApiKey).toBeUndefined();
  });
});
