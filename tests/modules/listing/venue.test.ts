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

describe('v3.7.0 CR-031 C: POST /listings/{domain}/venue', () => {
  const T = 'promptinjectionaudit.com';
  const NOW = Date.parse('2026-10-12T09:00:00Z');
  const venue = (w: Record<string, string>, body: object) => post(`/listings/${T}/venue`, w, body);
  const sedo = { venue: 'sedo', listed_at: '2026-10-11T10:00:00+02:00', shown: { mode: 'make_offer', price_usd: null, min_offer_usd: 100 }, evidence: { source: 'sedo_dashboard', ref: 'screenshot-1' }, note: 'listed by Dvir' };
  async function setup() {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    await listedDomain({ domain: T, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, first_listed_at: new Date('2026-10-01T09:00:00Z'), listing_changed_at: new Date('2026-10-01T09:00:00Z'), lander: 'afternic' });
    return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
  }
  const exp = async (r: Record<string, string>, v: 'afternic' | 'sedo') => (await get(`/portfolio/${T}`, r)).json().export[v];

  it('T31-C1: a Sedo hand listing (make_offer, no price, min offer $100) shows in /portfolio and clears pending', async () => {
    const { w, r } = await setup();
    expect((await exp(r, 'sedo')).pending).toBe(true);
    const res = await venue(w, sedo);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ venue: 'sedo', delisted: false, shown: { mode: 'make_offer', price_cents: null, min_offer_cents: 10000 } });
    const sedoBlock = await exp(r, 'sedo');
    expect(sedoBlock).toMatchObject({ pending: false, shown: { mode: 'make_offer', price_cents: null, min_offer_cents: 10000 } });
    expect(sedoBlock.listed_by_hand_at).toMatch(/^2026-10-11T11:00:00\+03:00$/);
    expect((await exp(r, 'afternic')).listed_by_hand_at).toBeNull();
  });

  it('T31-C2: pending follows the plan: a priced listing matches until a scheduled price change, then pending is true again', async () => {
    const { w, r } = await setup();
    await venue(w, { venue: 'afternic', listed_at: '2026-10-11T10:00:00+02:00', shown: { mode: 'hybrid', price_usd: 1488, min_offer_usd: 100 } });
    expect((await exp(r, 'afternic')).pending).toBe(false);
    await db.updateTable('domains').set({ bin_cents: 108800, floor_cents: 70700, walkaway_cents: 52200 }).where('domain', '=', T).execute(); // a scheduled drop step
    expect((await exp(r, 'afternic')).pending).toBe(true);
    await venue(w, { venue: 'afternic', listed_at: '2026-10-12T10:00:00+02:00', shown: { mode: 'hybrid', price_usd: 1088, min_offer_usd: 100 } });
    expect((await exp(r, 'afternic')).pending).toBe(false);
  });

  it('T31-C3: any walk-away field is refused and nothing is stored', async () => {
    const { w } = await setup();
    for (const body of [
      { ...sedo, walkaway_usd: 714 }, { ...sedo, shown: { ...sedo.shown, walkaway_usd: 714 } }, { ...sedo, shown: { ...sedo.shown, walkaway: 714 } },
    ]) {
      const res = await venue(w, body);
      expect(res.statusCode, res.body).toBe(422);
    }
    expect(await db.selectFrom('venue_listings').select('id').execute()).toHaveLength(0);
  });

  it('T31-C4: delisted: true ends the hand listing; validation of listed_at, venue and shown; the table is append-only', async () => {
    const { w, r } = await setup();
    await venue(w, sedo);
    expect((await venue(w, { venue: 'sedo', listed_at: '2026-10-12T10:00:00+02:00', delisted: true })).statusCode).toBe(201);
    expect(await exp(r, 'sedo')).toMatchObject({ listed_by_hand_at: null, shown: null });
    expect((await venue(w, { ...sedo, listed_at: '2027-01-01T00:00:00+02:00' })).statusCode).toBe(422);
    expect((await venue(w, { ...sedo, venue: 'godaddy' })).statusCode).toBe(422);
    expect((await venue(w, { venue: 'sedo', listed_at: sedo.listed_at })).statusCode).toBe(422);
    expect((await post('/listings/nothere.com/venue', w, sedo)).statusCode).toBe(404);
    await expect(db.deleteFrom('venue_listings').execute()).rejects.toThrow(/append-only/);
    expect((await app.inject({ method: 'POST', url: `/listings/${T}/venue`, headers: { ...r, 'idempotency-key': key() }, payload: sedo })).statusCode).toBe(403);
  });

  it('T31-C5: the /sold checklist names the venue listed by hand', async () => {
    const { w } = await setup();
    await venue(w, sedo);
    const res = await post(`/sold/${T}`, w, {
      venue: 'afternic', sale_price: 1488, commission: 223.2, sold_at: '2026-10-12T11:00:00+02:00', transaction_ref: 'AFN-9',
      approval_ref: { text: `it sold on afternic for 1488 (${T})`, approved_at: new Date(NOW - 30_000).toISOString() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().checklist.join('\n')).toMatch(/by hand at Sedo/);
  });
});
