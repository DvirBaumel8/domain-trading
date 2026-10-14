// v5.7.0 (CR-058 part A): the weekly watch of the other endings of owned names (RDAP mocked), owned_ending_events, ENDING_REGISTERED and GET /owned/:domain/endings. IDs EN-90..EN-99.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RDAP_FALLBACK_BASES, type RdapLookup, type RdapLookupFn } from '../../../src/core/rdap.js';
import { EndingsJob } from '../../../src/modules/engine/index.js';
import type { ScreeningDeps } from '../../../src/modules/selection/index.js';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

const T0 = Date.parse('2026-10-14T00:05:00Z');
const DAY = 86_400_000;
let now = T0;
let app: FastifyInstance | undefined;
beforeEach(() => { now = T0; });
afterEach(async () => { await app?.close(); app = undefined; });

const BOOTSTRAP = JSON.stringify({ publication: '2026-10-01T00:00:00Z', services: [[['net'], ['https://rdap.verisign.com/net/v1/']], [['org'], ['https://rdap.pir.test/']], [['ai'], ['https://rdap.ai.test/']]] });
type Answer = Partial<RdapLookup> & { outcome: RdapLookup['outcome'] };
const reg = (created: string, registrar: string | null = 'Some Registrar'): Answer => ({ outcome: 'registered', httpStatus: 200, facts: { registrar, created_at: created, expires_at: '2027-01-01T00:00:00.000Z', updated_at: null, statuses: ['active'], nameservers: [] } });
const free: Answer = { outcome: 'not_registered', httpStatus: 404 };
const unk: Answer = { outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null };

function harness(answer: (domain: string) => Answer) {
  const asked: string[] = [];
  const rdapLookup: RdapLookupFn = async (domain, o) => {
    asked.push(domain);
    return { reasonCode: null, httpStatus: null, url: `${o?.baseUrl}domain/${domain}`, retrievedAt: new Date(now), body: null, facts: null, ...answer(domain) } as RdapLookup;
  };
  const fetch = (async () => new Response(BOOTSTRAP, { status: 200 })) as unknown as typeof globalThis.fetch;
  const screening = { rdapLookup, sleep: async () => {}, fetch } as unknown as ScreeningDeps;
  return { asked, job: (o: { maxPairs?: number } = {}) => new EndingsJob({ db, screening, now: () => now, ...o }) };
}
void RDAP_FALLBACK_BASES;

const events = (domain?: string) => { let q = db.selectFrom('owned_ending_events').selectAll().orderBy('id'); if (domain) q = q.where('domain', '=', domain); return q.execute(); };
async function seedBulk(names: string[]): Promise<void> {
  const up = await db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 0, accepted_n: 0, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'test', audit_id: null }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('engine_sales').values(names.map((n) => ({ domain: `${n}.com`, price_cents: 10000, sale_date: '2026-09-01', venue: 'v', source: 's', source_url: null, upload_id: up.id }))).execute();
}
async function report(): Promise<{ warnings: { code: string; domain?: string; details: Record<string, unknown> }[] }> {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now });
  const r = (await issueToken('read')).auth;
  return (await app.inject({ method: 'GET', url: '/report', headers: r })).json();
}
const endingWarnings = (rep: Awaited<ReturnType<typeof report>>) => rep.warnings.filter((w) => w.code === 'ENDING_REGISTERED');

