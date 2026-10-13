// CR-050 part 1 (v4.1.0): POST /selection/sibling-scan and GET /selection/sibling-scan/:domain. RDAP is a fake lookup, pages are MSW handlers; nothing touches the network.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { issueToken } from '../../helpers/tokens.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { mswServer } from '../../setup/network.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const SLD = 'rooferdrone';
const NAME = `${SLD}.com`;
const html = (body: string, status = 200, extra: Record<string, string> = {}) => new HttpResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });
const robots404 = (host: string) => http.get(`https://${host}/robots.txt`, () => new HttpResponse(null, { status: 404 }));
const site = (host: string, body: string, status = 200) => [robots404(host), http.get(`https://${host}/`, () => html(body, status))];
const facts = { registrar: 'Fake', created_at: '2020-01-01T00:00:00Z', expires_at: null, updated_at: null, statuses: [], nameservers: [] };
const registered = (): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{}', facts });
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });
const timeout = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: '', retrievedAt: new Date(), body: null, facts: null });
const fakeRdap = (table: Record<string, RdapLookup>): RdapLookupFn => async (d) => table[d] ?? free();

const BUSINESS = (extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Roofer Drone Services | Home</title><meta property="og:site_name" content="Roofer Drone Services LLC"></head><body><nav><a href="/about">About</a> <a href="/contact">Contact us</a></nav><h1>Roofer Drone Services</h1><p>We fly drones over roofs for insurance adjusters and roofing contractors across the state. Our pilots are licensed and insured, and every report includes high resolution photos, measurements and a written summary of damage found on each roof we inspect. Call or write to book an inspection this week.</p>${extra}</body></html>`;
const PARKED = '<html><head><title>rooferdrone.org</title></head><body>This domain is for sale on afternic.com. Buy it now.</body></html>';

async function h(rdap: RdapLookupFn = fakeRdap({})): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup: rdap, sleep: async () => {}, siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch } });
  app = x.app;
  return x;
}
const scanOf = (res: { json: () => any }, i = 0) => res.json().scans[i];
const sib = (scan: any, d: string) => scan.siblings.find((s: any) => s.domain === d);
const rowsText = async (): Promise<string> => JSON.stringify(await db.selectFrom('sibling_scans').selectAll().execute());

describe('CR-050 sibling scan (POST/GET /selection/sibling-scan)', () => {
  it('SIB-1 registered live / parked / free / unknown, per sibling fields, hyphen and prefix kinds, lead points', async () => {
    const hy = 'roofer-drone.com'; // the best split of rooferdrone
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered(), [hy]: registered(), [`get${SLD}.com`]: registered() }));
    mswServer.use(...site(`${SLD}.net`, BUSINESS()), ...site(`${SLD}.org`, PARKED), ...site(hy, BUSINESS()), ...site(`get${SLD}.com`, '<html><body>tiny</body></html>'));
    const res = await x.post('/selection/sibling-scan', { domains: [NAME] });
    expect(res.statusCode).toBe(200);
    const s = scanOf(res);
    expect(s).toMatchObject({ domain: NAME, complete: true, skipped_n: 0, settings_version: expect.any(String) });
    expect(s.upstream_calls).toBeGreaterThan(0);
    const net = sib(s, `${SLD}.net`);
    expect(net).toMatchObject({
      kind: 'ending', registered: true, live_business: true, site_state: 'in_use', url: `https://${SLD}.net/`, http_status: 200, title: 'Roofer Drone Services | Home',
      company: 'Roofer Drone Services LLC', contact_url: `https://${SLD}.net/contact`,
    });
    expect(new Date(net.fetched_at).getTime()).toBeGreaterThan(0);
    expect(sib(s, `${SLD}.org`)).toMatchObject({ registered: true, live_business: false, site_state: 'parked_or_for_sale', contact_url: null });
    expect(sib(s, hy)).toMatchObject({ kind: 'hyphen', registered: true, live_business: true });
    expect(sib(s, `get${SLD}.com`)).toMatchObject({ kind: 'prefix', registered: true, live_business: false }); // too little content: not a business site
    expect(sib(s, `${SLD}.ai`)).toMatchObject({ registered: false, live_business: false, url: null, http_status: null, company: null, contact_url: null });
    expect(sib(s, `${SLD}.io`)).toMatchObject({ registered: false, reason_code: null }); // v4.2.1 (CR-052 S-2): io via its registry's RDAP
    expect(sib(s, `${SLD}.co.uk`)).toMatchObject({ registered: null, reason_code: 'NO_REGISTRY_SERVICE', live_business: null });
    expect(s.lead_points).toMatchObject({ live_n: 2, parked_n: expect.any(Number), points: expect.any(Number) });
    expect(s.lead_points.points).toBe(20 + 2 * s.lead_points.parked_n);
    expect(s.lead_points.formula).toContain('min(30,');
    expect(s.siblings.map((q: any) => q.domain)).not.toContain(NAME);
  });

  it('SIB-2 the endings are the settings\' list (net org io co ai us co.uk)', async () => {
    const x = await h();
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: ['cloudharbor.com'] }));
    const endings = s.siblings.filter((q: any) => q.kind === 'ending').map((q: any) => q.domain.slice('cloudharbor.'.length));
    expect(endings).toEqual(DEFAULT_SELECTION_VALUES.siblings.endings);
    expect(s.siblings.filter((q: any) => q.kind === 'prefix').map((q: any) => q.domain)).toEqual(['getcloudharbor.com', 'trycloudharbor.com']);
  });

  it('SIB-3 a redirect to a marketplace and a for-sale page are not live; a 404 home page and a 403 are not live; none adds the 10 points (parked and redirect add 2 each)', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered(), [`${SLD}.ai`]: registered(), [`get${SLD}.com`]: registered() }));
    mswServer.use(
      robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => new HttpResponse(null, { status: 302, headers: { location: 'https://www.afternic.com/forsale/rooferdrone.net' } })),
      ...site(`${SLD}.org`, PARKED), ...site(`${SLD}.ai`, 'not found', 404), ...site(`get${SLD}.com`, 'blocked', 403),
    );
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(sib(s, `${SLD}.net`)).toMatchObject({ registered: true, live_business: false, site_state: 'redirect_off_domain', contact_url: null });
    expect(sib(s, `${SLD}.org`)).toMatchObject({ live_business: false, site_state: 'parked_or_for_sale' });
    expect(sib(s, `${SLD}.ai`)).toMatchObject({ live_business: false, site_state: 'registered_no_site', http_status: 404 });
    expect(sib(s, `get${SLD}.com`)).toMatchObject({ live_business: null, http_status: 403 });
    expect(s.lead_points).toMatchObject({ live_n: 0, parked_n: 2, points: 4 });
  });

  it('SIB-4 an RDAP timeout is unknown, never "not registered"; the scan is marked incomplete only for a time-out of the scan itself', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: timeout() }));
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(sib(s, `${SLD}.net`)).toMatchObject({ registered: null, reason_code: 'TIMEOUT', live_business: null });
    expect(s.complete).toBe(false);
  });

  it('SIB-5 contact: found when the home page links /contact, null when it does not', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered() }));
    mswServer.use(...site(`${SLD}.net`, BUSINESS()), ...site(`${SLD}.org`, BUSINESS().replace(/<nav>.*<\/nav>/, '')));
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(sib(s, `${SLD}.net`).contact_url).toBe(`https://${SLD}.net/contact`);
    expect(sib(s, `${SLD}.org`)).toMatchObject({ live_business: true, contact_url: null });
  });

  it('SIB-6 no email address and no person name is stored, even when the page shows one (title, og:site_name, text, mailto link)', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered() }));
    const withMail = BUSINESS('<p>Owner: Jane Q. Roofer, jane.roofer@example.org, +1 555 0100</p><a href="mailto:jane.roofer@example.org">Contact Jane</a>')
      .replace('<title>Roofer Drone Services | Home</title>', '<title>jane.roofer@example.org</title>')
      .replace('content="Roofer Drone Services LLC"', 'content="Roofer Drone jane.roofer@example.org Services"');
    mswServer.use(...site(`${SLD}.net`, withMail), ...site(`${SLD}.org`, BUSINESS().replace('<title>Roofer Drone Services | Home</title>', '<title>Ann Lee (ann@lee.example)</title>').replace(/<meta property="og:site_name"[^>]*>/, '')));
    const res = await x.post('/selection/sibling-scan', { domains: [NAME] });
    const s = scanOf(res);
    expect(sib(s, `${SLD}.net`)).toMatchObject({ title: null, company: 'Roofer Drone Services', contact_url: `https://${SLD}.net/contact` });
    expect(sib(s, `${SLD}.org`).company).toBe('Ann Lee');
    for (const text of [res.body, await rowsText(), JSON.stringify((await x.get(`/selection/sibling-scan/${NAME}`)).json())]) {
      expect(text).not.toContain('@');
      expect(text).not.toContain('jane.roofer');
      expect(text).not.toContain('555 0100');
      expect(text).not.toContain('Jane');
    }
  });

  it('SIB-7 company is og:site_name else the title, trimmed to 120 characters', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered() }));
    const long = 'Acme '.repeat(60).trim();
    mswServer.use(...site(`${SLD}.net`, BUSINESS().replace(/<meta property="og:site_name"[^>]*>/, '').replace('Roofer Drone Services | Home', long)), ...site(`${SLD}.org`, BUSINESS()));
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(sib(s, `${SLD}.net`).company.length).toBeLessThanOrEqual(120);
    expect(sib(s, `${SLD}.net`).company.startsWith('Acme Acme')).toBe(true);
    expect(sib(s, `${SLD}.org`).company).toBe('Roofer Drone Services LLC');
  });

  it('SIB-8 points follow the settings: weights, caps and endings are not hard-coded; max_checks caps the lookups and reports skipped_n', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered() }));
    mswServer.use(...site(`${SLD}.net`, BUSINESS()), ...site(`${SLD}.org`, BUSINESS()));
    await patchActiveSettings(['siblings'], { ...DEFAULT_SELECTION_VALUES.siblings, points_live: 25, max: 40, live_counted_max: 5, endings: ['net', 'org', 'io'], max_checks: 4 });
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(s.lead_points).toMatchObject({ points: 40, live_n: 2 }); // 50 capped at 40
    expect(s.siblings).toHaveLength(4);
    expect(s.siblings.map((q: any) => q.kind)).toEqual(['ending', 'ending', 'ending', 'hyphen']);
    expect(s.skipped_n).toBe(2); // get / try
  });

  it('SIB-9 a settings version stored before CR-050 (no siblings key) scans with the defaults', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered() }));
    mswServer.use(...site(`${SLD}.net`, BUSINESS()));
    const row = await db.selectFrom('selection_settings').select('values').where('activation_seq', 'is not', null).executeTakeFirstOrThrow();
    expect((row.values as any).siblings).toBeUndefined();
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(s.lead_points.points).toBe(10);
    expect(s.siblings.some((q: any) => q.domain === `${SLD}.us`)).toBe(true);
  });

  it('SIB-10 validation: only .com names (422), at most 20 (422 VALIDATION_ERROR), at least one, no other keys, bad names (422); duplicates scanned once', async () => {
    const x = await h();
    const VALIDATION = 422;
    const r1 = await x.post('/selection/sibling-scan', { domains: ['acme.net'] });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error.code).toBe('TLD_NOT_SUPPORTED');
    expect((await x.post('/selection/sibling-scan', { domains: [NAME, 'a.b.com'] })).statusCode).toBe(422);
    expect((await x.post('/selection/sibling-scan', { domains: ['not a domain'] })).json().error.code).toBe('DOMAIN_INVALID');
    expect((await x.post('/selection/sibling-scan', { domains: Array.from({ length: 21 }, (_, i) => `name${String.fromCharCode(97 + i)}.com`) })).statusCode).toBe(VALIDATION);
    expect((await x.post('/selection/sibling-scan', { domains: [] })).statusCode).toBe(VALIDATION);
    expect((await x.post('/selection/sibling-scan', { domains: [NAME], extra: 1 })).statusCode).toBe(VALIDATION);
    expect(await db.selectFrom('sibling_scans').selectAll().execute()).toHaveLength(0); // nothing was scanned or stored for a refused call
    const dup = await x.post('/selection/sibling-scan', { domains: [NAME, NAME.toUpperCase()] });
    expect(dup.json().scans).toHaveLength(1);
  });

  it('SIB-11 up to 20 names in one call: one stored scan per name', async () => {
    const x = await h();
    const names = Array.from({ length: 20 }, (_, i) => `scanname${String.fromCharCode(97 + i)}.com`);
    const res = await x.post('/selection/sibling-scan', { domains: names });
    expect(res.statusCode).toBe(200);
    expect(res.json().scans.map((q: any) => q.domain)).toEqual(names);
    expect(await db.selectFrom('sibling_scans').selectAll().execute()).toHaveLength(20);
  }, 60_000);

  it('SIB-12 GET returns the newest stored scan (READ token); 404 when none; 422 for a non-.com; a read token cannot POST', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered() }));
    expect((await x.get(`/selection/sibling-scan/${NAME}`)).statusCode).toBe(404);
    expect((await x.get(`/selection/sibling-scan/${NAME}`)).json().error.code).toBe('SIBLING_SCAN_NOT_FOUND');
    expect((await x.get('/selection/sibling-scan/acme.net')).statusCode).toBe(422);
    const first = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(first.lead_points.points).toBe(0); // .net registered but its page does not exist in MSW => not live
    mswServer.use(...site(`${SLD}.net`, BUSINESS()));
    x.clock.t += 60_000;
    const second = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    expect(second.lead_points.points).toBe(10);
    const got = await x.get(`/selection/sibling-scan/${NAME}`);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(second);
    expect(await db.selectFrom('sibling_scans').selectAll().execute()).toHaveLength(2); // append-only: both scans are kept
    const r = await issueToken('read');
    const denied = await x.app.inject({ method: 'POST', url: '/selection/sibling-scan', headers: { ...r.auth, 'idempotency-key': randomUUID() }, payload: { domains: [NAME] } });
    expect(denied.statusCode).toBe(403);
  });

  it('SIB-13 idempotent: the same Idempotency-Key replays the stored answer and scans once; the call is audited', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered() }));
    mswServer.use(...site(`${SLD}.net`, BUSINESS()));
    const w = await issueToken('write', 'scanner');
    const key = randomUUID();
    const call = () => x.app.inject({ method: 'POST', url: '/selection/sibling-scan', headers: { ...w.auth, 'idempotency-key': key }, payload: { domains: [NAME] } });
    const a = await call();
    const b = await call();
    expect(a.statusCode).toBe(200);
    expect(b.body).toBe(a.body);
    expect(await db.selectFrom('sibling_scans').selectAll().execute()).toHaveLength(1);
    const row = await db.selectFrom('sibling_scans').select(['audit_id', 'recorded_by']).executeTakeFirstOrThrow();
    expect(row.recorded_by).toBe('scanner');
    expect(row.audit_id).not.toBeNull();
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', '/selection/sibling-scan').execute();
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const noKey = await x.app.inject({ method: 'POST', url: '/selection/sibling-scan', headers: w.auth, payload: { domains: [NAME] } });
    expect(noKey.statusCode).toBe(400);
  });

  it('SIB-14 sibling_scans is append-only (update, delete and truncate are refused)', async () => {
    const x = await h();
    await x.post('/selection/sibling-scan', { domains: [NAME] });
    await expect(sql`UPDATE sibling_scans SET complete = false`.execute(db)).rejects.toThrow();
    await expect(sql`DELETE FROM sibling_scans`.execute(db)).rejects.toThrow();
    await expect(sql`TRUNCATE sibling_scans`.execute(db)).rejects.toThrow();
  });

  it('SIB-15 upstream calls are recorded like other checks: RDAP answers are stored as rdap_lookups and the scan keeps its call count', async () => {
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered() }));
    mswServer.use(...site(`${SLD}.net`, BUSINESS()));
    const s = scanOf(await x.post('/selection/sibling-scan', { domains: [NAME] }));
    const row = await db.selectFrom('sibling_scans').select(['upstream_calls', 'evidence_ids']).executeTakeFirstOrThrow();
    expect(row.upstream_calls).toBe(s.upstream_calls);
    expect(row.upstream_calls).toBeGreaterThan(3);
    expect((row.evidence_ids as unknown[]).length).toBeGreaterThan(0);
    const looked = await db.selectFrom('rdap_lookups').select('domain').where('domain', '=', `${SLD}.net`).execute();
    expect(looked.length).toBeGreaterThan(0);
  });
});
