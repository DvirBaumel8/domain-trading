// v5.39.0 (CR-077): POST /auctions/prebid, POST /auctions/plans, POST /auctions/plans/:id/result, GET /auctions/plans[/:id] and the bid-plan rule of POST /portfolio/import (lane S8).
// Test ids AB539-*; rules in docs/internal/auctions.md. Outside calls: RDAP and DNS are fakes, home pages and the IANA bootstrap are MSW (unhandled requests fail).
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { amountsNamed } from '../../../src/modules/ops/auctions/plans.js';
import { makeApp } from '../../helpers/app.js';
import { insertBidPlan } from '../../helpers/bid-plans.js';
import { T0 } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { V3_SET } from '../../helpers/pricing.js';
import { patchActiveSettings, putList } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { newPricingSettings } from '../../../src/modules/ops/admin/pricing-settings.js';
import { mswServer } from '../../setup/network.js';

const D = 'brightwidgets.com';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let app: FastifyInstance;
let clock: { t: number };
let rdapTable: Record<string, RdapLookup>;

const facts = (statuses: string[] = ['active']) => ({ registrar: 'Fake Registrar', created_at: '2019-01-01T00:00:00Z', expires_at: '2026-11-01T00:00:00Z', updated_at: null, statuses, nameservers: [] });
const registered = (statuses?: string[]): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{}', facts: facts(statuses) });
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });

async function boot(): Promise<void> {
  clock = { t: T0 };
  rdapTable = { [D]: registered() };
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  app = await makeApp({
    now: () => clock.t,
    screening: {
      rdapLookup: async (d: string) => rdapTable[d] ?? free(), dnsQuery: async () => ({ rcode: 3, answers: [] }),
      siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch,
      lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    },
  });
  // the DNS-based and list-download sources are off in tests (no real resolver, no popularity list)
  await patchActiveSettings(['sources', 'surbl'], false);
  await patchActiveSettings(['sources', 'popularity'], false);
  await putList('brand', ['zzbrand']);
  await putList('bigco', ['zzbigco']);
}

beforeEach(boot);
afterEach(async () => app?.close());

type Scope = 'write' | 'read' | 'bots';
async function call(method: 'GET' | 'POST', url: string, payload?: object, scope: Scope = 'write', key: string = randomUUID(), auth?: Record<string, string>) {
  auth ??= (await issueToken(scope)).auth;
  return app.inject({ method, url, headers: method === 'POST' ? { ...auth, 'idempotency-key': key } : auth, ...(payload ? { payload } : {}) });
}
const prebid = (domain = D, venue = 'godaddy', scope: Scope = 'write') => call('POST', '/auctions/prebid', { domain, venue }, scope);

const approval = (text: string, ageH = 1) => ({ text, approved_at: new Date(T0 - ageH * HOUR).toISOString() });
const endAt = (days = 3) => new Date(T0 + days * DAY).toISOString();
const planBody = (prebidId: number, over: Record<string, unknown> = {}) => ({
  domain: D, venue: 'godaddy', kind: 'auction', auction_end_at: endAt(), max_bid_usd: 40, prebid_id: prebidId,
  manual: { exact_string_business: { checked: true, note: 'Google exact phrase: none' }, history: { checked: true, note: 'Wayback: parked page only' } },
  reasons: { buyers: 'small widget retailers' }, approval_ref: approval(`Dvir: bid up to $40 on ${D}`), ...over,
});
async function newPrebid(domain = D): Promise<number> {
  const r = await prebid(domain);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().prebid_id as number;
}
async function newPlan(over: Record<string, unknown> = {}, domain = D): Promise<{ id: number; res: Awaited<ReturnType<typeof call>> }> {
  const pid = await newPrebid(domain);
  const res = await call('POST', '/auctions/plans', planBody(pid, { domain, approval_ref: approval(`Dvir: bid up to $40 on ${domain}`), ...over }));
  return { id: res.json().id as number, res };
}

