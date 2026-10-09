// v3.7.0: CR-031 B (offer dry run), CR-031 C (hand listings per venue), CR-033 G-1, G-2, G-3, G-6, G-8, G-9.
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { newAuditId } from '../../../src/http/audit.js';
import { RegistrarCheckJob } from '../../../src/modules/ops/jobs/registrar-check.js';
import { PorkbunAdapter } from '../../../src/modules/registrars/porkbun.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { buyBody, postBuy } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { FAKE_KEYS, PORKBUN_BASE } from '../../helpers/porkbun-msw.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const AFN = ['ns1.afternic.com', 'ns2.afternic.com'];
const key = () => randomUUID();
const get = (url: string, auth: Record<string, string>) => app.inject({ method: 'GET', url, headers: auth });
const post = (url: string, auth: Record<string, string>, payload: object) =>
  app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': key() }, payload });
const reportWarnings = async (auth: Record<string, string>) =>
  (await get('/report', auth)).json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('v3.7.0 CR-033 G-8: LANDER_AWAITING_MARKETPLACE before the first confirmed Afternic upload', () => {
  const D = 'aievalsconsulting.com';
  const NOW = Date.parse('2026-10-12T09:00:00Z');
  const fail = async (id: number, at: string) =>
    db.insertInto('portfolio_checks').values({ domain_id: id, kind: 'web', status: 'fail', at: new Date(at), details: JSON.stringify({ status_code: null, reason: 'network_error' }) }).execute();

  it('T33-G8: info while never uploaded; LANDER_DOWN counts only from the first confirmed upload', async () => {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read')).auth;
    const id = await listedDomain({ domain: D, lander: 'afternic', lander_ns: AFN, ns_verified_at: new Date(NOW) });
    await fail(id, '2026-10-08T09:00:00Z');
    await fail(id, '2026-10-09T09:00:00Z');
    let w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_AWAITING_MARKETPLACE')).toMatchObject({ level: 'info', domain: D });
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toBeUndefined();

    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: [D], export_id: 'exp_g8' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'exp_g8', domains: [D], uploaded_at: new Date('2026-10-10T09:00:00Z'), approval_text: 'uploaded' }).execute();
    w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_AWAITING_MARKETPLACE')).toBeUndefined();
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toBeUndefined(); // the old fails predate the upload

    await fail(id, '2026-10-11T09:00:00Z');
    w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toMatchObject({ level: 'warn', domain: D });
    await fail(id, '2026-10-12T01:00:00Z'); // a second IDT day after the upload
    w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toMatchObject({ level: 'error', domain: D });
  });
});
