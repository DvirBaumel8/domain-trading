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

describe('v3.7.0 CR-033 G-1: nsVerifier always checks names never verified', () => {
  it('T33-G1: a manual tick after the day\'s NS check verifies a new name whose NS are public; verified names are not re-checked', async () => {
    const NOW = Date.parse('2026-10-09T12:00:00Z');
    const seen: string[] = [];
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')], env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' }, nsLookup: async (d) => { seen.push(d); return AFN; } });
    await insertOwnedDomain(db, { domain: 'oldone.com', lander: 'afternic', lander_ns: AFN, ns_verified_at: new Date(NOW - 86_400_000) });
    await insertOwnedDomain(db, { domain: 'newone.com', lander: 'afternic', lander_ns: AFN, ns_verified_at: null });
    await db.insertInto('audit_log').values({ id: newAuditId(), at: new Date(NOW - 3_600_000), scope: 'job', method: 'JOB', path: 'ns-verify', status_code: 200, result_summary: 'earlier today' }).execute();
    const read = (await issueToken('read')).auth;
    expect((await reportWarnings(read)).filter((w) => w.code === 'NS_UNVERIFIED').map((w) => w.domain)).toEqual(['newone.com']);

    const run = await runJobToEnd(app, 'tick');
    expect(run.json().steps.nsVerifier).toMatchObject({ ok: true });
    expect(run.json().steps.nsVerifier.skipped).toBeUndefined();
    expect(seen).toEqual(['newone.com']);
    expect((await db.selectFrom('domains').select('ns_verified_at').where('domain', '=', 'newone.com').executeTakeFirstOrThrow()).ns_verified_at).not.toBeNull();
    expect((await reportWarnings(read)).filter((w) => w.code === 'NS_UNVERIFIED')).toEqual([]);
    // the daily marker is untouched, so the next tick has nothing unverified and is skipped
    expect((await runJobToEnd(app, 'tick')).json().steps.nsVerifier).toMatchObject({ ok: true, skipped: true });
  });
});
