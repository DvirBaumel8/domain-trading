import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { GoDaddyAdapter } from '../../src/modules/registrars/godaddy.js';
import { RegistrarError } from '../../src/modules/registrars/types.js';
import { logCapture, makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { FAKE_PAT, GODADDY_BASE, godaddyNsHandlers, type GdRequest } from '../helpers/godaddy-msw.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const T0 = Date.parse('2026-10-06T09:00:00Z'); // fixed clock: the suite must not depend on the calendar
const AFTERNIC = ['ns1.afternic.com', 'ns2.afternic.com'];

/** A fake clock that only moves when the adapter sleeps (or `jump` is called). */
const adapter = (o: { pollTimeoutMs?: number; jumpPerPoll?: number } = {}) => {
  let t = 0;
  return new GoDaddyAdapter({
    pat: FAKE_PAT, baseUrl: GODADDY_BASE, pollIntervalMs: 10, pollTimeoutMs: o.pollTimeoutMs ?? 1000,
    now: () => t, sleep: async (ms) => { t += ms + (o.jumpPerPoll ?? 0); },
  });
};

async function setup(gd: GoDaddyAdapter, logStream?: Parameters<typeof makeApp>[0] extends infer O ? (O extends { logStream?: infer L } ? L : never) : never) {
  app = await makeApp({ adapters: [gd], nsLookup: async () => null, now: () => T0, ...(logStream ? { logStream } : {}) });
  await insertOwnedDomain(db, { domain: D, registrar: 'godaddy', registrar_api: 'manage', category: 'trend' });
  return (await issueToken('write')).auth;
}
const list = (auth: Record<string, string>, body: object = {}) =>
  app.inject({ method: 'POST', url: `/list/${D}`, headers: { ...auth, 'idempotency-key': randomUUID() }, payload: body });
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();

describe('GoDaddy NS through /list', () => {
  it('L-12: 202 + operation polling to SUCCESS → ns_status set; right body; PAT in the header; 2 polls', async () => {
    const rec: GdRequest[] = [];
    mswServer.use(
      ...godaddyNsHandlers({ operationStatuses: ['PENDING', 'SUCCESS'], recorded: rec }),
      http.get(`${GODADDY_BASE}/v3/domains/domain-names/:d`, ({ request }) => {
        rec.push({ method: 'GET', path: new URL(request.url).pathname, auth: null, body: null });
        return HttpResponse.json({ domain: D, nameServers: AFTERNIC });
      }),
    );
    const logs = logCapture();
    const auth = await setup(adapter(), logs.stream);
    const res = await list(auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ns_status: 'set', lander: 'afternic' });
    expect(logs.text()).not.toContain(FAKE_PAT);
    const put = rec.find((r) => r.method === 'PUT')!;
    expect(put.body).toEqual({ nameServers: AFTERNIC });
    expect(put.auth).toBe(`Bearer ${FAKE_PAT}`);
    expect(rec.filter((r) => r.path.includes('/operations/'))).toHaveLength(2);
    expect(res.body).not.toContain(FAKE_PAT);
  });

  it('L-12: the operation id may arrive in the Location header', async () => {
    const rec: GdRequest[] = [];
    mswServer.use(
      ...godaddyNsHandlers({ operationStatuses: ['DONE'], operationId: 'op9', viaLocation: true, recorded: rec }),
      http.get(`${GODADDY_BASE}/v3/domains/domain-names/:d`, () => HttpResponse.json({ nameServers: AFTERNIC })),
    );
    const auth = await setup(adapter());
    expect((await list(auth)).json().ns_status).toBe('set');
    expect(rec.some((r) => r.path.endsWith('/operations/op9'))).toBe(true);
  });

  it('L-16: operation still PENDING past the poll timeout → ns_status pending + NS_PENDING; no read-back; listing saved', async () => {
    const rec: GdRequest[] = [];
    mswServer.use(...godaddyNsHandlers({ operationStatuses: ['PENDING'], recorded: rec })); // a read-back would hit an unhandled route and error
    const auth = await setup(adapter({ pollTimeoutMs: 30 }));
    const res = await list(auth, { mode: 'hybrid', bin: 1995 });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.ns_status).toBe('pending');
    expect(b.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^NS_PENDING/)]));
    expect(rec.filter((r) => r.method === 'GET' && !r.path.includes('/operations/'))).toHaveLength(0);
    expect(await dom()).toMatchObject({ status: 'listed', lander: 'afternic', lander_ns: AFTERNIC, bin_cents: 199500 });
    expect(await db.selectFrom('listing_history').selectAll().execute()).toHaveLength(1);
  });

  it('L-16: wall-clock deadline: a slow poll that jumps the clock past the timeout stops polling', async () => {
    const rec: GdRequest[] = [];
    mswServer.use(...godaddyNsHandlers({ operationStatuses: ['PENDING'], recorded: rec }));
    const auth = await setup(adapter({ pollTimeoutMs: 1000, jumpPerPoll: 5000 }));
    expect((await list(auth)).json().ns_status).toBe('pending');
    expect(rec.filter((r) => r.path.includes('/operations/'))).toHaveLength(1);
  });

  it('L-16: PUT 202 then the poll returns 404 / 503 → pending, listing saved', async () => {
    for (const status of [404, 503]) {
      mswServer.use(
        http.put(`${GODADDY_BASE}/v3/domains/domain-names/:d/nameservers`, () => HttpResponse.json({ operationId: 'op1' }, { status: 202 })),
        http.get(`${GODADDY_BASE}/v3/domains/operations/:id`, () => new HttpResponse(null, { status })),
      );
      const auth = await setup(adapter());
      const res = await list(auth);
      expect(res.statusCode, String(status)).toBe(200);
      expect(res.json().ns_status).toBe('pending');
      expect(await dom()).toMatchObject({ lander: 'afternic', lander_ns: AFTERNIC });
      await app.close();
      await db.deleteFrom('domains').execute().catch(() => undefined);
    }
  });

  it('202 without any operation id → pending (accepted but untrackable)', async () => {
    mswServer.use(http.put(`${GODADDY_BASE}/v3/domains/domain-names/:d/nameservers`, () => new HttpResponse(null, { status: 202, headers: { location: 'https://x.test/other/1' } })));
    expect(await adapter().setNameservers(D, AFTERNIC)).toEqual({ pending: true });
  });

  it('FAILED uses the operation body code when valid, else GODADDY_OPERATION_FAILED', async () => {
    const put = http.put(`${GODADDY_BASE}/v3/domains/domain-names/:d/nameservers`, () => HttpResponse.json({ operationId: 'op1' }, { status: 202 }));
    mswServer.use(put, http.get(`${GODADDY_BASE}/v3/domains/operations/:id`, () => HttpResponse.json({ status: 'FAILED', code: 'NS_NOT_ALLOWED' })));
    expect(await adapter().setNameservers(D, AFTERNIC).catch((x: unknown) => x)).toMatchObject({ code: 'NS_NOT_ALLOWED', ambiguous: false });
    mswServer.use(http.get(`${GODADDY_BASE}/v3/domains/operations/:id`, () => HttpResponse.json({ status: 'FAILED', code: 'bad code!' })));
    expect(await adapter().setNameservers(D, AFTERNIC).catch((x: unknown) => x)).toMatchObject({ code: 'GODADDY_OPERATION_FAILED' });
  });

  it('L-12: operation FAILED → 409 REGISTRAR_REJECTED, nothing saved', async () => {
    mswServer.use(...godaddyNsHandlers({ operationStatuses: ['FAILED'], recorded: [] }));
    const auth = await setup(adapter());
    const res = await list(auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'REGISTRAR_REJECTED' });
    expect(await dom()).toMatchObject({ lander: null, status: 'owned' });
  });

  it('a FakeAdapter returning { pending: true } is handled the same way', async () => {
    const fake = new FakeAdapter('godaddy', { setNsResult: { pending: true } });
    app = await makeApp({ adapters: [fake], nsLookup: async () => null, now: () => T0 });
    await insertOwnedDomain(db, { domain: D, registrar: 'godaddy', registrar_api: 'manage', category: 'trend' });
    const auth = (await issueToken('write')).auth;
    const res = await list(auth);
    expect(res.json().ns_status).toBe('pending');
    expect(fake.calls.some((c) => c.startsWith('getNameservers'))).toBe(false);
  });
});

