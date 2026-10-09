// v3.7.0: CR-031 B (offer dry run), CR-031 C (hand listings per venue), CR-033 G-1, G-2, G-3, G-6, G-8, G-9.
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { newAuditId } from '../../../src/http/audit.js';
import { RegistrarCheckJob } from '../../../src/modules/ops/jobs/registrar-check.js';
import { PorkbunAdapter } from '../../../src/modules/registrars/porkbun.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { buyBody, postBuy } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { FAKE_KEYS, PORKBUN_BASE } from '../../helpers/porkbun-msw.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const AFN = ['ns1.afternic.com', 'ns2.afternic.com'];
const key = () => randomUUID();
const get = (url: string, auth: Record<string, string>) => app.inject({ method: 'GET', url, headers: auth });
const post = (url: string, auth: Record<string, string>, payload: object) =>
  app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': key() }, payload });
const reportWarnings = async (auth: Record<string, string>) =>
  (await get('/report', auth)).json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('v3.7.0 CR-033 G-2 / G-9: /buy display_name and drop_policy', () => {
  const NOW = Date.parse('2026-10-05T10:00:00Z');
  const D = 'ukcbamcompliance.com';
  const body = (over: Record<string, unknown> = {}) => {
    const { price_grade: _g, ...b } = buyBody({ domain: D, category: 'trend', approval_ref: { text: `yes buy ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() } });
    return { ...b, ...over };
  };
  const HYBRID = { mode: 'hybrid', bin: 1995 };
  async function setup() {
    const pb = new FakeAdapter('porkbun', { domainInfo: { expiryDate: '2027-10-05' } });
    app = await makeApp({ adapters: [pb], rdap: async () => 'not_registered', now: () => NOW });
    return (await issueToken('write')).auth;
  }
  const intake = (words: string[], domain = D) => db.insertInto('candidate_intake').values({ domain, lane: 'S3', source: 'test', token_name: 'scout', status: 'queued', words }).execute();

  it('T33-G2a: the dry run shows a display_name built from the newest intake words, in proposed_listing too', async () => {
    const auth = await setup();
    await intake(['uk', 'cbam', 'compliance']);
    const res = await post('/buy', auth, body({ dry_run: true, proposed_listing: HYBRID }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ display_name: 'UkCbamCompliance.com', proposed_listing: { display_name: 'UkCbamCompliance.com' } });
  });

  it('T33-G2b: an explicit display_name wins; one that is not the domain is DISPLAY_NAME_MISMATCH; without words or a name it is null', async () => {
    const auth = await setup();
    await intake(['uk', 'cbam', 'compliance']);
    expect((await post('/buy', auth, body({ dry_run: true, display_name: 'UKCBAMCompliance.com' }))).json().display_name).toBe('UKCBAMCompliance.com');
    const bad = await post('/buy', auth, body({ dry_run: true, display_name: 'Other.com' }));
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'DISPLAY_NAME_MISMATCH']);
    const other = 'nowordsname.com';
    const none = await post('/buy', auth, body({ dry_run: true, domain: other, approval_ref: { text: `yes buy ${other}`, approved_at: new Date(NOW - 3_600_000).toISOString() } }));
    expect(none.json().display_name).toBeNull();
  });

  it('T33-G2c: a real buy stores the display_name and the next Afternic export uses it', async () => {
    const auth = await setup();
    await intake(['uk', 'cbam', 'compliance']);
    const res = await postBuy(app, body({ proposed_listing: HYBRID, expected_settings_version: 2 }), auth);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().display_name).toBe('UkCbamCompliance.com');
    expect((await db.selectFrom('domains').select('display_name').where('domain', '=', D).executeTakeFirstOrThrow()).display_name).toBe('UkCbamCompliance.com');
    const csv = await get('/export/afternic.csv', (await issueToken('read')).auth);
    expect(csv.body).toContain('UkCbamCompliance.com');
  });

  it('T33-G9a: the dry run and the 201 carry drop_policy and renewal_committed_cents (default after_one_renewal) and drop_policy_line', async () => {
    const auth = await setup();
    const dry = (await post('/buy', auth, body({ dry_run: true, proposed_listing: HYBRID }))).json();
    expect(dry).toMatchObject({ drop_policy: 'after_one_renewal', renewal_committed_cents: 1108 });
    expect(dry.drop_policy_line).toContain('after one renewal ($11.08');
    const res = await postBuy(app, body({ proposed_listing: HYBRID, expected_settings_version: 2 }), auth);
    expect(res.json()).toMatchObject({ drop_policy: 'after_one_renewal', renewal_committed_cents: 1108, expiry_date: '2027-10-05', drop_date: '2028-10-05' });
    expect(res.json().drop_policy_line).toContain('after one renewal');
  });

  it('T33-G9b: drop_policy at_first_expiry: no renewal committed, drop_date = expiry, schedule ends before the first expiry', async () => {
    const auth = await setup();
    const dry = (await post('/buy', auth, body({ dry_run: true, drop_policy: 'at_first_expiry', proposed_listing: HYBRID }))).json();
    expect(dry).toMatchObject({ drop_policy: 'at_first_expiry', renewal_committed_cents: 0 });
    expect(dry.proposed_listing.sell_plan_line).toContain('at first expiry');
    const res = await postBuy(app, body({ drop_policy: 'at_first_expiry', proposed_listing: HYBRID, expected_settings_version: 2 }), auth);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ drop_policy: 'at_first_expiry', renewal_committed_cents: 0, expiry_date: '2027-10-05', drop_date: '2027-10-05' });
    const dom = await db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
    expect([dom.status, dom.drop_date, dom.expiry_date]).toEqual(['listed', '2027-10-05', '2027-10-05']);
    const events = await db.selectFrom('price_schedule').select(['event', 'due_on', 'status']).orderBy('due_on').execute();
    expect(events.filter((e) => e.status === 'planned').map((e) => e.event)).toEqual(['drop1_m6', 'final_push', 'delist']);
    expect(events.find((e) => e.event === 'drop2_m18')?.status).toBe('superseded_by_final_push');
    expect(events.filter((e) => e.status === 'planned').every((e) => String(e.due_on).slice(0, 10) < '2027-10-05')).toBe(true);
    const bad = await post('/buy', auth, body({ dry_run: true, drop_policy: 'never' }));
    expect(bad.statusCode).toBe(422);
  });
});
