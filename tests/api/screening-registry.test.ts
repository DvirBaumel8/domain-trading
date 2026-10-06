// Task 5: registry, DNS and dated-extension checks: availability (CAP-03), SURBL (CAP-05), sibling census (CAP-10), other extensions
// (CAP-12), plus the RDAP cache, the pacer and the IANA bootstrap. RDAP is MSW fixtures or a fake lookup; DNS is a fake dnsQuery.
import { readFileSync } from 'node:fs';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DnsAnswer } from '../../src/dns/ns-lookup.js';
import type { RdapLookup, RdapLookupFn } from '../../src/rdap.js';
import { readEvidence } from '../../src/screening/evidence.js';
import { BootstrapError, Pacer, lookupCached, rdapBaseFor } from '../../src/screening/rdap-batch.js';
import type { ScreeningDeps } from '../../src/screening/types.js';
import { testDb as db } from '../helpers/db.js';
import { putList, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, RANDOM_COM, respond } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(screening?: Partial<ScreeningDeps>, opts: { start?: number } = {}): Promise<ScreeningHarness> {
  const x = await screeningHarness({ ...opts, screening });
  app = x.app;
  return x;
}
const byDomain = (body: any, domain: string) => body.names.find((n: any) => n.domain === domain);
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check);
const item = (domain: string, extra: object = {}) => ({ domain, lane: 'S3', ...extra });

// ---- fakes ----
const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const unknown = (code: NonNullable<RdapLookup['reasonCode']>, retryAfterMs: number | null = null): RdapLookup => ({ outcome: 'unknown', reasonCode: code, httpStatus: null, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null, retryAfterMs });
function fakeRdap(table: Record<string, RdapLookup>, fallback: RdapLookup = notRegistered()): { fn: RdapLookupFn; calls: { domain: string; baseUrl?: string }[] } {
  const calls: { domain: string; baseUrl?: string }[] = [];
  return { calls, fn: async (domain, o) => { calls.push({ domain, baseUrl: o?.baseUrl }); return table[domain] ?? fallback; } };
}
const ianaOk = () => mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));