describe('AB539 pre-bid check', () => {
  it('AB539-1: a clean registered name passes; the answer has the checks, the manual items, the endings and the cap; it is stored and audited', async () => {
    mswServer.use(
      http.get('https://brightwidgets.net/robots.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('https://brightwidgets.net/', () => new HttpResponse('<html><body>' + 'We sell widgets to small shops and ship them worldwide every week. '.repeat(10) + '</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    rdapTable['brightwidgets.net'] = registered();
    const r = await prebid();
    expect(r.statusCode, r.body).toBe(201);
    const j = r.json();
    expect(j.verdict).toBe('flag'); // .net is a live site: a human reads it
    expect(j.checks.map((c: { id: string }) => c.id)).toEqual(['SPELL-1', 'BRAND-1', 'BIGCO-1', 'TM_KILL', 'TYPO-1', 'SURBL-1', 'WEB-RISK-1', 'RDAP_STATUS', 'SAME_NAME_ENDINGS', 'UK_COMPANY']);
    const by = Object.fromEntries(j.checks.map((c: { id: string; result: string }) => [c.id, c.result]));
    expect(by).toMatchObject({ 'SPELL-1': 'PASS', 'BRAND-1': 'PASS', 'BIGCO-1': 'PASS', TM_KILL: 'PASS', 'TYPO-1': 'SKIP', 'SURBL-1': 'SKIP', 'WEB-RISK-1': 'SKIP', RDAP_STATUS: 'PASS', SAME_NAME_ENDINGS: 'FLAG', UK_COMPANY: 'SKIP' });
    expect(j.manual_required.map((m: { id: string }) => m.id)).toEqual(['EXACT_STRING_BUSINESS', 'HIST_WAYBACK']);
    expect(j.endings.net).toMatchObject({ registered: true, in_use: true });
    expect(j.endings.org).toMatchObject({ registered: false });
    expect(Object.keys(j.endings)).toEqual(['net', 'org', 'co', 'io', 'ai']);
    expect(j).toMatchObject({ domain: D, venue: 'godaddy', s8_max_price_cents: 25000, s8_max_price: '$250.00' });
    expect(j.checked_at).toMatch(/\+0[23]:00$/); // Asia/Jerusalem offset
    const row = await db.selectFrom('prebid_checks').selectAll().where('id', '=', j.prebid_id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ domain: D, venue: 'godaddy', verdict: 'flag' });
    expect((row.answer as { checks: unknown[] }).checks).toHaveLength(10);
    const audit = await db.selectFrom('audit_log').select(['path', 'method']).where('id', '=', j.audit_id).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ path: '/auctions/prebid', method: 'POST' });
  });

  it('AB539-2: a brand-list hit is FAIL BRAND-1, the later name rules are SKIP, the verdict is fail; prebid_checks is append-only', async () => {
    await putList('brand', ['widgets'], 2);
    const r = await prebid();
    expect(r.statusCode, r.body).toBe(201);
    const by = Object.fromEntries(r.json().checks.map((c: { id: string; result: string }) => [c.id, c.result]));
    expect(by).toMatchObject({ 'SPELL-1': 'PASS', 'BRAND-1': 'FAIL', 'BIGCO-1': 'SKIP', TM_KILL: 'SKIP' });
    expect(r.json().verdict).toBe('fail');
    await expect(db.updateTable('prebid_checks').set({ verdict: 'pass' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('prebid_checks').execute()).rejects.toThrow(/append-only/);
  });

  it('AB539-3: RDAP flags (clientHold, redemptionPeriod, pendingDelete, serverHold) are FLAG; not registered and unreadable RDAP are FLAG too; a tm_kills term is FAIL', async () => {
    rdapTable[D] = registered(['clientHold', 'redemptionPeriod']);
    let r = await prebid();
    let rd = r.json().checks.find((c: { id: string }) => c.id === 'RDAP_STATUS');
    expect(rd.result).toBe('FLAG');
    expect(rd.evidence.flagged_statuses).toEqual(['clientHold', 'redemptionPeriod']);
    rdapTable[D] = registered(['pending delete']);
    rd = (await prebid()).json().checks.find((c: { id: string }) => c.id === 'RDAP_STATUS');
    expect(rd.evidence.flagged_statuses).toEqual(['pendingDelete']);
    delete rdapTable[D];
    rd = (await prebid()).json().checks.find((c: { id: string }) => c.id === 'RDAP_STATUS');
    expect(rd).toMatchObject({ result: 'FLAG', evidence: { registered: false } });
    await db.insertInto('tm_kills').values({ term: 'brightwidgets', by: 'test' }).execute();
    r = await prebid();
    expect(r.json().checks.find((c: { id: string }) => c.id === 'TM_KILL').result).toBe('FAIL');
    expect(r.json().verdict).toBe('fail');
  });

  it('AB539-4: Web Risk is used when a key is configured (a listed name is FAIL) and is SKIP without one', async () => {
    await app.close();
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
    app = await makeApp({
      now: () => clock.t, env: {},
      screening: {
        rdapLookup: async (d: string) => rdapTable[d] ?? free(), dnsQuery: async () => ({ rcode: 3, answers: [] }), webRiskApiKey: 'fake-web-risk-key',
        siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch, lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    });
    mswServer.use(http.get('https://webrisk.googleapis.com/v1/uris:search', () => HttpResponse.json({ threat: { threatTypes: ['MALWARE'], expireTime: '2026-12-01T00:00:00Z' } })));
    const r = await prebid();
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().checks.find((c: { id: string }) => c.id === 'WEB-RISK-1')).toMatchObject({ result: 'FAIL' });
    expect(r.json().verdict).toBe('fail');
  });

  it('AB539-5: scope and shape: a READ token is 403, a bots token may call it, the Idempotency-Key is required, a non-.com name and an unknown field are 422', async () => {
    expect((await prebid(D, 'godaddy', 'read')).statusCode).toBe(403);
    expect((await prebid(D, 'godaddy', 'bots')).statusCode).toBe(201);
    const { auth } = await issueToken('write');
    const noKey = await app.inject({ method: 'POST', url: '/auctions/prebid', headers: auth, payload: { domain: D, venue: 'godaddy' } });
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await prebid('brightwidgets.net')).statusCode).toBe(422);
    expect((await prebid('brightwidgets.com', 'namejet')).statusCode).toBe(422);
    expect((await call('POST', '/auctions/prebid', { domain: D, venue: 'godaddy', extra: 1 })).statusCode).toBe(422);
    // the same key replays the stored answer: one row
    const key = randomUUID();
    const same = (await issueToken('write')).auth;
    const a = await call('POST', '/auctions/prebid', { domain: D, venue: 'dynadot' }, 'write', key, same);
    const b = await call('POST', '/auctions/prebid', { domain: D, venue: 'dynadot' }, 'write', key, same);
    expect(b.json().prebid_id).toBe(a.json().prebid_id);
    expect((await db.selectFrom('prebid_checks').select('id').where('venue', '=', 'dynadot').execute())).toHaveLength(1);
  });
});

