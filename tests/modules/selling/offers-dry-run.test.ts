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

describe('v3.7.0 CR-031 B: POST /offers dry_run', () => {
  const T = 'promptinjectionaudit.com';
  const NOW = Date.parse('2026-10-12T09:00:00Z');
  const offer = (amount: string, over: object = {}) => ({ domain: T, amount_usd: amount, source: 'afternic', received_at: '2026-10-11T12:00:00+02:00', ...over });

  async function setup() {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    await listedDomain({ domain: T, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, first_listed_at: new Date('2026-10-01T09:00:00Z') });
    return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
  }

  it('T31-B1: the $500 / $960 / $1,000 / $1,600 bands on a hybrid 1488/967 plan; nothing is written but the audit row', async () => {
    const { w, r } = await setup();
    const expected: [string, string, string][] = [
      ['500.00', 'below_walkaway', 'auto_decline'], ['960.00', 'mid_range', 'dvir'],
      ['1000.00', 'at_or_above_floor', 'auto_accept'], ['1600.00', 'at_or_above_bin', 'auto_accept'],
    ];
    const before = (await get('/offers', r)).json();
    for (const [amount, band, routing] of expected) {
      const res = await post('/offers', w, offer(amount, { dry_run: true }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ dry_run: true, id: null, band, routing, snapshot: { bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400 } });
      expect(res.json().next_step).toBeTruthy();
    }
    expect(await db.selectFrom('offers').select('id').execute()).toHaveLength(0);
    expect((await get('/offers', r)).json()).toEqual(before);
    const audits = await db.selectFrom('audit_log').select('path').where('path', '=', '/offers').execute();
    expect(audits).toHaveLength(4);
  });

  it('T31-B2: a dry run claims no dedupe key and takes no hold; the same offer then records for real; the real one is a 201', async () => {
    const { w } = await setup();
    const o = offer('1000.00', { external_ref: 'ref-1', pricing_hold: true, pricing_hold_reason: 'looking at it' });
    expect((await post('/offers', w, { ...o, dry_run: true })).statusCode).toBe(200);
    expect((await post('/offers', w, { ...o, dry_run: true })).json().duplicate).toBeUndefined();
    expect((await db.selectFrom('domains').select('pricing_hold').where('domain', '=', T).executeTakeFirstOrThrow()).pricing_hold).toBe(false);
    const real = await post('/offers', w, o);
    expect(real.statusCode).toBe(201);
    expect(real.json().dry_run).toBeUndefined();
    expect(await db.selectFrom('offers').select('id').execute()).toHaveLength(1);
  });

  it('T31-B3: a dry run still validates (bad amount, unknown domain) and shows the private walk-away only in the bot view', async () => {
    const { w } = await setup();
    expect((await post('/offers', w, offer('abc', { dry_run: true }))).statusCode).toBe(422);
    expect((await post('/offers', w, offer('500.00', { dry_run: true, domain: 'nothere.com' }))).statusCode).toBe(404);
    expect((await post('/offers', w, offer('500.00', { dry_run: true }))).json().snapshot.walkaway).toBe('$714 (private)');
  });
});
