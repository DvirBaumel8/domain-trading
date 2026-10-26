// v5.27.0 (CR-076): venue_listings provenance, POST /listings/{domain}/observed, POST /portfolio/{domain}/display-name, the seed in migrations/1765900000000_v5-27-0.sql. IDs PV527-1..PV527-8.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { issueToken } from '../../helpers/tokens.js';
import { pendingDomains } from '../../../src/modules/listing/export-state.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
let clock = Date.parse('2026-10-21T09:00:00Z');

// the seed part of the migration (the ALTER TABLE part is already applied by the test database)
const MIGRATION = readFileSync('migrations/1765900000000_v5-27-0.sql', 'utf8').split('-- Down Migration')[0]!;
const SEED = MIGRATION.slice(MIGRATION.indexOf('INSERT INTO public.venue_listings'));
const applySeed = () => sql.raw(SEED).execute(db);

type H = Record<string, string>;
const call = (method: 'GET' | 'POST', url: string, h: H, payload?: unknown) => {
  clock += 10_000;
  return app.inject({ method, url, headers: { ...h, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
};
async function setup() {
  clock = Date.parse('2026-10-21T09:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock });
  return { bots: (await issueToken('bots', 'bots-shared')).auth, write: (await issueToken('write', 'gavriel')).auth, read: (await issueToken('read', 'reader')).auth };
}
const NAMES = ['promptinjectionaudit.com', 'ukcbamcompliance.com', 'aievalsconsulting.com', 'roofingvoiceagent.com'];
const seedPortfolio = async () => {
  for (const domain of NAMES) await listedDomain({ domain, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71500, min_offer_cents: 10000 });
  await listedDomain({ domain: 'mineunited.com', display_name: null, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71500, min_offer_cents: 10000, lane: 'S8' });
};
const books = async (h: H) => {
  const lines = (await call('GET', '/books.csv', h)).body.trimEnd().split('\r\n');
  const head = lines[0]!.split(',');
  return { head, row: (domain: string) => { const c = lines.slice(1).map((l) => l.split(',')).find((x) => x[0] === domain)!; return (k: string) => c[head.indexOf(k)]!; } };
};
const venueRows = (domain: string) => db.selectFrom('venue_listings').selectAll().where('domain', '=', domain).orderBy('id').execute();

describe('CR-076 listing provenance', () => {
  it('PV527-1 (AT-1) after the seed books.csv listed_venues = afternic for the four Line 1 names and empty for mineunited.com; observed_venues is the third last column (receipt_ref, deal_id follow since 5.58.0) and shows afternic for mineunited.com', async () => {
    const { read } = await setup();
    await seedPortfolio();
    await applySeed();
    const b = await books(read);
    expect(b.head[b.head.length - 3]).toBe('observed_venues'); // v5.58.0 (CR-079): receipt_ref and deal_id are appended after it
    for (const d of NAMES) { expect(b.row(d)('listed_venues'), d).toBe('afternic'); expect(b.row(d)('observed_venues'), d).toBe(''); }
    expect(b.row('mineunited.com')('listed_venues')).toBe('');
    expect(b.row('mineunited.com')('observed_venues')).toBe('afternic');
    const p = (await call('GET', '/portfolio', read)).json().domains as { domain: string; listed_venues: string[]; observed_venues: string[] }[];
    expect(p.find((x) => x.domain === 'promptinjectionaudit.com')).toMatchObject({ listed_venues: ['afternic'], observed_venues: [] });
    expect(p.find((x) => x.domain === 'mineunited.com')).toMatchObject({ listed_venues: [], observed_venues: ['afternic'] });
    const [m] = await venueRows('mineunited.com');
    expect(m).toMatchObject({ provenance: 'observed_public', seen_price_cents: 148800, seen_url: 'https://www.afternic.com/domain/mineunited.com' });
    expect(m!.seen_at!.toISOString()).toBe('2026-10-20T12:00:00.000Z');
  });

  it('PV527-2 (AT-2) a bot logs observed_public Afternic $1,488: 201; listed_venues stays empty, observed_venues = afternic; the listing, export state, plan and listing_history are unchanged; dry_run stores nothing', async () => {
    const { bots, read } = await setup();
    await seedPortfolio();
    const before = await db.selectFrom('domains').selectAll().where('domain', '=', 'mineunited.com').executeTakeFirstOrThrow();
    const histN = (await db.selectFrom('listing_history').select('id').execute()).length;
    const pendingBefore = await pendingDomains(db, 'afternic');
    const body = { venue: 'afternic', price_usd: '1488', url: 'https://www.afternic.com/domain/mineunited.com', seen_at: '2026-10-20T15:00:00+03:00' };
    const dry = await call('POST', '/listings/mineunited.com/observed', bots, { ...body, dry_run: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(await venueRows('mineunited.com')).toHaveLength(0);
    const res = await call('POST', '/listings/mineunited.com/observed', bots, body);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ domain: 'mineunited.com', venue: 'afternic', provenance: 'observed_public', seen_price_cents: 148800, seen_price: '$1,488.00' });
    const rows = await venueRows('mineunited.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provenance: 'observed_public', delisted: false, price_cents: null });
    const b = await books(read);
    expect(b.row('mineunited.com')('listed_venues')).toBe('');
    expect(b.row('mineunited.com')('observed_venues')).toBe('afternic');
    expect(await db.selectFrom('domains').selectAll().where('domain', '=', 'mineunited.com').executeTakeFirstOrThrow()).toEqual(before);
    expect((await db.selectFrom('listing_history').select('id').execute()).length).toBe(histN);
    expect(await pendingDomains(db, 'afternic')).toEqual(pendingBefore);
    const ex = (await call('GET', '/portfolio/mineunited.com', read)).json().export.afternic;
    expect(ex).toMatchObject({ listed_by_hand_at: null, shown: null });
    expect((await call('POST', '/listings/nosuch.com/observed', bots, body)).statusCode).toBe(404);
    expect((await call('POST', '/listings/mineunited.com/observed', bots, { ...body, price_usd: '14.8.8' })).statusCode).toBe(422);
  });

  it('PV527-3 (AT-3) the observed route with a provenance key (ours_confirmed or any) is 422 VALIDATION_ERROR and nothing is stored', async () => {
    const { bots, write } = await setup();
    await seedPortfolio();
    const body = { venue: 'afternic', price_usd: '1488', url: 'https://www.afternic.com/domain/mineunited.com', seen_at: '2026-10-20T15:00:00+03:00' };
    for (const h of [bots, write]) for (const provenance of ['ours_confirmed', 'observed_public']) {
      const r = await call('POST', '/listings/mineunited.com/observed', h, { ...body, provenance });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(await venueRows('mineunited.com')).toHaveLength(0);
  });

  it('PV527-4 (AT-4) a bots token cannot set ours_confirmed on the venue route (403 SCOPE_FORBIDDEN, nothing stored); WRITE can, default ours_confirmed counts in listed_venues, "unknown" does not', async () => {
    const { bots, write, read } = await setup();
    await seedPortfolio();
    const v = { venue: 'afternic', listed_at: '2026-10-20T10:00:00+03:00', shown: { mode: 'bin', price_usd: 1488, min_offer_usd: null } };
    const denied = await call('POST', '/listings/mineunited.com/venue', bots, { ...v, provenance: 'ours_confirmed' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('SCOPE_FORBIDDEN');
    expect((await call('POST', '/listings/mineunited.com/venue', bots, v)).statusCode).toBe(403);
    expect(await venueRows('mineunited.com')).toHaveLength(0);
    const unknown = await call('POST', '/listings/mineunited.com/venue', write, { ...v, provenance: 'unknown' });
    expect(unknown.statusCode, unknown.body).toBe(201);
    expect(unknown.json().provenance).toBe('unknown');
    expect((await books(read)).row('mineunited.com')('listed_venues')).toBe('');
    const ours = await call('POST', '/listings/mineunited.com/venue', write, v);
    expect(ours.statusCode, ours.body).toBe(201);
    expect(ours.json().provenance).toBe('ours_confirmed');
    expect((await books(read)).row('mineunited.com')('listed_venues')).toBe('afternic');
    const rej = await call('POST', '/listings/mineunited.com/venue', write, { ...v, provenance: 'observed_public' });
    expect(rej.statusCode).toBe(422);
  });

  it('PV527-5 (AT-5) display_name MineUnited.com: 200 and in books.csv, a listed name is flagged for the next export; Mine-United.com is 422 DISPLAY_NAME_MISMATCH; unknown domain 404; the same name again changes nothing', async () => {
    const { bots, read } = await setup();
    await seedPortfolio();
    await db.updateTable('domains').set({ export_pending_since: null, listing_changed_at: null }).where('domain', '=', 'mineunited.com').execute();
    const bad = await call('POST', '/portfolio/mineunited.com/display-name', bots, { display_name: 'Mine-United.com' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('DISPLAY_NAME_MISMATCH');
    expect((await call('POST', '/portfolio/mineunited.com/display-name', bots, { display_name: 'MineUnited.org' })).json().error.code).toBe('DISPLAY_NAME_MISMATCH');
    expect((await books(read)).row('mineunited.com')('display_name')).toBe('');
    const ok = await call('POST', '/portfolio/mineunited.com/display-name', bots, { display_name: 'MineUnited.com' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ domain: 'mineunited.com', display_name: 'MineUnited.com', changed: true, export_pending: true });
    expect((await books(read)).row('mineunited.com')('display_name')).toBe('MineUnited.com');
    expect(await pendingDomains(db, 'afternic')).toContain('mineunited.com');
    await db.updateTable('domains').set({ export_pending_since: null }).where('domain', '=', 'mineunited.com').execute();
    const again = await call('POST', '/portfolio/mineunited.com/display-name', bots, { display_name: 'MineUnited.com' });
    expect(again.json()).toMatchObject({ changed: false, export_pending: false });
    expect((await db.selectFrom('domains').select('export_pending_since').where('domain', '=', 'mineunited.com').executeTakeFirstOrThrow()).export_pending_since).toBeNull();
    expect((await call('POST', '/portfolio/nosuch.com/display-name', bots, { display_name: 'NoSuch.com' })).statusCode).toBe(404);
    expect((await call('POST', '/portfolio/mineunited.com/display-name', bots, { display_name: 'MineUnited.com', x: 1 })).statusCode).toBe(422);
  });

  it('PV527-6 the seed is a no-op when the domains do not exist, and a second run appends nothing more', async () => {
    await setup();
    await applySeed();
    expect(await db.selectFrom('venue_listings').select('id').execute()).toHaveLength(0);
    await seedPortfolio();
    await applySeed();
    expect(await db.selectFrom('venue_listings').select('id').execute()).toHaveLength(5);
    await applySeed();
    expect(await db.selectFrom('venue_listings').select('id').execute()).toHaveLength(5);
  });

  it('PV527-7 old rows (no provenance given) read `unknown`, never count in listed_venues, and the table stays append-only; a later delisting stops the seed from re-listing', async () => {
    const { read } = await setup();
    await seedPortfolio();
    await db.insertInto('venue_listings').values({ domain: 'promptinjectionaudit.com', venue: 'sedo', listed_at: new Date('2026-10-09T00:00:00Z'), mode: 'make_offer', price_cents: null, min_offer_cents: 10000, evidence: null, note: null, token_name: null, audit_id: null }).execute();
    const [old] = await venueRows('promptinjectionaudit.com');
    expect(old!.provenance).toBe('unknown');
    expect((await books(read)).row('promptinjectionaudit.com')('listed_venues')).toBe('');
    await expect(sql`update venue_listings set provenance = 'ours_confirmed'`.execute(db)).rejects.toThrow(/append-only/);
    await applySeed();
    await db.insertInto('venue_listings').values({ domain: 'promptinjectionaudit.com', venue: 'afternic', listed_at: new Date('2026-10-22T00:00:00Z'), delisted: true, mode: 'delisted', price_cents: null, min_offer_cents: null, evidence: null, note: null, token_name: null, audit_id: null, provenance: 'ours_confirmed' }).execute();
    await applySeed();
    expect((await venueRows('promptinjectionaudit.com')).filter((r) => r.venue === 'afternic')).toHaveLength(2);
    expect((await books(read)).row('promptinjectionaudit.com')('listed_venues')).toBe('');
  });

  it('PV527-8 a sighting does not show as a hand listing in the export block', async () => {
    const { bots, read } = await setup();
    await seedPortfolio();
    await call('POST', '/listings/mineunited.com/observed', bots, { venue: 'afternic', price_usd: '1488.00', url: 'https://www.afternic.com/domain/mineunited.com', seen_at: '2026-10-20T15:00:00+03:00' });
    const ex = (await call('GET', '/portfolio/mineunited.com', read)).json().export;
    expect(ex.afternic.shown).toBeNull();
    expect(ex.afternic.delisted_by_hand_at).toBeNull();
  });
});
