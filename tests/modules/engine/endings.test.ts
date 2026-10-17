// v5.4.0 (CR-056 part 1): the daily step engineEndings (RDAP only; mocked here) and the endings numbers of GET /engine/health.
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RDAP_COM_BASE, RDAP_FALLBACK_BASES, type RdapLookup, type RdapLookupFn } from '../../../src/core/rdap.js';
import { EndingsJob } from '../../../src/modules/engine/index.js';
import type { ScreeningDeps } from '../../../src/modules/selection/index.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

const T0 = Date.parse('2026-10-14T00:05:00Z');
const DAY = 86_400_000;
let now = T0;
let app: FastifyInstance | undefined;
beforeEach(() => { now = T0; });
afterEach(async () => { await app?.close(); app = undefined; });

const BASES = { net: 'https://rdap.verisign.com/net/v1/', org: 'https://rdap.pir.test/', ai: 'https://rdap.ai.test/', co: RDAP_FALLBACK_BASES.co!, io: RDAP_FALLBACK_BASES.io! };
const BOOTSTRAP = JSON.stringify({ publication: '2026-10-01T00:00:00Z', services: [[['net'], [BASES.net]], [['org'], [BASES.org]], [['ai'], [BASES.ai]]] });
type Answer = Partial<RdapLookup> & { outcome: RdapLookup['outcome'] };
const reg = (created: string, extra: Partial<RdapLookup['facts'] & object> = {}): Answer => ({ outcome: 'registered', httpStatus: 200, facts: { registrar: 'Some Registrar', created_at: created, expires_at: '2027-01-01T00:00:00.000Z', updated_at: null, statuses: ['active'], nameservers: [], ...extra } });
const free: Answer = { outcome: 'not_registered', httpStatus: 404 };
const unk = (reasonCode: NonNullable<RdapLookup['reasonCode']>, httpStatus: number | null = null, retryAfterMs?: number): Answer => ({ outcome: 'unknown', reasonCode, httpStatus, retryAfterMs });

function harness(answer: (host: string, domain: string) => Answer | Promise<Answer>) {
  const asked: { domain: string; base: string }[] = [];
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const rdapLookup: RdapLookupFn = async (domain, o) => {
    asked.push({ domain, base: o?.baseUrl ?? '' });
    const a = await answer(new URL(o?.baseUrl ?? 'https://x.test/').host, domain);
    return { reasonCode: null, httpStatus: null, url: `${o?.baseUrl}domain/${domain}`, retrievedAt: new Date(now), body: null, facts: null, ...a } as RdapLookup;
  };
  const fetch = (async () => new Response(BOOTSTRAP, { status: 200 })) as unknown as typeof globalThis.fetch;
  const screening = { rdapLookup, sleep, fetch } as unknown as ScreeningDeps;
  const job = (o: { maxPairs?: number; budgetMs?: number } = {}) => new EndingsJob({ db, screening, now: () => now, ...o });
  return { asked, sleeps, job };
}

async function seed(names: string[], unsoldNames: string[] = []): Promise<void> {
  const up = await db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 0, accepted_n: 0, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'test', audit_id: null }).returning('id').executeTakeFirstOrThrow();
  if (names.length) await db.insertInto('engine_sales').values(names.map((n) => ({ domain: `${n}.com`, price_cents: 10000, sale_date: '2026-09-01', venue: 'v', source: 's', source_url: null, upload_id: up.id }))).execute();
  if (unsoldNames.length) await db.insertInto('engine_unsold').values(unsoldNames.map((n) => ({ domain: `${n}.com`, type: 'dropped_after_held' as const, observation_date: '2026-10-08', caught_by_catcher: null, upload_id: up.id }))).execute();
}
const rowsOf = () => db.selectFrom('engine_endings').selectAll().orderBy('id').execute();
const find = async (name: string, tld: string) => (await rowsOf()).filter((r) => r.name === name && r.tld === tld);

