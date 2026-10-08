import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addOneYear, idtDay as jerusalemDate } from '../../src/core/dates.js';
import { http, HttpResponse } from 'msw';
import { importDomain, type ImportInput } from '../../src/modules/ops/admin/import-domain.js';
import { GoDaddyAdapter } from '../../src/modules/registrars/godaddy.js';
import { RegistrarError, type RegistrarAdapter } from '../../src/modules/registrars/types.js';
import { spentAndPending } from '../../src/modules/buying/budget.js';
import { makeApp } from '../helpers/app.js';
import { COMPS, buyBody, postBuy, seedOwnedDomains, seedSpent, T0 } from '../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { FAKE_PAT, GODADDY_BASE } from '../helpers/godaddy-msw.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = new Date('2026-10-06T09:00:00Z');
const D = 'promptinjectionaudit.com';
const run = promisify(execFile);

const D001: ImportInput = {
  domain: D, registrar: 'godaddy', buyDate: '2026-10-04', cost: '13.73', costNote: '42 ILS @0.3269', order: 'none', deal: 'D-001', category: 'trend',
  listingMode: 'hybrid', bin: '1995', floor: '1295', walkaway: '950', pricingException: 'Dvir approved 2026-10-05 00:39 IDT',
  legacyNoComps: 'bought before the comps rule; card found no comps', approvalText: 'Approve the prices, but wait for the software to list it',
  approvalAt: '2026-10-05T00:39:00+03:00', manual: true, expiry: '2027-10-04',
};
const MANUAL: ImportInput = { domain: D, registrar: 'other', buyDate: '2026-10-04', cost: '10', category: 'trend', legacyNoComps: 'pre-rule', manual: true, expiry: '2027-10-04' };
const pb = (info: Partial<{ expiryDate: string | null }> | null = { expiryDate: '2027-10-04' }) =>
  new FakeAdapter('porkbun', { findDomain: () => (info === null ? null : { expiryDate: '2027-10-04', whoisPrivacy: true, autoRenew: false, apiAccess: true, ns: null, ...info }) });
const go = (input: ImportInput, adapters: RegistrarAdapter[] = [pb()], now = NOW) => importDomain(db, input, { adapters, now });
const count = async (t: 'domains' | 'ledger_entries' | 'pricing_evidence' | 'audit_log' | 'listing_history' | 'price_schedule') =>
  (await db.selectFrom(t).selectAll().execute()).length;
const refused = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as { code?: string; message: string } | null;
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();