describe('owned-name endings watch', () => {
  it('EN-90: the first check stores a baseline for every owned name and ending; nothing is a warning; dropped and pending names are left out', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    await insertOwnedDomain(db, { domain: 'betatwo.com', buy_date: '2026-10-04', status: 'listed' });
    await insertOwnedDomain(db, { domain: 'gonethree.com', status: 'dropped' });
    const h = harness((d) => (d === 'alphaone.net' ? reg('2019-01-01T00:00:00Z', 'Old Reg') : free));
    const s = await h.job().runOnce();
    expect(s).toMatchObject({ asked: 10, registered: 1, not_registered: 9 });
    const ev = await events();
    expect(ev).toHaveLength(10);
    expect(ev.every((e) => e.kind === 'baseline' && e.ending_id !== null)).toBe(true);
    expect(new Set(ev.map((e) => e.domain))).toEqual(new Set(['alphaone.com', 'betatwo.com']));
    const net = ev.find((e) => e.domain === 'alphaone.com' && e.tld === 'net')!;
    expect(net).toMatchObject({ registered: true, registrar: 'Old Reg' });
    expect(net.created_at_registry!.toISOString()).toBe('2019-01-01T00:00:00.000Z');
    expect((await db.selectFrom('engine_endings').select('registrar').where('name', '=', 'alphaone').where('tld', '=', 'net').executeTakeFirstOrThrow()).registrar).toBe('Old Reg');
    expect(endingWarnings(await report())).toHaveLength(0);
  });

  it('EN-91: a .net created after the buy date gives one newly_registered event and exactly one ENDING_REGISTERED warning; a second run adds nothing', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    const h = harness((d) => (d === 'alphaone.net' ? reg('2026-10-10T08:00:00Z', 'Fresh Reg') : free));
    await h.job().runOnce();
    now += 8 * DAY;
    await h.job().runOnce();
    const ev = (await events()).filter((e) => e.kind !== 'baseline');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ domain: 'alphaone.com', tld: 'net', kind: 'newly_registered', registered: true, registrar: 'Fresh Reg' });
    expect(await events()).toHaveLength(5);
    const w = endingWarnings(await report());
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ domain: 'alphaone.com', details: { owned_domain: 'alphaone.com', host: 'alphaone.net', created: '2026-10-10T11:00:00+03:00', registrar: 'Fresh Reg' } });
  });

  it('EN-92: a later registration (free at the baseline, registered a week later) is newly_registered once', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    let taken = false;
    const h = harness((d) => (d === 'alphaone.co' && taken ? reg('2026-10-15T00:00:00Z') : free));
    await h.job().runOnce();
    expect((await events()).every((e) => e.kind === 'baseline' && !e.registered)).toBe(true);
    taken = true; now += 8 * DAY;
    await h.job().runOnce();
    now += 8 * DAY;
    await h.job().runOnce();
    const ch = (await events()).filter((e) => e.kind !== 'baseline');
    expect(ch.map((e) => [e.tld, e.kind])).toEqual([['co', 'newly_registered']]);
  });

  it('EN-93: a changed creation date is re_registered; the same date again is not', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    let created = '2019-01-01T00:00:00Z';
    const h = harness((d) => (d === 'alphaone.org' ? reg(created) : free));
    await h.job().runOnce();
    now += 8 * DAY; created = '2026-10-18T00:00:00Z';
    await h.job().runOnce();
    now += 8 * DAY;
    await h.job().runOnce();
    const ch = (await events()).filter((e) => e.kind !== 'baseline');
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ tld: 'org', kind: 're_registered' });
    expect(ch[0]!.created_at_registry!.toISOString()).toBe('2026-10-18T00:00:00.000Z');
    expect(endingWarnings(await report()).map((w) => w.details.host)).toEqual(['alphaone.org']);
  });

  it('EN-94: an unanswered check writes no event; the baseline comes with the first answer', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    let down = true;
    const h = harness((d) => (d === 'alphaone.io' && down ? unk : free));
    await h.job().runOnce();
    expect((await events()).map((e) => e.tld).sort()).toEqual(['ai', 'co', 'net', 'org']);
    down = false; now += 7 * 3_600_000;
    await h.job().runOnce();
    expect((await events()).filter((e) => e.tld === 'io').map((e) => e.kind)).toEqual(['baseline']);
  });

  it('EN-95: owned names are asked first, before the bulk names, and the bulk run skips their pairs', async () => {
    await seedBulk(['bulk1', 'bulk2', 'alphaone']);
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    const h = harness(() => free);
    await h.job({ maxPairs: 7 }).runOnce();
    const ownedAsks = h.asked.filter((d) => d.startsWith('alphaone.') && !d.endsWith('.com'));
    expect(ownedAsks).toHaveLength(5);
    expect(h.asked).toHaveLength(7);
    expect(await events()).toHaveLength(5);
    // the owned name's own sales row does not make the bulk step ask its endings twice
    const full = harness(() => free);
    await full.job().runOnce();
    expect(full.asked.filter((d) => d.startsWith('alphaone.') && !d.endsWith('.com'))).toHaveLength(0);
  });

  it('EN-96: owned pairs are due weekly: nothing at 6 days, five asks at 8 days', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    const h = harness(() => free);
    await h.job().runOnce();
    now += 6 * DAY;
    expect(await h.job().runOnce()).toMatchObject({ due: 0, asked: 0 });
    now += 2 * DAY;
    expect(await h.job().runOnce()).toMatchObject({ due: 5, asked: 5 });
  });

  it('EN-97: GET /owned/:domain/endings returns the five endings and the event history', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    const h = harness((d) => (d === 'alphaone.net' ? reg('2026-10-10T08:00:00Z', 'Fresh Reg') : free));
    await h.job().runOnce();
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now });
    const r = (await issueToken('read')).auth;
    const res = await app.inject({ method: 'GET', url: '/owned/AlphaOne.com/endings', headers: r });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ domain: 'alphaone.com', buy_date: '2026-10-04' });
    expect(b.endings.map((e: { tld: string }) => e.tld)).toEqual(['net', 'co', 'org', 'io', 'ai']);
    expect(b.endings[0]).toEqual({ tld: 'net', host: 'alphaone.net', registered: true, created: '2026-10-10T11:00:00+03:00', registrar: 'Fresh Reg', checked_at: '2026-10-14T03:05:00+03:00' });
    expect(b.endings[1]).toMatchObject({ tld: 'co', registered: false, created: null, registrar: null });
    expect(b.events).toHaveLength(5);
    expect(b.events.find((e: { tld: string }) => e.tld === 'net')).toEqual({ id: expect.any(Number), tld: 'net', kind: 'newly_registered', registered: true, created: '2026-10-10T11:00:00+03:00', registrar: 'Fresh Reg', at: '2026-10-14T03:05:00+03:00' });
  });

  it('EN-98: GET /owned/:domain/endings is 404 DOMAIN_NOT_FOUND for a name we do not own (dropped, or unknown)', async () => {
    await insertOwnedDomain(db, { domain: 'gonethree.com', status: 'dropped' });
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now });
    const r = (await issueToken('read')).auth;
    for (const d of ['gonethree.com', 'nobody.com']) {
      const res = await app.inject({ method: 'GET', url: `/owned/${d}/endings`, headers: r });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('DOMAIN_NOT_FOUND');
    }
  });

  it('EN-99: owned_ending_events is append-only', async () => {
    await insertOwnedDomain(db, { domain: 'alphaone.com', buy_date: '2026-10-04' });
    await harness(() => free).job().runOnce();
    await expect(db.updateTable('owned_ending_events').set({ kind: 'newly_registered' }).execute()).rejects.toThrow();
    await expect(db.deleteFrom('owned_ending_events').execute()).rejects.toThrow();
  });
});
