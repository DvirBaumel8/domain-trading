// CR-043 (v3.10.0): length reject, sellers / comps gates, lookalikes, topic reuse, report.csv, buy.exclude_lanes. All off under the seeded (v1) settings
// unless a test turns a key on. RDAP is a fake lookup, pages are MSW handlers; nothing touches the network.
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const page = (n: string) => readFileSync(new URL(`../../fixtures/screening/sites/${n}`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new HttpResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const robots404 = (host: string) => http.get(`https://${host}/robots.txt`, () => new HttpResponse(null, { status: 404 }));
const site = (host: string, body: string) => [robots404(host), http.get(`https://${host}/`, () => html(body))];
const facts = { registrar: 'Fake', created_at: '2020-01-01T00:00:00Z', expires_at: null, updated_at: null, statuses: [], nameservers: [] };
const registered = (): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{}', facts });
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });
const fakeRdap = (table: Record<string, RdapLookup>): RdapLookupFn => async (d) => table[d] ?? free();
const DAY = 86_400_000;
const intakeKeys = (o: object) => patchActiveSettings(['intake'], { ...DEFAULT_SELECTION_VALUES.intake, ...o });

async function h(rdap: RdapLookupFn = fakeRdap({})): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup: rdap, sleep: async () => {}, siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch } });
  app = x.app;
  return x;
}
const resultOf = (body: any, check: string, i = 0) => body.names[i].results.find((r: any) => r.check === check);
const intake = (x: ScreeningHarness, names: object[]) => x.post('/candidates/intake', { names });

describe('CR-043 length reject (form.max_sld_chars)', () => {
  const LONG = 'roofdroneinspection.com'; // 19 characters before .com
  const SHORT = 'roofdronesurvey.com'; // 15

  it('CR43-10 unset (null): the form check does not answer SLD_TOO_LONG and intake accepts the name', async () => {
    const x = await h();
    const { body } = await x.runDone({ mode: 'full', checks: ['form'], names: [{ domain: LONG, lane: 'S3' }] });
    expect(resultOf(body, 'form').reason_code).not.toBe('SLD_TOO_LONG');
    const r = await intake(x, [{ domain: LONG, lane: 'S3', source: 's' }]);
    expect(r.json().removed.map((q: any) => q.reason)).not.toContain('SLD_TOO_LONG');
  });

  it('CR43-11 set to 16: the form check FAILs SLD_TOO_LONG, the name is removed at intake, a shorter name still passes', async () => {
    const x = await h();
    await patchActiveSettings(['form', 'max_sld_chars'], 16);
    const { body } = await x.runDone({ mode: 'full', checks: ['form'], names: [{ domain: LONG, lane: 'S3' }, { domain: SHORT, lane: 'S3' }] });
    expect(resultOf(body, 'form', 0)).toMatchObject({ status: 'FAIL', reason_code: 'SLD_TOO_LONG' });
    expect(resultOf(body, 'form', 1).reason_code).not.toBe('SLD_TOO_LONG'); // 15 characters
    const r = await intake(x, [{ domain: LONG, lane: 'S3', source: 's' }, { domain: SHORT, lane: 'S3', source: 's' }]);
    expect(r.json().removed).toEqual([{ domain: LONG, reason: 'SLD_TOO_LONG' }]);
    expect(r.json().accepted).toHaveLength(1);
  });
});