// ---- availability ----
describe('availability (CAP-03, S1)', () => {
  it('#1 registered (recorded Verisign fixture): FAIL REGISTERED with registrar, created_at, expires_at, statuses, nameservers', async () => {
    mswServer.use(http.get('https://rdap.verisign.com/com/v1/domain/:d', () => respond(fixture('rdap/promptinjectionaudit_com.json'))));
    const { runDone } = await h();
    const { body } = await runDone({ checks: ['availability'], names: [item('promptinjectionaudit.com')] });
    const r = res(byDomain(body, 'promptinjectionaudit.com'), 'availability');
    expect(r).toMatchObject({ status: 'FAIL', reason_code: 'REGISTERED', gate: 'G2', rule_ids: ['S1'] });
    expect(r.fields).toMatchObject({ availability: 'registered', registrar: 'GoDaddy.com, LLC', registry_statuses: expect.arrayContaining(['client transfer prohibited']), nameservers: ['ns21.domaincontrol.com', 'ns22.domaincontrol.com'] });
    expect(r.fields.created_at).toMatch(/^2026-10-04T13:16/);
    expect(r.fields.expires_at).toMatch(/^2027-10-04/);
    expect(r.fields.checked_at).toBeTruthy();
    expect(byDomain(body, 'promptinjectionaudit.com').final_status).toBe('rejected');
  });

  it('#3 not registered (recorded 404): PASS available, with evidence', async () => {
    mswServer.use(http.get('https://rdap.verisign.com/com/v1/domain/:d', () => respond(fixture(`rdap/${RANDOM_COM.replace('.', '_')}.json`))));
    const { runDone } = await h();
    const { body } = await runDone({ checks: ['availability'], names: [item(RANDOM_COM)] });
    const r = res(byDomain(body, RANDOM_COM), 'availability');
    expect(r).toMatchObject({ status: 'PASS', reason_code: null, fields: { availability: 'available' } });
    const row = await db.selectFrom('screening_results').select('evidence_ids').where('check_id', '=', 'availability').executeTakeFirstOrThrow();
    expect(row.evidence_ids).toHaveLength(1);
    expect((await readEvidence(db, Number(row.evidence_ids[0]))) ?? null).toMatchObject({ source: 'rdap', http_status: 404 });
  });

  it('#4 a timeout is UNKNOWN TIMEOUT (never "available") and in live mode the name does not reach the later gates', async () => {
    const rdap = fakeRdap({}, unknown('TIMEOUT'));
    const { runDone } = await h({ rdapLookup: rdap.fn, dnsQuery: async () => { throw new Error('surbl must not run'); } });
    const { body } = await runDone({ checks: ['form', 'availability', 'surbl'], names: [item('tampapoolsco.com')] });
    const n = byDomain(body, 'tampapoolsco.com');
    expect(res(n, 'availability')).toMatchObject({ status: 'UNKNOWN', reason_code: 'TIMEOUT', fields: { availability: 'unknown' } });
    expect(n.results.map((x: any) => x.check)).toEqual(['form', 'availability']);
    expect(n.final_status).toBe('unknown');
  });

  it.each(['RATE_LIMITED', 'SOURCE_ERROR'] as const)('an RDAP failure keeps its own code: %s', async (code) => {
    const { runDone } = await h({ rdapLookup: fakeRdap({}, unknown(code)).fn });
    const { body } = await runDone({ checks: ['availability'], names: [item('tampapoolsco.com')] });
    expect(res(byDomain(body, 'tampapoolsco.com'), 'availability')).toMatchObject({ status: 'UNKNOWN', reason_code: code });
  });

  it('sources.rdap_com false is UNKNOWN SOURCE_DISABLED and nothing is fetched', async () => {
    const rdap = fakeRdap({});
    const { post, runDone } = await h({ rdapLookup: rdap.fn });
    expect((await post('/selection/settings', { label: 'v1b', set: { 'sources.rdap_com': false } })).statusCode).toBe(201);
    const { body } = await runDone({ mode: 'full', settings: 'v1b', checks: ['availability'], names: [item('tampapoolsco.com', { as_of: '2026-01-01T00:00:00Z' })] });
    expect(res(byDomain(body, 'tampapoolsco.com'), 'availability')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED' });
    expect(rdap.calls).toEqual([]);
  });
});

// ---- the RDAP cache, retry and pacer ----
describe('lookupCached, Pacer, rdapBaseFor', () => {
  const baseDeps = (rdapLookup: RdapLookupFn, sleeps: number[] = []): ScreeningDeps => ({
    fetch: globalThis.fetch, sleep: async (ms) => { sleeps.push(ms); }, checkService: undefined as never, rdapLookup,
    dnsQuery: async () => null, resolveNs: async () => [], resolve4: async () => [],
  });
  const opts = (sleeps: number[] = []) => ({ maxAgeHours: 1, evidenceMaxBytes: 32768, pace: new Pacer(0, 1, async (ms) => { sleeps.push(ms); }), now: () => Date.parse('2026-10-06T08:00:00Z') });

  it('reuses registered / not_registered rows inside the window, never an unknown row, and re-asks after the window', async () => {
    const rdap = fakeRdap({ 'a.com': registered('2020-01-01T00:00:00Z') });
    const deps = baseDeps(rdap.fn);
    const o = opts();
    expect((await lookupCached(db, deps, 'a.com', o)).cached).toBe(false);
    const again = await lookupCached(db, deps, 'a.com', o);
    expect(again).toMatchObject({ cached: true, outcome: 'registered', facts: { created_at: '2020-01-01T00:00:00Z' } });
    expect(rdap.calls).toHaveLength(1);
    expect((await lookupCached(db, deps, 'a.com', { ...o, now: () => Date.parse('2026-10-06T09:30:00Z') })).cached).toBe(false);
    const bad = fakeRdap({}, unknown('TIMEOUT'));
    await lookupCached(db, baseDeps(bad.fn), 'b.com', o);
    expect((await lookupCached(db, baseDeps(bad.fn), 'b.com', o)).cached).toBe(false);
    expect(bad.calls).toHaveLength(2);
    expect(await db.selectFrom('rdap_lookups').select('outcome').where('domain', '=', 'b.com').execute()).toEqual([{ outcome: 'unknown' }, { outcome: 'unknown' }]);
  });

  it('retries once after Retry-After when it is at most 10 s; a longer wait or no header is not retried', async () => {
    let n = 0;
    const flaky: RdapLookupFn = async () => (n++ === 0 ? unknown('RATE_LIMITED', 2000) : notRegistered());
    const sleeps: number[] = [];
    const r = await lookupCached(db, baseDeps(flaky, sleeps), 'c.com', opts(sleeps));
    expect(r).toMatchObject({ outcome: 'not_registered' });
    expect(n).toBe(2);
    expect(sleeps).toContain(2000);
    for (const ra of [20_000, null]) {
      let m = 0;
      const limited: RdapLookupFn = async () => { m++; return unknown('RATE_LIMITED', ra); };
      expect(await lookupCached(db, baseDeps(limited), `d${ra}.com`, opts())).toMatchObject({ outcome: 'unknown', reasonCode: 'RATE_LIMITED' });
      expect(m).toBe(1);
    }
  });

  it('Pacer: at most `concurrency` calls at once, and a gap of minMsBetween between starts', async () => {
    const sleeps: number[] = [];
    const p = new Pacer(250, 2, async (ms) => { sleeps.push(ms); });
    let live = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => p.run(async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; })));
    expect(peak).toBe(2);
    expect(sleeps.length).toBeGreaterThanOrEqual(4); // 6 starts inside a few ms: all but the first wait
    expect(sleeps.every((ms) => ms > 0 && ms <= 6 * 250)).toBe(true);
    expect(await p.run(async () => 42)).toBe(42);
  });

  it('rdapBaseFor: com is Verisign without a fetch; org/net/info come from the stored bootstrap; co/io/us are null; one fetch serves later calls', async () => {
    let hits = 0;
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => { hits++; return respond(fixture('iana-dns.json')); }));
    const deps = baseDeps(fakeRdap({}).fn);
    const now = () => Date.parse('2026-10-06T08:00:00Z');
    expect(await rdapBaseFor(db, deps, 'com', { enabled: true, now })).toBe('https://rdap.verisign.com/com/v1/');
    expect(hits).toBe(0);
    expect(await rdapBaseFor(db, deps, 'org', { enabled: true, now })).toBe('https://rdap.publicinterestregistry.org/rdap/');
    expect(await rdapBaseFor(db, deps, 'info', { enabled: true, now })).toBe('https://rdap.identitydigital.services/rdap/');
    expect(await rdapBaseFor(db, deps, 'net', { enabled: true, now })).toBe('https://rdap.verisign.com/net/v1/');
    for (const t of ['co', 'io', 'us']) expect(await rdapBaseFor(db, deps, t, { enabled: true, now })).toBeNull();
    expect(hits).toBe(1);
    expect(await rdapBaseFor(db, deps, 'org', { enabled: false, now })).toBeNull();
    const row = await db.selectFrom('reference_files').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ name: 'iana_rdap_dns', data_date: expect.anything() });
  });

  it('rdapBaseFor: older than 7 days is re-fetched (an identical body adds a row pointing at the first); a failed refresh keeps the old copy; none at all throws BootstrapError', async () => {
    let status = 200;
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => (status === 200 ? respond(fixture('iana-dns.json')) : new Response('<html/>', { status }))));
    const deps = baseDeps(fakeRdap({}).fn);
    const t0 = Date.parse('2026-10-06T08:00:00Z');
    await expect(rdapBaseFor(db, deps, 'org', { enabled: true, now: () => t0 })).resolves.toBeTruthy();
    await expect(rdapBaseFor(db, deps, 'org', { enabled: true, now: () => t0 + 8 * 86_400_000 })).resolves.toBeTruthy();
    const rows = await db.selectFrom('reference_files').select(['id', 'body_gz', 'same_as_id']).orderBy('id').execute();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ body_gz: null, same_as_id: rows[0]!.id });
    status = 503; // a failed refresh two weeks later: the stored copy still answers
    await expect(rdapBaseFor(db, deps, 'net', { enabled: true, now: () => t0 + 20 * 86_400_000 })).resolves.toBe('https://rdap.verisign.com/net/v1/');
    await db.deleteFrom('reference_files').where('same_as_id', 'is not', null).execute();
    await db.deleteFrom('reference_files').execute();
    await expect(rdapBaseFor(db, deps, 'org', { enabled: true, now: () => t0 })).rejects.toBeInstanceOf(BootstrapError);
    status = 200;
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => new Response('{"services":[]}', { status: 200 })));
    await expect(rdapBaseFor(db, deps, 'org', { enabled: true, now: () => t0 })).rejects.toBeInstanceOf(BootstrapError); // 200 with a non-conforming body
    expect(await db.selectFrom('reference_files').select('id').execute()).toHaveLength(0);
  });
});

