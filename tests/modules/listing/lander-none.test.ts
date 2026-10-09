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

describe('POST /list lander "none" (CR-004 §10.3)', () => {
  const list = (post: (u: string, p: object) => Promise<{ statusCode: number; body: string; json(): any }>, body: object) => post(`/list/${D}`, body);

  it('stores the listing and plan with no registrar call and no DNS lookup; lander_pending; /report info note; schedule built', async () => {
    const t = await boot();
    await insertOwnedDomain(db, { domain: D, category: 'trend', drop_date: '2027-10-05', expiry_date: '2027-10-05' });
    const res = await list(t.post, { lander: 'none', mode: 'hybrid', bin: 1495 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'listed', lander: null, ns: [], lander_pending: true, ns_status: 'skipped', ns_public: 'unknown' });
    expect(t.pb.calls.filter((c) => c.startsWith('setNameservers') || c.startsWith('getNameservers'))).toEqual([]);
    const row = await db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'listed', lander: null, lander_ns: null, lander_set_at: null, lander_pending: true, bin_cents: 149500, listing_mode: 'hybrid' });
    expect((await db.selectFrom('price_schedule').selectAll().where('domain_id', '=', row.id).execute()).length).toBeGreaterThan(0);
    expect((await db.selectFrom('listing_history').selectAll().where('domain_id', '=', row.id).execute()).length).toBe(1);
    const w = (await t.get('/report')).json().warnings as { code: string; level: string; domain?: string }[];
    expect(w.filter((x) => x.code === 'LANDER_PENDING').map((x) => [x.domain, x.level])).toEqual([[D, 'info']]);
    expect(w.map((x) => x.code)).not.toContain('NS_UNVERIFIED');
  });

  it('a later lander "afternic" switches the nameservers as today and clears lander_pending (and the note)', async () => {
    const t = await boot(new FakeAdapter('porkbun', { getNs: ['ns1.afternic.com', 'ns2.afternic.com'] }));
    await insertOwnedDomain(db, { domain: D, category: 'trend', drop_date: '2027-10-05', expiry_date: '2027-10-05' });
    await list(t.post, { lander: 'none', mode: 'hybrid', bin: 1495 });
    const res = await list(t.post, { lander: 'afternic' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ lander: 'afternic', ns: ['ns1.afternic.com', 'ns2.afternic.com'], lander_pending: false, ns_status: 'set' });
    expect(t.pb.calls).toContain(`setNameservers ${D} ns1.afternic.com,ns2.afternic.com`);
    expect((await db.selectFrom('domains').select('lander_pending').where('domain', '=', D).executeTakeFirstOrThrow()).lander_pending).toBe(false);
    const w = (await t.get('/report')).json().warnings as { code: string }[];
    expect(w.map((x) => x.code)).not.toContain('LANDER_PENDING');
  });

  it('"none" with an existing lander changes only the plan: nameservers and lander stay, not pending', async () => {
    const t = await boot();
    await listedDomain({ domain: D, drop_date: '2027-10-05', expiry_date: '2027-10-05', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], lander_set_at: new Date(NOW) });
    const res = await list(t.post, { lander: 'none', pricing_hold: true, pricing_hold_reason: 'testing' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ lander: 'afternic', ns: ['ns1.afternic.com', 'ns2.afternic.com'], lander_pending: false, ns_status: 'skipped' });
    expect(t.pb.calls.some((c) => c.startsWith('setNameservers'))).toBe(false);
  });

  it('"none" refuses ns; a dry run with "none" makes no changes and shows lander_pending', async () => {
    const t = await boot();
    await insertOwnedDomain(db, { domain: D, category: 'trend', drop_date: '2027-10-05', expiry_date: '2027-10-05' });
    expect((await list(t.post, { lander: 'none', ns: ['a.x.com', 'b.x.com'] })).json().error.code).toBe('NS_INVALID');
    const dry = await list(t.post, { lander: 'none', mode: 'hybrid', bin: 1495, dry_run: true });
    expect(dry.json()).toMatchObject({ dry_run: true, valid: true, lander: 'none', ns: [], lander_pending: true });
    expect(await db.selectFrom('domains').select(['status', 'lander_pending']).where('domain', '=', D).executeTakeFirstOrThrow()).toEqual({ status: 'owned', lander_pending: false });
  });
});
