// Daily step referenceRefresh (CAP-02, CAP-11): popularity list, NameBio (disabled stub), IANA bootstrap, pruning. MSW only.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { POPULARITY_URL, latestPopularity } from '../../src/screening/popularity.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { issueToken } from '../helpers/tokens.js';
import { screeningHarness } from '../helpers/screening.js';
import { mswServer } from '../setup/network.js';

const csv = readFileSync(new URL('../fixtures/screening/majestic-million-top.csv', import.meta.url), 'utf8');
const DAY = 86_400_000;
let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const clock = { t: Date.parse('2026-10-06T08:00:00Z') };
const hits = { pop: 0, namebio: 0 };
function serve(body: () => string | null, status = 200): void {
  hits.pop = 0;
  hits.namebio = 0;
  mswServer.use(
    http.get(POPULARITY_URL, () => {
      hits.pop++;
      return new HttpResponse(body(), { status, headers: { 'content-type': 'text/csv', 'last-modified': new Date(clock.t).toUTCString() } });
    }),
    http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))),
    http.all(/namebio\.com/, () => { hits.namebio++; return new HttpResponse('blocked', { status: 403 }); }),
  );
}
async function daily(adapter?: FakeAdapter) {
  app = await makeApp({ now: () => clock.t, adapters: adapter ? [adapter] : [] });
  const r = await app.jobRunner.run('daily');
  await app.close();
  app = undefined;
  return r;
}

