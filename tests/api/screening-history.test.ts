// Task 7: history (CAP-07, HIST-2 + prior-business guard) from Wayback captures. The archive is MSW: real recorded CDX/capture
// fixtures (tests/fixtures/screening/wayback/<name>_com/) and clearly named synthetic-*.json for classes the live archive no longer holds.
import { afterEach, describe, expect, it } from 'vitest';
import { HttpResponse } from 'msw';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup } from '../../src/rdap.js';
import { readEvidence } from '../../src/screening/evidence.js';
import { outcome, type Check, type CheckId } from '../../src/screening/types.js';
import { testDb as db } from '../helpers/db.js';
import { enableWayback, putBrandLists, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { recordedSite, syntheticSite, waybackHandlers, type WaybackLog, type WaybackOpts, type WaybackSite } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const REGISTERED_AT = '2026-10-04T13:16:00.000Z';
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: { registrar: 'R', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] } });
const available = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });

async function h(opts: { rdap?: Record<string, RdapLookup>; fetch?: typeof fetch; enabled?: boolean } = {}): Promise<ScreeningHarness & { log: WaybackLog }> {
  if (opts.enabled !== false) await enableWayback();
  const x = await screeningHarness({ screening: { sleep: async () => {}, rdapLookup: async (d) => opts.rdap?.[d] ?? available(), ...(opts.fetch && { fetch: opts.fetch }) } });
  app = x.app;
  return Object.assign(x, { log: { cdx: [], captures: [] } as WaybackLog });
}
const serve = (x: { log: WaybackLog }, sites: Record<string, WaybackSite>, o: WaybackOpts = {}) => mswServer.use(...waybackHandlers(sites, x.log, o));
const synth = (name: string) => { const s = syntheticSite(name); return { domain: s.domain, site: s as WaybackSite }; };
const item = (domain: string, extra: object = {}) => ({ domain, lane: 'S3', ...extra });
const hist = (body: any, domain?: string) => (domain ? body.names.find((n: any) => n.domain === domain) : body.names[0]).results.find((r: any) => r.check === 'history');
const fake = (id: CheckId, gate: string, status: 'PASS' | 'FAIL' | 'UNKNOWN', code: string | null = null): Check => ({ id, gate, ruleIds: [], lists: [], run: async () => outcome(status, code, null, {}) });

describe('history: recorded archive captures', () => {
  it('officeprep.com: parking and for-sale history only (the live archive holds no business page) -> PASS, prior_history 1, pre_cls parked, forsale', async () => {
    const x = await h();
    serve(x, { 'officeprep.com': recordedSite('officeprep.com') });
    const { body } = await x.runDone({ checks: ['history'], names: [item('officeprep.com')] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'PASS', reason_code: null, gate: 'G6', rule_ids: ['HIST-2'], upstream_calls: 4 });
    expect(r.fields).toMatchObject({ prior_history: 1, pre_caps: 30, pre_cls: 'parked', hist2: 'PASS', hist2_fail_class: null, forsale: true, parked_only: true, prior_business_use: 'no', prior_business_name: null });
    expect(r.fields.captures.map((c: any) => [c.timestamp.slice(0, 10), c.status, c.class])).toEqual([['2003-04-14', 302, 'parked'], ['2005-02-13', 200, 'parked'], ['2025-03-24', 302, 'forsale']]);
    expect(r.fields.captures[2]).toMatchObject({ redirect_target: expect.stringContaining('domains.atom.com'), archive_url: expect.stringContaining('/web/20250324035157id_/'), matched: ['forsale:atom.com'] });
    expect(r.fields.first_capture).toBe('2003-04-14T15:45:59.000Z');
    expect(r.fields.archive_span_yrs).toBeCloseTo(21.9, 1);
    expect(r.fields.list_versions).toEqual({ sig_harmful_strong: 2, sig_harmful_weak: 2, sig_parked: 2, sig_forsale: 2 });
  });

  it('pittsburghroofpros.com: a 2018 redirect to thetrocheckgroup.com -> FLAG REDIRECT_OFFSITE (CR-002 CAP-07 #2); the same-site redirect and the NameSilo parking page are not the cause', async () => {
    const x = await h();
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com') });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pittsburghroofpros.com')] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'REDIRECT_OFFSITE' });
    expect(r.fields).toMatchObject({ pre_cls: 'redirect_offsite', prior_history: 1, hist2: 'FLAG', hist2_fail_class: null });
    expect(r.fields.captures.map((c: any) => c.class)).toEqual(['redirect_offsite', 'same_site_redirect', 'parked', 'same_site_redirect']);
    expect(body.names[0].flags).toEqual(['history']);
  });

  it('a draft with history.redirect_action FAIL fails the same name (the verdict comes from the settings)', async () => {
    const x = await h();
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com') });
    expect((await x.post('/selection/settings', { label: 'v1r', set: { 'history.redirect_action': 'FAIL' } })).statusCode).toBe(201);
    const { body } = await x.runDone({ checks: ['history'], mode: 'full', settings: 'v1r', names: [item('pittsburghroofpros.com', { as_of: '2026-10-06T08:00:00Z' })] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'REDIRECT_OFFSITE' });
    expect(body.names[0].first_fail).toMatchObject({ check: 'history', gate: 'G6' });
  });

  it('sacramentoepoxypros.com: the only home-page capture is a blank meta-refresh page (to a page of its own site), never a normal page -> PASS redirect_error_only', async () => {
    const x = await h();
    serve(x, { 'sacramentoepoxypros.com': recordedSite('sacramentoepoxypros.com') });
    const { body } = await x.runDone({ checks: ['history'], names: [item('sacramentoepoxypros.com')] });
    expect(hist(body)).toMatchObject({ status: 'PASS', fields: { prior_history: 1, pre_cls: 'redirect_error_only', prior_business_use: 'no' } });
    expect(hist(body).fields.captures[0]).toMatchObject({ status: 200, class: 'same_site_redirect', meta_refresh: true, redirect_target: 'defaultsite' });
  });

  it('memphisplumbingpros.com: no captures at all -> PASS, pre_cls none, prior_history 0 (the server\'s empty body is "none", with evidence of what it said)', async () => {
    const x = await h();
    serve(x, { 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com') });
    const { body } = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'PASS', upstream_calls: 1, fields: { prior_history: 0, pre_caps: 0, pre_cls: 'none', archive_span_yrs: 0, first_capture: null, captures: [], forsale: false } });
    expect(r.evidence).toHaveLength(1);
  });

  it('promptinjectionaudit.com (registered 2026-10-04 13:16Z): our own captures from 18:21Z on are ignored (CR-001 CAP-07 #8); the index is asked only up to the registration', async () => {
    const x = await h({ rdap: { 'promptinjectionaudit.com': registered(REGISTERED_AT) } });
    serve(x, { 'promptinjectionaudit.com': recordedSite('promptinjectionaudit.com') });
    const { body } = await x.runDone({ checks: ['availability', 'history'], mode: 'full', names: [item('promptinjectionaudit.com')] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'PASS', fields: { prior_history: 0, pre_caps: 0, pre_cls: 'none', after_cutoff_n: 3, cutoff: REGISTERED_AT, cutoff_basis: 'registration', com_prior_registration: 'no', source_lane: 'fresh' } });
    expect(x.log.cdx[0]!.searchParams.get('to')).toBe('20261004131600');
    expect(x.log.captures).toEqual([]); // nothing before the cut-off is decisive: no capture is fetched
  });

  it('evidence: the CDX answer and one row per decisive capture (url, timestamp, sha256, visible text, no raw HTML)', async () => {
    const x = await h();
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com') });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pittsburghroofpros.com')] });
    const r = hist(body);
    expect(r.evidence).toHaveLength(5);
    const rows = await Promise.all(r.evidence.map((id: number) => readEvidence(db, id)));
    expect(rows[0]).toMatchObject({ source: 'wayback', url: expect.stringContaining('/cdx/search/cdx?url=pittsburghroofpros.com'), http_status: 200 });
    expect(rows[0]!.text).toContain('"20180807083604"');
    const page = rows.find((e) => e!.url.includes('20220312011738'))!;
    expect(page.text).toContain('This domain is parked free of charge with NameSilo.com');
    expect(page.text).not.toMatch(/<[a-z]/i);
    expect(page.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.find((e) => e!.url.includes('20180807083604'))!.text).toContain('redirect to');
    expect(r.fields.evidence_urls).toHaveLength(5);
    expect((await x.get(`/screening/evidence/${r.evidence[0]}`)).json()).toMatchObject({ source: 'wayback' });
  });
});

