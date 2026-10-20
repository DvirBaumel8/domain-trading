// v5.20.0 (BUG-047): POST /portfolio/{domain}/renewal-price records a renewal price with its source and date.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { insertOwnedDomain, testDb } from '../../helpers/db.js';
import { makeApp } from '../../helpers/app.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-20T09:00:00Z');
const post = (url: string, h: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': randomUUID() }, payload: payload as object });

describe('renewal price record (BUG-047)', () => {
  it('L520-2: WRITE and bots tokens record the price, source and date; GET /portfolio/{domain} shows them; the ledger and listing are untouched; bad input is 422, unknown domain 404, READ 403', async () => {
    app = await makeApp({ testRoutes: false, now: () => NOW });
    await insertOwnedDomain(testDb, { domain: 'mineunited.com', renewal_price_cents: null });
    const w = (await issueToken('write')).auth;
    const bots = (await issueToken('bots')).auth;
    const read = (await issueToken('read')).auth;
    const body = { renewal_price: '22.48', source: 'GoDaddy .com renewal rate', as_of: '2026-10-20' };
    const res = await post('/portfolio/mineunited.com/renewal-price', w, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ domain: 'mineunited.com', renewal_price_cents: 2248, renewal_price: '$22.48', renewal_price_source: 'GoDaddy .com renewal rate', renewal_price_as_of: '2026-10-20', previous_renewal_price_cents: null });
    const detail = (await app.inject({ method: 'GET', url: '/portfolio/mineunited.com', headers: read })).json();
    expect(detail).toMatchObject({ renewal_price_cents: 2248, renewal_price_source: 'GoDaddy .com renewal rate', renewal_price_as_of: '2026-10-20' });
    expect((await post('/portfolio/mineunited.com/renewal-price', bots, { ...body, renewal_price: '$23' })).json().renewal_price_cents).toBe(2300);
    const audit = await testDb.selectFrom('audit_log').select(['scope', 'status_code']).where('path', '=', '/portfolio/mineunited.com/renewal-price').orderBy('at').execute();
    expect(audit.map((a) => a.scope)).toEqual(['write', 'bots']);
    expect(await testDb.selectFrom('ledger_entries').select('id').execute()).toEqual([]);
    for (const bad of [{ ...body, renewal_price: '12.345' }, { ...body, renewal_price: '0' }, { ...body, source: '' }, { ...body, source: 'x'.repeat(201) }, { ...body, as_of: '2026-13-01' }, { ...body, as_of: '2026-10-21' }, { renewal_price: '9.99', as_of: '2026-10-20' }]) {
      expect((await post('/portfolio/mineunited.com/renewal-price', w, bad)).statusCode, JSON.stringify(bad)).toBe(422);
    }
    expect((await post('/portfolio/nosuchname.com/renewal-price', w, body)).statusCode).toBe(404);
    expect((await post('/portfolio/mineunited.com/renewal-price', read, body)).statusCode).toBe(403);
  });
});
