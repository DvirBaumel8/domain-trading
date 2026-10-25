// v5.44.0 (research funnel-names-safety-2026-10 §5): the safety upgrades of the pre-bid check (BRAND-TYPO-2, URIBL-1, SPAMHAUS-DBL, EUIPO-1, exact search strings, checked_at)
// and the after-auction transfer check of an S8 import (transfer_confirmed, S8_TRANSFER_UNCONFIRMED, the daily re-check). RDAP and DNS are injected; nothing touches the network.
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { http, HttpResponse } from 'msw';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { newPricingSettings } from '../../../src/modules/ops/admin/pricing-settings.js';
import { PortfolioCheckJob } from '../../../src/modules/ops/jobs/portfolio-check.js';
import { makeApp } from '../../helpers/app.js';
import { insertBidPlan } from '../../helpers/bid-plans.js';
import { T0 } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { V3_SET } from '../../helpers/pricing.js';
import { patchActiveSettings, putList } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const D = 'brightwidgets.com';
let app: FastifyInstance;
let clock: { t: number };
let rdapTable: Record<string, RdapLookup>;
let dns: (qname: string, server: string) => { rcode: number; answers: { type: number; data: string }[] } | null;

const facts = (registrar = 'Fake Registrar') => ({ registrar, created_at: '2019-01-01T00:00:00Z', expires_at: '2026-11-01T00:00:00Z', updated_at: null, statuses: ['active'], nameservers: [] });
const registered = (registrar?: string): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{}', facts: facts(registrar) });
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });
const unreadable = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });
const A = (last: number) => ({ rcode: 0, answers: [{ type: 1, data: `127.0.0.${last}` }] });
const NX = { rcode: 3, answers: [] as { type: number; data: string }[] };

async function boot(): Promise<void> {
  clock = { t: T0 };
  rdapTable = { [D]: registered() };
  dns = () => NX;
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  app = await makeApp({
    now: () => clock.t,
    screening: {
      rdapLookup: async (d: string) => rdapTable[d] ?? free(),
      dnsQuery: async (qname: string, _t: number, o?: { server?: string }) => dns(qname, o?.server ?? ''),
      resolveNs: async () => ['ns1.example.test'], resolve4: async () => ['192.0.2.53'],
      siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch,
      lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    },
  });
  await patchActiveSettings(['sources', 'surbl'], false);
  await patchActiveSettings(['sources', 'popularity'], false);
  await putList('brand', ['zzbrand']);
  await putList('bigco', ['zzbigco']);
}
beforeEach(boot);
afterEach(async () => app?.close());

type Scope = 'write' | 'read' | 'bots';
async function call(method: 'GET' | 'POST', url: string, payload?: object, scope: Scope = 'write') {
  const auth = (await issueToken(scope)).auth;
  return app.inject({ method, url, headers: method === 'POST' ? { ...auth, 'idempotency-key': randomUUID() } : auth, ...(payload ? { payload } : {}) });
}
const prebid = async (domain = D) => {
  const r = await call('POST', '/auctions/prebid', { domain, venue: 'godaddy' });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { verdict: string; checks: { id: string; result: string; reason: string | null; evidence: Record<string, any>; checked_at: string }[]; manual_required: Record<string, any>[] };
};
const checkOf = (j: Awaited<ReturnType<typeof prebid>>, id: string) => j.checks.find((c) => c.id === id)!;

/** A stored popularity snapshot (what the daily referenceRefresh step writes), dated `ageDays` before the test clock. */
async function seedPopularity(rows: [number, string][], ageDays = 0): Promise<void> {
  await patchActiveSettings(['sources', 'popularity'], true);
  const body = rows.map(([rank, d]) => `${rank},${d},com`).join('\n');
  await db.insertInto('reference_files').values({
    name: 'popularity_list', source_url: 'https://downloads.majestic.com/majestic_million.csv', fetched_at: new Date(clock.t), data_date: new Date(clock.t - ageDays * 86_400_000).toISOString().slice(0, 10),
    sha256: `t${rows.length}${ageDays}`, bytes: body.length, body_gz: gzipSync(Buffer.from(body, 'utf8')), same_as_id: null,
  }).execute();
}