describe('history: harmful use, for-sale, parked and the prior-business guard (synthetic captures)', () => {
  it('a pharma-spam capture: FAIL HARMFUL_HISTORY, hist2_fail_class spam, details.class pharma (CR-002 #3); script text is not read', async () => {
    const x = await h();
    const s = synth('synthetic-pharma');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY' });
    expect(r.fields).toMatchObject({ hist2: 'FAIL', hist2_fail_class: 'spam', pre_cls: 'harmful', details: { class: 'pharma', fail_class: 'spam', matched: expect.arrayContaining(['pharma:viagra']) } });
    expect(r.fields.captures[0].excerpt.length).toBeLessThanOrEqual(300);
    expect(r.fields.captures[0].excerpt.toLowerCase()).toContain('viagra');
    expect(body.names[0]).toMatchObject({ final_status: 'rejected', first_fail: { check: 'history', gate: 'G6', reason_code: 'HARMFUL_HISTORY' } });
  });

  it('PBN / link-farm text: FAIL, class spam (the strong list wins over a weak casino hit)', async () => {
    const x = await h();
    const s = synth('synthetic-pbn');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY', fields: { hist2_fail_class: 'spam', details: { class: 'pbn' } } });
  });

  it('a weak signature only: FLAG HARMFUL_WEAK with the excerpt and capture url for a human', async () => {
    const x = await h();
    const s = synth('synthetic-pbn');
    s.site.captures['20170810080000']!.body = s.site.captures['20170810080000']!.body.replace(/Buy backlinks and paid guest posts from our private blog network\./, 'Best guest post ideas.');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FLAG', reason_code: 'HARMFUL_WEAK', fields: { hist2: 'FLAG', hist2_fail_class: null, pre_cls: 'harmful' } });
    expect(hist(body).fields.captures[0]).toMatchObject({ class: 'harmful_weak', matched: expect.arrayContaining(['pbn:guest post']), archive_url: expect.stringContaining('id_/') });
  });

  it('a for-sale lander is positive history: PASS with forsale true, pre_cls parked, never a reject (BT10-12); parked likewise ("not yet connected")', async () => {
    const x = await h();
    const a = synth('synthetic-forsale');
    const b = synth('synthetic-notyetconnected');
    serve(x, { [a.domain]: a.site, [b.domain]: b.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(a.domain), item(b.domain)] });
    expect(hist(body, a.domain)).toMatchObject({ status: 'PASS', fields: { forsale: true, pre_cls: 'parked', prior_history: 1, hist2: 'PASS' } });
    expect(hist(body, b.domain)).toMatchObject({ status: 'PASS', fields: { forsale: false, pre_cls: 'parked', parked_only: true } });
  });

  it('draft actions: forsale_action FLAG and parked_action FAIL are honoured (data-driven)', async () => {
    const x = await h();
    const a = synth('synthetic-forsale');
    const b = synth('synthetic-notyetconnected');
    serve(x, { [a.domain]: a.site, [b.domain]: b.site });
    await x.post('/selection/settings', { label: 'v1p', set: { 'history.forsale_action': 'FLAG', 'history.parked_action': 'FAIL' } });
    const { body } = await x.runDone({ checks: ['history'], mode: 'full', settings: 'v1p', names: [item(a.domain, { as_of: '2026-10-06T08:00:00Z' }), item(b.domain, { as_of: '2026-10-06T08:00:00Z' })] });
    expect(hist(body, a.domain)).toMatchObject({ status: 'FLAG', reason_code: 'FORSALE_HISTORY' });
    expect(hist(body, b.domain)).toMatchObject({ status: 'FAIL', reason_code: 'PARKED_HISTORY' });
  });

  it('a prior real business with no list hit: PASS, prior_business_use yes, the name, the years, pre_cls content (CR-002 #1, Amendment A1 #1)', async () => {
    await putBrandLists();
    const x = await h();
    const s = synth('synthetic-business');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'PASS', fields: { prior_history: 1, pre_caps: 3, pre_cls: 'content', prior_business_use: 'yes', prior_business_name: 'Office Prep Solutions Inc', prior_business_years: 7.7, hist2: 'PASS' } });
    expect(r.fields.prior_business_guard).toMatchObject({ name: 'Office Prep Solutions Inc', brand_hits: [], bigco_hits: [], cap08_required: true });
    expect(r.fields.captures).toHaveLength(3);
  });

  it('the prior business name on the brand list: FAIL PRIOR_BUSINESS_BRAND_HIT (a BRAND-1 failure, hist2 itself PASS); on bigco: BIGCO', async () => {
    await putBrandLists(['acme'], ['zzbigco']);
    const x = await h();
    const s = synth('synthetic-business-acme');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'PRIOR_BUSINESS_BRAND_HIT', fields: { hist2: 'PASS', hist2_fail_class: null, prior_business_name: 'Acme Roofing LLC', prior_business_guard: { gate: 'G1', rules: ['BRAND-1', 'BIGCO-1'], brand_hits: [{ term: 'acme' }] } } });
  });

  it('a prior business whose name is on the big-company list: FAIL PRIOR_BUSINESS_BIGCO_HIT', async () => {
    await putBrandLists(['zzbrand'], ['acme roofing']);
    const x = await h();
    const s = synth('synthetic-business-acme');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'PRIOR_BUSINESS_BIGCO_HIT' });
  });

  it('a prior business with no clear name: FLAG PRIOR_BUSINESS_NAME_UNKNOWN, prior_business_use yes, name null', async () => {
    await putBrandLists();
    const x = await h();
    const s = synth('synthetic-business-noname');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FLAG', reason_code: 'PRIOR_BUSINESS_NAME_UNKNOWN', fields: { prior_business_use: 'yes', prior_business_name: null, hist2: 'PASS' } });
  });

  it('a prior business with no uploaded brand list: UNKNOWN LIST_MISSING (never a clean result)', async () => {
    const x = await h();
    const s = synth('synthetic-business');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'LIST_MISSING' });
  });

  it('the manual trademark request names the prior business (CAP-08 must run on it); without a prior business it does not', async () => {
    await putBrandLists();
    const x = await h();
    const s = synth('synthetic-business');
    const t = synth('synthetic-forsale');
    serve(x, { [s.domain]: s.site, [t.domain]: t.site });
    const { body } = await x.runDone({ checks: ['history', 'tm_us'], names: [item(s.domain), item(t.domain)] });
    const tm = (d: string) => body.names.find((n: any) => n.domain === d).results.find((r: any) => r.check === 'tm_us');
    expect(tm(s.domain).fields).toMatchObject({ prior_business_name: 'Office Prep Solutions Inc', prior_business_phrase: 'OFFICE PREP SOLUTIONS INC' });
    expect(tm(s.domain).fields.phrases_to_query).toContain('OFFICE PREP SOLUTIONS INC');
    expect(tm(t.domain).fields.prior_business_name).toBeUndefined();
  });

  it('a missing signature list is UNKNOWN LIST_MISSING, not a clean pass', async () => {
    await db.connection().execute(async (conn) => {
      await sql`SET session_replication_role = replica`.execute(conn);
      await sql`DELETE FROM selection_lists WHERE name = 'sig_parked'`.execute(conn);
      await sql`SET session_replication_role = origin`.execute(conn);
    });
    const x = await h();
    const s = synth('synthetic-forsale');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'LIST_MISSING', fields: { lists_missing: ['sig_parked'] } });
    expect(x.log.cdx).toHaveLength(0);
  });
});