describe('CR-043 sellers and comps gates (tier check)', () => {
  const NAME = 'roofdroneinspection.com';
  const sellers = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Firm ${i}`, url: `https://firm${i}.example/` }));
  beforeEach(() => {
    for (let i = 0; i < 3; i++) mswServer.use(...site(`firm${i}.example`, i < 2 ? page('synthetic-service.html') : '<html><body>This domain is for sale on afternic.com</body></html>'));
  });

  it('CR43-20 off by default: 0 verified sellers and no comps do not FAIL the tier check', async () => {
    const x = await h();
    await intake(x, [{ domain: NAME, lane: 'S3', source: 's' }]);
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(['SELLERS_TOO_FEW', 'COMPS_MISSING']).not.toContain(resultOf(body, 'tier').reason_code);
  });

  it('CR43-21 require_sellers_min 3: two verified of three listed is FAIL SELLERS_TOO_FEW; no list at all is FAIL with 0', async () => {
    const x = await h();
    await intakeKeys({ require_sellers_min: 3 });
    await intake(x, [{ domain: NAME, lane: 'S3', source: 's', sellers: sellers(3) }, { domain: 'roofdronesurvey.com', lane: 'S3', source: 's' }]);
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: NAME, lane: 'S3' }, { domain: 'roofdronesurvey.com', lane: 'S3' }] });
    expect(resultOf(body, 'tier', 0)).toMatchObject({ status: 'FAIL', reason_code: 'SELLERS_TOO_FEW', fields: { sellers_required_min: 3, sellers: { verified_n: 2 } } });
    expect(resultOf(body, 'tier', 1)).toMatchObject({ status: 'FAIL', reason_code: 'SELLERS_TOO_FEW', fields: { sellers: { verified_n: 0 } } });
  });

  it('CR43-22 require_sellers_min 2 with two verified sellers does not FAIL', async () => {
    const x = await h();
    await intakeKeys({ require_sellers_min: 2 });
    await intake(x, [{ domain: NAME, lane: 'S3', source: 's', sellers: sellers(3) }]);
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(resultOf(body, 'tier').reason_code).not.toBe('SELLERS_TOO_FEW');
  });

  it('CR43-23 require_comps true: a name without intake comps is FAIL COMPS_MISSING; with comps it is not', async () => {
    const x = await h();
    await intakeKeys({ require_comps: true });
    const comps = [{ domain: 'a.com', price_usd: 1500, sold_on: '2026-01-05', venue: 'namebio', source_url: 'https://example.com/a' }, { domain: 'b.com', price_usd: 900, sold_on: '2026-02-05', venue: 'namebio', source_url: 'https://example.com/b' }];
    const ok = await intake(x, [{ domain: NAME, lane: 'S3', source: 's', comps }, { domain: 'roofdronesurvey.com', lane: 'S3', source: 's' }]);
    expect(ok.statusCode, ok.body).toBe(200);
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: NAME, lane: 'S3' }, { domain: 'roofdronesurvey.com', lane: 'S3' }] });
    expect(resultOf(body, 'tier', 0).reason_code).not.toBe('COMPS_MISSING');
    expect(resultOf(body, 'tier', 1)).toMatchObject({ status: 'FAIL', reason_code: 'COMPS_MISSING', fields: { comps_n: 0 } });
  });
});