describe('AB539 bid plan', () => {
  it('AB539-6: a plan is created (201) with the approval, the manual block and the reasons; an event row, an audit row; GET list and GET one with events', async () => {
    const { id, res } = await newPlan();
    expect(res.statusCode, res.body).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({ domain: D, venue: 'godaddy', kind: 'auction', status: 'open', stored_status: 'open', max_bid_cents: 4000, max_bid: '$40.00', final_price_cents: null, created_by: expect.stringMatching(/^test-write/) });
    expect(p.approval.text).toContain('$40');
    expect(p.manual.exact_string_business.checked).toBe(true);
    const audit = await db.selectFrom('audit_log').select(['path', 'approval_text']).where('id', '=', p.audit_id).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ path: '/auctions/plans' });
    expect(audit.approval_text).toContain('$40');
    const list = (await call('GET', '/auctions/plans?status=open', undefined, 'read')).json();
    expect(list.count).toBe(1);
    expect(list.plans[0].id).toBe(id);
    expect((await call('GET', `/auctions/plans?domain=${D}&status=won`, undefined, 'bots')).json().count).toBe(0);
    const one = (await call('GET', `/auctions/plans/${id}`, undefined, 'read')).json();
    expect(one.events).toHaveLength(1);
    expect(one.events[0]).toMatchObject({ event: 'created', from_status: null, to_status: 'open' });
    expect((await call('GET', '/auctions/plans/99999', undefined, 'read')).json().error.code).toBe('BID_PLAN_NOT_FOUND');
    expect((await call('GET', '/auctions/plans/abc', undefined, 'read')).statusCode).toBe(400);
    expect((await call('GET', '/auctions/plans?status=bogus', undefined, 'read')).statusCode).toBe(400);
  });

  it('AB539-7: approval_ref is validated (present, names the domain, not old, not in the future) and its text must name the maximum bid', async () => {
    const pid = await newPrebid();
    const code = async (ref: unknown) => { const r = await call('POST', '/auctions/plans', planBody(pid, { approval_ref: ref })); return [r.statusCode, r.json().error?.code as string, r.json().error?.details] as const; };
    expect((await code(undefined))[1]).toBe('APPROVAL_INVALID');
    expect((await code(approval('Dvir: bid up to $40 on another.com')))[1]).toBe('APPROVAL_INVALID');
    expect((await code(approval(`Dvir: bid up to $40 on ${D}`, 100)))[1]).toBe('APPROVAL_EXPIRED');
    expect((await code({ text: `Dvir: bid up to $40 on ${D}`, approved_at: new Date(T0 + HOUR).toISOString() }))[1]).toBe('APPROVAL_INVALID');
    const noAmount = await code(approval(`Dvir: yes bid on ${D}`));
    expect(noAmount).toEqual([422, 'APPROVAL_INVALID', { missing: 'max_bid_amount', max_bid_cents: 4000 }]);
    expect((await code(approval(`Dvir: bid up to $45 on ${D}`)))[2]).toMatchObject({ missing: 'max_bid_amount' });
    expect((await code(approval(`Dvir: bid up to $400 on ${D}`)))[2]).toMatchObject({ missing: 'max_bid_amount' });
    expect(await db.selectFrom('bid_plans').select('id').execute()).toHaveLength(0);
    for (const [i, text] of [`Dvir: ${D} up to 40`, `Dvir: ${D} up to $40.00`, `Dvir: yes ${D} max $40 please`].entries()) {
      const d = i === 0 ? D : D; // the same name, one plan at a time
      const r = await call('POST', '/auctions/plans', planBody(pid, { approval_ref: approval(text) }));
      expect(r.statusCode, text + r.body).toBe(201);
      await db.updateTable('bid_plans').set({ status: 'withdrawn' }).where('domain', '=', d).execute();
    }
  });

  it('AB539-8: amountsNamed reads $, commas and cents, ignores digits in the domain, and does not read a longer number', () => {
    const c = (t: string, d = 'x1.com') => [...amountsNamed(t, d)].sort((a, b) => a - b);
    expect(c('up to $180')).toEqual([18000]);
    expect(c('up to 180')).toEqual([18000]);
    expect(c('$1,180 and $50.5')).toEqual([5050, 118000]);
    expect(c('$180.00')).toEqual([18000]);
    expect(c('bid x1.com at 12')).toEqual([1200]);
    expect(c('order 1180x')).toEqual([]);
    expect(c('$18,0000')).not.toContain(18000);
  });

  it('AB539-9: above $50 reasons.comparables or reasons.other_endings is required; at $50 it is not', async () => {
    const pid = await newPrebid();
    const big = await call('POST', '/auctions/plans', planBody(pid, { max_bid_usd: 180, approval_ref: approval(`Dvir: bid up to $180 on ${D}`) }));
    expect(big.statusCode).toBe(422);
    expect(big.json().error.code).toBe('VALIDATION_ERROR');
    expect(big.json().error.details.required_one_of).toEqual(['reasons.comparables', 'reasons.other_endings']);
    const ok = await call('POST', '/auctions/plans', planBody(pid, { max_bid_usd: 180, approval_ref: approval(`Dvir: bid up to $180 on ${D}`), reasons: { buyers: 'retailers', comparables: 'brightwidget.net sold $900 in 2024' } }));
    expect(ok.statusCode, ok.body).toBe(201);
    await db.updateTable('bid_plans').set({ status: 'withdrawn' }).execute();
    const fifty = await call('POST', '/auctions/plans', planBody(pid, { max_bid_usd: 50, approval_ref: approval(`Dvir: bid up to $50 on ${D}`) }));
    expect(fifty.statusCode, fifty.body).toBe(201);
    await db.updateTable('bid_plans').set({ status: 'withdrawn' }).execute();
    const other = await call('POST', '/auctions/plans', planBody(pid, { max_bid_usd: 51, approval_ref: approval(`Dvir: bid up to $51 on ${D}`), reasons: { buyers: 'retailers', other_endings: '.net is a live shop' } }));
    expect(other.statusCode, other.body).toBe(201);
  });

  it('AB539-10: a closeout is 409 CLOSEOUTS_PAUSED while settings.s8_closeouts_allowed is false; with the setting on it is accepted', async () => {
    const pid = await newPrebid();
    const r = await call('POST', '/auctions/plans', planBody(pid, { kind: 'closeout', auction_end_at: undefined }));
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CLOSEOUTS_PAUSED');
    expect(await db.selectFrom('bid_plans').select('id').execute()).toHaveLength(0);
    await sql`update settings set s8_closeouts_allowed = true`.execute(db);
    const ok = await call('POST', '/auctions/plans', planBody(pid, { kind: 'closeout', auction_end_at: undefined }));
    expect(ok.statusCode, ok.body).toBe(201);
    await sql`update settings set s8_closeouts_allowed = false`.execute(db);
  });

  it('AB539-11: the pre-bid check must exist, be for this name and venue, be at most 72 h old and not failed (flag is allowed)', async () => {
    const post = (b: object) => call('POST', '/auctions/plans', b);
    expect((await post(planBody(999999))).json().error.code).toBe('PREBID_REQUIRED');
    const other = await newPrebid('otherwidgets.com');
    expect((await post(planBody(other))).json().error.code).toBe('PREBID_REQUIRED');
    const dyn = (await prebid(D, 'dynadot')).json().prebid_id;
    expect((await post(planBody(dyn))).json().error.code).toBe('PREBID_REQUIRED');
    const old = await newPrebid();
    clock.t += 73 * HOUR;
    const stale = await post(planBody(old, { auction_end_at: new Date(clock.t + 3 * DAY).toISOString(), approval_ref: { text: `Dvir: bid up to $40 on ${D}`, approved_at: new Date(clock.t - HOUR).toISOString() } }));
    expect(stale.json().error.code).toBe('PREBID_REQUIRED');
    expect(stale.json().error.message).toContain('older than');
    clock.t = T0;
    expect(await db.selectFrom('bid_plans').select('id').execute()).toHaveLength(0);
    // a flag verdict is allowed
    rdapTable[D] = registered(['clientHold']);
    const flagged = (await prebid()).json();
    expect(flagged.verdict).toBe('flag');
    expect((await post(planBody(flagged.prebid_id))).statusCode).toBe(201);
    await db.updateTable('bid_plans').set({ status: 'withdrawn' }).execute();
    // a failed check gets no plan
    await putList('brand', ['widgets'], 2);
    const failing = (await prebid()).json();
    expect(failing.verdict).toBe('fail');
    const failed = await post(planBody(failing.prebid_id));
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('PREBID_FAILED');
    expect(await db.selectFrom('bid_plans').select('id').where('status', '=', 'open').execute()).toHaveLength(0);
  });

  it('AB539-12: one open plan per name (BID_PLAN_EXISTS with the plan id); a lost plan frees the name; a plan whose auction ended over 7 days ago is expired in reads and replaced by a new plan', async () => {
    const first = await newPlan();
    const second = await newPlan();
    expect(second.res.statusCode).toBe(409);
    expect(second.res.json().error.code).toBe('BID_PLAN_EXISTS');
    expect(second.res.json().error.details.plan_id).toBe(first.id);
    const lost = await call('POST', `/auctions/plans/${first.id}/result`, { outcome: 'lost', final_price_usd: 55, ended_at: new Date(T0).toISOString() });
    expect(lost.statusCode, lost.body).toBe(200);
    const again = await newPlan();
    expect(again.res.statusCode, again.res.body).toBe(201);
    // time passes: the auction ended 8 days ago and nobody reported a result
    clock.t = T0 + 11 * DAY;
    const read = (await call('GET', `/auctions/plans/${again.id}`, undefined, 'read')).json();
    expect(read).toMatchObject({ status: 'expired', stored_status: 'open' });
    expect((await call('GET', '/auctions/plans?status=expired', undefined, 'read')).json().plans.map((p: { id: number }) => p.id)).toEqual([again.id]);
    expect((await call('GET', '/auctions/plans?status=open', undefined, 'read')).json().count).toBe(0);
    const pid = await newPrebid();
    const fresh = await call('POST', '/auctions/plans', planBody(pid, { auction_end_at: new Date(clock.t + 2 * DAY).toISOString(), approval_ref: { text: `Dvir: bid up to $40 on ${D}`, approved_at: new Date(clock.t - HOUR).toISOString() } }));
    expect(fresh.statusCode, fresh.body).toBe(201);
    const ev = (await call('GET', `/auctions/plans/${again.id}`, undefined, 'read')).json();
    expect(ev).toMatchObject({ status: 'expired', stored_status: 'expired' });
    expect(ev.events.map((e: { event: string }) => e.event)).toEqual(['created', 'expired']);
  });

  it('AB539-13: body rules: an auction needs a future auction_end_at, max_bid_usd is positive and at most the S8 cap (S8_PRICE_CAP), manual checks must be true, unknown fields are refused, a bots token is 403', async () => {
    const pid = await newPrebid();
    const code = async (over: Record<string, unknown>) => { const r = await call('POST', '/auctions/plans', planBody(pid, over)); return [r.statusCode, r.json().error?.code as string] as const; };
    expect(await code({ auction_end_at: undefined })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ auction_end_at: new Date(T0 - HOUR).toISOString() })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ auction_end_at: 'tomorrow' })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ max_bid_usd: 0 })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ max_bid_usd: 12.345 })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ max_bid_usd: 251, approval_ref: approval(`Dvir: bid up to $251 on ${D}`), reasons: { buyers: 'x', comparables: 'y' } })).toEqual([400, 'S8_PRICE_CAP']);
    expect(await code({ manual: { exact_string_business: { checked: false, note: 'x' }, history: { checked: true, note: 'y' } } })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ manual: { exact_string_business: { checked: true, note: 'x' } } })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ reasons: {} })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ bonus: 1 })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await code({ domain: 'brightwidgets.net' })).toEqual([422, 'TLD_NOT_SUPPORTED']);
    expect(await code({ kind: 'private_sale' })).toEqual([422, 'VALIDATION_ERROR']);
    const bots = await call('POST', '/auctions/plans', planBody(pid), 'bots');
    expect(bots.statusCode).toBe(403);
    expect(bots.json().error.code).toBe('SCOPE_FORBIDDEN');
    const botsDry = await call('POST', '/auctions/plans', { ...planBody(pid), dry_run: true }, 'bots');
    expect(botsDry.statusCode).toBe(403);
    expect((await call('POST', '/auctions/plans', planBody(pid), 'read')).statusCode).toBe(403);
    expect(await db.selectFrom('bid_plans').select('id').execute()).toHaveLength(0);
  });

  it('AB539-14: a plan call replayed with the same Idempotency-Key creates one plan', async () => {
    const pid = await newPrebid();
    const key = randomUUID();
    const same = (await issueToken('write')).auth;
    const a = await call('POST', '/auctions/plans', planBody(pid), 'write', key, same);
    const b = await call('POST', '/auctions/plans', planBody(pid), 'write', key, same);
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(await db.selectFrom('bid_plans').select('id').execute()).toHaveLength(1);
  });
});