describe('history: the archive failing is UNKNOWN, never "no history"', () => {
  it('the index times out on every attempt (2 retries): UNKNOWN TIMEOUT with error_code ARCHIVE_UNAVAILABLE (CR-002 #4)', async () => {
    let n = 0;
    const x = await h({ fetch: (async () => { n++; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as unknown as typeof fetch });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pittsburghroofpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'TIMEOUT', upstream_calls: 3, fields: { error_code: 'ARCHIVE_UNAVAILABLE', prior_history: null, pre_cls: 'unknown', hist2: 'UNKNOWN', source_lane: 'unknown' } });
    expect(n).toBe(3);
    expect(body.names[0].final_status).toBe('unknown');
  });

  it('a transient failure then success within the retry budget: the second answer is used', async () => {
    const x = await h();
    serve(x, { 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com') });
    let first = true;
    mswServer.use(...waybackHandlers({}, x.log, { cdx: () => { if (first) { first = false; return new HttpResponse('busy', { status: 429 }); } return new HttpResponse('[]', { status: 200 }); } }));
    const { body } = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'PASS', upstream_calls: 2, fields: { pre_cls: 'none' } });
  });

  it('HTTP 429 and 500 from the index: UNKNOWN RATE_LIMITED / SOURCE_ERROR', async () => {
    const x = await h();
    for (const [status, code] of [[429, 'RATE_LIMITED'], [500, 'SOURCE_ERROR']] as const) {
      mswServer.use(...waybackHandlers({}, x.log, { cdx: () => new HttpResponse('x', { status }) }));
      const { body } = await x.runDone({ checks: ['history'], names: [item(`ratelimit${status}.com`)] });
      expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: code, fields: { error_code: 'ARCHIVE_UNAVAILABLE' } });
    }
  });

  it('an index body that is HTML (a proxy error page): UNKNOWN SOURCE_ERROR (Review Focus 2), not "no captures"', async () => {
    const x = await h();
    mswServer.use(...waybackHandlers({}, x.log, { cdx: () => new HttpResponse('<html><body>Service Unavailable</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }) }));
    const { body } = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR', fields: { prior_history: null, pre_caps: null } });
  });

  it('a decisive capture answered 503 by the archive: UNKNOWN CAPTURE_UNAVAILABLE (incomplete never passes)', async () => {
    const x = await h();
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com') }, { capture: (ts) => (ts === '20220312011738' ? new HttpResponse('down', { status: 503 }) : undefined) });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pittsburghroofpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'CAPTURE_UNAVAILABLE', fields: { error_code: 'ARCHIVE_UNAVAILABLE', capture: '20220312011738', fetch_reason: 'CAPTURE_UNAVAILABLE', pre_caps: 7 } });
    expect(body.names[0].final_status).toBe('unknown');
  });

  it('the seed ships with sources.wayback false (the Internet Archive is never automated, Amendment B1): MANUAL_REQUIRED MANUAL_SOURCE (CR-002 Amendment B1), nothing is fetched', async () => {
    const x = await h({ enabled: false });
    serve(x, { 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com') });
    const { body } = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'MANUAL_REQUIRED', reason_code: 'MANUAL_SOURCE', fields: { prior_history: null, pre_cls: 'unknown', lookup_name: 'memphisplumbingpros.com' } });
    expect(x.log.cdx).toHaveLength(0);
    expect(body.names[0]).toMatchObject({ final_status: 'pending_manual', pending_manual: ['history'] });
  });
});

describe('history: blocklists', () => {
  it('SURBL FAIL: FAIL HARMFUL_HISTORY, class blocklist (a listing is a HIST-2 fail class)', async () => {
    const x = await h();
    x.app.screeningWorker.checks.surbl = fake('surbl', 'G4', 'FAIL', 'SURBL_LISTED');
    serve(x, { 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com') });
    const { body } = await x.runDone({ checks: ['surbl', 'history'], mode: 'full', names: [item('memphisplumbingpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY', fields: { hist2_fail_class: 'blocklist', blocklist: { surbl: 'FAIL', web_risk: 'not_run' }, details: { class: 'blocklist' } } });
  });

  it('SURBL UNKNOWN (it ran and could not answer): UNKNOWN BLOCKLIST_UNAVAILABLE; a clean SURBL does not block', async () => {
    const x = await h();
    x.app.screeningWorker.checks.surbl = fake('surbl', 'G4', 'UNKNOWN', 'TIMEOUT');
    serve(x, { 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com') });
    const a = await x.runDone({ checks: ['surbl', 'history'], mode: 'full', names: [item('memphisplumbingpros.com')] });
    expect(hist(a.body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'BLOCKLIST_UNAVAILABLE', fields: { error_code: 'BLOCKLIST_UNAVAILABLE', pre_cls: 'none' } });
    x.app.screeningWorker.checks.surbl = fake('surbl', 'G4', 'PASS');
    const b = await x.runDone({ checks: ['surbl', 'history'], mode: 'full', names: [item('memphisplumbingpros.com')] });
    expect(hist(b.body)).toMatchObject({ status: 'PASS', fields: { blocklist: { surbl: 'PASS' } } });
  });
});

describe('history: as_of, the registration cut-off and the source lane', () => {
  it('as_of is strict: a capture AT as_of is not used, one second later is (A2 #1); undated rows are counted and excluded', async () => {
    const x = await h();
    const s = recordedSite('pittsburghroofpros.com');
    serve(x, { 'pittsburghroofpros.com': s });
    const at = await x.runDone({ checks: ['history'], mode: 'full', names: [item('pittsburghroofpros.com', { as_of: '2018-08-07T08:36:04Z' })] });
    expect(hist(at.body).fields).toMatchObject({ pre_caps: 0, pre_cls: 'none', as_of: '2018-08-07T08:36:04.000Z', after_cutoff_n: 7 });
    expect(x.log.cdx.at(-1)!.searchParams.get('to')).toBe('20180807083604');
    const later = await x.runDone({ checks: ['history'], mode: 'full', names: [item('pittsburghroofpros.com', { as_of: '2018-08-07T08:36:05Z' })] });
    expect(hist(later.body)).toMatchObject({ status: 'FLAG', fields: { pre_caps: 1, pre_cls: 'redirect_offsite', after_cutoff_n: 6 } });
    const u = synth('synthetic-undated');
    serve(x, { [u.domain]: u.site });
    const d = await x.runDone({ checks: ['history'], names: [item(u.domain)] });
    expect(hist(d.body).fields).toMatchObject({ undated_excluded_n: 1, pre_caps: 1, pre_cls: 'parked' });
  });

  it('a backtest run without as_of: UNKNOWN AS_OF_REQUIRED; a live run is as of the request time and echoes it', async () => {
    const x = await h();
    await x.post('/selection/settings', { label: 'v1b', set: { 'history.retries': 0 } });
    const { body } = await x.runDone({ checks: ['history'], mode: 'full', settings: 'v1b', names: [item('memphisplumbingpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'AS_OF_REQUIRED' });
    serve(x, {});
    const live = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    expect(hist(live.body).fields.as_of).toMatch(/^2026-10-06T08:0/);
  });

  it('source lane (inferred): available + captures -> expired_drop; available + none -> fresh; registered with captures before created_at -> expired_drop; flags are documented as inferred', async () => {
    const x = await h({ rdap: { 'promptinjectionaudit.com': registered(REGISTERED_AT), 'officeprep.com': registered('2025-04-01T00:00:00Z') } });
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com'), 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com'), 'officeprep.com': recordedSite('officeprep.com'), 'promptinjectionaudit.com': recordedSite('promptinjectionaudit.com') });
    const { body } = await x.runDone({ checks: ['availability', 'history'], mode: 'full', names: [item('pittsburghroofpros.com'), item('memphisplumbingpros.com'), item('officeprep.com'), item('promptinjectionaudit.com')] });
    const f = (d: string) => hist(body, d).fields;
    expect(f('pittsburghroofpros.com')).toMatchObject({ source_lane: 'expired_drop', source_lane_inferred: true, com_prior_registration: 'yes' });
    expect(f('memphisplumbingpros.com')).toMatchObject({ source_lane: 'fresh', com_prior_registration: 'no' });
    expect(f('officeprep.com')).toMatchObject({ source_lane: 'expired_drop', com_prior_registration: 'yes', cutoff_basis: 'registration', pre_caps: 30 });
    expect(f('promptinjectionaudit.com')).toMatchObject({ source_lane: 'fresh', com_prior_registration: 'no' });
    expect(body.names.find((n: any) => n.domain === 'pittsburghroofpros.com').source_lane).toBe('expired_drop');
  });

  it('without an availability result the lane and com_prior_registration are unknown (not guessed)', async () => {
    const x = await h();
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com') });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pittsburghroofpros.com')] });
    expect(hist(body).fields).toMatchObject({ source_lane: 'unknown', com_prior_registration: 'unknown', prior_history: 1 });
  });

  it('ext_dates reads com_prior_registration from the history result (CAP-12)', async () => {
    const x = await h();
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com'), 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com') });
    const { body } = await x.runDone({ checks: ['availability', 'history', 'ext_dates'], mode: 'full', names: [item('pittsburghroofpros.com'), item('memphisplumbingpros.com')] });
    const ext = (d: string) => body.names.find((n: any) => n.domain === d).results.find((r: any) => r.check === 'ext_dates').fields.com_prior_registration;
    expect([ext('pittsburghroofpros.com'), ext('memphisplumbingpros.com')]).toEqual(['yes', 'no']);
  });

  it('pacing: every request to web.archive.org goes through one pacer of history.min_ms_between_calls (1 s)', async () => {
    const sleeps: number[] = [];
    await enableWayback();
    const x = await screeningHarness({ screening: { sleep: async (ms) => { sleeps.push(ms); }, rdapLookup: async () => available() } });
    app = x.app;
    serve({ log: { cdx: [], captures: [] } }, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com') });
    await x.runDone({ checks: ['history'], names: [item('pittsburghroofpros.com')] });
    // 1 index + 4 captures: the first starts at once; each next one waits for the previous slot (the sleep is a no-op here, so the waits add up)
    expect(sleeps).toHaveLength(4);
    sleeps.forEach((s, i) => { if (i > 0) expect(s - sleeps[i - 1]!).toBeGreaterThan(900); if (i > 0) expect(s - sleeps[i - 1]!).toBeLessThanOrEqual(1100); });
    expect(sleeps[0]).toBeLessThanOrEqual(1000);
  });
});

const HEAD = ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'];
const wr = (domain: string) => ({ domain, check: 'web_risk', checked_at: '2026-10-06T07:30:00Z', evidence_url: 'https://transparencyreport.google.com/safe-browsing/search?url=x', result: { raw_status: 6 } });
const tm = (domain: string, result: object) => ({ domain, check: 'tm_us', checked_at: '2026-10-06T07:30:00Z', evidence_url: 'https://tmsearch.uspto.gov/x', result: { control_ok: true, exact_or_core_live: [], generic_live: [], ...result } });
const mark = { mark: 'OFFICE PREP SOLUTIONS', serial: '88123456', owner: 'Someone Else LLC', status: 'LIVE' };

describe('history: parked first (ads on a placeholder are a FLAG, never a FAIL)', () => {
  it('a parked capture with a pharma ad: FLAG HARMFUL_ON_PARKED_PAGE with ad_matches and excerpt; pre_cls parked; not harmful', async () => {
    const x = await h();
    const s = synth('synthetic-notyetconnected');
    s.site.captures['20250713063751']!.body = s.site.captures['20250713063751']!.body.replace('</p>', '</p><p>Sponsored links: buy viagra online, cialis, xxx</p>');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'HARMFUL_ON_PARKED_PAGE', fields: { pre_cls: 'parked', hist2: 'FLAG', hist2_fail_class: null } });
    expect(r.fields.captures[0]).toMatchObject({ class: 'parked', ad_matches: expect.arrayContaining(['pharma:viagra', 'adult:xxx']) });
    expect(r.fields.parked_page_ads[0]).toMatchObject({ ad_matches: expect.arrayContaining(['pharma:viagra']), excerpt: expect.stringContaining('viagra') });
  });

  it('a for-sale line on a FULL page does not override: the pharma page still FAILs', async () => {
    const x = await h();
    const s = synth('synthetic-pharma');
    const cap = s.site.captures['20160412101010']!;
    cap.body = cap.body.replace('</body>', `<p>This domain name is for sale.</p><p>${'filler words about our region and service '.repeat(60)}</p></body>`);
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY', fields: { hist2_fail_class: 'spam' } });
  });
});

describe('history: the index (paging, truncation, paths)', () => {
  const rows = (n: number, prefix = 'p'): string[][] => Array.from({ length: n }, (_, i) => [`${2010 + (i % 15)}${String((i % 12) + 1).padStart(2, '0')}${String((i % 27) + 1).padStart(2, '0')}000000`, `http://bigexample.com/${prefix}${i}`, '404', 'text/html', `D${prefix}${i}`]);

  it('asks for a narrowed, pageable index: the domain, collapse by digest, a resume key, asset types filtered out', async () => {
    const x = await h();
    serve(x, {});
    await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    const q = x.log.cdx[0]!.searchParams;
    expect([q.get('url'), q.get('matchType'), q.get('collapse'), q.get('limit'), q.get('showResumeKey')]).toEqual(['memphisplumbingpros.com', 'domain', 'digest', '2000', 'true']);
    expect(q.getAll('filter')).toEqual(['!mimetype:(image|font|audio|video).*', '!mimetype:text/css', '!mimetype:.*javascript.*']);
  });

  it('a full page with no resume key: UNKNOWN INDEX_TRUNCATED (never "no history", never clean)', async () => {
    const x = await h();
    serve(x, {}, { cdx: () => new HttpResponse(JSON.stringify([HEAD, ...rows(2000)]), { status: 200 }) });
    const { body } = await x.runDone({ checks: ['history'], names: [item('bigexample.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'INDEX_TRUNCATED', upstream_calls: 1, fields: { error_code: 'ARCHIVE_UNAVAILABLE', prior_history: null } });
  });

  it('a resume key is followed: the pages are merged, every request is counted, the evidence holds both pages', async () => {
    const x = await h();
    const keys: (string | null)[] = [];
    serve(x, {}, { cdx: (_d, url) => {
      keys.push(url.searchParams.get('resumeKey'));
      return new HttpResponse(JSON.stringify(url.searchParams.get('resumeKey') ? [HEAD, ['20100101000000', 'http://other.example.org/', '200', 'text/html', 'DX']] : [HEAD, ['20090101000000', 'http://pgexample.com/', '404', 'text/html', 'DY'], [], ['KEY1']]), { status: 200 });
    } });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pgexample.com')] });
    expect(keys).toEqual([null, 'KEY1']);
    expect(hist(body)).toMatchObject({ status: 'PASS', upstream_calls: 2, fields: { pre_caps: 2, first_capture: '2009-01-01T00:00:00.000Z' } });
  });

  it('a resume key after the fifth page: UNKNOWN INDEX_TRUNCATED', async () => {
    const x = await h();
    serve(x, {}, { cdx: () => new HttpResponse(JSON.stringify([HEAD, ['20100101000000', 'http://pgexample.com/', '404', 'text/html', 'DY'], [], ['MORE']]), { status: 200 }) });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pgexample.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'INDEX_TRUNCATED' });
    expect(x.log.cdx).toHaveLength(5);
  });

  it('an EMPTY 200 index body is UNKNOWN SOURCE_ERROR; `[]` is "no captures"', async () => {
    const x = await h();
    serve(x, {}, { cdx: () => new HttpResponse('', { status: 200 }) });
    const a = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    expect(hist(a.body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    serve(x, {}, { cdx: () => new HttpResponse('[]', { status: 200 }) });
    const b = await x.runDone({ checks: ['history'], names: [item('tulsaroofingco.com')] });
    expect(hist(b.body)).toMatchObject({ status: 'PASS', fields: { pre_cls: 'none' } });
  });

  it('a no-fetch scan of archived URLs: harmful words in a path or subdomain FLAG HARMFUL_PATH, with the url', async () => {
    const x = await h();
    const s = synth('synthetic-forsale');
    s.site.cdx.push(['20190302000000', `http://${s.domain}/cheap-viagra-online`, '200', 'text/html', 'DPATH'], ['20190303000000', `http://casino.${s.domain}/`, '200', 'text/html', 'DSUB']);
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    const r = hist(body);
    expect(r).toMatchObject({ status: 'FLAG', reason_code: 'HARMFUL_PATH', fields: { pre_cls: 'parked' } });
    expect(r.fields.path_hits.map((p: any) => [p.url, p.matched])).toEqual([[`http://${s.domain}/cheap-viagra-online`, ['pharma:viagra', 'url:viagra']], [`http://casino.${s.domain}/`, ['gambling:casino', 'url:casino']]]);
    expect(x.log.captures).toEqual(['20190301120000']); // only the home page was fetched
  });

  it('url_terms is a setting: a URL term flags, an emptied list finds nothing', async () => {
    const x = await h();
    const s = synth('synthetic-forsale');
    s.site.cdx.push(['20190302000000', `http://${s.domain}/cheap-payday-loan-offers`, '200', 'text/html', 'DPATH']);
    serve(x, { [s.domain]: s.site });
    const a = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(a.body)).toMatchObject({ status: 'FLAG', reason_code: 'HARMFUL_PATH', fields: { path_hits: [{ matched: ['url:payday loan'] }] } });
    await x.post('/selection/settings', { label: 'v1u', set: { 'history.url_terms': [] } });
    const { body } = await x.runDone({ checks: ['history'], mode: 'full', settings: 'v1u', names: [item(s.domain, { as_of: '2026-10-06T08:00:00Z' })] });
    expect(hist(body)).toMatchObject({ status: 'PASS', fields: { path_hits: [] } });
  });
});

describe('history: manual records that depend on it', () => {
  it('Web Risk "safe" after a FLAG history is PASS (a FLAG is final and clean here); after a FAIL history it is UNKNOWN HISTORY_NOT_CLEAN', async () => {
    const x = await h();
    const p = synth('synthetic-pharma');
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com'), [p.domain]: p.site });
    const a = await x.runDone({ checks: ['web_risk', 'history'], mode: 'full', names: [item('pittsburghroofpros.com'), item(p.domain)] });
    expect(hist(a.body, 'pittsburghroofpros.com').status).toBe('FLAG');
    const ok = await x.post(`/screening/runs/${a.id}/manual`, wr('pittsburghroofpros.com'));
    expect([ok.statusCode, ok.json().status, ok.json().fields.history_status]).toEqual([201, 'PASS', 'FLAG']);
    const bad = await x.post(`/screening/runs/${a.id}/manual`, wr(p.domain));
    expect([bad.statusCode, bad.json().status, bad.json().reason_code]).toEqual([201, 'UNKNOWN', 'HISTORY_NOT_CLEAN']);
  });

  it('TM-1 on the prior name is enforced: a record that does not list its phrase is UNKNOWN PRIOR_NAME_NOT_QUERIED; with it, a live mark on it is FAIL TM_LIVE_MARK; none is PASS', async () => {
    await putBrandLists();
    const x = await h();
    const s = synth('synthetic-business');
    serve(x, { [s.domain]: s.site });
    const a = await x.runDone({ checks: ['history', 'tm_us'], names: [item(s.domain)] });
    expect(a.body.names[0].results.find((r: any) => r.check === 'tm_us').fields.phrases_to_query).toContain('OFFICE PREP SOLUTIONS INC');
    const missing = await x.post(`/screening/runs/${a.id}/manual`, tm(s.domain, { phrases_queried: ['OFFICEPREPEXAMPLE'] }));
    expect([missing.statusCode, missing.json().status, missing.json().reason_code]).toEqual([201, 'UNKNOWN', 'PRIOR_NAME_NOT_QUERIED']);
    const live = await x.post(`/screening/runs/${a.id}/manual`, tm(s.domain, { phrases_queried: ['OFFICEPREPEXAMPLE', 'Office Prep Solutions Inc'], prior_name_live: [mark] }));
    expect([live.json().status, live.json().reason_code, live.json().fields.prior_business_phrase]).toEqual(['FAIL', 'TM_LIVE_MARK', 'OFFICE PREP SOLUTIONS INC']);
    const clean = await x.post(`/screening/runs/${a.id}/manual`, tm(s.domain, { phrases_queried: ['OFFICEPREPEXAMPLE', 'OFFICE PREP SOLUTIONS INC'] }));
    expect(clean.json().status).toBe('PASS');
  });

  it('a name with no prior business needs no extra phrase', async () => {
    const x = await h();
    const s = synth('synthetic-forsale');
    serve(x, { [s.domain]: s.site });
    const a = await x.runDone({ checks: ['history', 'tm_us'], names: [item(s.domain)] });
    const r = await x.post(`/screening/runs/${a.id}/manual`, tm(s.domain, { phrases_queried: ['FORSALEEXAMPLE'] }));
    expect(r.json().status).toBe('PASS');
  });
});

describe('history: prior-business name quality', () => {
  const twoCaptures = (a: string, b: string) => {
    const s = synth('synthetic-business');
    const [t1, t2] = Object.keys(s.site.captures);
    s.site.captures[t1!]!.body = s.site.captures[t1!]!.body.replace('Home | Office Prep Solutions Inc', a);
    s.site.captures[t2!]!.body = s.site.captures[t2!]!.body.replace('Home | Office Prep Solutions Inc', b);
    delete s.site.captures[Object.keys(s.site.captures)[2]!];
    s.site.cdx = [s.site.cdx[0]!, s.site.cdx[1]!, s.site.cdx[2]!];
    return s;
  };

  it('captures that name different businesses: no name, FLAG PRIOR_BUSINESS_NAME_UNKNOWN (conflict)', async () => {
    await putBrandLists();
    const x = await h();
    const s = twoCaptures('Alpha Studio Inc', 'Beta Studio Inc');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FLAG', reason_code: 'PRIOR_BUSINESS_NAME_UNKNOWN', fields: { prior_business_name: null, prior_business_name_basis: 'conflict' } });
  });

  it('only a copyright line gives a name: low confidence, FLAG (text_line_only)', async () => {
    await putBrandLists();
    const x = await h();
    const s = synth('synthetic-business-noname');
    const t = Object.keys(s.site.captures)[0]!;
    s.site.captures[t]!.body = s.site.captures[t]!.body.replace('</body>', '<p>\u00a9 2015 Quiet Hill Group. All rights reserved.</p></body>');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FLAG', reason_code: 'PRIOR_BUSINESS_NAME_UNKNOWN', fields: { prior_business_name: null, prior_business_name_basis: 'text_line_only' } });
  });

  it('an error or navigation title is not a name (403 Forbidden, Index of, Account Suspended): FLAG', async () => {
    await putBrandLists();
    const x = await h();
    const s = synth('synthetic-business');
    for (const t of Object.keys(s.site.captures)) s.site.captures[t]!.body = s.site.captures[t]!.body.replace('Home | Office Prep Solutions Inc', '403 Forbidden').replace('Office Prep Solutions Inc.', '');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FLAG', reason_code: 'PRIOR_BUSINESS_NAME_UNKNOWN', fields: { prior_business_use: 'yes', prior_business_name: null } });
  });

  it('a title that is the domain\'s own name is used, with prior_business_name_is_domain true', async () => {
    await putBrandLists();
    const x = await h();
    const s = synth('synthetic-business');
    for (const t of Object.keys(s.site.captures)) s.site.captures[t]!.body = s.site.captures[t]!.body.replace('Home | Office Prep Solutions Inc', 'OfficePrepExample.com | Home');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'PASS', fields: { prior_business_name: 'OfficePrepExample.com', prior_business_name_is_domain: true } });
  });
});

describe('history: capture reading', () => {
  const one = (name: string) => { const s = synth(name); const t = Object.keys(s.site.captures)[0]!; s.site.cdx = [s.site.cdx[0]!, s.site.cdx.find((r) => r[0] === t)!]; return { s, t }; };

  it('the declared charset is honoured (ISO-8859-1 header): the accent survives in the title and the name', async () => {
    await putBrandLists();
    const x = await h();
    const { s, t } = one('synthetic-business');
    const html = s.site.captures[t]!.body.replace('Home | Office Prep Solutions Inc', 'Caf\u00e9 Prep Inc');
    serve(x, { [s.domain]: s.site }, { capture: () => new HttpResponse(Buffer.from(html, 'latin1'), { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }) });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'PASS', fields: { prior_business_name: 'Caf\u00e9 Prep Inc' } });
    expect(hist(body).fields.captures[0].title).toBe('Caf\u00e9 Prep Inc');
  });

  it('a charset in <meta> is honoured when the header says nothing', async () => {
    await putBrandLists();
    const x = await h();
    const { s, t } = one('synthetic-business');
    const html = s.site.captures[t]!.body.replace('Home | Office Prep Solutions Inc', 'Caf\u00e9 Prep Inc').replace('<head>', '<head><meta charset="windows-1252">');
    serve(x, { [s.domain]: s.site }, { capture: () => new HttpResponse(Buffer.from(html, 'latin1'), { status: 200, headers: { 'content-type': 'text/html' } }) });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body).fields.captures[0].title).toBe('Caf\u00e9 Prep Inc');
  });

  it('a quick meta refresh to another site is an off-site redirect: FLAG REDIRECT_OFFSITE', async () => {
    const x = await h();
    const { s, t } = one('synthetic-forsale');
    s.site.captures[t]!.body = '<html><head><meta http-equiv="refresh" content="0; url=http://elsewhere.example.net/landing"></head><body></body></html>';
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FLAG', reason_code: 'REDIRECT_OFFSITE', fields: { pre_cls: 'redirect_offsite' } });
    expect(hist(body).fields.captures[0]).toMatchObject({ class: 'redirect_offsite', meta_refresh: true, redirect_target: 'http://elsewhere.example.net/landing' });
  });

  it('a 3xx capture with no Location: UNKNOWN CAPTURE_UNAVAILABLE', async () => {
    const x = await h();
    serve(x, { 'pittsburghroofpros.com': recordedSite('pittsburghroofpros.com') }, { capture: (ts) => (ts === '20180807083604' ? new HttpResponse(null, { status: 302 }) : undefined) });
    const { body } = await x.runDone({ checks: ['history'], names: [item('pittsburghroofpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'CAPTURE_UNAVAILABLE', fields: { capture: '20180807083604' } });
  });

  it('meta description and alt text feed only the weak list: a weak phrase FLAGs, a strong one does not FAIL', async () => {
    await putBrandLists();
    const x = await h();
    const { s, t } = one('synthetic-business');
    const base = s.site.captures[t]!.body;
    s.site.captures[t]!.body = base.replace('<head>', '<head><meta name="description" content="best online casino bonus">');
    serve(x, { [s.domain]: s.site });
    const weak = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(weak.body)).toMatchObject({ status: 'FLAG', reason_code: 'HARMFUL_WEAK', fields: { pre_cls: 'harmful' } });
    s.site.captures[t]!.body = base.replace('<head>', '<head><meta name="keywords" content="buy viagra, xxx"><meta name="description" content="x">').replace('<h1>', '<img src="a.png" alt="cialis"><h1>');
    x.clock.t += 170 * 3_600_000; // past the 168 h freshness window: the first answer is not reused
    const strong = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(strong.body)).toMatchObject({ status: 'PASS', fields: { pre_cls: 'content' } });
  });
});