describe('CR-043 lookalikes', () => {
  const SLD = 'rooferdrone';
  const NAME = `${SLD}.com`;

  it('CR43-30 registered + live site = in_use; registered + parked = not in use; free = not registered; an ending with no RDAP service is unknown', async () => {
    mswServer.use(...site(`${SLD}.net`, page('synthetic-service.html')), ...site(`${SLD}.org`, page('synthetic-parked.html')));
    const hy = 'roofer-drone.com'; // the best split of rooferdrone
    const x = await h(fakeRdap({ [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered(), [hy]: registered() }));
    mswServer.use(...site(hy, page('synthetic-business-title.html')));
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'lookalikes'], names: [{ domain: NAME, lane: 'S3' }] });
    const r = resultOf(body, 'lookalikes');
    expect(r).toMatchObject({ status: 'PASS', gate: 'G8' });
    const items = r.fields.lookalikes.items as any[];
    const by = (d: string) => items.find((i) => i.domain === d);
    expect(by(`${SLD}.net`)).toMatchObject({ kind: 'ending', registered: true, in_use: true });
    expect(by(`${SLD}.org`)).toMatchObject({ registered: true, in_use: false });
    expect(by(`${SLD}.ai`)).toMatchObject({ registered: false, in_use: null });
    expect(by(`${SLD}.io`)).toMatchObject({ registered: null, in_use: null, reason_code: 'NO_REGISTRY_SERVICE' });
    expect(by(`${SLD}.co.uk`)).toMatchObject({ registered: null, reason_code: 'NO_REGISTRY_SERVICE' });
    const tokens = resultOf(body, 'form').fields.tokens as string[];
    expect(tokens.join('')).toBe(SLD);
    expect(by(`${tokens.join('-')}.com`)).toMatchObject({ kind: 'hyphen', registered: true });
    expect(by(`get${SLD}.com`)).toMatchObject({ kind: 'prefix', registered: false });
    expect(r.fields.lookalikes).toMatchObject({ registered_n: 3, in_use_n: expect.any(Number) });
    expect(r.fields.lookalikes.in_use_n).toBeGreaterThanOrEqual(1);
    expect(r.fields.lookalikes.unknown_n).toBe(3); // .io, .co, .co.uk
    expect(r.upstream_calls).toBeGreaterThan(0);
  });

  it('CR43-31 an RDAP timeout is unknown (never "not registered"); a page that cannot be read leaves in_use unknown; the check still PASSes', async () => {
    mswServer.use(robots404(`${SLD}.net`), http.get(`https://${SLD}.net/`, () => HttpResponse.error()));
    const x = await h(async (d) => (d === `${SLD}.org` ? { outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: '', retrievedAt: new Date(), body: null, facts: null } : d === `${SLD}.net` ? registered() : free()));
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'lookalikes'], names: [{ domain: NAME, lane: 'S3' }] });
    const r = resultOf(body, 'lookalikes');
    const items = r.fields.lookalikes.items as any[];
    expect(r.status).toBe('PASS');
    expect(items.find((i) => i.domain === `${SLD}.org`)).toMatchObject({ registered: null, reason_code: 'TIMEOUT' });
    expect(items.find((i) => i.domain === `${SLD}.net`)).toMatchObject({ registered: true, in_use: null });
  });

  it('CR43-32 max_checks caps the lookups and says how many were skipped; enabled false removes the check from the plan', async () => {
    const x = await h();
    await patchActiveSettings(['lookalikes'], { enabled: true, endings: ['net', 'org', 'io', 'co', 'ai', 'co.uk'], prefixes: ['get', 'try'], timeout_ms: 5000, max_bytes: 100000, max_checks: 3 });
    const a = await x.runDone({ mode: 'full', checks: ['form', 'lookalikes'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(resultOf(a.body, 'lookalikes').fields).toMatchObject({ checked_n: 3, skipped_n: 6 });
    await patchActiveSettings(['lookalikes', 'enabled'], false);
    const b = await x.runDone({ mode: 'full', checks: ['form', 'lookalikes'], names: [{ domain: 'rooferdrones.com', lane: 'S3' }] });
    expect(resultOf(b.body, 'lookalikes')).toBeUndefined();
  });

  it('CR43-33 it never changes a verdict: a name that passes without it ends the same, and it is not a gating check', async () => {
    const x = await h();
    const { body } = await x.runDone({ mode: 'full', checks: ['form', 'lookalikes'], names: [{ domain: NAME, lane: 'S3' }] });
    const bare = await x.runDone({ mode: 'full', checks: ['form'], names: [{ domain: NAME, lane: 'S3' }] });
    expect(body.names[0].final_status).toBe(bare.body.names[0].final_status); // lookalikes is a feature check
    expect(body.names[0].first_fail).toBeNull();
  });
});

describe('CR-043 topic reuse', () => {
  it('CR43-40 the topic is stored lower-cased; the default is lane:first two content words; a second name in the window is flagged TOPIC_REUSED with the earlier id; the first is not', async () => {
    const x = await h();
    const a = await intake(x, [{ domain: 'roofdroneinspection.com', lane: 'S3', source: 's', topic: '  Roof Drone Inspection ' }]);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().accepted[0]).toMatchObject({ topic: 'roof drone inspection' });
    expect(a.json().accepted[0].flags).toBeUndefined();
    const b = await intake(x, [{ domain: 'dronesroofcheck.com', lane: 'S4', source: 's', topic: 'roof drone inspection' }]);
    const flag = b.json().accepted[0].flags[0];
    expect(flag).toMatchObject({ code: 'TOPIC_REUSED', topic: 'roof drone inspection' });
    expect(flag.earlier).toEqual([{ intake_id: a.json().accepted[0].intake_id, domain: 'roofdroneinspection.com', received_at: expect.any(String) }]);
    const row = await db.selectFrom('candidate_intake').select('topic').where('domain', '=', 'dronesroofcheck.com').executeTakeFirstOrThrow();
    expect(row.topic).toBe('roof drone inspection');
    const c = await intake(x, [{ domain: 'solarpanelcleaning.com', lane: 'S3', source: 's' }]);
    expect(c.json().accepted[0].topic).toBeUndefined();
    const stored = await db.selectFrom('candidate_intake').select('topic').where('domain', '=', 'solarpanelcleaning.com').executeTakeFirstOrThrow();
    expect(stored.topic).toBe('s3:solar panel');
  });

  it('CR43-41 the window: a topic older than intake.topic_window_days is not reused; the same name sent again does not reuse itself; a topic over 60 characters is 422', async () => {
    const x = await h();
    await intake(x, [{ domain: 'roofdroneinspection.com', lane: 'S3', source: 's', topic: 'shared topic' }]);
    const again = await intake(x, [{ domain: 'roofdroneinspection.com', lane: 'S3', source: 's', topic: 'shared topic' }]);
    expect(again.json().accepted ?? []).toEqual([]); // a duplicate within 30 days
    x.clock.t += 31 * DAY;
    const late = await intake(x, [{ domain: 'dronesroofcheck.com', lane: 'S3', source: 's', topic: 'shared topic' }]);
    expect(late.json().accepted[0].flags).toBeUndefined();
    x.clock.t += 5 * DAY;
    const soon = await intake(x, [{ domain: 'solarpanelcleaning.com', lane: 'S3', source: 's', topic: 'shared topic' }]);
    expect(soon.json().accepted[0].flags[0].earlier.map((e: any) => e.domain)).toEqual(['dronesroofcheck.com']);
    const big = await intake(x, [{ domain: 'bigtopicname.com', lane: 'S3', source: 's', topic: 'x'.repeat(61) }]);
    expect([big.statusCode, big.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
  });
});

describe('CR-043 GET /screening/runs/{id}/report.csv', () => {
  it('CR43-50 one row per name with the columns, CSV quoting, and a leading apostrophe on a formula-like cell', async () => {
    const x = await h();
    await intake(x, [{ domain: 'roofdroneinspection.com', lane: 'S3', source: 's', topic: '=cmd|"a,b"' }, { domain: 'dronesroofcheck.com', lane: 'S3', source: 's', topic: '=cmd|"a,b"' }]);
    const { id } = await x.runDone({ mode: 'full', checks: ['form', 'lookalikes'], names: [{ domain: 'roofdroneinspection.com', lane: 'S3' }, { domain: 'dronesroofcheck.com', lane: 'S3' }] });
    const res = await x.get(`/screening/runs/${id}/report.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe('domain,lane,status,first_fail,ev_cents,ratio,score,tier,lookalikes_registered,lookalikes_in_use,topic,topic_reused,sellers_verified_n,comps_n,reason_codes');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`"'=cmd|""a,b"""`); // quoted, quotes doubled, apostrophe-prefixed
    expect(lines[1]).toMatch(/^roofdroneinspection\.com,S3,would_buy,,,,,,\d+,\d+,.*,false,,0,$/);
    expect(lines[2]).toMatch(/,true,,0,$/); // the second name reuses the first one's topic
    const missing = await x.get('/screening/runs/run_nope/report.csv');
    expect(missing.statusCode).toBe(404);
  });
});
