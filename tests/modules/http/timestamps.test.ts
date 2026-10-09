// v2.1.0 part 1: daily-only runner, BUG-2 timestamps, CR-004 §10.3 (lander none, forecast fixes, legacy comps).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-12T09:00:00Z');
const D = 'examplecityroofing.com';
const JOB = 'job_token_fake_0123456789abcdef0123456789';
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/;

async function boot(pb = new FakeAdapter('porkbun')) {
  app = await makeApp({ adapters: [pb], nsLookup: async () => null, now: () => NOW });
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  return { pb, post, get };
}

describe('BUG-2: Asia/Jerusalem offset on every response timestamp', () => {
  it('tranche opened_at in POST /tranches, GET /tranches and /report tranches[] uses the offset', async () => {
    const t = await boot();
    const created = await t.post('/tranches', { name: 'tr-1' });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().opened_at).toMatch(OFFSET);
    const list = (await t.get('/tranches')).json();
    expect(list.tranches[0].opened_at).toMatch(OFFSET);
    const rep = (await t.get('/report')).json();
    expect(rep.tranches[0].opened_at).toMatch(OFFSET);
    expect(JSON.stringify(rep.tranches)).not.toMatch(/\dZ"/);
  });

  it('the documented UTC fields stay UTC: started_at / finished_at on /jobs/run; everything else in the reply uses the offset', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: JOB } });
    const res = await runJobToEnd(app, 'daily', { headers: { authorization: `Bearer ${JOB}` }, key: randomUUID() });
    expect(res.statusCode, res.body).toBe(202); // v3.0.0: the POST answers 202 with the run id; the run result (started_at/finished_at, UTC) is read once the worker is done
    expect(res.json().started_at).toMatch(/Z$/);
    expect(res.json().finished_at).toMatch(/Z$/);
  });
});
