import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { RegistrarError } from '../../src/registrars/types.js';
import { withDomainLock } from '../../src/services/plan-store.js';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const approval = () => ({ text: `yes list ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() });
const AFTERNIC = ['ns1.afternic.com', 'ns2.afternic.com'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(pb: FakeAdapter) {
  app = await makeApp({ adapters: [pb], nsLookup: async () => null, now: () => NOW });
  return (await issueToken('write')).auth;
}
const list = (body: object, auth: Record<string, string>, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `/list/${D}`, headers: { ...auth, 'idempotency-key': key }, payload: body });
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
const history = () => db.selectFrom('listing_history').selectAll().orderBy('id').execute();

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

describe('POST /list concurrency and NS hardening', () => {
  it('Review Focus 3: two concurrent plan changes serialise; the later one wins; one live plan', async () => {
    const g = gate();
    let n = 0;
    const pb = new FakeAdapter('porkbun', { onSetNs: async () => { if (n++ === 0) await g.promise; } });
    const auth = await setup(pb);
    await listedDomain({ domain: D });
    let secondDone = false;
    const first = list({ mode: 'hybrid', bin: 2495, approval_ref: approval() }, auth);
    while (!pb.calls.some((c) => c.startsWith('setNameservers'))) await sleep(5);
    const second = list({ mode: 'hybrid', bin: 2995, approval_ref: approval() }, auth).then((r) => { secondDone = true; return r; });
    await sleep(250);
    expect(secondDone).toBe(false); // blocked on the lock while the first holds it
    expect(pb.calls.filter((c) => c.startsWith('setNameservers'))).toHaveLength(1);
    g.release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const h = await history();
    expect(h).toHaveLength(2);
    expect(new Set(h.map((r) => r.plan_audit_id)).size).toBe(2);
    expect((await dom()).bin_cents).toBe(h[h.length - 1]!.bin_cents);
    expect(h.map((r) => r.bin_cents)).toEqual([249500, 299500]);
    const sched = await db.selectFrom('price_schedule').selectAll().execute();
    const livePlans = new Set(sched.filter((e) => e.status === 'planned').map((e) => e.plan_id));
    expect(livePlans.size).toBe(1);
    const other = sched.filter((e) => !livePlans.has(e.plan_id));
    expect(other.length).toBeGreaterThan(0);
    expect(other.every((e) => e.status === 'superseded')).toBe(true);
  });

  it('shares the lock with /buy: /list waits for a held domain lock', async () => {
    const auth = await setup(new FakeAdapter('porkbun'));
    await listedDomain({ domain: D });
    const g = gate();
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const holder = withDomainLock(db, D, async () => { entered(); await g.promise; });
    await inside;
    let done = false;
    const call = list({ mode: 'hybrid', bin: 2495, approval_ref: approval() }, auth).then((r) => { done = true; return r; });
    await sleep(250);
    expect(done).toBe(false);
    expect((await dom()).bin_cents).toBe(199500);
    g.release();
    await holder;
    expect((await call).statusCode).toBe(200);
    expect((await dom()).bin_cents).toBe(249500);
  });

  it('Review Focus 4a: ambiguous setNs but the registrar shows the lander NS → 200, set, NS_SET_AFTER_AMBIGUOUS', async () => {
    const auth = await setup(new FakeAdapter('porkbun', { setNs: new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }), getNs: AFTERNIC }));
    await listedDomain({ domain: D });
    const res = await list({}, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ns_status: 'set', warnings: expect.arrayContaining(['NS_SET_AFTER_AMBIGUOUS']) });
  });

  it('Review Focus 4b: ambiguous setNs and different NS → 503, nothing saved; same-key retry re-executes', async () => {
    const auth = await setup(new FakeAdapter('porkbun', { setNs: new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }), getNs: ['ns1.old.com', 'ns2.old.com'] }));
    await listedDomain({ domain: D });
    const key = randomUUID();
    const res = await list({ mode: 'hybrid', bin: 2495, approval_ref: approval() }, auth, key);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'REGISTRAR_UNAVAILABLE', details: { registrar: 'porkbun', registrar_code: 'REGISTRAR_TIMEOUT' } });
    expect(await history()).toHaveLength(0);
    expect(await dom()).toMatchObject({ lander: null, bin_cents: 199500 });
    await app.close();
    const auth2 = await setup(new FakeAdapter('porkbun'));
    const retry = await list({ mode: 'hybrid', bin: 2495, approval_ref: approval() }, auth2, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect((await dom()).bin_cents).toBe(249500);
  });

  it('Review Focus 4c: ambiguous setNs and the read-back fails → 503', async () => {
    const auth = await setup(new FakeAdapter('porkbun', {
      setNs: new RegistrarError('porkbun', 'REGISTRAR_NETWORK', 'n', { ambiguous: true }), getNsError: new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }),
    }));
    await listedDomain({ domain: D });
    const res = await list({}, auth);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('REGISTRAR_UNAVAILABLE');
    expect((await dom()).lander).toBeNull();
  });

  it('L-6: a non-porkbun registrar gets its own API-access message', async () => {
    const gd = new FakeAdapter('godaddy', { setNs: new RegistrarError('godaddy', 'API_ACCESS_DISABLED', 'x'), capabilities: { canManageNs: true } });
    const auth = await setup(gd);
    await listedDomain({ domain: D, registrar: 'godaddy', registrar_api: 'manage' });
    const res = await list({}, auth);
    expect(res.statusCode).toBe(409);
    const msg = res.json().error.message as string;
    expect(res.json().error.code).toBe('API_ACCESS_DISABLED');
    expect(msg).toContain('godaddy');
    expect(msg).not.toContain('porkbun');
  });

  it('display_name: the Kelvin sign is refused; ASCII mixed case is accepted', async () => {
    const auth = await setup(new FakeAdapter('porkbun'));
    await listedDomain({ domain: 'kelvin.com' });
    const bad = await app.inject({ method: 'POST', url: '/list/kelvin.com', headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { display_name: '\u212Aelvin.com' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('DISPLAY_NAME_MISMATCH');
    const ok = await app.inject({ method: 'POST', url: '/list/kelvin.com', headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { display_name: 'KelVin.com' } });
    expect(ok.statusCode).toBe(200);
  });
});
