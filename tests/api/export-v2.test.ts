import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PriceScheduleJob } from '../../src/jobs/price-schedule.js';
import { makeApp } from '../helpers/app.js';
import { parseCsvStrict } from '../helpers/csv.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

const NOW = Date.parse('2026-10-12T09:00:00Z');
const HOUR = 3_600_000;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function sedoTemplate(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'sedo-')), 'sedo_template.json');
  writeFileSync(path, JSON.stringify({
    headers: ['Domain Name', 'Option', 'Sale', 'Price', 'Min', 'Cur', 'Action'],
    map: { domain: 'Domain Name', selling_option: 'Option', for_sale: 'Sale', price: 'Price', min_price: 'Min', currency: 'Cur', action: 'Action' },
    values: { buy_now: 'FIXED', make_offer: 'OFFER', for_sale_yes: 'yes', usd: 'USD', action_add: 'ADD' },
  }));
  return path;
}
const TEMPLATE = sedoTemplate();

async function appAt(now: number): Promise<FastifyInstance> {
  const a = await makeApp({ now: () => now, adapters: [new FakeAdapter('porkbun')], env: { SEDO_TEMPLATE_PATH: TEMPLATE } });
  apps.push(a);
  return a;
}

const post = (app: FastifyInstance, url: string, auth: Record<string, string>, payload: object, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': key }, payload });
const get = (app: FastifyInstance, venue: 'afternic' | 'sedo', auth: Record<string, string>, q = '') =>
  app.inject({ method: 'GET', url: `/export/${venue}.csv${q}`, headers: auth });

/** A real /list call at the app's clock, so plan, schedule and change columns are real. */
async function listVia(app: FastifyInstance, auth: Record<string, string>, clock: number, domain: string, over: Record<string, unknown> = {}, dom0: Record<string, unknown> = {}) {
  const existing = await db.selectFrom('domains').select('id').where('domain', '=', domain).executeTakeFirst();
  if (!existing) await insertOwnedDomain(db, { domain, category: 'trend', price_grade: null, ...dom0 });
  const res = await post(app, `/list/${domain}`, auth, {
    mode: 'hybrid', bin: 1995, approval_ref: { text: `yes list ${domain}`, approved_at: new Date(clock - HOUR).toISOString() }, ...over,
  });
  expect(res.statusCode, res.body).toBe(200);
}
const confirmBody = (exportId: string, clock: number, text = 'Dvir uploaded the file') =>
  ({ export_id: exportId, approval_ref: { text, approved_at: new Date(clock - 30_000).toISOString() } });
const row = (domain: string) => db.selectFrom('domains').selectAll().where('domain', '=', domain).executeTakeFirstOrThrow();
const count = async (table: 'domains' | 'listing_history' | 'export_uploads' | 'audit_log' | 'export_runs') =>
  Number((await db.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

describe('exports v2', () => {
  it('E-2 (v2 rules): 3 rows as LX-1/LX-4/LX-2; a sold domain from a confirmed upload is in X-Manual-Delist', async () => {
    const app = await appAt(NOW);
    const { auth } = await issueToken('write');
    const base = { first_listed_at: new Date('2026-10-12T09:00:00Z') };
    await insertOwnedDomain(db, { domain: 'austinroofrepair.com', display_name: 'AustinRoofRepair.com', status: 'listed', category: 'geo', price_grade: 'weaker', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, walkaway_cents: 39900, min_offer_cents: 39900, ...base });
    await insertOwnedDomain(db, { domain: 'trendname.com', status: 'listed', category: 'trend', price_grade: null, listing_mode: 'hybrid', bin_cents: 499500, floor_cents: 324500, walkaway_cents: 240000, min_offer_cents: 10000, lto_max_months: 24, ...base });
    await insertOwnedDomain(db, { domain: 'buzz.com', status: 'listed', category: 'buzzword', price_grade: null, listing_mode: 'offer', bin_cents: null, floor_cents: null, walkaway_cents: null, min_offer_cents: 50000, ...base });
    await insertOwnedDomain(db, { domain: 'gone.com', status: 'listed', category: 'trend', price_grade: null, listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, min_offer_cents: 10000, ...base });
    const first = await get(app, 'afternic', auth);
    expect(parseCsvStrict(first.body)).toHaveLength(5);
    expect((await post(app, '/export/afternic/uploaded', auth, confirmBody(first.headers['x-export-id'] as string, NOW))).statusCode).toBe(200);
    const later = await appAt(NOW + 24 * HOUR);
    await db.updateTable('domains').set({ status: 'sold', sold_at: new Date(NOW + 20 * HOUR), delisted_at: new Date(NOW + 20 * HOUR) }).where('domain', '=', 'gone.com').execute();
    const res = await get(later, 'afternic', auth);
    expect(parseCsvStrict(res.body).map((r) => r.join(','))).toEqual([
      'Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden',
      'AustinRoofRepair.com,399,399,399,N,,Buy It Now,Y,N,N,N',
      'buzz.com,0,,500,N,,Custom Lander,N,N,Y,N',
      'trendname.com,4995,3245,100,Y,24,Custom Lander,Y,Y,Y,N',
    ]);
    expect(res.headers['x-manual-delist']).toBe('gone.com');
  });

  it('PR-36 / E-10: changed_only after a scheduled drop; 1 row with the M6 values; confirming clears it', async () => {
    const a1 = await appAt(NOW);
    const { auth } = await issueToken('write');
    await listVia(a1, auth, NOW, 'alpharoof.com');
    const T2 = Date.parse('2026-11-11T09:00:00Z');
    const a2 = await appAt(T2);
    await listVia(a2, auth, T2, 'betaroof.com');
    await listVia(a2, auth, T2, 'gammaroof.com');
    const full = await get(a2, 'afternic', auth);
    expect(parseCsvStrict(full.body)).toHaveLength(4);
    expect((await post(a2, '/export/afternic/uploaded', auth, confirmBody(full.headers['x-export-id'] as string, T2))).statusCode).toBe(200);

    const LATER = Date.parse('2027-04-12T09:00:00Z');
    const r = await new PriceScheduleJob({ db, now: () => LATER }).runOnce({ today: '2027-04-12' });
    expect(r.applied.map((x) => x.domain)).toEqual(['alpharoof.com']);

    const a3 = await appAt(LATER + HOUR);
    const changed = await get(a3, 'afternic', auth, '?changed_only=true');
    expect(parseCsvStrict(changed.body).map((x) => x.join(','))).toEqual([
      expect.stringMatching(/^Domain,/),
      'alpharoof.com,1595,1035,100,N,,Custom Lander,Y,N,Y,N',
    ]);
    expect(changed.headers['x-pending-changes']).toBe('1');
    expect((await row('alpharoof.com')).export_pending_since).not.toBeNull();

    const ok = await post(a3, '/export/afternic/uploaded', auth, confirmBody(changed.headers['x-export-id'] as string, LATER + HOUR));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ venue: 'afternic', export_id: changed.headers['x-export-id'], domains: 1, pending_after: 0, still_pending: [] });
    expect((await get(a3, 'afternic', auth)).headers['x-pending-changes']).toBe('0');
    expect((await row('alpharoof.com')).export_pending_since).toBeNull();
  });

  it('R1: a /list price change after the file was generated stays pending after the confirmation', async () => {
    const a1 = await appAt(NOW);
    const { auth } = await issueToken('write');
    await listVia(a1, auth, NOW, 'alpharoof.com');
    const A = await get(a1, 'afternic', auth);
    const T2 = NOW + HOUR;
    const a2 = await appAt(T2);
    await listVia(a2, auth, T2, 'alpharoof.com', { bin: 2495 });
    const ok = await post(a2, '/export/afternic/uploaded', auth, confirmBody(A.headers['x-export-id'] as string, T2));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ pending_after: 1, still_pending: ['alpharoof.com'] });
    expect((await row('alpharoof.com')).export_pending_since).not.toBeNull();
    expect((await get(a2, 'afternic', auth)).headers['x-pending-changes']).toBe('1');
  });

  it('venue independence: a confirmed Afternic upload does not clear Sedo pending', async () => {
    const app = await appAt(NOW);
    const { auth } = await issueToken('write');
    await listVia(app, auth, NOW, 'alpharoof.com');
    const A = await get(app, 'afternic', auth);
    await post(app, '/export/afternic/uploaded', auth, confirmBody(A.headers['x-export-id'] as string, NOW));
    expect((await get(app, 'afternic', auth)).headers['x-pending-changes']).toBe('0');
    const s = await get(app, 'sedo', auth, '?changed_only=true');
    expect(s.statusCode).toBe(200);
    expect(s.headers['x-pending-changes']).toBe('1');
    expect(parseCsvStrict(s.body)).toHaveLength(2);
    expect((await row('alpharoof.com')).export_pending_since).toBeNull(); // Afternic confirmation cleared the shared flag only for Afternic's view
  });

  describe('E-11 POST /export/{venue}/uploaded', () => {
    async function withFile() {
      const app = await appAt(NOW);
      const { auth } = await issueToken('write');
      await listVia(app, auth, NOW, 'alpharoof.com');
      const A = await get(app, 'afternic', auth);
      return { app, auth, id: A.headers['x-export-id'] as string };
    }

    it('unknown export_id → 404 EXPORT_NOT_FOUND', async () => {
      const { app, auth } = await withFile();
      const res = await post(app, '/export/afternic/uploaded', auth, confirmBody('exp_nope', NOW));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('EXPORT_NOT_FOUND');
    });

    it('an Afternic id posted to /export/sedo/uploaded → 404 EXPORT_NOT_FOUND', async () => {
      const { app, auth, id } = await withFile();
      const res = await post(app, '/export/sedo/uploaded', auth, confirmBody(id, NOW));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('EXPORT_NOT_FOUND');
    });

    it('a READ token → 403', async () => {
      const { app, id } = await withFile();
      const { auth: read } = await issueToken('read');
      expect((await post(app, '/export/afternic/uploaded', read, confirmBody(id, NOW))).statusCode).toBe(403);
    });

    it('same key and body twice → replayed, one export_uploads row', async () => {
      const { app, auth, id } = await withFile();
      const key = randomUUID();
      const r1 = await post(app, '/export/afternic/uploaded', auth, confirmBody(id, NOW), key);
      const r2 = await post(app, '/export/afternic/uploaded', auth, confirmBody(id, NOW), key);
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
      expect(r2.headers['idempotent-replayed']).toBe('true');
      expect(r2.body).toBe(r1.body);
      expect(await count('export_uploads')).toBe(1);
    });

    it('a new key for an already-confirmed id → 409 EXPORT_ALREADY_CONFIRMED', async () => {
      const { app, auth, id } = await withFile();
      expect((await post(app, '/export/afternic/uploaded', auth, confirmBody(id, NOW))).statusCode).toBe(200);
      const res = await post(app, '/export/afternic/uploaded', auth, confirmBody(id, NOW));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EXPORT_ALREADY_CONFIRMED');
      expect(await count('export_uploads')).toBe(1);
    });

    it('an approval that predates the file by more than 60 s → 422 APPROVAL_INVALID; 30 s before is accepted', async () => {
      const { app, auth, id } = await withFile();
      const early = await post(app, '/export/afternic/uploaded', auth, { export_id: id, approval_ref: { text: 'ok', approved_at: new Date(NOW - 61_000).toISOString() } });
      expect(early.statusCode).toBe(422);
      expect(early.json().error).toMatchObject({ code: 'APPROVAL_INVALID', message: 'the upload approval predates the file' });
      expect(await count('export_uploads')).toBe(0);
      expect((await post(app, '/export/afternic/uploaded', auth, { export_id: id, approval_ref: { text: 'ok', approved_at: new Date(NOW - 30_000).toISOString() } })).statusCode).toBe(200);
    });

    it('no approval_ref → 200, approval_text null, uploaded_at now (or the one sent); a bad uploaded_at → 422; @ in note → NO_PII', async () => {
      const { app, auth, id } = await withFile();
      const bad: [object, string][] = [
        [{ export_id: id, uploaded_at: new Date(NOW + 2 * 60_000).toISOString() }, 'UPLOADED_AT_INVALID'],
        [{ export_id: id, uploaded_at: new Date(NOW - 3_600_000 * 24).toISOString() }, 'UPLOADED_AT_INVALID'],
        [{ export_id: id, uploaded_at: '2026-10-12 08:00' }, 'UPLOADED_AT_INVALID'],
        [{ export_id: id, note: 'by me@example.com' }, 'NO_PII'],
      ];
      for (const [payload, code] of bad) {
        const res = await post(app, '/export/afternic/uploaded', auth, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
        expect(res.json().error.code).toBe(code);
      }
      expect(await count('export_uploads')).toBe(0);
      const ok = await post(app, '/export/afternic/uploaded', auth, { export_id: id, note: 'uploaded by the bot' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().uploaded_at).toBe(new Date(NOW).toISOString());
      expect(await db.selectFrom('export_uploads').select(['approval_text', 'note']).executeTakeFirstOrThrow()).toEqual({ approval_text: null, note: 'uploaded by the bot' });
    });

    it('an uploaded_at sent without approval_ref is stored', async () => {
      const { app, auth, id } = await withFile();
      const at = new Date(NOW - 30_000).toISOString();
      const ok = await post(app, '/export/afternic/uploaded', auth, { export_id: id, uploaded_at: at });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().uploaded_at).toBe(at);
    });

    it('a clear hitting DOMAIN_BUSY → 503 and no export_uploads row; a retry with the same key after release → 200, one row', async () => {
      const app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')], env: { SEDO_TEMPLATE_PATH: TEMPLATE }, exportLockTimeoutMs: 150 });
      apps.push(app);
      const { auth } = await issueToken('write');
      await listVia(app, auth, NOW, 'alpharoof.com');
      const id = (await get(app, 'afternic', auth)).headers['x-export-id'] as string;
      const key = randomUUID();
      await db.connection().execute(async (conn) => {
        await sql`select pg_advisory_lock(hashtext('alpharoof.com'))`.execute(conn);
        try {
          const busy = await post(app, '/export/afternic/uploaded', auth, confirmBody(id, NOW), key);
          expect(busy.statusCode, busy.body).toBe(503);
          expect(busy.json().error.code).toBe('DOMAIN_BUSY');
          expect(await count('export_uploads')).toBe(0);
        } finally {
          await sql`select pg_advisory_unlock(hashtext('alpharoof.com'))`.execute(conn);
        }
      });
      const ok = await post(app, '/export/afternic/uploaded', auth, confirmBody(id, NOW), key);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await count('export_uploads')).toBe(1);
      expect((await row('alpharoof.com')).export_pending_since).toBeNull();
    });

    it('/export/dan/uploaded → 404 NOT_FOUND', async () => {
      const { app, auth, id } = await withFile();
      const res = await post(app, '/export/dan/uploaded', auth, confirmBody(id, NOW));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('a blank, stale, future or non-ISO approval_ref that is sent → 422', async () => {
      const { app, auth, id } = await withFile();
      const at = new Date(NOW - HOUR).toISOString();
      const cases: [object, string][] = [
        [{ export_id: id, approval_ref: { text: '   ', approved_at: at } }, 'APPROVAL_INVALID'],
        [{ export_id: id, approval_ref: { text: 'ok', approved_at: '2026-10-12 08:00' } }, 'APPROVAL_INVALID'],
        [{ export_id: id, approval_ref: { text: 'ok', approved_at: new Date(NOW + 2 * 60_000).toISOString() } }, 'APPROVAL_INVALID'],
        [{ export_id: id, approval_ref: { text: 'ok', approved_at: new Date(NOW - 73 * HOUR).toISOString() } }, 'APPROVAL_EXPIRED'],
      ];
      for (const [payload, code] of cases) {
        const res = await post(app, '/export/afternic/uploaded', auth, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(422);
        expect(res.json().error.code).toBe(code);
      }
      expect(await count('export_uploads')).toBe(0);
    });
  });

  it('E-12 / PR-27: a delisted domain is absent from both files and in X-Manual-Delist until a new upload is confirmed', async () => {
    const a1 = await appAt(NOW);
    const { auth } = await issueToken('write');
    await listVia(a1, auth, NOW, 'alpharoof.com');
    await listVia(a1, auth, NOW, 'betaroof.com');
    for (const v of ['afternic', 'sedo'] as const) {
      const f = await get(a1, v, auth);
      expect((await post(a1, `/export/${v}/uploaded`, auth, confirmBody(f.headers['x-export-id'] as string, NOW))).statusCode).toBe(200);
    }
    const dropDate = (await row('alpharoof.com')).drop_date!;
    const delistDay = new Date(Date.parse(`${dropDate}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    const DEL = Date.parse(`${delistDay}T09:00:00Z`);
    const r = await new PriceScheduleJob({ db, now: () => DEL }).runOnce({ today: delistDay });
    expect(r.delisted.sort()).toEqual(['alpharoof.com', 'betaroof.com']);
    const a2 = await appAt(DEL + 2 * HOUR);
    for (const v of ['afternic', 'sedo'] as const) {
      const res = await get(a2, v, auth);
      expect(parseCsvStrict(res.body)).toHaveLength(1);
      expect(res.headers['x-manual-delist']).toBe('alpharoof.com,betaroof.com');
    }
    const f = await get(a2, 'afternic', auth);
    expect((await post(a2, '/export/afternic/uploaded', auth, confirmBody(f.headers['x-export-id'] as string, DEL + 2 * HOUR))).statusCode).toBe(200);
    expect((await get(a2, 'afternic', auth)).headers['x-manual-delist']).toBe('');
    expect((await get(a2, 'sedo', auth)).headers['x-manual-delist']).toBe('alpharoof.com,betaroof.com'); // Sedo's upload is separate
  });

  it('E-7: default Sedo hybrid row is make-offer (price 1995, minimum 100); sedo_hybrid_as=buy_now gives a fixed price with no minimum', async () => {
    const app = await appAt(NOW);
    const { auth } = await issueToken('write');
    await listVia(app, auth, NOW, 'alpharoof.com');
    const header = 'Domain Name,Option,Sale,Price,Min,Cur,Action';
    expect(parseCsvStrict((await get(app, 'sedo', auth)).body).map((r) => r.join(','))).toEqual([header, 'alpharoof.com,OFFER,yes,1995,100,USD,ADD']);
    await db.updateTable('settings').set({ sedo_hybrid_as: 'buy_now' }).execute();
    expect(parseCsvStrict((await get(app, 'sedo', auth)).body).map((r) => r.join(','))).toEqual([header, 'alpharoof.com,FIXED,yes,1995,,USD,ADD']);
  });

  it('the walk-away (960) appears in no file and no header', async () => {
    const app = await appAt(NOW);
    const { auth } = await issueToken('write');
    await listVia(app, auth, NOW, 'alpharoof.com');
    expect((await row('alpharoof.com')).walkaway_cents).toBe(96000);
    for (const v of ['afternic', 'sedo'] as const) {
      const res = await get(app, v, auth);
      const { 'x-export-id': _id, ...headers } = res.headers; // the random id may contain any digits
      expect(res.body).not.toContain('960');
      expect(JSON.stringify(headers)).not.toContain('960');
    }
  });

  it('changed_only=maybe and unknown query parameters → 400 VALIDATION_ERROR', async () => {
    const app = await appAt(NOW);
    const { auth } = await issueToken('read');
    for (const v of ['afternic', 'sedo'] as const) {
      for (const q of ['?changed_only=maybe', '?foo=1', '?changed_only=true&foo=1']) {
        const res = await get(app, v, auth, q);
        expect(res.statusCode, `${v}${q}`).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      }
    }
    expect(await count('export_runs')).toBe(0);
  });

  it('a GET writes only the export_runs snapshot', async () => {
    const app = await appAt(NOW);
    const { auth } = await issueToken('write');
    await listVia(app, auth, NOW, 'alpharoof.com');
    const before = [await count('domains'), await count('listing_history'), await count('export_uploads'), await count('audit_log')];
    const runs = await count('export_runs');
    const dBefore = await row('alpharoof.com');
    for (const v of ['afternic', 'sedo'] as const) expect((await get(app, v, auth)).statusCode).toBe(200);
    expect([await count('domains'), await count('listing_history'), await count('export_uploads'), await count('audit_log')]).toEqual(before);
    expect(await count('export_runs')).toBe(runs + 2);
    expect(await row('alpharoof.com')).toEqual(dBefore);
  });

  it('the snapshot uses the app clock as export_runs.at', async () => {
    const app = await appAt(NOW);
    const { auth } = await issueToken('read');
    const res = await get(app, 'afternic', auth);
    const run = await db.selectFrom('export_runs').selectAll().where('export_id', '=', res.headers['x-export-id'] as string).executeTakeFirstOrThrow();
    expect(run.at.getTime()).toBe(NOW);
    expect(run.changed_only).toBe(false);
  });
});