// ---- SURBL ----
describe('surbl (CAP-05, SURBL-1)', () => {
  const ZONE = 'multi.surbl.org';
  const listed = (last: number): DnsAnswer => ({ rcode: 0, answers: [{ type: 1, data: `127.0.0.${last}` }] });
  const nx: DnsAnswer = { rcode: 3, answers: [] };
  /** A scripted SURBL: the control name and `table` entries answer, every other name is NXDOMAIN. */
  function surbl(table: Record<string, DnsAnswer | null> = {}, o: { down?: string[]; control?: DnsAnswer | null } = {}) {
    const calls: { name: string; server: string }[] = [];
    const dnsQuery: ScreeningDeps['dnsQuery'] = async (name, qtype, opts) => {
      calls.push({ name, server: opts.server });
      expect(qtype).toBe(1);
      if (o.down?.includes(opts.server)) return null;
      if (name === `test.surbl.org.${ZONE}`) return o.control === undefined ? listed(254) : o.control;
      const key = name.slice(0, -(ZONE.length + 1));
      return key in table ? table[key]! : nx;
    };
    const ns = { calls: 0 };
    return { calls, ns, deps: { dnsQuery, resolveNs: async () => { ns.calls++; return ['a.surbl.org', 'b.surbl.org']; }, resolve4: async (host: string) => (host === 'a.surbl.org' ? ['192.0.2.1'] : ['192.0.2.2']) } };
  }
  const run = async (s: ReturnType<typeof surbl>, names: string[]) => {
    const { runDone } = await h(s.deps);
    return runDone({ checks: ['surbl'], names: names.map((d) => item(d)) });
  };

  it('CAP-05 #2: control listed and names NXDOMAIN: PASS listed false, control_ok true, server and evidence recorded; the control and NS discovery run once for the batch', async () => {
    const s = surbl();
    const { body } = await run(s, ['tampapoolsco.com', 'boisesolarco.com']);
    for (const d of ['tampapoolsco.com', 'boisesolarco.com']) {
      const r = res(byDomain(body, d), 'surbl');
      expect(r).toMatchObject({ status: 'PASS', gate: 'G4', rule_ids: ['SURBL-1'], fields: { listed: false, lists: [], control_ok: true } });
      expect(['192.0.2.1', '192.0.2.2']).toContain(r.fields.server);
    }
    expect(s.calls.filter((c) => c.name.startsWith('test.surbl.org'))).toHaveLength(1);
    expect(s.ns.calls).toBe(1);
    expect(s.calls.every((c) => ['192.0.2.1', '192.0.2.2'].includes(c.server))).toBe(true); // only the zone's own servers
    const ev = await db.selectFrom('screening_results').select('evidence_ids').where('domain', '=', 'tampapoolsco.com').executeTakeFirstOrThrow();
    const e = await readEvidence(db, Number(ev.evidence_ids[ev.evidence_ids.length - 1]));
    expect(e?.text).toContain('tampapoolsco.com.multi.surbl.org A');
    expect(e?.text).toContain('rcode 3');
  });

  it('CAP-05 #1: a listed name FAILs SURBL_LISTED with the lists decoded from the bits (80 = MW + ABUSE; 254 control bits)', async () => {
    const s = surbl({ 'spamsite.com': listed(80), 'phishy.com': listed(8) });
    const { body } = await run(s, ['spamsite.com', 'phishy.com']);
    expect(res(byDomain(body, 'spamsite.com'), 'surbl')).toMatchObject({ status: 'FAIL', reason_code: 'SURBL_LISTED', fields: { listed: true, lists: ['MW', 'ABUSE'], control_ok: true } });
    expect(res(byDomain(body, 'phishy.com'), 'surbl').fields.lists).toEqual(['PH']);
  });

  it('CAP-05 #3: servers that do not answer make every name UNKNOWN CONTROL_FAILED (never "not listed")', async () => {
    const down = surbl({}, { down: ['192.0.2.1', '192.0.2.2'] });
    const { body } = await run(down, ['tampapoolsco.com', 'boisesolarco.com']);
    for (const d of ['tampapoolsco.com', 'boisesolarco.com']) {
      expect(res(byDomain(body, d), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CONTROL_FAILED', fields: { listed: null, control_ok: false } });
    }
    expect(down.calls.filter((c) => !c.name.startsWith('test.surbl.org'))).toEqual([]);
  });

  it.each([['NXDOMAIN', nx], ['127.0.0.1 (blocked)', listed(1)], ['an empty answer', { rcode: 0, answers: [] }], ['no answer', null]] as [string, DnsAnswer | null][])(
    'a control name that is not answered as listed (%s) is CONTROL_FAILED', async (_n, control) => {
      const { body } = await run(surbl({}, { control }), ['tampapoolsco.com']);
      expect(res(byDomain(body, 'tampapoolsco.com'), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CONTROL_FAILED' });
    });

  it('no server found at all (NS discovery empty) is CONTROL_FAILED', async () => {
    const { runDone } = await h({ resolveNs: async () => [], resolve4: async () => [] });
    const { body } = await runDone({ checks: ['surbl'], names: [item('tampapoolsco.com')] });
    expect(res(byDomain(body, 'tampapoolsco.com'), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CONTROL_FAILED' });
  });

  it('zone without NS records of its own: falls back to SURBL\'s documented a..j query hosts; NS records that do not answer the control as listed are skipped', async () => {
    const asked: string[] = [];
    const dnsQuery: ScreeningDeps['dnsQuery'] = async (name, _t, { server }) => {
      asked.push(server);
      if (server === '198.51.100.1') return { rcode: 0, answers: [] }; // the parent zone's servers: NOERROR, no data
      return name.startsWith('test.surbl.org') ? listed(254) : nx;
    };
    const resolved: string[] = [];
    const { runDone } = await h({ dnsQuery, resolveNs: async () => ['green.surbl.org'], resolve4: async (host) => { resolved.push(host); return [host === 'green.surbl.org' ? '198.51.100.1' : '203.0.113.9']; } });
    const { body } = await runDone({ checks: ['surbl'], names: [item('tampapoolsco.com')] });
    expect(res(byDomain(body, 'tampapoolsco.com'), 'surbl')).toMatchObject({ status: 'PASS', fields: { control_ok: true, server: '203.0.113.9' } });
    expect(resolved).toEqual(['green.surbl.org', ...'abcdefghij'.split('').map((l) => `${l}.surbl.org`)]);
    expect(asked[0]).toBe('198.51.100.1');
  });

  it('127.0.0.1 is QUERY_REFUSED (a blocked resolver, never listed or clean); REFUSED too; an odd answer is SOURCE_ERROR', async () => {
    const s = surbl({ 'blocked.com': listed(1), 'refused.com': { rcode: 5, answers: [] }, 'odd.com': { rcode: 0, answers: [{ type: 1, data: '10.1.2.3' }] }, 'nodata.com': { rcode: 0, answers: [] }, 'servfail.com': { rcode: 2, answers: [] } });
    const { body } = await run(s, ['blocked.com', 'refused.com', 'odd.com', 'nodata.com', 'servfail.com']);
    expect(res(byDomain(body, 'blocked.com'), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'QUERY_REFUSED' });
    expect(res(byDomain(body, 'refused.com'), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'QUERY_REFUSED' });
    for (const d of ['odd.com', 'nodata.com', 'servfail.com']) expect(res(byDomain(body, d), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
  });

  it('a name tries the next server when the first does not answer; all down for the name is UNKNOWN TIMEOUT', async () => {
    const calls: string[] = [];
    let controlDone = false;
    const dnsQuery: ScreeningDeps['dnsQuery'] = async (name, _t, { server }) => {
      if (name.startsWith('test.surbl.org')) { controlDone = true; return listed(254); }
      calls.push(`${name.split('.')[0]}@${server}`);
      if (server === '192.0.2.1' || name.startsWith('dead.')) return null;
      return nx;
    };
    const { runDone } = await h({ dnsQuery, resolveNs: async () => ['a.surbl.org', 'b.surbl.org'], resolve4: async (x) => (x === 'a.surbl.org' ? ['192.0.2.1'] : ['192.0.2.2']) });
    const { body } = await runDone({ checks: ['surbl'], names: [item('fine.com'), item('dead.com')] });
    expect(controlDone).toBe(true);
    expect(res(byDomain(body, 'fine.com'), 'surbl')).toMatchObject({ status: 'PASS', fields: { server: '192.0.2.2' } });
    expect(res(byDomain(body, 'dead.com'), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'TIMEOUT' });
  });

  it('ns_override names the servers (hostnames are resolved, IPs are used as given) and skips NS discovery', async () => {
    const s = surbl();
    const { post, runDone } = await h(s.deps);
    expect((await post('/selection/settings', { label: 'v1b', set: { 'surbl.ns_override': ['203.0.113.7', 'ns.example.net'] } })).statusCode).toBe(201);
    const { body } = await runDone({ mode: 'full', settings: 'v1b', checks: ['surbl'], names: [item('tampapoolsco.com', { as_of: '2026-01-01T00:00:00Z' })] });
    expect(res(byDomain(body, 'tampapoolsco.com'), 'surbl').status).toBe('PASS');
    expect(s.ns.calls).toBe(0);
    expect(s.calls.length).toBeGreaterThan(0);
    expect(s.calls.every((c) => ['203.0.113.7', '192.0.2.2'].includes(c.server))).toBe(true);
    expect(s.calls[0]!.server).toBe('203.0.113.7');
  });

  it('sources.surbl false is UNKNOWN SOURCE_DISABLED with no DNS query', async () => {
    const s = surbl();
    const { post, runDone } = await h(s.deps);
    expect((await post('/selection/settings', { label: 'v1b', set: { 'sources.surbl': false } })).statusCode).toBe(201);
    const { body } = await runDone({ mode: 'full', settings: 'v1b', checks: ['surbl'], names: [item('tampapoolsco.com', { as_of: '2026-01-01T00:00:00Z' })] });
    expect(res(byDomain(body, 'tampapoolsco.com'), 'surbl')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED' });
    expect(s.calls).toEqual([]);
  });
});

// ---- census ----
describe('census (CAP-10, CR-002)', () => {
  const siblings = readFileSync(new URL('../../docs/requests/CR-002-reference/census/bt1_netextend@v1.csv', import.meta.url), 'utf8')
    .split('\n').slice(1).map((s) => s.trim()).filter(Boolean).map((s) => `${s}.com`);
  const T = item('netextend.com', { census_list: 'bt1_netextend@v1' });
  const census = async (table: Record<string, RdapLookup>, extra: object = {}, itemExtra: object = {}, fallback: RdapLookup = notRegistered()) => {
    await db.insertInto('selection_lists').values({ name: 'bt1_netextend', version: 1, terms: siblings, created_by: 'test' }).onConflict((oc) => oc.doNothing()).execute();
    const rdap = fakeRdap(table, fallback);
    const hh = await h({ rdapLookup: rdap.fn });
    const { body } = await hh.runDone({ checks: ['census'], names: [{ ...T, ...itemExtra }], ...extra });
    return { body, n: byDomain(body, 'netextend.com'), rdap, hh };
  };
  const first = (k: number, c: RdapLookup = registered('2015-06-01T00:00:00Z')): Record<string, RdapLookup> => Object.fromEntries(siblings.slice(0, k).map((d) => [d, c]));

  it('the fixture has 20 siblings', () => expect(siblings).toHaveLength(20));

  it('CAP-10 #1: 13 of 20 registered is 0.65 (n_registered 13, n_checked 20, n_unknown 0), with the per-sibling list and the list version', async () => {
    const { n } = await census(first(13));
    const r = res(n, 'census');
    expect(r).toMatchObject({ status: 'PASS', gate: 'G8', fields: { registered_share: 0.65, n_registered: 13, n_checked: 20, n_unknown: 0, list: 'bt1_netextend@v1', as_of_exact: true, in_use_share: null } });
    expect(r.fields.siblings).toHaveLength(20);
    expect(r.fields.siblings[0]).toMatchObject({ domain: siblings[0], status: 'registered', created_at: '2015-06-01T00:00:00Z' });
    expect(r.fields.siblings[19]).toMatchObject({ status: 'not_registered' });
    expect(n.final_status).not.toBe('rejected'); // a feature check never rejects
  });

  it('CAP-10 #2: 4 of 20 registered is 0.20', async () => {
    const { n } = await census(first(4));
    expect(res(n, 'census').fields).toMatchObject({ registered_share: 0.2, n_registered: 4 });
  });

  it('CAP-10 #3: 6 of 20 unknown is UNKNOWN TOO_MANY_UNKNOWN with registered_share null, not a number', async () => {
    const t: Record<string, RdapLookup> = { ...first(10), ...Object.fromEntries(siblings.slice(10, 16).map((d) => [d, unknown('TIMEOUT')])) };
    const { n } = await census(t);
    expect(res(n, 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'TOO_MANY_UNKNOWN', fields: { registered_share: null, n_unknown: 6, n_registered: 10, n_checked: 20 } });
    expect(res(n, 'census').fields.siblings.filter((x: any) => x.status === 'unknown')).toHaveLength(6);
  });

  it('5 of 20 unknown (25%, not more) is still a number, with the unknown in the denominator', async () => {
    const t5: Record<string, RdapLookup> = { ...first(10), ...Object.fromEntries(siblings.slice(10, 15).map((d) => [d, unknown('RATE_LIMITED')])) };
    const { n: n5 } = await census(t5, {}, {}, notRegistered());
    expect(res(n5, 'census')).toMatchObject({ status: 'PASS', fields: { registered_share: 0.5, n_unknown: 5, n_checked: 20 } });
  });

  it('as_of (full mode): a sibling created on or after as_of is not counted (strict <), an undated one is counted and makes as_of_exact false, as_of is echoed', async () => {
    const t: Record<string, RdapLookup> = {
      [siblings[0]!]: registered('2015-06-01T00:00:00Z'), [siblings[1]!]: registered('2024-03-01T00:00:00Z'),
      [siblings[2]!]: registered('2023-01-01T00:00:00Z'), [siblings[3]!]: registered(null),
    };
    const { n } = await census(t, { mode: 'full' }, { as_of: '2023-01-01T00:00:00Z' });
    const f = res(n, 'census').fields;
    expect(f).toMatchObject({ n_registered: 2, registered_share: 0.1, registered_after_as_of_n: 2, undated_counted_n: 1, as_of: '2023-01-01T00:00:00.000Z', as_of_exact: false });
    expect(f.siblings.filter((s: any) => s.counted).map((s: any) => s.domain)).toEqual([siblings[0], siblings[3]]);
  });

  it('as_of_exact is false when as_of is older than census.as_of_exact_max_days (365), true inside it', async () => {
    const { n } = await census(first(4), { mode: 'full' }, { as_of: '2025-01-01T00:00:00Z' });
    expect(res(n, 'census').fields).toMatchObject({ as_of_exact: false, n_registered: 4 });
  });
  it('as_of 4 months back is as_of_exact', async () => {
    const { n } = await census(first(4), { mode: 'full' }, { as_of: '2026-06-01T00:00:00Z' });
    expect(res(n, 'census').fields.as_of_exact).toBe(true);
  });

  it('no census_list or an unknown list is UNKNOWN CENSUS_LIST_MISSING', async () => {
    const { n } = await census({}, {}, { census_list: undefined });
    expect(res(n, 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_LIST_MISSING', fields: { registered_share: null } });
  });
  it('a list that does not exist, or a version that does not exist, is CENSUS_LIST_MISSING; a list of the wrong size is CENSUS_LIST_SIZE', async () => {
    await putList('bt1_short', siblings.slice(0, 19));
    const rdap = fakeRdap({});
    const hh = await h({ rdapLookup: rdap.fn });
    const { body } = await hh.runDone({ checks: ['census'], names: [
      item('aaaextend.com', { census_list: 'bt1_other@v1' }), item('bbbextend.com', { census_list: 'bt1_short@v9' }), item('cccextend.com', { census_list: 'bt1_short' }),
    ] });
    expect(res(byDomain(body, 'aaaextend.com'), 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_LIST_MISSING' });
    expect(res(byDomain(body, 'bbbextend.com'), 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_LIST_MISSING' });
    expect(res(byDomain(body, 'cccextend.com'), 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_LIST_SIZE', fields: { list: 'bt1_short@v1' } });
    expect(rdap.calls).toEqual([]);
  });

  it('"name" without @vN uses the newest version', async () => {
    await putList('bt1_netextend', siblings.slice(0, 19).concat('zzextra.com'), 1);
    await putList('bt1_netextend', siblings, 2);
    const rdap = fakeRdap(first(2));
    const hh = await h({ rdapLookup: rdap.fn });
    const { body } = await hh.runDone({ checks: ['census'], names: [item('netextend.com', { census_list: 'bt1_netextend' })] });
    expect(res(byDomain(body, 'netextend.com'), 'census').fields).toMatchObject({ list: 'bt1_netextend@v2', n_registered: 2 });
  });

  it('a backtest (draft settings) without as_of is UNKNOWN AS_OF_REQUIRED; sources.rdap_com false is SOURCE_DISABLED', async () => {
    await putList('bt1_netextend', siblings);
    const rdap = fakeRdap({});
    const { post, runDone } = await h({ rdapLookup: rdap.fn });
    expect((await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } })).statusCode).toBe(201);
    expect((await post('/selection/settings', { label: 'v1c', set: { 'sources.rdap_com': false } })).statusCode).toBe(201);
    const a = await runDone({ mode: 'full', settings: 'v1b', checks: ['census'], names: [T] });
    expect(res(byDomain(a.body, 'netextend.com'), 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'AS_OF_REQUIRED' });
    const b = await runDone({ mode: 'full', settings: 'v1c', checks: ['census'], names: [{ ...T, as_of: '2026-01-01T00:00:00Z' }] });
    expect(res(byDomain(b.body, 'netextend.com'), 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED' });
    expect(rdap.calls).toEqual([]);
  });

  it('siblings are looked up through the cache: a second name sharing the list does not re-fetch', async () => {
    await putList('bt1_netextend', siblings);
    const rdap = fakeRdap(first(3));
    const hh = await h({ rdapLookup: rdap.fn });
    await hh.runDone({ checks: ['census'], names: [T] });
    expect(rdap.calls).toHaveLength(20);
    await hh.runDone({ checks: ['census'], names: [{ ...T, domain: 'netextend2.com' }] });
    expect(rdap.calls).toHaveLength(20);
  });
});

// ---- other extensions ----
describe('ext_dates (CAP-12, CR-002)', () => {
  const COM = 'netextend.com';
  const ext = async (table: Record<string, RdapLookup>, o: { as_of?: string; checks?: string[]; extra?: object } = {}, fallback: RdapLookup = notRegistered()) => {
    ianaOk();
    const rdap = fakeRdap(table, fallback);
    const hh = await h({ rdapLookup: rdap.fn });
    const { body } = await hh.runDone({ checks: o.checks ?? ['availability', 'ext_dates'], names: [item(COM, o.as_of ? { as_of: o.as_of } : {})], ...(o.as_of ? { mode: 'full' } : {}), ...o.extra });
    const n = byDomain(body, COM);
    return { n, f: res(n, 'ext_dates')?.fields, r: res(n, 'ext_dates'), rdap };
  };
  // availability FAILs REGISTERED for a registered .com, and a feature check still runs in full mode; use full mode so ext_dates runs.
  const full = { extra: { mode: 'full' } };

  it('CAP-12: .net created 2015, .com created 2023 gives alt_tld_before_n >= 1', async () => {
    const { r, f } = await ext({ [COM]: registered('2023-05-01T00:00:00Z'), 'netextend.net': registered('2015-02-02T00:00:00Z') }, full);
    expect(r).toMatchObject({ status: 'PASS', gate: 'G8' });
    expect(f.alt_tld_before_n).toBeGreaterThanOrEqual(1);
    expect(f).toMatchObject({ alt_tld_before_n: 1, comparison_basis: 'com_created_at', comparison_date: '2023-05-01T00:00:00.000Z' });
    expect(f.extensions.find((e: any) => e.tld === 'net')).toMatchObject({ status: 'registered', created_at: '2015-02-02T00:00:00.000Z'.replace('.000Z', 'Z'), counted: true });
  });

  it('CAP-12: .net created after the .com (leakage rule) gives 0; an equal date does not count either', async () => {
    const a = await ext({ [COM]: registered('2023-05-01T00:00:00Z'), 'netextend.net': registered('2024-01-01T00:00:00Z') }, full);
    expect(a.f.alt_tld_before_n).toBe(0);
    expect(a.f.extensions.find((e: any) => e.tld === 'net').counted).toBe(false);
  });
  it('CAP-12: an extension created at the very same instant as the .com does not count (strict <)', async () => {
    const b = await ext({ [COM]: registered('2023-05-01T00:00:00Z'), 'netextend.net': registered('2023-05-01T00:00:00Z') }, full);
    expect(b.f.alt_tld_before_n).toBe(0);
  });

  it('CAP-12: a timed-out extension is unknown and counted in n_unknown_ext; .co/.io/.us (no bootstrap entry) are NO_REGISTRY_SERVICE and counted too; unknown is never "not registered"', async () => {
    const { r, f } = await ext({ [COM]: registered('2023-05-01T00:00:00Z'), 'netextend.net': registered('2015-02-02T00:00:00Z'), 'netextend.ai': unknown('TIMEOUT') }, full);
    expect(r.status).toBe('PASS');
    const byTld = (t: string) => f.extensions.find((e: any) => e.tld === t);
    expect(byTld('ai')).toMatchObject({ status: 'unknown', reason_code: 'TIMEOUT' });
    for (const t of ['co', 'io', 'us']) expect(byTld(t)).toMatchObject({ status: 'unknown', reason_code: 'NO_REGISTRY_SERVICE', created_at: null });
    expect(byTld('org')).toMatchObject({ status: 'not_registered' });
    expect(f).toMatchObject({ alt_tld_before_n: 1, n_unknown_ext: 4 });
  });

  it('the no-bootstrap TLDs are never asked; the others use the bootstrap base', async () => {
    const { rdap } = await ext({ [COM]: registered('2023-05-01T00:00:00Z') }, full);
    const asked = Object.fromEntries(rdap.calls.filter((c) => c.domain !== COM).map((c) => [c.domain, c.baseUrl]));
    expect(asked).toEqual({
      'netextend.net': 'https://rdap.verisign.com/net/v1/', 'netextend.org': 'https://rdap.publicinterestregistry.org/rdap/',
      'netextend.ai': 'https://rdap.identitydigital.services/rdap/', 'netextend.info': 'https://rdap.identitydigital.services/rdap/',
    });
  });

  it('all extensions unknown is UNKNOWN ALL_EXT_UNKNOWN with alt_tld_before_n null', async () => {
    const { r, f } = await ext({ [COM]: registered('2023-05-01T00:00:00Z') }, { ...full }, unknown('SOURCE_ERROR'));
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'ALL_EXT_UNKNOWN' });
    expect(f).toMatchObject({ alt_tld_before_n: null, n_unknown_ext: 7 });
  });

  it('an unreachable IANA bootstrap makes the other extensions unknown SOURCE_ERROR (not "no registry")', async () => {
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => new Response('nope', { status: 503 })));
    const rdap = fakeRdap({ [COM]: registered('2023-05-01T00:00:00Z') });
    const hh = await h({ rdapLookup: rdap.fn });
    const { body } = await hh.runDone({ mode: 'full', checks: ['availability', 'ext_dates'], names: [item(COM)] });
    expect(res(byDomain(body, COM), 'ext_dates')).toMatchObject({ status: 'UNKNOWN', reason_code: 'ALL_EXT_UNKNOWN' });
    expect(res(byDomain(body, COM), 'ext_dates').fields.extensions.every((e: any) => e.reason_code === 'SOURCE_ERROR')).toBe(true);
  });

  it('an available .com compares with as_of (full mode): only extensions created strictly before it count; an extension with no creation date is excluded and counted in undated_excluded_n', async () => {
    const { f } = await ext({ 'netextend.net': registered('2015-01-01T00:00:00Z'), 'netextend.org': registered('2022-06-01T00:00:00Z'), 'netextend.info': registered(null) }, { as_of: '2020-01-01T00:00:00Z' });
    expect(f).toMatchObject({ comparison_basis: 'as_of', comparison_date: '2020-01-01T00:00:00.000Z', alt_tld_before_n: 1, undated_excluded_n: 1, as_of: '2020-01-01T00:00:00.000Z' });
  });

  it('com_prior_registration comes from the history check when it exists (yes/no), else unknown', async () => {
    const { f } = await ext({ [COM]: registered('2023-05-01T00:00:00Z') }, full);
    expect(f.com_prior_registration).toBe('unknown');
  });

  it('a backtest without as_of is AS_OF_REQUIRED; sources.rdap_other false is SOURCE_DISABLED', async () => {
    ianaOk();
    const rdap = fakeRdap({});
    const { post, runDone } = await h({ rdapLookup: rdap.fn });
    expect((await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } })).statusCode).toBe(201);
    expect((await post('/selection/settings', { label: 'v1c', set: { 'sources.rdap_other': false } })).statusCode).toBe(201);
    const a = await runDone({ mode: 'full', settings: 'v1b', checks: ['ext_dates'], names: [item(COM)] });
    expect(res(byDomain(a.body, COM), 'ext_dates')).toMatchObject({ status: 'UNKNOWN', reason_code: 'AS_OF_REQUIRED', fields: { alt_tld_before_n: null } });
    const b = await runDone({ mode: 'full', settings: 'v1c', checks: ['ext_dates'], names: [item(COM, { as_of: '2026-01-01T00:00:00Z' })] });
    expect(res(byDomain(b.body, COM), 'ext_dates')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED' });
    expect(rdap.calls).toEqual([]);
  });
});