describe('SF544 pre-bid: brand typo / combosquat (BRAND-TYPO-2)', () => {
  it('SF544-8: against the stored popularity list: a typo is FAIL, a combosquat of a non-word brand FAIL, a brand that is an ordinary word FLAG, a clean name PASS', async () => {
    await seedPopularity([[1, 'paypal.com'], [2, 'target.com'], [3, 'google.com']]);
    const typo = checkOf(await prebid('paypall.com'), 'BRAND-TYPO-2');
    expect(typo).toMatchObject({ result: 'FAIL' });
    expect(typo.evidence.matches[0]).toMatchObject({ brand: 'paypal', kind: 'edit', distance: 1 });
    expect(typo.evidence).toMatchObject({ top_n: 10000, brands_compared: 3 });
    const combo = await prebid('securepaypalshop.com');
    expect(checkOf(combo, 'BRAND-TYPO-2')).toMatchObject({ result: 'FAIL' });
    expect(combo.verdict).toBe('fail');
    expect(checkOf(await prebid('targetmarketing.com'), 'BRAND-TYPO-2')).toMatchObject({ result: 'FLAG' });
    expect(checkOf(await prebid(), 'BRAND-TYPO-2')).toMatchObject({ result: 'PASS', reason: null });
  });

  it('SF544-9: no stored list or a list older than typo.max_list_age_days is a FLAG (never a pass); a switched-off source is SKIP', async () => {
    await patchActiveSettings(['sources', 'popularity'], true);
    expect(checkOf(await prebid(), 'BRAND-TYPO-2')).toMatchObject({ result: 'FLAG', reason: expect.stringContaining('no popularity list') });
    await seedPopularity([[1, 'paypal.com']], 30);
    expect(checkOf(await prebid(), 'BRAND-TYPO-2')).toMatchObject({ result: 'FLAG', reason: expect.stringContaining('over 7 days old') });
    await patchActiveSettings(['sources', 'popularity'], false);
    expect(checkOf(await prebid(), 'BRAND-TYPO-2').result).toBe('SKIP');
  });
});

describe('SF544 pre-bid: URIBL (URIBL-1), Spamhaus, EUIPO', () => {
  const surblOn = async () => { await patchActiveSettings(['sources', 'surbl'], true); };
  /** Both zones prove their control name (listed) and answer `name` with `a`. */
  const zones = (a: ReturnType<typeof A> | typeof NX | null | ((q: string) => unknown)) => {
    dns = (q) => {
      if (q.startsWith('test.surbl.org.')) return A(4);
      if (q.startsWith('test.uribl.com.')) return A(2);
      if (q.endsWith('.multi.uribl.com')) return (typeof a === 'function' ? a(q) : a) as never;
      return NX;
    };
  };

  it('SF544-10: URIBL black is FAIL; grey or red alone is FLAG; not listed is PASS', async () => {
    await surblOn();
    zones(A(2));
    const black = await prebid();
    expect(checkOf(black, 'URIBL-1')).toMatchObject({ result: 'FAIL', evidence: { reason_code: 'URIBL_BLACK', lists: ['black'], control_ok: true } });
    expect(black.verdict).toBe('fail');
    zones(A(4));
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'FLAG', evidence: { reason_code: 'URIBL_GREY_RED', lists: ['grey'] } });
    zones(A(8));
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'FLAG', evidence: { lists: ['red'] } });
    zones(A(14));
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'FAIL', evidence: { lists: ['black', 'grey', 'red'] } });
    zones(NX);
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'PASS', evidence: { listed: false, control_ok: true } });
  });

  it('SF544-11: a resolver refusal is never PASS: 127.0.0.1, REFUSED, SERVFAIL, a timeout and an unprovable control are all FLAG', async () => {
    await surblOn();
    zones(A(1));
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'FLAG', evidence: { reason_code: 'QUERY_REFUSED' } });
    zones({ rcode: 5, answers: [] });
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'FLAG', evidence: { reason_code: 'QUERY_REFUSED' } });
    zones({ rcode: 2, answers: [] });
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'FLAG', evidence: { reason_code: 'SOURCE_ERROR' } });
    zones(null);
    expect(checkOf(await prebid(), 'URIBL-1')).toMatchObject({ result: 'FLAG', evidence: { reason_code: 'TIMEOUT' } });
    // the control name is not answered as listed (an NXDOMAIN-for-everything server): nothing can be trusted
    dns = (q) => (q.startsWith('test.surbl.org.') ? A(4) : NX);
    const j = await prebid();
    expect(checkOf(j, 'URIBL-1')).toMatchObject({ result: 'FLAG', evidence: { reason_code: 'CONTROL_FAILED', control_ok: false } });
    expect(checkOf(j, 'URIBL-1').result).not.toBe('PASS');
  });

  it('SF544-12: URIBL is SKIP while the DNS blocklist source is off; SPAMHAUS-DBL is always a visible SKIP with the reason; EUIPO-1 is SKIP (no key), never PASS', async () => {
    const j = await prebid();
    expect(checkOf(j, 'URIBL-1').result).toBe('SKIP');
    expect(checkOf(j, 'SPAMHAUS-DBL')).toMatchObject({ result: 'SKIP', reason: 'not used: free Spamhaus access is non-commercial only' });
    expect(checkOf(j, 'EUIPO-1')).toMatchObject({ result: 'SKIP', reason: expect.stringContaining('API key') });
    await surblOn();
    zones(NX);
    expect(checkOf(await prebid(), 'SPAMHAUS-DBL').result).toBe('SKIP');
  });
});

