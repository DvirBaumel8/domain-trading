// v5.58.0 (CR-079): the daily missing-name check (step ownershipCheck, /report warnings LISTING_RECORD_MISSING, LISTING_UNAPPROVED, OBSERVED_UNCONFIRMED, RECEIPT_POINTER_MISSING,
// plus the pinned DOMAIN_LEFT_ACCOUNT / REGISTRY_MISMATCH) and the receipt pointer on GET /portfolio and GET /books.csv. IDs CR079-AT1..CR079-AT7.
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

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-26T09:00:00Z');
type H = Record<string, string>;
type W = { code: string; level: string; domain?: string; details: Record<string, any> };

async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  return { read: (await issueToken('read', 'reader')).auth as H, write: (await issueToken('write', 'gavriel')).auth as H, bots: (await issueToken('bots', 'bots-shared')).auth as H };
}
const call = (method: 'GET' | 'POST', url: string, h: H, payload?: unknown) =>
  app.inject({ method, url, headers: { ...h, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const warnings = async (h: H, code?: string): Promise<W[]> => {
  const r = await call('GET', '/report', h);
  expect(r.statusCode, r.body).toBe(200);
  const all = r.json().warnings as W[];
  return code ? all.filter((w) => w.code === code) : all;
};
const reg = (domainId: number, receipt: string | null, deal: string | null = null) =>
  db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: domainId, type: 'registration', amount_cents: -1108, receipt_ref: receipt, deal_id: deal }).execute();
const rawVenue = (domain: string, venue: 'afternic' | 'sedo', evidenceSource: string | null) => sql`
  insert into venue_listings (domain, venue, listed_at, mode, price_cents, evidence, provenance)
  values (${domain}, ${venue}, '2026-10-20T09:00:00Z', 'bin', 148800, ${evidenceSource ? JSON.stringify({ source: evidenceSource, ref: 'x' }) : null}::jsonb, 'ours_confirmed')`.execute(db);
// the tagging part of the migration (the ALTER TABLE ADD COLUMN part is already applied by the test database)
const MIGRATION = readFileSync('migrations/1767800000000_v5-58-0.sql', 'utf8').split('-- Down Migration')[0]!;
const TAG = MIGRATION.slice(MIGRATION.indexOf('ALTER TABLE public.venue_listings DISABLE TRIGGER'));
const tagSeeds = async () => { for (const stmt of TAG.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await sql.raw(stmt).execute(db); };

describe('CR-079 daily missing-name check', () => {
  it('CR079-AT1 a live name absent from the registrar account and not sold: DOMAIN_LEFT_ACCOUNT in /report and in the portfolioCheck step summary (alerts_n, by_code)', async () => {
    const { read } = await setup();
    const id = await listedDomain({ domain: 'gonename.com', registrar: 'godaddy', registrar_api: 'none' });
    await reg(id, 'godaddy:none');
    await db.insertInto('registrar_presence').values({ domain_id: id, status: 'absent', first_absent_at: new Date(NOW - 86_400_000), last_checked_at: new Date(NOW) }).execute();
    const w = await warnings(read, 'DOMAIN_LEFT_ACCOUNT');
    expect(w.map((x) => x.domain)).toEqual(['gonename.com']);
    const sum = await (app as unknown as { portfolioCheckJob: { runOnce(): Promise<{ alerts_n: number; by_code: Record<string, number> }> } }).portfolioCheckJob.runOnce();
    expect(sum.by_code.DOMAIN_LEFT_ACCOUNT).toBe(1);
    expect(sum.alerts_n).toBeGreaterThanOrEqual(1);
  });

  it('CR079-AT2 registry clientHold or redemptionPeriod: REGISTRY_MISMATCH carries the status in differences', async () => {
    const { read } = await setup();
    const a = await listedDomain({ domain: 'holdname.com' });
    const b = await listedDomain({ domain: 'redeemname.com' });
    await db.insertInto('portfolio_checks').values([
      { domain_id: a, kind: 'registry', status: 'fail', details: JSON.stringify({ differences: [{ field: 'status', registry: 'clientHold' }] }) },
      { domain_id: b, kind: 'registry', status: 'fail', details: JSON.stringify({ differences: [{ field: 'status', registry: 'redemptionPeriod' }] }) },
    ]).execute();
    const w = await warnings(read, 'REGISTRY_MISMATCH');
    expect(w.map((x) => [x.domain, x.level, x.details.differences[0].registry])).toEqual([['holdname.com', 'warn', 'clientHold'], ['redeemname.com', 'warn', 'redemptionPeriod']]);
  });

  it('CR079-AT3 status listed with no ours_confirmed venue: LISTING_RECORD_MISSING; it clears once an ours_confirmed Afternic venue is recorded', async () => {
    const { read, write } = await setup();
    const id = await listedDomain({ domain: 'norecord.com' });
    await reg(id, 'porkbun:1');
    const w = await warnings(read, 'LISTING_RECORD_MISSING');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'warn', domain: 'norecord.com', details: { domain: 'norecord.com', status: 'listed', listed_venues: [] } });
    const v = await call('POST', '/listings/norecord.com/venue', write, { venue: 'afternic', listed_at: '2026-10-26T10:00:00+02:00', shown: { mode: 'bin', price_usd: 1488 } });
    expect(v.statusCode, v.body).toBe(201);
    expect(await warnings(read, 'LISTING_RECORD_MISSING')).toHaveLength(0);
    expect(await warnings(read, 'LISTING_UNAPPROVED')).toHaveLength(0); // an audited venue record is its own approval trail
  });

  it('CR079-AT4 an ours_confirmed Sedo record with no sale, no approval trail and no seed tag: LISTING_UNAPPROVED (warn) for sedo; a tagged CR-076 seed is grandfathered; a record with an audit row, a listing approval or a confirmed upload is not flagged', async () => {
    const { read } = await setup();
    const a = await listedDomain({ domain: 'unapproved.com' });
    const s = await listedDomain({ domain: 'seeded.com' });
    const h = await listedDomain({ domain: 'approved.com' });
    for (const [id] of [[a], [s], [h]] as const) await reg(id, 'porkbun:1');
    await rawVenue('unapproved.com', 'sedo', null);
    await rawVenue('seeded.com', 'afternic', 'CR-076 R-4 seed');
    await rawVenue('approved.com', 'afternic', null);
    await db.insertInto('listing_history').values({ domain_id: h, source: 'list', category: 'trend', mode: 'hybrid', bin_cents: 148800, approval_text: 'Dvir: list approved.com', approval_at: new Date(NOW - 3_600_000) } as never).execute();
    // before the tag the seed row looks like any untracked record
    expect((await warnings(read, 'LISTING_UNAPPROVED')).map((x) => x.domain)).toEqual(['seeded.com', 'unapproved.com']);
    await tagSeeds();
    const w = await warnings(read, 'LISTING_UNAPPROVED');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'warn', domain: 'unapproved.com', details: { domain: 'unapproved.com', venue: 'sedo' } });
    expect(await db.selectFrom('venue_listings').select('approval_source').where('domain', '=', 'seeded.com').executeTakeFirstOrThrow()).toEqual({ approval_source: 'seed_cr076' });
    expect(await db.selectFrom('venue_listings').select('approval_source').where('domain', '=', 'unapproved.com').executeTakeFirstOrThrow()).toEqual({ approval_source: null });
    // an export file that was generated but never confirmed (no upload row) is not a trail
    await db.insertInto('export_runs').values({ marketplace: 'sedo', domains: ['unapproved.com'], export_id: 'exp-1' }).execute();
    expect((await warnings(read, 'LISTING_UNAPPROVED')).map((x) => x.domain)).toEqual(['unapproved.com']);
    // a confirmed upload of Afternic does not cover a Sedo record
    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: ['unapproved.com'], export_id: 'exp-2' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'exp-2', domains: ['unapproved.com'], uploaded_at: new Date(NOW) }).execute();
    expect((await warnings(read, 'LISTING_UNAPPROVED')).map((x) => x.domain)).toEqual(['unapproved.com']);
    // a confirmed Sedo upload that contained the name clears it
    await db.insertInto('export_uploads').values({ venue: 'sedo', export_id: 'exp-1', domains: ['unapproved.com'], uploaded_at: new Date(NOW) }).execute();
    expect(await warnings(read, 'LISTING_UNAPPROVED')).toHaveLength(0);
  });

  it('CR079-AT5 (negative) POST /listings/{domain}/observed for Afternic: 201, listed_venues unchanged, OBSERVED_UNCONFIRMED (info) at most, never LISTING_UNAPPROVED; the plan and export state are unchanged', async () => {
    const { read, bots } = await setup();
    const id = await listedDomain({ domain: 'sighted.com' });
    await reg(id, 'porkbun:1');
    const before = await db.selectFrom('domains').selectAll().where('domain', '=', 'sighted.com').executeTakeFirstOrThrow();
    const res = await call('POST', '/listings/sighted.com/observed', bots, { venue: 'afternic', price_usd: '1488', url: 'https://www.afternic.com/domain/sighted.com', seen_at: '2026-10-26T10:00:00+02:00' });
    expect(res.statusCode, res.body).toBe(201);
    const p = (await call('GET', '/portfolio', read)).json().domains as { domain: string; listed_venues: string[]; observed_venues: string[] }[];
    expect(p.find((x) => x.domain === 'sighted.com')).toMatchObject({ listed_venues: [], observed_venues: ['afternic'] });
    const o = await warnings(read, 'OBSERVED_UNCONFIRMED');
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ level: 'info', domain: 'sighted.com', details: { domain: 'sighted.com', venue: 'afternic' } });
    expect(await warnings(read, 'LISTING_UNAPPROVED')).toHaveLength(0);
    expect(await db.selectFrom('domains').selectAll().where('domain', '=', 'sighted.com').executeTakeFirstOrThrow()).toEqual(before);
  });

  it('CR079-AT6 a live name with a blank or absent registration receipt_ref: RECEIPT_POINTER_MISSING; porkbun:1 and the placeholder godaddy:none do not raise it', async () => {
    const { read } = await setup();
    const blank = await listedDomain({ domain: 'blankref.com' });
    const none = await listedDomain({ domain: 'norow.com' });
    const ok = await listedDomain({ domain: 'okref.com' });
    const gd = await listedDomain({ domain: 'importedref.com' });
    await reg(blank, '  ');
    await reg(ok, 'porkbun:1');
    await reg(gd, 'godaddy:none');
    void none;
    const w = await warnings(read, 'RECEIPT_POINTER_MISSING');
    expect(w.map((x) => x.domain)).toEqual(['blankref.com', 'norow.com']);
    expect(w[0]).toMatchObject({ level: 'warn', details: { domain: 'blankref.com' } });
    await db.updateTable('ledger_entries').set({ receipt_ref: null }).where('domain_id', '=', ok).execute().catch(() => undefined); // append-only: refused, so the name stays clean
    expect((await warnings(read, 'RECEIPT_POINTER_MISSING')).map((x) => x.domain)).toEqual(['blankref.com', 'norow.com']);
  });

  it('CR079-AT7 GET /portfolio and GET /books.csv carry receipt_ref and deal_id per live name equal to the registration ledger row; the old books.csv columns keep their positions', async () => {
    const { read } = await setup();
    const a = await listedDomain({ domain: 'withref.com' });
    const b = await listedDomain({ domain: 'withoutdeal.com' });
    await db.insertInto('deals').values({ id: 'D-007', domain: 'withref.com', strategy: 'test' } as never).execute();
    await reg(a, 'porkbun:12047825', 'D-007');
    await reg(b, 'godaddy:none');
    const p = (await call('GET', '/portfolio', read)).json().domains as { domain: string; receipt_ref: string | null; deal_id: string | null }[];
    expect(p.find((x) => x.domain === 'withref.com')).toMatchObject({ receipt_ref: 'porkbun:12047825', deal_id: 'D-007' });
    expect(p.find((x) => x.domain === 'withoutdeal.com')).toMatchObject({ receipt_ref: 'godaddy:none', deal_id: null });
    const lines = (await call('GET', '/books.csv', read)).body.trimEnd().split('\r\n');
    const head = lines[0]!.split(',');
    expect(head.slice(-4)).toEqual(['listed_venues', 'observed_venues', 'receipt_ref', 'deal_id']);
    expect(head.slice(0, 5)).toEqual(['domain', 'display_name', 'line', 'category', 'status']);
    const row = lines.slice(1).map((l) => l.split(',')).find((c) => c[0] === 'withref.com')!;
    expect(row[head.indexOf('receipt_ref')]).toBe('porkbun:12047825');
    expect(row[head.indexOf('deal_id')]).toBe('D-007');
    const row2 = lines.slice(1).map((l) => l.split(',')).find((c) => c[0] === 'withoutdeal.com')!;
    expect(row2[head.indexOf('receipt_ref')]).toBe('godaddy:none');
    expect(row2[head.indexOf('deal_id')]).toBe('');
  });
});
