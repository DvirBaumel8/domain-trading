// v2.6.0 (CR-009): sibling method bt1@v2 (routes, census), test sets with sibling_method and features_as_of, not_screened (N-7),
// Web Risk error detail (N-3), a non-WRITE token on POST /jobs/run (N-4). N-2 (preview) is in jobs-v2-1.test.ts, the blocklist rule in portfolio-check.test.ts.
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { deriveItem } from '../../../src/modules/selection/derive.js';
import { siblingsBt1 } from '../../../src/modules/selection/siblings.js';
import { splitV2 } from '../../../src/modules/selection/split-v2.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(screening?: object): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup: fakeRdap({}), ...screening } });
  app = x.app;
  return x;
}
const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const fakeRdap = (table: Record<string, RdapLookup>): RdapLookupFn => async (domain) => table[domain] ?? notRegistered();
const approval = (x: ScreeningHarness, method: string) => ({ text: `sibling method ${method} approved`, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });
const approve = async (x: ScreeningHarness, method: string) => expect((await x.post(`/selection/sibling-methods/${method}/approve`, { approval_ref: approval(x, method) })).statusCode).toBe(201);
const byDomain = (body: any, domain: string) => body.names.find((n: any) => n.domain === domain);
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check);
const sibs = (tokens: string[]) => siblingsBt1(tokens).map((l) => `${l}.com`);

describe('POST /jobs/run by a non-WRITE token (CR-009 N-4)', () => {
  it('V26-14 a READ token is 401 with no RateLimit headers and never consumes the WRITE limiter (4 WRITE starts still succeed afterwards)', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
    const read = await issueToken('read');
    const write = await issueToken('write');
    const post = (auth: Record<string, string>, i: number) => app!.inject({ method: 'POST', url: '/jobs/run', headers: { ...auth, 'idempotency-key': `n4-${i}` }, payload: { job: 'tick' } });
    for (let i = 0; i < 6; i++) {
      const r = await post(read.auth, i);
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHORIZED');
      expect(Object.keys(r.headers).filter((k) => k.startsWith('ratelimit') || k === 'retry-after')).toEqual([]);
    }
    const codes: number[] = [];
    for (let i = 10; i < 14; i++) codes.push((await post(write.auth, i)).statusCode);
    expect(codes).toEqual([202, 202, 202, 202]); // v3.0.0: 202 (queued)
  });
});