describe('GoDaddyAdapter.findDomain', () => {
  const path = `${GODADDY_BASE}/v3/domains/domain-names/:d`;
  it('200 → mapped info', async () => {
    mswServer.use(http.get(path, () => HttpResponse.json({ expiresAt: '2027-10-04T13:16:00.000Z', nameServers: ['NS1.X.COM.', 'ns2.x.com'], privacy: true, renewAuto: false })));
    expect(await adapter().findDomain(D)).toEqual({ expiryDate: '2027-10-04', whoisPrivacy: true, autoRenew: false, apiAccess: true, ns: ['ns1.x.com', 'ns2.x.com'] });
  });
  it('404 → null', async () => {
    mswServer.use(http.get(path, () => new HttpResponse(null, { status: 404 })));
    expect(await adapter().findDomain(D)).toBeNull();
  });
  it('403 ACCOUNT_NOT_ELIGIBLE → definite RegistrarError with that code', async () => {
    mswServer.use(http.get(path, () => HttpResponse.json({ code: 'ACCOUNT_NOT_ELIGIBLE', message: `nope ${FAKE_PAT}` }, { status: 403 })));
    const e = await adapter().findDomain(D).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RegistrarError);
    expect(e).toMatchObject({ code: 'ACCOUNT_NOT_ELIGIBLE', ambiguous: false, registrar: 'godaddy' });
    expect((e as Error).message).not.toContain(FAKE_PAT);
  });
  it('5xx and network errors are ambiguous', async () => {
    mswServer.use(http.get(path, () => new HttpResponse(null, { status: 503 })));
    expect(await adapter().findDomain(D).catch((x: unknown) => x)).toMatchObject({ code: 'REGISTRAR_HTTP_5XX', ambiguous: true });
    mswServer.use(http.get(path, () => HttpResponse.error()));
    expect(await adapter().findDomain(D).catch((x: unknown) => x)).toMatchObject({ code: 'REGISTRAR_NETWORK', ambiguous: true });
  });
});