describe('admin import-domain', () => {
  it('IM-1: a Porkbun import has the same rows as a /buy success', async () => {
    const r = await go({ domain: D, registrar: 'porkbun', buyDate: '2026-10-04', cost: '11.08', renewalPrice: '11.08', category: 'geo', grade: 'weaker',
      listingMode: 'bin', bin: '399', evidence: { comps: COMPS, rationale: 'r' } });
    expect(r).toMatchObject({ status: 'listed', registrar_api: 'full', expiry_date: '2027-10-04', drop_date: '2028-10-04' });
    const d = await dom();
    for (const k of ['registrar', 'registrar_api', 'buy_date', 'cost_cents', 'expiry_date', 'renewal_price_cents', 'renewals_used', 'drop_date', 'category', 'listing_mode', 'bin_cents',
      'pricing_source', 'pricing_settings_version', 'first_listed_at', 'plan_id', 'plan_audit_id'] as const) expect(d[k], k).not.toBeNull();
    expect(d).toMatchObject({ renewals_used: 0, cost_cents: 1108, price_grade: 'weaker', bin_cents: 39900 });
    const led = await db.selectFrom('ledger_entries').selectAll().executeTakeFirstOrThrow();
    expect(led).toMatchObject({ type: 'registration', amount_cents: -1108, counterparty: 'porkbun', receipt_ref: 'porkbun:none', domain_id: d.id });
    expect(await db.selectFrom('pricing_evidence').selectAll().executeTakeFirstOrThrow()).toMatchObject({ legacy_no_comps_reason: null, rationale: 'r' });
    expect((await spentAndPending(db)).spent).toBe(1108);
    expect(await count('audit_log')).toBe(1);
  });

  it('IM-2: a second import is refused with no new rows', async () => {
    await go(MANUAL);
    const before = [await count('domains'), await count('ledger_entries'), await count('audit_log')];
    expect((await refused(go(MANUAL)))?.code).toBe('ALREADY_IN_PORTFOLIO');
    expect([await count('domains'), await count('ledger_entries'), await count('audit_log')]).toEqual(before);
  });

  it('IM-3: findDomain null -> NOT_IN_ACCOUNT, nothing written', async () => {
    const e = await refused(go({ ...MANUAL, registrar: 'porkbun', manual: false, expiry: undefined }, [pb(null)]));
    expect(e?.code).toBe('NOT_IN_ACCOUNT');
    expect(await count('domains')).toBe(0);
    expect(await count('audit_log')).toBe(0);
  });

  it('IM-5: GoDaddy findDomain OK -> registrar_api manage, expiry from the registrar', async () => {
    mswServer.use(http.get(`${GODADDY_BASE}/v3/domains/domain-names/:d`, () => HttpResponse.json({ expiresAt: '2027-10-04T13:16:00.000Z', nameServers: ['a.x.com', 'b.x.com'], privacy: true, renewAuto: false })));
    const gd = new GoDaddyAdapter({ pat: FAKE_PAT, baseUrl: GODADDY_BASE });
    const r = await go({ ...MANUAL, registrar: 'godaddy', manual: false, expiry: undefined }, [gd]);
    expect(r).toMatchObject({ registrar_api: 'manage', expiry_date: '2027-10-04', drop_date: '2028-10-04', status: 'owned' });
    expect(await dom()).toMatchObject({ registrar: 'godaddy', registrar_api: 'manage', expiry_date: '2027-10-04' });
  });

  it('IM-6: GoDaddy 403 ACCOUNT_NOT_ELIGIBLE -> refused with the --manual hint, no rows', async () => {
    mswServer.use(http.get(`${GODADDY_BASE}/v3/domains/domain-names/:d`, () => HttpResponse.json({ code: 'ACCOUNT_NOT_ELIGIBLE', message: 'no' }, { status: 403 })));
    const gd = new GoDaddyAdapter({ pat: FAKE_PAT, baseUrl: GODADDY_BASE });
    const e = await refused(go({ ...MANUAL, registrar: 'godaddy', manual: false, expiry: undefined }, [gd]));
    expect(e?.code).toBe('ACCOUNT_NOT_ELIGIBLE');
    expect(e?.message).toContain('use --manual with --expiry YYYY-MM-DD');
    expect(await count('domains')).toBe(0);
    expect(await count('ledger_entries')).toBe(0);
  });

  it('other registrar errors are refused (not crashed) with no rows', async () => {
    const bad = new FakeAdapter('porkbun', { findDomain: () => new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }) });
    const e = await refused(go({ ...MANUAL, registrar: 'porkbun', manual: false, expiry: undefined }, [bad]));
    expect(e?.code).toBe('REGISTRAR_ERROR');
    expect(await count('domains')).toBe(0);
  });

  it('a registrar that is not enabled is refused', async () => {
    expect((await refused(go({ ...MANUAL, registrar: 'godaddy', manual: false, expiry: undefined }, [pb()])))?.code).toBe('ADAPTER_NOT_ENABLED');
  });

  it('IM-7: --manual without --expiry is a usage error', async () => {
    const e = await refused(go({ ...MANUAL, expiry: undefined }));
    expect(e?.constructor.name).toBe('ImportInputError');
    expect(e?.message).toContain('--expiry');
    expect(await count('domains')).toBe(0);
  });

  it('IM-8: manual, no renewal price -> imported owned, registrar_api none, drop_date +1y, RENEWAL_PRICE_UNKNOWN', async () => {
    const r = await go(MANUAL);
    expect(r).toMatchObject({ status: 'owned', registrar_api: 'none', drop_date: '2028-10-04', listing: null });
    expect(r.warnings.some((w) => w.startsWith('RENEWAL_PRICE_UNKNOWN'))).toBe(true);
    expect(await dom()).toMatchObject({ renewal_price_cents: null, listing_mode: null, first_listed_at: null, renewals_used: 0 });
    expect(await count('listing_history')).toBe(0);
  });

  it('a known renewal price drops the warning; an expiry already in the past imports as owned with a warning', async () => {
    const r = await go({ ...MANUAL, renewalPrice: '19.99', expiry: '2026-09-01', buyDate: '2025-09-01' });
    expect(r.status).toBe('owned');
    expect(r.warnings.some((w) => w.startsWith('RENEWAL_PRICE_UNKNOWN'))).toBe(false);
    expect(r.warnings.some((w) => w.startsWith('EXPIRY_IN_PAST'))).toBe(true);
    expect(await dom()).toMatchObject({ status: 'owned', expiry_date: '2026-09-01', drop_date: '2027-09-01', renewal_price_cents: 1999 });
  });

  it('IM-9: no category -> CATEGORY_REQUIRED; a trend plain bin without override -> MODE_NOT_ALLOWED_FOR_CATEGORY; nothing written', async () => {
    expect((await refused(go({ ...MANUAL, category: undefined })))?.code).toBe('CATEGORY_REQUIRED');
    expect((await refused(go({ ...MANUAL, listingMode: 'bin', bin: '999' })))?.code).toBe('MODE_NOT_ALLOWED_FOR_CATEGORY');
    expect((await refused(go({ ...MANUAL, category: 'geo' })))?.code).toBe('GEO_GRADE_REQUIRED');
    expect(await count('domains')).toBe(0);
    expect(await count('audit_log')).toBe(0);
  });

  it('an override needs an approval; with one the listing imports and the history row carries the approval', async () => {
    const o: ImportInput = { ...MANUAL, listingMode: 'bin', bin: '999', override: true, overrideReason: 'Dvir wants a flat price' };
    expect((await refused(go(o)))?.code).toBe('OVERRIDE_NEEDS_APPROVAL');
    await go({ ...o, approvalText: 'ok flat price', approvalAt: '2026-10-05T12:00:00Z' });
    const h = await db.selectFrom('listing_history').selectAll().executeTakeFirstOrThrow();
    expect(h).toMatchObject({ source: 'import', override: true, approval_text: 'ok flat price', mode: 'bin', bin_cents: 99900 });
  });

  it('an exception needs a reason and an approval (amendment); a plain formula listing needs none', async () => {
    const x: ImportInput = { ...D001, approvalText: undefined, approvalAt: undefined };
    expect((await refused(go(x)))?.code).toBe('APPROVAL_REQUIRED');
    expect((await refused(go({ ...D001, pricingException: '  ' })))?.code).toBe('EXCEPTION_REASON_REQUIRED');
    const r = await go({ ...MANUAL, listingMode: 'hybrid', bin: '1995' });
    expect(r.listing).toMatchObject({ bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, pricing_source: 'formula' });
    const h = await db.selectFrom('listing_history').selectAll().executeTakeFirstOrThrow();
    expect(h).toMatchObject({ approval_text: null, approval_at: null, source: 'import' });
    expect(await db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow()).toMatchObject({ approval_text: null });
  });

  it('a given approval is validated: future, bad format, half-given', async () => {
    const m: ImportInput = { ...MANUAL, listingMode: 'hybrid', bin: '1995' };
    for (const bad of [
      { approvalText: 'ok', approvalAt: '2026-10-07T00:00:00Z' }, { approvalText: 'ok', approvalAt: '2026-10-05' },
      { approvalText: ' ', approvalAt: '2026-10-05T00:00:00Z' }, { approvalText: 'ok' },
    ]) expect((await refused(go({ ...m, ...bad })))?.constructor.name).toBe('ImportInputError');
    expect(await count('domains')).toBe(0);
  });

  it('IM-10: the import counts toward the POC cap and the domain cap', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], rdap: async () => 'not_registered', now: () => T0 });
    const { auth } = await issueToken('write');
    await go({ ...MANUAL, cost: '13.73' });
    expect((await spentAndPending(db)).spent).toBe(1373);
    await seedSpent(150000 - 1373 - 500); // $5.00 left
    const res = await postBuy(app, buyBody({ domain: 'examplecityroofing.com' }), auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('POC_CAP_EXCEEDED');
  });

  it('IM-10: with 50 domains the import succeeds with DOMAIN_CAP_EXCEEDED_BY_IMPORT and /buy is then DOMAIN_CAP_REACHED', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], rdap: async () => 'not_registered', now: () => T0 });
    const { auth } = await issueToken('write');
    await seedOwnedDomains(50);
    const r = await go(MANUAL);
    expect(r.warnings.some((w) => w.startsWith('DOMAIN_CAP_EXCEEDED_BY_IMPORT'))).toBe(true);
    const res = await postBuy(app, buyBody({ domain: 'examplecityroofing.com' }), auth);
    expect(res.json().error.code).toBe('DOMAIN_CAP_REACHED');
  });

  it('LG-9 / D-001: the spec command lists hybrid 1995/1295/950/100 as an approved exception, schedule from the import date', async () => {
    const r = await go(D001);
    expect(r).toMatchObject({ status: 'listed', registrar_api: 'none', expiry_date: '2027-10-04', drop_date: '2028-10-04' });
    expect(r.listing).toMatchObject({ bin_cents: 199500, floor_cents: 129500, walkaway_cents: 95000, min_offer_cents: 10000, pricing_source: 'approved_exception' });
    for (const w of ['FLOOR_AUTO_ACCEPT', 'PRICING_EXCEPTION', 'LEGACY_NO_COMPS', 'RENEWAL_PRICE_UNKNOWN']) expect(r.warnings.some((x) => x.startsWith(w)), w).toBe(true);
    const d = await dom();
    expect(d).toMatchObject({ status: 'listed', deal_id: 'D-001', registrar: 'godaddy', cost_cents: 1373, pricing_source: 'approved_exception', category: 'trend' });
    expect(d.first_listed_at?.getTime()).toBe(NOW.getTime());
    expect(d.listing_changed_at?.getTime()).toBe(NOW.getTime());
    const led = await db.selectFrom('ledger_entries').selectAll().executeTakeFirstOrThrow();
    expect(led).toMatchObject({ amount_cents: -1373, receipt_ref: 'godaddy:none', occurred_on: '2026-10-04', deal_id: 'D-001' });
    expect(led.note).toMatch(/^import; 42 ILS @0\.3269; approval aud_/);
    const sched = (await db.selectFrom('price_schedule').selectAll().where('status', '!=', 'superseded').orderBy('due_on').execute())
      .map((e) => [e.event, e.due_on, e.bin_cents, e.floor_cents, e.walkaway_cents, e.status]);
    expect(sched.map((e) => [e[0], e[1]])).toEqual([['drop1_m6', '2027-04-06'], ['drop2_m18', '2028-04-06'], ['final_push', '2028-07-06'], ['delist', '2028-09-27']]);
    expect(sched[0]).toEqual(['drop1_m6', '2027-04-06', 159500, 103500, 76000, 'planned']);
    const h = await db.selectFrom('listing_history').selectAll().executeTakeFirstOrThrow();
    expect(h).toMatchObject({ source: 'import', approval_text: D001.approvalText, walkaway_cents: 95000, pricing_source: 'approved_exception' });
    expect(h.approval_at?.toISOString()).toBe('2026-10-04T21:39:00.000Z');
    expect(h.audit_id).toBe(d.plan_audit_id);
    const audit = await db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ scope: 'admin', path: 'import-domain', approval_text: D001.approvalText });
    expect(await db.selectFrom('deals').selectAll().executeTakeFirstOrThrow()).toMatchObject({ id: 'D-001', domain: D });
    expect(await db.selectFrom('pricing_evidence').selectAll().executeTakeFirstOrThrow()).toMatchObject({ comps: null, legacy_no_comps_reason: D001.legacyNoComps });
  });

  it('D8: --legacy-no-comps with a buy date on or after 2026-10-05 -> COMPS_REQUIRED; no comps at all -> COMPS_REQUIRED', async () => {
    expect((await refused(go({ ...MANUAL, buyDate: '2026-10-06' })))?.code).toBe('COMPS_REQUIRED');
    expect((await refused(go({ ...MANUAL, legacyNoComps: undefined })))?.code).toBe('COMPS_REQUIRED');
    expect((await refused(go({ ...MANUAL, legacyNoComps: undefined, evidence: { comps: COMPS.slice(0, 1) } })))?.code).toBe('COMPS_REQUIRED');
    expect(await count('domains')).toBe(0);
  });

  it('the cost note is free text: an email address is refused (NO_PII)', async () => {
    expect((await refused(go({ ...MANUAL, costNote: 'paid by me@example.com' })))?.code).toBe('NO_PII');
  });

  it('a dry run writes nothing and returns the plan with the schedule', async () => {
    const r = await go({ ...D001, dryRun: true });
    expect(r).toMatchObject({ dry_run: true, status: 'listed', drop_date: '2028-10-04' });
    expect((r.listing as { schedule: unknown[] }).schedule).toHaveLength(4);
    for (const t of ['domains', 'ledger_entries', 'pricing_evidence', 'audit_log', 'listing_history', 'price_schedule'] as const) expect(await count(t), t).toBe(0);
  });

  it('PR-17: import dry run, GET /pricing/preview, /list dry run and /buy dry run agree', async () => {
    const T = Date.parse('2026-10-12T09:00:00Z');
    app = await makeApp({ adapters: [new FakeAdapter('porkbun', { domainInfo: { expiryDate: '2027-10-12' } })], rdap: async () => 'not_registered', now: () => T });
    const { auth } = await issueToken('write');
    const imp = (await go({ ...MANUAL, listingMode: 'hybrid', bin: '1995', dryRun: true }, [pb()], new Date(T))).listing as Record<string, unknown>;
    const prev = (await app.inject({ method: 'GET', url: '/pricing/preview?category=trend&bin=1995&listed_on=2026-10-12&drop_date=2028-10-04', headers: auth })).json();
    await insertOwnedDomain(db, { domain: 'listme.com', category: 'trend', price_grade: null, drop_date: '2028-10-04' });
    const list = (await app.inject({ method: 'POST', url: '/list/listme.com', headers: { ...auth, 'idempotency-key': 'k-17' },
      payload: { mode: 'hybrid', bin: 1995, dry_run: true } })).json().listing;
    const keys = ['bin_cents', 'floor_cents', 'walkaway_cents', 'min_offer_cents', 'sell_plan_line', 'schedule'];
    expect((imp.schedule as unknown[]).length).toBe(4);
    for (const k of keys) { expect(imp[k], k).toEqual(prev[k]); expect(list[k], k).toEqual(prev[k]); }
    const { price_grade: _g, ...b } = buyBody({ domain: 'buyme.com', category: 'trend', approval_ref: { text: 'yes buy buyme.com', approved_at: new Date(T - 3_600_000).toISOString() } });
    const buy = (await postBuy(app, { ...b, dry_run: true, proposed_listing: { mode: 'hybrid', bin: 1995 } }, auth)).json().proposed_listing;
    for (const k of keys.slice(0, 4)) expect(buy[k], k).toEqual(prev[k]);
  });

  it('registrar status warnings (dry run, one per case)', async () => {
    const dry = (info: object) => go({ ...MANUAL, registrar: 'porkbun', manual: false, expiry: undefined, dryRun: true }, [pb(info as never)]);
    const cases: [string, object, (x: string) => boolean][] = [
      ['auto-renew on', { autoRenew: true }, (x) => x === 'AUTO_RENEW_ON: turn auto-renew OFF at porkbun (renewals there are billed outside the $1,500 cap)'],
      ['privacy off', { whoisPrivacy: false }, (x) => x.startsWith('PRIVACY_OFF')],
      ['auto-renew null', { autoRenew: null }, (x) => x === 'AUTO_RENEW_UNCONFIRMED: check auto-renew is OFF in the porkbun dashboard'],
      ['api access off', { apiAccess: false }, (x) => x.startsWith('API_ACCESS_DISABLED: turn on API access for this domain at porkbun.com/account/api')],
    ];
    for (const [label, info, match] of cases) expect((await dry(info)).warnings.some(match), label).toBe(true);
    expect((await dry({ autoRenew: true })).warnings.some((x) => x.startsWith('AUTO_RENEW_UNCONFIRMED'))).toBe(false);
    expect((await dry({})).warnings.some((x) => /^(AUTO_RENEW|PRIVACY_OFF|API_ACCESS)/.test(x))).toBe(false);
    expect((await go({ ...MANUAL, dryRun: true })).warnings).toContain('AUTO_RENEW_UNCONFIRMED: check auto-renew is OFF in the other dashboard');
  });

  it('a GoDaddy import always asks to confirm auto-renew', async () => {
    mswServer.use(http.get(`${GODADDY_BASE}/v3/domains/domain-names/:d`, () => HttpResponse.json({ expiresAt: '2027-10-04T13:16:00.000Z', privacy: true, renewAuto: false })));
    const gd = new GoDaddyAdapter({ pat: FAKE_PAT, baseUrl: GODADDY_BASE });
    const r = await go({ ...MANUAL, registrar: 'godaddy', manual: false, expiry: undefined }, [gd]);
    expect(r.warnings).toContain('AUTO_RENEW_UNCONFIRMED: check auto-renew is OFF in the godaddy dashboard');
  });

  it('GoDaddy NOT_IN_ACCOUNT carries the lookup-path hint', async () => {
    mswServer.use(http.get(`${GODADDY_BASE}/v3/domains/domain-names/:d`, () => new HttpResponse(null, { status: 404 })));
    const gd = new GoDaddyAdapter({ pat: FAKE_PAT, baseUrl: GODADDY_BASE });
    const e = await refused(go({ ...MANUAL, registrar: 'godaddy', manual: false, expiry: undefined }, [gd]));
    expect(e?.code).toBe('NOT_IN_ACCOUNT');
    expect(e?.message).toContain('the lookup path may differ');
  });

  it('one-year term: D-001 with expiry 2028-10-04 is refused (also dry run); 2027-10-04 and 2027-10-10 are fine', async () => {
    expect((await refused(go({ ...D001, expiry: '2028-10-04' })))?.code).toBe('REGISTRATION_TERM_INVALID');
    expect((await refused(go({ ...D001, expiry: '2028-10-04', dryRun: true })))?.code).toBe('REGISTRATION_TERM_INVALID');
    expect(await count('domains')).toBe(0);
    expect((await go({ ...D001, expiry: '2027-10-10', dryRun: true })).expiry_date).toBe('2027-10-10');
    expect((await go({ ...D001, expiry: '2027-10-04' })).status).toBe('listed');
  });

  it('a registrar term over one year is refused too', async () => {
    const e = await refused(go({ ...MANUAL, registrar: 'porkbun', manual: false, expiry: undefined }, [pb({ expiryDate: '2028-10-04' })]));
    expect(e?.code).toBe('REGISTRATION_TERM_INVALID');
  });

  it('EXPIRY_MISMATCH when --expiry and the registrar differ; the registrar wins', async () => {
    const r = await go({ ...MANUAL, registrar: 'porkbun', manual: false, expiry: '2027-10-05' }, [pb()]);
    expect(r.expiry_date).toBe('2027-10-04');
    expect(r.warnings.some((x) => x.startsWith('EXPIRY_MISMATCH'))).toBe(true);
  });

  it('--registrar must be porkbun, godaddy or other; --order must not contain @', async () => {
    for (const registrar of ['namecheap', 'cloudflare']) expect((await refused(go({ ...MANUAL, registrar })))?.constructor.name, registrar).toBe('ImportInputError');
    expect((await refused(go({ ...MANUAL, order: 'me@example.com' })))?.code).toBe('NO_PII');
    expect(await count('domains')).toBe(0);
  });

  it('CLI: the D-001 command with --dry-run exits 0 with JSON and prints no secret', async () => {
    // clock-independent: the CLI uses the real clock, so the dates derive from today
    const buy = jerusalemDate(new Date(Date.now() - 86_400_000));
    const expiry = addOneYear(buy);
    const compsFile = join(mkdtempSync(join(tmpdir(), 'imp-')), 'comps.json');
    writeFileSync(compsFile, JSON.stringify({ comps: COMPS, rationale: 'r' }));
    const args = ['--domain', D, '--registrar', 'godaddy', '--buy-date', buy, '--cost', '13.73', '--cost-note', '42 ILS @0.3269', '--order', 'none',
      '--deal', 'D-001', '--category', 'trend', '--listing-mode', 'hybrid', '--bin', '1995', '--floor', '1295', '--walkaway', '950',
      '--pricing-exception', 'Dvir approved 2026-10-05 00:39 IDT', '--comps-file', compsFile,
      '--approval-text', 'Approve the prices, but wait for the software to list it', '--approval-at', '2026-10-05T00:39:00+03:00', '--manual', '--expiry', expiry, '--dry-run'];
    const { stdout } = await run('npx', ['tsx', 'src/modules/ops/admin.ts', 'import-domain', ...args], { env: { ...process.env, ...testEnv() } });
    const j = JSON.parse(stdout);
    expect(j).toMatchObject({ dry_run: true, domain: D, status: 'listed', drop_date: addOneYear(expiry) });
    for (const secret of ['pk1_', 'sk1_', 'fake_godaddy_pat', 'github_pat_fake']) expect(stdout).not.toContain(secret);
    expect(await count('domains')).toBe(0);
    await expect(run('npx', ['tsx', 'src/modules/ops/admin.ts', 'import-domain', '--domain', D], { env: { ...process.env, ...testEnv() } })).rejects.toMatchObject({ code: 2 });
  });
});