describe('SF544 pre-bid: evidence and manual search strings', () => {
  it('SF544-13: every check carries checked_at (Asia/Jerusalem ISO) and the stored answer keeps it', async () => {
    const j = await app.inject({ method: 'POST', url: '/auctions/prebid', headers: { ...(await issueToken('write')).auth, 'idempotency-key': randomUUID() }, payload: { domain: D, venue: 'godaddy' } });
    const body = j.json();
    expect(body.checks.length).toBeGreaterThanOrEqual(14);
    for (const c of body.checks) expect(c.checked_at, c.id).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+0[23]:00$/);
    const row = await db.selectFrom('prebid_checks').select('answer').where('id', '=', body.prebid_id).executeTakeFirstOrThrow();
    expect((row.answer as { checks: { checked_at?: string }[] }).checks.every((c) => typeof c.checked_at === 'string')).toBe(true);
  });

  it('SF544-14: manual_required carries the exact search strings: the name as words in quotes, the CamelCase form, the registers, and the Wayback URL', async () => {
    const j = await prebid();
    const exact = j.manual_required.find((m) => m.id === 'EXACT_STRING_BUSINESS')!;
    expect(exact).toMatchObject({ name_as_words: 'bright widgets', camel_case: 'BrightWidgets' });
    expect(exact.search_strings).toEqual([
      '"bright widgets"', '"BrightWidgets"', '"brightwidgets"', 'site:opencorporates.com "bright widgets"',
      'site:find-and-update.company-information.service.gov.uk "bright widgets"', 'site:companieshouse.gov.uk "bright widgets"',
    ]);
    expect(j.manual_required.find((m) => m.id === 'HIST_WAYBACK')).toMatchObject({ wayback_url: 'https://web.archive.org/web/*/brightwidgets.com' });
  });
});