describe('IM-11: GoDaddy never quotes or registers', () => {
  it('register / quote / accountState / setAutoRenew / getReceipt / findRegistration throw NOT_SUPPORTED with no HTTP request', async () => {
    const a = adapter(); // MSW onUnhandledRequest:'error' would fail any request
    const calls = [
      () => a.register(D, { costCents: 1, idempotencyKey: 'k', dryRun: false }),
      () => a.quote(D), () => a.accountState(), () => a.setAutoRenew(D, false), () => a.getReceipt('x'),
      () => a.findRegistration(D, { since: '2026-10-01' }),
    ];
    for (const c of calls) {
      expect(await c().catch((x: unknown) => x)).toMatchObject({ code: 'NOT_SUPPORTED', ambiguous: false });
    }
  });

  it('GET /check lists godaddy as NO_AVAILABILITY_ACCESS and it is never the winner', async () => {
    const porkbun = new FakeAdapter('porkbun');
    app = await makeApp({ adapters: [adapter(), porkbun], rdap: async () => 'not_registered', env: { ENABLED_REGISTRARS: 'porkbun,godaddy' } });
    await db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'godaddy'] }).execute();
    const { auth } = await issueToken('read');
    const b = (await app.inject({ method: 'GET', url: `/check?domain=${D}`, headers: auth })).json();
    const gd = b.quotes.find((q: { registrar: string }) => q.registrar === 'godaddy');
    expect(gd).toMatchObject({ eligible: false, exclusion_reason: 'NO_AVAILABILITY_ACCESS' });
    expect(b.winner.registrar).toBe('porkbun');
  });
});