describe('history: retries, Retry-After, the shared pacer, the fail class', () => {
  it('Retry-After is honoured when it asks for more than the backoff; retries default to 2', async () => {
    const sleeps: number[] = [];
    await enableWayback();
    const x = await screeningHarness({ screening: { sleep: async (ms) => { sleeps.push(ms); }, rdapLookup: async () => available() } });
    app = x.app;
    let n = 0;
    mswServer.use(...waybackHandlers({}, { cdx: [], captures: [] }, { cdx: () => (++n < 3 ? new HttpResponse('slow down', { status: 429, headers: { 'retry-after': n === 1 ? '3' : '1' } }) : new HttpResponse('[]', { status: 200 })) }));
    const { body } = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'PASS', upstream_calls: 3 });
    expect(sleeps.filter((ms) => ms >= 2000 && ms <= 4000)).toEqual(expect.arrayContaining([3000, 4000]));
  });

  it('a Retry-After over 30 s is not waited for: UNKNOWN RATE_LIMITED after one request', async () => {
    const x = await h();
    serve(x, {}, { cdx: () => new HttpResponse('slow', { status: 429, headers: { 'retry-after': '600' } }) });
    const { body } = await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'RATE_LIMITED', upstream_calls: 1 });
  });

  it('one pacer per host serves every run of the process: the second run starts behind the first one\'s last slot', async () => {
    const sleeps: number[][] = [[], []];
    let run = 0;
    await enableWayback();
    const x = await screeningHarness({ screening: { sleep: async (ms) => { sleeps[run]!.push(ms); }, rdapLookup: async () => available() } });
    app = x.app;
    serve({ log: { cdx: [], captures: [] } }, { 'memphisplumbingpros.com': recordedSite('memphisplumbingpros.com'), 'tulsaroofingco.com': recordedSite('memphisplumbingpros.com') });
    await x.runDone({ checks: ['history'], names: [item('memphisplumbingpros.com')] });
    run = 1;
    await x.runDone({ checks: ['history'], names: [item('tulsaroofingco.com')] });
    expect(sleeps[0]).toHaveLength(0); // one request, no wait
    expect(sleeps[1]).toHaveLength(1); // a new run still waits for the previous slot
  });

  it('hist2_fail_class is blocklist when SURBL caused the FAIL, whatever else the pages say', async () => {
    const x = await h();
    x.app.screeningWorker.checks.surbl = fake('surbl', 'G4', 'FAIL', 'SURBL_LISTED');
    const s = synth('synthetic-pharma');
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['surbl', 'history'], mode: 'full', names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY', fields: { hist2_fail_class: 'blocklist', details: { class: 'pharma' } } });
  });
});