describe('SF544 S8 transfer check', () => {
  const IMP = 'brightwidgets.com';
  beforeEach(async () => {
    await newPricingSettings(db, { set: { ...V3_SET, comps_min: '0' }, approvalText: 'Dvir 7 Oct 2026: pricing v3, comps optional', approvalAt: new Date(T0 - 3_600_000).toISOString(), now: new Date(T0 - 60_000) });
  });
  const imp = async (over: Record<string, unknown> = {}) => {
    if (!(await db.selectFrom('bid_plans').select('id').where('domain', '=', IMP).executeTakeFirst())) await insertBidPlan(db, { domain: IMP, createdAt: new Date(T0 - 3_600_000) });
    return call('POST', '/portfolio/import', { domain: IMP, lane: 'S8', registrar: 'dynadot', source: 'auction', price_paid: 31.5, buy_date: '2026-10-05', expiry_date: '2027-10-05', category: 'trend', ...over });
  };
  const warningsOf = async (code = 'S8_TRANSFER_UNCONFIRMED') => ((await call('GET', '/report')).json().warnings as { code: string; domain?: string; level: string; message: string }[]).filter((w) => w.code === code);
  const row = () => db.selectFrom('domains').select(['transfer_confirmed', 'transfer_checked_at']).where('domain', '=', IMP).executeTakeFirstOrThrow();

  it('SF544-15: RDAP shows the buying registrar: transfer_confirmed true in the answer and on the row; no warning', async () => {
    rdapTable[IMP] = registered('Dynadot Inc');
    const r = await imp();
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().transfer_confirmed).toBe(true);
    expect(r.json().warnings.some((w: string) => w.startsWith('S8_TRANSFER_UNCONFIRMED'))).toBe(false);
    expect(await row()).toMatchObject({ transfer_confirmed: true });
    expect((await row()).transfer_checked_at).not.toBeNull();
    expect(await warningsOf()).toEqual([]);
  });

  it('SF544-16: RDAP shows another registrar: transfer_confirmed false, the import warning and the /report warning say not to list yet; the import is not blocked', async () => {
    rdapTable[IMP] = registered('GoDaddy.com, LLC');
    const r = await imp();
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().transfer_confirmed).toBe(false);
    expect(r.json().warnings.find((w: string) => w.startsWith('S8_TRANSFER_UNCONFIRMED'))).toMatch(/do not list/);
    expect(await row()).toMatchObject({ transfer_confirmed: false });
    const w = await warningsOf();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ domain: IMP, level: 'warn' });
    expect(w[0]!.message).toMatch(/do not list/);
  });

  it('SF544-17: RDAP unreadable: transfer_confirmed null (not true), still warned; a dry run reports the field and writes nothing', async () => {
    rdapTable[IMP] = unreadable();
    const dry = await imp({ dry_run: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().transfer_confirmed).toBeNull();
    expect(await db.selectFrom('domains').select('id').execute()).toHaveLength(0);
    const r = await imp();
    expect(r.json().transfer_confirmed).toBeNull();
    expect((await row()).transfer_confirmed).toBeNull();
    expect(await warningsOf()).toHaveLength(1);
  });

  it('SF544-18: the daily portfolioCheck step re-checks an unconfirmed S8 name and sets true once RDAP shows our registrar (warning gone); a confirmed name is not touched again; a Line 1 name has no warning', async () => {
    rdapTable[IMP] = registered('GoDaddy.com, LLC');
    await imp();
    await insertOwnedDomain(db, { domain: 'plainline1name.com' });
    expect(await warningsOf()).toHaveLength(1);
    const job = (reg: string) => new PortfolioCheckJob({
      db, rdapLookup: async () => registered(reg), now: () => clock.t,
      screening: { fetch: globalThis.fetch, sleep: async () => {}, checkService: undefined as never, rdapLookup: async () => registered(reg), dnsQuery: async () => NX, resolveNs: async () => [], resolve4: async () => [], lookupHost: async () => [{ address: '93.184.216.34', family: 4 }], siteFetch: (async () => new Response('', { status: 200 })) as typeof fetch },
    });
    clock.t = T0 + 86_400_000;
    await job('GoDaddy.com, LLC').runOnce();
    expect(await row()).toMatchObject({ transfer_confirmed: false });
    clock.t = T0 + 2 * 86_400_000;
    await job('Dynadot Inc').runOnce();
    const confirmed = await row();
    expect(confirmed.transfer_confirmed).toBe(true);
    expect(await warningsOf()).toEqual([]);
    // a confirmed name is not written again, even if the registry later shows another registrar (that is REGISTRY_MISMATCH's job)
    clock.t = T0 + 3 * 86_400_000;
    await job('GoDaddy.com, LLC').runOnce();
    const again = await row();
    expect(again.transfer_confirmed).toBe(true);
    expect(again.transfer_checked_at?.getTime()).toBe(confirmed.transfer_checked_at?.getTime());
  });
});