describe('referenceRefresh (daily step)', () => {
  it('stores the popularity list and the IANA bootstrap; NameBio is skipped (disabled); runs before backupExport; never calls a registrar to create', async () => {
    clock.t = Date.parse('2026-10-06T08:00:00Z');
    serve(() => csv);
    const adapter = new FakeAdapter('porkbun');
    const r = await daily(adapter);
    expect(Object.keys(r.steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume', 'priceJob', 'dropJob', 'registrarCheck', 'portfolioCheck', 'dropWatch', 'cohortOutcomes', 'referenceRefresh', 'backupExport']);
    expect(r.steps.referenceRefresh).toMatchObject({
      ok: true,
      summary: { popularity: { list_id: 'majestic-2026-10-06', list_date: '2026-10-06', rows: 1000, malformed_skipped: 0 }, namebio: { skipped: true, reason: 'SOURCE_DISABLED' }, iana: { refreshed: true }, pruned: 0, errors: [] },
    });
    const rows = await db.selectFrom('reference_files').select(['name', 'data_date', 'bytes']).orderBy('id').execute();
    expect(rows.map((x) => x.name).sort()).toEqual(['iana_rdap_dns', 'popularity_list']);
    const list = (await latestPopularity(db))!;
    expect(list).toMatchObject({ listId: 'majestic-2026-10-06', listDate: '2026-10-06' });
    expect(list.ranks.get('google')).toBe(1);
    expect(list.slds).toHaveLength(new Set(list.slds).size); // distinct SLDs
    expect(adapter.calls.filter((c) => /^(register|topup)/i.test(c))).toEqual([]);
  });

  it('one download per day: a second run inside 20 h is skipped; the next day an identical list adds a row without a second body (same_as_id)', async () => {
    clock.t = Date.parse('2026-10-06T08:00:00Z');
    serve(() => csv);
    await daily();
    expect(hits.pop).toBe(1);
    clock.t += 3_600_000;
    const again = await daily();
    expect(again.steps.referenceRefresh!.summary).toMatchObject({ popularity: { skipped: true } });
    expect(hits.pop).toBe(1);
    clock.t += DAY;
    await daily();
    expect(hits.pop).toBe(2);
    const pop = await db.selectFrom('reference_files').select(['id', 'body_gz', 'same_as_id']).where('name', '=', 'popularity_list').orderBy('id').execute();
    expect(pop).toHaveLength(2);
    expect(pop[0]!.body_gz).not.toBeNull();
    expect(pop[1]!.body_gz).toBeNull();
    expect(Number(pop[1]!.same_as_id)).toBe(Number(pop[0]!.id));
    expect((await latestPopularity(db))!.slds.length).toBeGreaterThan(800); // the newest row borrows the older body
  });

  it('an empty, non-CSV or HTTP 500 answer: the step is ok:false with the reason, the previous snapshot is still served (Review Focus 2)', async () => {
    clock.t = Date.parse('2026-10-06T08:00:00Z');
    serve(() => csv);
    await daily();
    const before = (await latestPopularity(db))!;
    for (const [body, status] of [['', 200], ['<html>Access denied</html>', 200], ['oops', 500]] as const) {
      clock.t += DAY;
      serve(() => body, status);
      const r = await daily();
      expect(r.steps.referenceRefresh).toMatchObject({ ok: false, summary: { pruned: 0, errors: [expect.stringMatching(/^popularity: /)] } });
      expect(r.steps.referenceRefresh!.error).toMatch(/popularity/);
      expect(r.steps.backupExport!.ok).toBe(true); // later steps still run
      expect(await latestPopularity(db)).toMatchObject({ listId: before.listId, listDate: before.listDate });
    }
    expect(await db.selectFrom('reference_files').select('id').where('name', '=', 'popularity_list').execute()).toHaveLength(1);
  });

  it('a switched-off source is skipped without a request', async () => {
    clock.t = Date.parse('2026-10-06T08:00:00Z');
    serve(() => csv);
    const { post } = await activeDraft({ 'sources.popularity': false });
    await post();
    const r = await daily();
    expect(r.steps.referenceRefresh!.summary).toMatchObject({ popularity: { skipped: true, reason: 'SOURCE_DISABLED' } });
    expect(hits.pop).toBe(0);
  });

  it('NameBio is never requested: not by the daily job, GET /selection/namebio or screening runs that use the namebio check (SEL9-13)', async () => {
    clock.t = Date.parse('2026-10-06T08:00:00Z');
    serve(() => csv);
    const x = await screeningHarness({ start: clock.t, adapters: [] });
    app = x.app;
    await x.post('/selection/settings', { label: 'v1n', set: { 'sources.namebio': true } });
    for (const trade of ['plumbing', 'solar', 'hvac']) {
      const { body } = await x.runDone({ checks: ['namebio'], mode: 'full', settings: 'v1n', names: [{ domain: `tulsa${trade}.com`, lane: 'S2', city: 'tulsa', state: 'ok', trade }] });
      expect(body.names[0].results[0]).toMatchObject({ check: 'namebio', status: 'UNKNOWN', reason_code: 'STALE_DATA' }); // enabled, but there is no cache and no fetcher
    }
    for (let i = 0; i < 3; i++) expect((await x.get('/selection/namebio?keywords=plumbing')).statusCode).toBe(200);
    expect(await app.jobRunner.run('daily')).toMatchObject({ job: 'daily' });
    expect(hits.namebio).toBe(0);
    expect(hits.pop).toBe(1); // the one daily download
  });

  it('an IANA refresh that fails while the stored copy is over 7 days old: the step is ok:false (the copy keeps serving)', async () => {
    clock.t = Date.parse('2026-10-06T08:00:00Z');
    serve(() => csv);
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => new HttpResponse('down', { status: 503 })));
    await db.insertInto('reference_files').values({ name: 'iana_rdap_dns', source_url: 'x', fetched_at: new Date(clock.t - 8 * DAY), data_date: null, sha256: 'i'.padEnd(64, '0'), bytes: 1, body_gz: gzipSync(Buffer.from(fixture('iana-dns.json').body)), same_as_id: null }).execute();
    const r = await daily();
    expect(r.steps.referenceRefresh).toMatchObject({ ok: false, summary: { errors: [expect.stringMatching(/^iana: .*kept/)] } });
    expect(r.steps.referenceRefresh!.error).toMatch(/iana/);
  });

  it('prune: rdap_lookups over 30 days; reference_files beyond the newest 10 per name (a kept row keeps the body it borrows); NameBio snapshots are kept', async () => {
    clock.t = Date.parse('2026-10-06T08:00:00Z');
    serve(() => csv);
    const gz = gzipSync(Buffer.from('1,google.com'));
    const ins = (name: string, ageDays: number, sha: string, body: Buffer | null, same: number | null) => db.insertInto('reference_files').values({
      name, source_url: 'x', fetched_at: new Date(clock.t - ageDays * DAY), data_date: null, sha256: sha.padEnd(64, '0'), bytes: 12, body_gz: body, same_as_id: same === null ? null : String(same),
    }).returning('id').executeTakeFirstOrThrow();
    const oldest = await ins('popularity_list', 100, 'a', gz, null); // the body that newer rows borrow
    for (let i = 0; i < 11; i++) await ins('popularity_list', 50 - i, `b${i}`, gz, null);
    const borrower = await ins('popularity_list', 0.5, 'a', null, Number(oldest.id)); // newest: kept, borrows the oldest body: must survive
    for (let i = 0; i < 12; i++) await ins('namebio_retailstats', 90 - i, `n${i}`, gz, null);
    await db.insertInto('rdap_lookups').values([
      { domain: 'old.com', outcome: 'registered', checked_at: new Date(clock.t - 31 * DAY) },
      { domain: 'new.com', outcome: 'registered', checked_at: new Date(clock.t - 29 * DAY) },
    ]).execute();
    const r = await daily();
    const s = r.steps.referenceRefresh!.summary as { pruned: number };
    const pop = await db.selectFrom('reference_files').select('id').where('name', '=', 'popularity_list').execute();
    const names = new Map((await db.selectFrom('reference_files').select('name').execute()).map((x) => [x.name, 0]));
    expect(names.has('namebio_retailstats')).toBe(true);
    expect(await db.selectFrom('reference_files').select('id').where('name', '=', 'namebio_retailstats').execute()).toHaveLength(12);
    expect(pop.map((x) => Number(x.id))).toContain(Number(oldest.id)); // borrowed by a kept row
    expect(pop.map((x) => Number(x.id))).toContain(Number(borrower.id));
    expect((await db.selectFrom('rdap_lookups').select('domain').execute()).map((x) => x.domain)).toEqual(['new.com']);
    expect(s.pruned).toBeGreaterThanOrEqual(2);
    // 13 old + 1 fresh download = 14 popularity rows; newest 10 kept + the borrowed oldest = 11
    expect(pop).toHaveLength(11);
  });
});

/** A helper that creates and activates a draft turning sources off (activation needs an approval naming the label). */
async function activeDraft(set: Record<string, unknown>) {
  const label = 'v1src';
  const app2 = await makeApp({ now: () => clock.t, adapters: [] });
  const w = await issueToken('write', 'gavriel');
  const { randomUUID } = await import('node:crypto');
  const send = (url: string, payload: object) => app2.inject({ method: 'POST', url, headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload });
  return {
    post: async () => {
      clock.t += 7_000;
      expect((await send('/selection/settings', { label, set })).statusCode).toBe(201);
      clock.t += 7_000;
      const a = await send(`/selection/settings/${label}/activate`, { approval_ref: { text: `Dvir: activate selection settings ${label}`, approved_at: new Date(clock.t - 1000).toISOString() } });
      expect(a.statusCode).toBe(200);
      await app2.close();
    },
  };
}