describe('history: unreadable and cut captures (fix round 2)', () => {
  const one = (name: string) => { const s = synth(name); const t = Object.keys(s.site.captures)[0]!; s.site.cdx = [s.site.cdx[0]!, s.site.cdx.find((r) => r[0] === t)!]; return { s, t }; };

  it('a script block that never closes: UNKNOWN CAPTURE_UNAVAILABLE (truncated_markup), never an empty page', async () => {
    const x = await h();
    const { s, t } = one('synthetic-forsale');
    s.site.captures[t]!.body = '<html><body><p>This domain name is for sale.</p><script>var a = 1;';
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'UNKNOWN', reason_code: 'CAPTURE_UNAVAILABLE', fields: { fetch_reason: 'TRUNCATED_MARKUP', truncated_markup: true, error_code: 'ARCHIVE_UNAVAILABLE' } });
  });

  it('a capture cut at the 512 KB cap that would pass: FLAG CAPTURE_TRUNCATED; a harmful match in the prefix still FAILs', async () => {
    await putBrandLists();
    const x = await h();
    const { s, t } = one('synthetic-business');
    const filler = `<p>${'regular words about our local service and staff '.repeat(20)}</p>`.repeat(600);
    const page = (extra: string) => s.site.captures[t]!.body.replace('</body>', `${extra}${filler}</body>`);
    serve(x, { [s.domain]: s.site }, { capture: () => new HttpResponse(page(''), { status: 200, headers: { 'content-type': 'text/html' } }) });
    const a = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(a.body)).toMatchObject({ status: 'FLAG', reason_code: 'CAPTURE_TRUNCATED', fields: { pre_cls: 'content' } });
    expect(hist(a.body).fields.captures[0].truncated).toBe(true);
    x.clock.t += 170 * 3_600_000;
    serve(x, { [s.domain]: s.site }, { capture: () => new HttpResponse(page('<p>Buy cheap viagra here</p>'), { status: 200, headers: { 'content-type': 'text/html' } }) });
    const b = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(b.body)).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY' });
  });

  it('a long page with strong harmful hits FAILs even when it contains a parking phrase (the override needs a thin page)', async () => {
    const x = await h();
    const s = synth('synthetic-pharma');
    const t = Object.keys(s.site.captures)[0]!;
    s.site.captures[t]!.body = s.site.captures[t]!.body.replace('</body>', `<p>This domain is not yet connected.</p><p>${'filler words about our region '.repeat(120)}</p></body>`);
    serve(x, { [s.domain]: s.site });
    const { body } = await x.runDone({ checks: ['history'], names: [item(s.domain)] });
    expect(hist(body)).toMatchObject({ status: 'FAIL', reason_code: 'HARMFUL_HISTORY' });
  });
});
