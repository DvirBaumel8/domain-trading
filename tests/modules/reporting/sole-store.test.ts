// v5.63.0 (CR-084): DOM is the sole durable store. IDs CR084-AT1..CR084-AT5 (AT6 = DEC-1, AT7 = XC-1 in their own files).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BOTS_ROUTES } from '../../../src/http/auth.js';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
let clock = Date.parse('2026-10-27T09:00:00Z');
const ROOT = join(import.meta.dirname, '..', '..', '..');

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, h: H, payload?: unknown) => {
  clock += 10_000; // stay under the general write limit
  return app.inject({ method, url, headers: { ...h, ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
};
async function setup() {
  clock = Date.parse('2026-10-27T09:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock });
  return { bots: (await issueToken('bots', 'bots-shared')).auth, write: (await issueToken('write', 'gavriel')).auth, read: (await issueToken('read', 'reader')).auth };
}
const names = [
  { domain: 'alpha.com', category: 'other', lane: 'S8', status: 'listed', listing_mode: 'hybrid', bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71500, min_offer_cents: 10000 },
  { domain: 'beta.com', category: 'other', status: 'listed', listing_mode: 'hybrid', bin_cents: 90000, floor_cents: 58500, walkaway_cents: 50000, min_offer_cents: 10000 },
  { domain: 'gamma.com', category: 'other', status: 'owned' },
] as const;

describe('CR-084 sole durable store', () => {
  it('CR084-AT1 books = portfolio: for every owned name, /books.csv and /portfolio/{d} carry the same BIN, floor, walk-away and min offer cents (also a name with no plan)', async () => {
    const { read } = await setup();
    for (const n of names) await insertOwnedDomain(db, n as never);
    const csv = (await call('GET', '/books.csv', read)).body.trimEnd().split('\r\n');
    const head = csv[0]!.split(',');
    const rows = csv.slice(1).map((l) => l.split(','));
    expect(rows.map((r) => r[0])).toEqual(['alpha.com', 'beta.com', 'gamma.com']);
    const list = (await call('GET', '/portfolio', read)).json().domains as Record<string, unknown>[];
    const usd = (cents: unknown) => (cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2));
    for (const r of rows) {
      const d = (await call('GET', `/portfolio/${r[0]}`, read)).json();
      for (const k of ['bin', 'floor', 'walkaway', 'min_offer']) {
        expect(r[head.indexOf(`${k}_usd`)], `${r[0]} ${k}`).toBe(usd(d[`${k}_cents`]));
        expect(d[`${k}_cents`] ?? null, `${r[0]} ${k} (list)`).toBe(list.find((x) => x.domain === r[0])![`${k}_cents`] ?? null);
      }
    }
    expect(rows[1]![head.indexOf('walkaway_usd')]).toBe('500.00');
  });

  it('CR084-AT2 the write path is named: sources-of-truth.md is linked from the contract README, lists every durable fact with its read endpoints and says box CSVs are not a source of truth', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'contract', 'sources-of-truth.md'), 'utf8');
    const readme = readFileSync(join(ROOT, 'docs', 'contract', 'README.md'), 'utf8');
    expect(readme).toContain('sources-of-truth.md');
    for (const must of ['`GET /portfolio`', '`GET /portfolio/{domain}`', '`GET /books.csv`', '`GET /ledger`', '`GET /decisions`', '`GET /kb/*`', '`GET /market/episodes`', 'Company-box files are not a source of truth', 'afternic_listings_daily', 'walk-away']) {
      expect(doc, must).toContain(must);
    }
    for (const route of ['/portfolio', '/portfolio/{domain}', '/books.csv', '/ledger', '/decisions', '/market/episodes']) expect(doc).toContain(route);
  });

  it('CR084-AT3 negative: no route reads or writes a company-box file, and every bots POST that can move a price (buy, list, venue, import, horizon) stays a money route', async () => {
    await setup();
    const table = (app as unknown as { routeTable: { method: string; url: string }[] }).routeTable;
    expect(table.filter((r) => /box|company-box|ledger\/portfolio|mirror/i.test(r.url) && !r.url.startsWith('/company/'))).toEqual([]);
    for (const key of ['POST /buy', 'POST /list/{domain}', 'POST /listings/{domain}/venue', 'POST /portfolio/import', 'POST /portfolio/{domain}/horizon']) expect(BOTS_ROUTES[key], key).toBe('money');
  });

  it('CR084-AT4 export is labelled: /books.csv is GET-only (a posted file changes nothing: 404/405) and the docs call it an export of DOM data, not a write path', async () => {
    const { write, read } = await setup();
    await insertOwnedDomain(db, names[0] as never);
    const before = await db.selectFrom('domains').selectAll().execute();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await call(m, '/books.csv', write, { csv: 'domain,bin_usd\nalpha.com,1.00' });
      expect([404, 405], m).toContain(r.statusCode);
    }
    expect((await call('GET', '/books.csv', read)).statusCode).toBe(200);
    expect(await db.selectFrom('domains').selectAll().execute()).toEqual(before);
    expect(readFileSync(join(ROOT, 'docs', 'contract', 'sources-of-truth.md'), 'utf8')).toMatch(/exports of DOM data[\s\S]*not a write path/);
  });

  it('CR084-AT5 negative: approval gates are unchanged: a bots token cannot really list or buy, and a WRITE /list on a price change without an approval_ref is still refused', async () => {
    const { bots, write } = await setup();
    await insertOwnedDomain(db, { domain: 'alpha.com', category: 'other', status: 'owned' });
    expect((await call('POST', '/list/alpha.com', bots, { mode: 'bin', bin: 1488 })).statusCode).toBe(403);
    expect((await call('POST', '/buy', bots, { domain: 'alpha.com', max_price: 10 })).statusCode).toBe(403);
    const noApproval = await call('POST', '/list/alpha.com', write, { mode: 'bin', bin: 1488 });
    expect(noApproval.statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.selectFrom('domains').select('bin_cents').where('domain', '=', 'alpha.com').executeTakeFirstOrThrow()).bin_cents).toBeNull();
  });
});