describe('AB539 result', () => {
  const result = (id: number | string, b: object, scope: Scope = 'write') => call('POST', `/auctions/plans/${id}/result`, b, scope);

  it('AB539-15: won records the final price, status and an event; the plan is closed afterwards (BID_PLAN_CLOSED)', async () => {
    const { id } = await newPlan();
    const r = await result(id, { outcome: 'won', final_price_usd: 31.5, ended_at: new Date(T0).toISOString() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'won', final_price_cents: 3150, final_price: '$31.50' });
    const one = (await call('GET', `/auctions/plans/${id}`, undefined, 'read')).json();
    expect(one.events.map((e: { event: string }) => e.event)).toEqual(['created', 'won']);
    expect(one.events[1]).toMatchObject({ from_status: 'open', to_status: 'won', final_price_cents: 3150 });
    const again = await result(id, { outcome: 'lost', ended_at: new Date(T0).toISOString() });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('BID_PLAN_CLOSED');
  });

  it('AB539-16: a won price above the maximum bid is 409 PRICE_ABOVE_PLAN and records nothing', async () => {
    const { id } = await newPlan();
    const r = await result(id, { outcome: 'won', final_price_usd: 40.01, ended_at: new Date(T0).toISOString() });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('PRICE_ABOVE_PLAN');
    expect(r.json().error.details).toMatchObject({ final_price_cents: 4001, max_bid_cents: 4000 });
    const p = await db.selectFrom('bid_plans').select(['status', 'final_price_cents']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(p).toEqual({ status: 'open', final_price_cents: null });
    expect(await db.selectFrom('bid_plan_events').select('id').where('plan_id', '=', id).execute()).toHaveLength(1);
    const exact = await result(id, { outcome: 'won', final_price_usd: 40, ended_at: new Date(T0).toISOString() });
    expect(exact.statusCode, exact.body).toBe(200);
  });

  it('AB539-17: lost may carry the winning price (even above the maximum) or none; withdrawn takes no price; won needs one', async () => {
    const a = await newPlan();
    const lost = await result(a.id, { outcome: 'lost', final_price_usd: 95, ended_at: new Date(T0).toISOString() });
    expect(lost.json()).toMatchObject({ status: 'lost', final_price_cents: 9500 });
    const b = await newPlan();
    expect((await result(b.id, { outcome: 'won', ended_at: new Date(T0).toISOString() })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await result(b.id, { outcome: 'withdrawn', final_price_usd: 5, ended_at: new Date(T0).toISOString() })).json().error.code).toBe('VALIDATION_ERROR');
    const w = await result(b.id, { outcome: 'withdrawn', ended_at: new Date(T0).toISOString() });
    expect(w.json()).toMatchObject({ status: 'withdrawn', final_price_cents: null });
  });

  it('AB539-18: a result needs WRITE (bots and READ are 403), a real plan id, an ended_at that is not in the future; a stale open plan still accepts its result', async () => {
    const { id } = await newPlan();
    const body = { outcome: 'lost', ended_at: new Date(T0).toISOString() };
    expect((await result(id, body, 'bots')).statusCode).toBe(403);
    expect((await result(id, body, 'read')).statusCode).toBe(403);
    expect((await result(424242, body)).json().error.code).toBe('BID_PLAN_NOT_FOUND');
    expect((await result('abc', body)).statusCode).toBe(400);
    expect((await result(id, { ...body, ended_at: new Date(T0 + 2 * HOUR).toISOString() })).statusCode).toBe(422);
    expect((await result(id, { ...body, extra: 1 })).statusCode).toBe(422);
    clock.t = T0 + 12 * DAY; // expired by the 7-day rule, still stored open
    const late = await result(id, { outcome: 'lost', ended_at: new Date(T0 + 3 * DAY).toISOString() });
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().status).toBe('lost');
  });

  it('AB539-19: bid_plan_events is append-only', async () => {
    await newPlan();
    await expect(db.updateTable('bid_plan_events').set({ actor: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('bid_plan_events').execute()).rejects.toThrow(/append-only/);
  });
});

describe('AB539 S8 import under a bid plan', () => {
  const IMP = 'brightwidgets.com';
  beforeEach(async () => {
    await newPricingSettings(db, { set: { ...V3_SET, comps_min: '0' }, approvalText: 'Dvir 7 Oct 2026: pricing v3, comps optional', approvalAt: new Date(T0 - 3_600_000).toISOString(), now: new Date(T0 - 60_000) });
  });
  const imp = (over: Record<string, unknown> = {}, scope: Scope = 'write') => call('POST', '/portfolio/import', {
    domain: IMP, lane: 'S8', registrar: 'dynadot', source: 'auction', price_paid: 31.5, buy_date: '2026-10-05', expiry_date: '2027-10-05', category: 'trend', ...over,
  }, scope);

  it('AB539-20: no plan is 409 BID_PLAN_REQUIRED (a dry run reports would_be_blocked); a given approval is still validated first; no approval and no plan is APPROVAL_INVALID', async () => {
    const appr = approval(`Dvir: bought ${IMP} at $31.50`);
    const real = await imp({ approval_ref: appr });
    expect(real.statusCode).toBe(409);
    expect(real.json().error.code).toBe('BID_PLAN_REQUIRED');
    const dry = await imp({ approval_ref: appr, dry_run: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().would_be_blocked).toBe('BID_PLAN_REQUIRED');
    expect((await imp({ approval_ref: approval('Dvir: no domain here') })).json().error.code).toBe('APPROVAL_INVALID');
    expect((await imp({})).json().error.code).toBe('APPROVAL_INVALID');
    expect(await db.selectFrom('domains').select('id').execute()).toHaveLength(0);
  });

  it('AB539-21: with an open plan the import needs no approval_ref (the plan approval is used); the plan becomes won with the paid price in the same step; the ledger and the audit name the plan', async () => {
    const { id } = await newPlan();
    const r = await imp();
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ bid_plan_id: id, approval_from_plan: true, lane: 'S8' });
    const p = await db.selectFrom('bid_plans').select(['status', 'final_price_cents']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(p).toEqual({ status: 'won', final_price_cents: 3150 });
    const ev = await db.selectFrom('bid_plan_events').select(['event', 'detail', 'final_price_cents']).where('plan_id', '=', id).orderBy('id').execute();
    expect(ev.map((e) => e.event)).toEqual(['created', 'won']);
    expect(ev[1]).toMatchObject({ final_price_cents: 3150 });
    const led = await db.selectFrom('ledger_entries').select(['amount_cents', 'note']).executeTakeFirstOrThrow();
    expect(led.amount_cents).toBe(-3150);
    expect(led.note).toContain(`bid plan ${id}`);
    const dom = await db.selectFrom('domains').select(['lane', 'cost_cents']).where('domain', '=', IMP).executeTakeFirstOrThrow();
    expect(dom).toEqual({ lane: 'S8', cost_cents: 3150 });
    const audit = await db.selectFrom('audit_log').select('result_summary').where('id', '=', r.json().audit_id).executeTakeFirstOrThrow();
    expect(audit.result_summary).toContain(`bid plan ${id}`);
  });

  it('AB539-22: a price above the plan maximum is 409 PRICE_ABOVE_PLAN (a dry run reports it) and writes nothing; the plan stays open', async () => {
    const { id } = await newPlan();
    const r = await imp({ price_paid: 40.01 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('PRICE_ABOVE_PLAN');
    expect(r.json().error.details).toMatchObject({ plan_id: id, price_paid_cents: 4001, max_bid_cents: 4000 });
    const dry = await imp({ price_paid: 40.01, dry_run: true });
    expect(dry.json().would_be_blocked).toBe('PRICE_ABOVE_PLAN');
    expect(await db.selectFrom('domains').select('id').execute()).toHaveLength(0);
    expect(await db.selectFrom('ledger_entries').select('id').execute()).toHaveLength(0);
    expect((await db.selectFrom('bid_plans').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('open');
    expect((await imp({ price_paid: 40 })).statusCode).toBe(201);
  });

  it('AB539-23: a plan already recorded as won (result route) is imported at the paid price and gets an imported event', async () => {
    const won = await newPlan();
    await call('POST', `/auctions/plans/${won.id}/result`, { outcome: 'won', final_price_usd: 30, ended_at: new Date(T0).toISOString() });
    const r = await imp({ price_paid: 31.5, approval_ref: approval(`Dvir: bought ${IMP} at $31.50`) });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ bid_plan_id: won.id, approval_from_plan: false });
    const ev = await db.selectFrom('bid_plan_events').select(['event', 'detail']).where('plan_id', '=', won.id).orderBy('id').execute();
    expect(ev.map((e) => e.event)).toEqual(['created', 'won', 'imported']);
    expect(ev[2]!.detail).toMatchObject({ plan_final_price_cents: 3000 });
  });

  it('AB539-24: lost, withdrawn and expired plans do not allow an import', async () => {
    for (const status of ['lost', 'withdrawn'] as const) {
      await insertBidPlan(db, { domain: `${status}name.com`, status });
      const r = await imp({ domain: `${status}name.com` , approval_ref: approval(`Dvir: bought ${status}name.com at $31.50`) });
      expect(r.json().error.code, status).toBe('BID_PLAN_REQUIRED');
    }
    await insertBidPlan(db, { domain: 'staleopen.com', kind: 'auction', auctionEndAt: new Date(T0 - 9 * DAY), createdAt: new Date(T0 - 12 * DAY) });
    const stale = await imp({ domain: 'staleopen.com', approval_ref: approval('Dvir: bought staleopen.com at $31.50') });
    expect(stale.json().error.code).toBe('BID_PLAN_REQUIRED');
    expect(await db.selectFrom('domains').select('id').execute()).toHaveLength(0);
  });
});
