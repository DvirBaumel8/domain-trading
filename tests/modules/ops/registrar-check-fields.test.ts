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

describe('v3.7.0 CR-033 G-6: registrarCheck reads auto-renew, privacy and nameservers', () => {
  const D = 'ukcbamcompliance.com';
  const seen: string[] = [];
  const mock = (o: { autoRenew: number; privacy: number; ns: string[] }) => {
    seen.length = 0;
    mswServer.use(
      http.get(`${PORKBUN_BASE}/domain/get/:d`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ status: 'SUCCESS', domain: { domain: D, expireDate: '2027-10-09 09:00:00', whoisPrivacy: o.privacy, autoRenew: o.autoRenew, apiAccess: 1 } });
      }),
      http.post(`${PORKBUN_BASE}/domain/getNs/:d`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ status: 'SUCCESS', ns: o.ns });
      }),
    );
  };
  const NOW = Date.parse('2026-10-10T00:30:00Z');

  it('T33-G6: stored append-only, shown in /portfolio, AUTO_RENEW_ON error and REGISTRAR_DRIFT warn; the latest check decides; read-only calls only', async () => {
    const pb = new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 2000 });
    app = await makeApp({ adapters: [pb], now: () => NOW });
    const read = (await issueToken('read')).auth;
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full', lander: 'afternic', lander_ns: AFN, ns_verified_at: new Date(NOW) });
    const job = () => new RegistrarCheckJob({ db, adapters: [pb], now: () => NOW });

    mock({ autoRenew: 1, privacy: 0, ns: ['ns1.porkbun.com', 'ns2.porkbun.com'] });
    expect(await job().runOnce()).toMatchObject({ checked: 1, present: 1 });
    expect(seen.every((p) => /\/domain\/(get|getNs)\//.test(p))).toBe(true);
    const detail = (await get(`/portfolio/${D}`, read)).json();
    expect(detail.registrar_state).toMatchObject({ auto_renew: true, privacy: false, ns: ['ns1.porkbun.com', 'ns2.porkbun.com'] });
    expect(detail.registrar_state.checked_at).toMatch(/\+0[23]:00$/);
    const w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'AUTO_RENEW_ON')).toMatchObject({ level: 'error', domain: D });
    expect(w.find((x) => x.code === 'REGISTRAR_DRIFT')).toMatchObject({ level: 'warn', domain: D, details: { drift: ['privacy_off', 'nameservers'] } });
    await expect(db.updateTable('registrar_state_checks').set({ auto_renew: false }).execute()).rejects.toThrow(/append-only/);

    mock({ autoRenew: 0, privacy: 1, ns: ['NS2.Afternic.com.', 'ns1.afternic.com'] });
    await job().runOnce();
    expect((await get(`/portfolio/${D}`, read)).json().registrar_state).toMatchObject({ auto_renew: false, privacy: true, ns: AFN });
    expect((await reportWarnings(read)).filter((x) => ['AUTO_RENEW_ON', 'REGISTRAR_DRIFT'].includes(x.code))).toEqual([]);
    expect(await db.selectFrom('registrar_state_checks').select('id').execute()).toHaveLength(2);
  });

  it('T33-G6b: a name at another registrar, and a name not yet checked, have registrar_state null', async () => {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read')).auth;
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full' });
    expect((await get(`/portfolio/${D}`, read)).json().registrar_state).toBeNull();
    await listedDomain({ domain: 'gd-one.com', registrar: 'godaddy', registrar_api: 'manage' });
    const gd = new FakeAdapter('godaddy', { domainInfo: { autoRenew: true } });
    await new RegistrarCheckJob({ db, adapters: [gd], now: () => NOW }).runOnce();
    expect(await db.selectFrom('registrar_state_checks').select('id').execute()).toHaveLength(0);
  });
});