describe('engine endings fill', () => {
  it('EN-11: a registered name keeps its registry creation date, a 404 is not registered, every row has the host and no DNS is used', async () => {
    await seed(['septicdrone'], ['unsoldone']);
    const h = harness((host, domain) => (domain === 'septicdrone.net' ? reg('2019-04-02T10:00:00.000Z', { registrar: 'Reg Inc' }) : domain === 'septicdrone.com' ? reg('2014-06-01T00:00:00.000Z') : domain === 'septicdrone.io' ? reg('2023-01-01T00:00:00Z') : free));
    const s = await h.job().runOnce();
    expect(s).toMatchObject({ skipped: false, due: 12, asked: 12, registered: 3, not_registered: 9, unknown: 0, inserted: 12, updated: 0, left_for_next_run: 0, partial: false });
    expect(s.by_tld.net).toEqual({ asked: 2, registered: 1, not_registered: 1, unknown: 0 });
    const [net] = await find('septicdrone', 'net');
    expect(net).toMatchObject({ registered: true, http_status: 200, reason_code: null });
    expect(net!.created_at_registry!.toISOString()).toBe('2019-04-02T10:00:00.000Z');
    expect(net!.evidence).toEqual({ host: 'rdap.verisign.com', registrar: 'Reg Inc', expires_at: '2027-01-01T00:00:00.000Z', statuses: ['active'] });
    const [co] = await find('septicdrone', 'co');
    expect(co).toMatchObject({ registered: false, created_at_registry: null, http_status: 404 });
    expect(h.asked.find((a) => a.domain === 'septicdrone.co')!.base).toBe(RDAP_FALLBACK_BASES.co);
    expect(h.asked.find((a) => a.domain === 'septicdrone.ai')!.base).toBe(BASES.ai);
    expect(h.asked.find((a) => a.domain === 'septicdrone.org')!.base).toBe(BASES.org);
    // v5.5.0: the name's own .com is asked at Verisign and its creation date is kept (the acquisition feature)
    expect(h.asked.find((a) => a.domain === 'septicdrone.com')!.base).toBe(RDAP_COM_BASE);
    expect((await find('septicdrone', 'com'))[0]!.created_at_registry!.toISOString()).toBe('2014-06-01T00:00:00.000Z');
    expect((await db.selectFrom('rdap_lookups').select('id').execute()).length).toBe(0);
    expect((await db.selectFrom('audit_log').select('result_summary').where('path', '=', 'engine-endings').executeTakeFirstOrThrow()).result_summary).toContain('asked 12');
  });

  it('EN-12: a timeout is stored as unanswered with its reason, asked again on a later run (not the same hour) and updated in place', async () => {
    await seed(['alpha']);
    let failing = true;
    const h = harness((_h, d) => (d === 'alpha.org' && failing ? unk('TIMEOUT') : free));
    let s = await h.job().runOnce();
    expect(s).toMatchObject({ asked: 6, unknown: 1, not_registered: 5, inserted: 6 });
    expect((await find('alpha', 'org'))[0]).toMatchObject({ registered: null, reason_code: 'TIMEOUT', created_at_registry: null, http_status: null });
    expect((await db.selectFrom('engine_endings').select('id').execute()).length).toBe(6);
    // the same hour: nothing is due
    s = await h.job().runOnce();
    expect(s).toMatchObject({ due: 0, asked: 0 });
    // seven hours later it is asked again; the registry now answers
    now += 7 * 3_600_000;
    failing = false;
    s = await h.job().runOnce();
    expect(s).toMatchObject({ due: 1, asked: 1, not_registered: 1, updated: 1, inserted: 0 });
    const rows = await find('alpha', 'org');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ registered: false, reason_code: null, http_status: 404 });
  });

  it('EN-13: an answer is asked again after 30 days and a new row is appended; before that nothing is asked', async () => {
    await seed(['alpha']);
    let created: Answer = free;
    const h = harness((_h, d) => (d === 'alpha.net' ? created : free));
    await h.job().runOnce();
    now += 29 * DAY;
    expect(await h.job().runOnce()).toMatchObject({ due: 0, asked: 0 });
    now += 2 * DAY; // 31 days after the first answers
    created = reg('2026-10-20T00:00:00.000Z');
    const s = await h.job().runOnce();
    // v5.14.0 (D4): the five unchanged answers update their row in place; only the changed one appends
    expect(s).toMatchObject({ due: 6, asked: 6, registered: 1, inserted: 1, updated: 5 });
    const rows = await find('alpha', 'net');
    expect(rows.map((r) => r.registered)).toEqual([false, true]);
    expect(rows[1]!.created_at_registry!.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(await find('alpha', 'org')).toHaveLength(1);
  });

  it('EN-74: a re-ask with the same answer updates checked_at and evidence in place (same row id); a changed registry creation date appends a row', async () => {
    await seed(['alpha']);
    let created = '2020-01-01T00:00:00Z';
    const h = harness((_h, d) => (d === 'alpha.net' ? reg(created) : free));
    await h.job().runOnce();
    const first = (await find('alpha', 'net'))[0]!;
    now += 31 * DAY;
    await h.job().runOnce();
    const again = await find('alpha', 'net');
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first.id);
    expect(again[0]!.checked_at.getTime()).toBeGreaterThan(first.checked_at.getTime());
    now += 31 * DAY;
    created = '2026-10-01T00:00:00Z';
    await h.job().runOnce();
    expect((await find('alpha', 'net')).map((r) => r.created_at_registry!.toISOString())).toEqual(['2020-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
  });

  it('EN-75: the 5.14.0 migration cleanup keeps the newest of consecutive identical answers, every change, and rows an owned-ending event points to', async () => {
    const ins = (name: string, registered: boolean | null, created: string | null, day: number) => sql`insert into engine_endings (name, tld, registered, created_at_registry, checked_at, reason_code)
      values (${name}, 'net', ${registered}, ${created}, ${new Date(T0 + day * DAY)}, ${registered === null ? 'SOURCE_ERROR' : null}) returning id`.execute(db);
    for (const d of [1, 2, 3]) await ins('same', false, null, d);                       // three identical: only the newest stays
    await ins('flip', false, null, 1); await ins('flip', true, '2020-01-01T00:00:00Z', 2); await ins('flip', true, '2020-01-01T00:00:00Z', 3); await ins('flip', false, null, 4);
    await ins('unk', null, null, 1); await ins('unk', null, null, 2);                    // unanswered rows are never collapsed
    const owned = (await ins('own', true, '2020-01-01T00:00:00Z', 1)).rows[0] as { id: string }; await ins('own', true, '2020-01-01T00:00:00Z', 2);
    await sql`insert into owned_ending_events (domain, tld, kind, registered, created_at_registry, ending_id, created_at) values ('own.com', 'net', 'baseline', true, '2020-01-01T00:00:00Z', ${owned.id}, ${new Date(T0)})`.execute(db);
    const file = readFileSync(new URL('../../../migrations/1764700000000_v5-14-0.sql', import.meta.url), 'utf8');
    const cleanup = file.slice(file.indexOf('DELETE FROM public.engine_endings'), file.indexOf('-- Down Migration'));
    await sql.raw(cleanup).execute(db);
    const left = async (n: string) => (await find(n, 'net')).map((r) => `${r.registered}`);
    expect(await left('same')).toEqual(['false']);
    expect(await left('flip')).toEqual(['false', 'true', 'false']);
    expect(await left('unk')).toEqual(['null', 'null']);
    expect(await left('own')).toEqual(['true', 'true']);
  });

  it('EN-14: when the re-ask of a known answer gets no answer, the known row stays and the pair is asked again on the next run', async () => {
    await seed(['alpha']);
    let down = false;
    const h = harness((_h, d) => (d === 'alpha.ai' && down ? unk('SOURCE_ERROR', 503) : reg('2020-01-01T00:00:00Z')));
    await h.job().runOnce();
    now += 31 * DAY;
    down = true;
    const s = await h.job().runOnce();
    expect(s).toMatchObject({ asked: 6, unknown: 1, registered: 5, inserted: 0, updated: 5 });
    const ai = await find('alpha', 'ai');
    expect(ai).toHaveLength(1);
    expect(ai[0]).toMatchObject({ registered: true });
    down = false;
    now += 3_600_000;
    expect(await h.job().runOnce()).toMatchObject({ due: 1, asked: 1, registered: 1, inserted: 0, updated: 1 });
    expect(await find('alpha', 'ai')).toHaveLength(1);
  });

  it('EN-15: asks to one registry host are paced through the injected sleep (250 ms apart, 4 at a time)', async () => {
    await seed(Array.from({ length: 12 }, (_, i) => `name${i}`));
    const h = harness(() => free);
    await h.job().runOnce();
    expect(h.asked).toHaveLength(72);
    // 12 names on one host: starts are queued 250 ms apart, so the waits grow in steps of 250 ms
    const waits = [...new Set(h.sleeps)].sort((a, b) => a - b);
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...h.sleeps)).toBeGreaterThanOrEqual(250);
    expect(h.sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it('EN-16: a run asks at most maxPairs, never-asked pairs first; the next runs continue until every pair has an answer', async () => {
    await seed(['aaa', 'bbb']);
    const h = harness(() => free);
    let s = await h.job({ maxPairs: 4 }).runOnce();
    expect(s).toMatchObject({ due: 12, asked: 4, left_for_next_run: 8 });
    expect((await rowsOf()).length).toBe(4);
    s = await h.job({ maxPairs: 4 }).runOnce();
    expect(s).toMatchObject({ due: 8, asked: 4, left_for_next_run: 4 });
    s = await h.job({ maxPairs: 4 }).runOnce();
    expect(s).toMatchObject({ due: 4, asked: 4, left_for_next_run: 0 });
    expect(new Set((await rowsOf()).map((r) => `${r.name}.${r.tld}`)).size).toBe(12);
    expect(h.asked).toHaveLength(12);
  });

  it('EN-17: a 429 with a short Retry-After is retried once after sleeping that long; an answer is stored; a refusal slows the host', async () => {
    await seed(['alpha']);
    let limited = true;
    const h = harness((_h, d) => {
      if (d === 'alpha.net' && limited) { limited = false; return unk('RATE_LIMITED', 429, 1500); }
      return free;
    });
    const s = await h.job().runOnce();
    expect(s).toMatchObject({ asked: 6, not_registered: 6, unknown: 0 });
    expect(h.sleeps).toContain(1500);
    expect(h.asked.filter((a) => a.domain === 'alpha.net')).toHaveLength(2);
    expect((await find('alpha', 'net'))[0]).toMatchObject({ registered: false });
  });

  it('EN-18: the time budget stops the run (partial) and the rest waits for the next run; a run that cannot find an ending\'s RDAP service skips that ending', async () => {
    await seed(['aaa', 'bbb', 'ccc']);
    let calls = 0;
    const h = harness(() => { calls++; now += 60_000; return free; });
    const s = await h.job({ budgetMs: 5 * 60_000 }).runOnce();
    expect(s.partial).toBe(true);
    expect(s.asked).toBeGreaterThan(0);
    expect(s.asked).toBeLessThan(18);
    expect(s.left_for_next_run).toBe(18 - s.asked);
    expect(calls).toBe(s.asked);
  });

  it('EN-20: an ending whose RDAP service cannot be found is skipped (named in skipped_tlds, no rows); the other endings are still filled', async () => {
    await seed(['alpha']);
    const asked: string[] = [];
    const rdapLookup: RdapLookupFn = async (domain, o) => { asked.push(domain); return { outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: `${o?.baseUrl}x`, retrievedAt: new Date(now), body: null, facts: null }; };
    const noAi = JSON.stringify({ publication: '2026-10-02T00:00:00Z', services: [[['net'], [BASES.net]], [['org'], [BASES.org]]] });
    const screening = { rdapLookup, sleep: async () => {}, fetch: (async () => new Response(noAi, { status: 200 })) as unknown as typeof globalThis.fetch } as unknown as ScreeningDeps;
    const s = await new EndingsJob({ db, screening, now: () => now }).runOnce();
    expect(s).toMatchObject({ asked: 5, skipped_tlds: ['ai'], partial: true, left_for_next_run: 1 });
    expect(asked.sort()).toEqual(['alpha.co', 'alpha.com', 'alpha.io', 'alpha.net', 'alpha.org']);
    expect(await find('alpha', 'ai')).toHaveLength(0);
  });

  it('EN-19: the daily job runs engineEndings as its last step; GET /engine/health shows the fill', async () => {
    await seed(['alpha', 'beta']);
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now, screening: { rdapLookup: (async (domain: string, o?: { baseUrl?: string }) => ({ outcome: domain.startsWith('alpha.') ? 'registered' : 'not_registered', reasonCode: null, httpStatus: domain.startsWith('alpha.') ? 200 : 404, url: `${o?.baseUrl}x`, retrievedAt: new Date(now), body: null, facts: domain.startsWith('alpha.') ? { registrar: null, created_at: '2018-05-05T00:00:00.000Z', expires_at: null, updated_at: null, statuses: [], nameservers: [] } : null })) as RdapLookupFn, fetch: (async () => new Response(BOOTSTRAP, { status: 200 })) as unknown as typeof globalThis.fetch, sleep: async () => {} } });
    const w = (await issueToken('write', 'gavriel')).auth;
    const plan = app.jobRunner.plan('daily').map((p) => p.name);
    expect(plan.slice(-2)).toEqual(['engineEndings', 'engineTrain']);
    const step = app.jobRunner.plan('daily').find((p) => p.name === 'engineEndings')!;
    expect(step.maxAttempts).toBe(1);
    expect(step.timeoutMs).toBe(25 * 60_000);
    const before = (await app.inject({ method: 'GET', url: '/engine/health', headers: w })).json();
    expect(before.endings).toMatchObject({ names_n: 2, checked_n: 0, pending_n: 12 });
    const r = await app.jobRunner.runStepOnce(step);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ asked: 12, registered: 6, not_registered: 6 });
    const h = (await app.inject({ method: 'GET', url: '/engine/health', headers: w })).json();
    expect(h.endings).toMatchObject({ names_n: 2, pairs_n: 12, checked_n: 12, unknown_n: 0, pending_n: 0 });
    expect(h.endings.by_tld.net).toEqual({ checked_n: 2, registered_n: 1, unknown_n: 0, pending_n: 0 });
  });
});
