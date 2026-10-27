// v5.64.0 (CR-083): the card evidence cache. CR083-AT1..AT6 are the CR's acceptance tests; CEC-1.. are the edge cases (rules: docs/internal/card-evidence.md).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { USPTO_TTL_HOURS } from '../../../src/modules/data/card-evidence.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-27T09:00:00Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  return {
    w: (await issueToken('write', 'gavriel')).auth, b: (await issueToken('bots', 'risk-gate')).auth,
    d: (await issueToken('data', 'data-engineer-upload')).auth, r: (await issueToken('read', 'reader')).auth,
  };
}
const post = (h: Record<string, string>, payload: unknown, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: '/data/card-evidence', headers: { ...h, 'idempotency-key': key }, payload: payload as object });
const get = (url: string, h: Record<string, string>) => app.inject({ method: 'GET', url, headers: h });
const uspto = (o: Record<string, unknown> = {}) => ({ domain: 'brightwidgets.com', kind: 'uspto_check', verdict: 'clear', checked_at: iso(NOW - HOUR), ...o });
type Row = { id: number; fresh: boolean | null; stale_reason: string | null; superseded_by: number | null; supersedes: number | null; kind: string; verdict: string; domain: string | null; term: string | null; checked_at: string; raw: unknown };
const rowsOf = async (h: Record<string, string>, qs = '') => (await get(`/data/card-evidence${qs}`, h)).json().rows as Row[];
const money = async () => ({
  domains: (await db.selectFrom('domains').select('id').execute()).length,
  ledger: (await db.selectFrom('ledger_entries').select('id').execute()).length,
  history: (await db.selectFrom('listing_history').select('id').execute()).length,
  schedule: (await db.selectFrom('price_schedule').select('id').execute()).length,
  plans: (await db.selectFrom('bid_plans').select('id').execute()).length,
});

describe('card evidence cache (CR-083)', () => {
  it('CR083-AT1: a bots or WRITE token posts a uspto_check (by domain or by term) -> 201; GET returns the row with fresh true within 24 h', async () => {
    const { w, b } = await setup();
    const a = await post(b, { rows: [uspto()] });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ table: 'card_evidence', received_n: 1, accepted_n: 1, duplicate_n: 0, rejected_n: 0 });
    expect((await post(w, { rows: [{ term: 'BrightWidgets', kind: 'uspto_check', verdict: 'flag', checked_at: iso(NOW - 2 * HOUR), note: 'class 35 hit' }] })).statusCode).toBe(201);
    const rows = await rowsOf(w);
    expect(rows).toHaveLength(2);
    const byDomain = rows.find((r) => r.domain === 'brightwidgets.com')!;
    expect(byDomain).toMatchObject({ kind: 'uspto_check', verdict: 'clear', fresh: true, stale_reason: null, superseded_by: null });
    expect(rows.find((r) => r.term === 'brightwidgets')).toMatchObject({ verdict: 'flag', fresh: true });
    expect(byDomain.checked_at).toMatch(/[+-]\d{2}:\d{2}$|Z$/);
    expect((await get(`/data/card-evidence/${byDomain.id}`, w)).json()).toMatchObject({ id: byDomain.id, fresh: true });
  });

  it('CR083-AT2: a uspto_check older than 24 h reads fresh false (stale_reason expired); nothing is deleted; exactly 24 h is still fresh', async () => {
    const { w, b } = await setup();
    expect(USPTO_TTL_HOURS).toBe(24);
    await post(b, { rows: [uspto({ checked_at: iso(NOW - 25 * HOUR) }), uspto({ domain: 'edge.com', checked_at: iso(NOW - 24 * HOUR) })] });
    const rows = await rowsOf(w);
    expect(rows.find((r) => r.domain === 'brightwidgets.com')).toMatchObject({ fresh: false, stale_reason: 'expired' });
    expect(rows.find((r) => r.domain === 'edge.com')).toMatchObject({ fresh: true });
    expect((await db.selectFrom('card_evidence').select('id').execute())).toHaveLength(2);
    expect((await get('/data/card-evidence', w)).json().ttl_hours).toBe(24);
  });

  it('CR083-AT3: a firm_screen with an operator count and checked_at -> 201; GET returns it (fresh null); no money table changes', async () => {
    const { w, b } = await setup();
    const before = await money();
    const res = await post(b, { rows: [{ domain: 'brightwidgets.com', kind: 'firm_screen', verdict: 'clear', checked_at: iso(NOW - 30 * HOUR), note: '3 operators', raw: { operators: 3 } }] });
    expect(res.statusCode, res.body).toBe(201);
    const row = (await rowsOf(w, '?kind=firm_screen'))[0]!;
    expect(row).toMatchObject({ kind: 'firm_screen', verdict: 'clear', fresh: null, stale_reason: null, raw: { operators: 3 } });
    expect(await money()).toEqual(before);
  });

  it('CR083-AT4: a correcting row with supersedes leaves the prior row readable (with superseded_by); the database refuses UPDATE, DELETE and TRUNCATE', async () => {
    const { w, b } = await setup();
    const first = (await post(b, { rows: [uspto({ verdict: 'clear' })] })).json().ids[0].id as number;
    const second = await post(b, { rows: [uspto({ verdict: 'kill', supersedes: first, note: 'owner found' })] });
    expect(second.statusCode, second.body).toBe(201);
    const rows = await rowsOf(w);
    const old = rows.find((r) => r.id === first)!;
    const fix = rows.find((r) => r.supersedes === first)!;
    expect(old).toMatchObject({ verdict: 'clear', superseded_by: fix.id, fresh: false, stale_reason: 'superseded' });
    expect(fix).toMatchObject({ verdict: 'kill', fresh: true, superseded_by: null });
    await expect(db.updateTable('card_evidence').set({ verdict: 'kill' }).where('id', '=', first).execute()).rejects.toThrow();
    await expect(db.deleteFrom('card_evidence').where('id', '=', first).execute()).rejects.toThrow();
    await expect(sql`truncate card_evidence`.execute(db)).rejects.toThrow();
    expect((await get(`/data/card-evidence/${first}`, w)).json()).toMatchObject({ id: first, superseded_by: fix.id });
  });

  it('CR083-AT5: the cache is not a money path: posting evidence of every verdict changes no domain, ledger, listing, price or bid row, and no route here is a buy, list, bid or sold route', async () => {
    const { b } = await setup();
    const before = await money();
    const kinds = ['uspto_check', 'firm_screen', 'other'];
    const verdicts = ['kill', 'clear', 'flag', 'error', 'unknown'];
    const rows = verdicts.map((v, i) => uspto({ domain: `name${i}.com`, kind: kinds[i % 3], verdict: v }));
    expect((await post(b, { rows })).json().accepted_n).toBe(5);
    expect(await money()).toEqual(before);
    const routes = app.routeTable.map((r) => r.url).filter((u) => u.startsWith('/data/card-evidence'));
    expect([...new Set(routes)].sort()).toEqual(['/data/card-evidence', '/data/card-evidence/:id']);
    expect(routes.filter((u) => /buy|list|bid|sold|plans|export|price/.test(u))).toEqual([]);
    // the bots token is still refused on a real money route
    expect((await app.inject({ method: 'POST', url: '/buy', headers: { ...b, 'idempotency-key': randomUUID() }, payload: { domain: 'x.com', max_price: 1000 } })).statusCode).toBe(403);
  });

  it('CR083-AT6: the service holds no USPTO, TSDR or trademark client: the card evidence code makes no outside call and names no trademark site', () => {
    for (const f of ['src/modules/data/card-evidence.ts', 'src/modules/data/api/card-evidence.ts']) {
      const text = readFileSync(join(import.meta.dirname, '..', '..', '..', f), 'utf8');
      expect(text, f).not.toMatch(/\bfetch\(|safeFetch|safe-fetch|undici|node:https?|https?:\/\//);
      expect(text, f).not.toMatch(/uspto\.gov|tmsearch|tsdr\.|tmview|euipo/i);
    }
  });

  it('CEC-1: supersedes must name an existing row (SUPERSEDES_NOT_FOUND), must be a positive integer (SUPERSEDES_INVALID); the rest of the batch is stored', async () => {
    const { b } = await setup();
    const res = await post(b, { rows: [uspto({ supersedes: 999 }), uspto({ domain: 'a.com', supersedes: 0 }), uspto({ domain: 'ok.com' })] });
    expect(res.json()).toMatchObject({ accepted_n: 1, rejected_n: 2 });
    expect(res.json().rejects.map((r: { row: number; reason: string }) => [r.row, r.reason])).toEqual([[0, 'SUPERSEDES_NOT_FOUND'], [1, 'SUPERSEDES_INVALID']]);
  });

  it('CEC-2: a /data/tm-kills row added after checked_at makes a uspto_check fresh false (tm_kills_changed); one added before does not; firm_screen is not affected', async () => {
    const { w, b } = await setup();
    await db.insertInto('tm_kills').values({ term: 'old', by: 'test', created_at: new Date(NOW - 3 * HOUR) }).execute();
    await post(b, { rows: [uspto({ checked_at: iso(NOW - 2 * HOUR) }), { domain: 'brightwidgets.com', kind: 'firm_screen', verdict: 'clear', checked_at: iso(NOW - 2 * HOUR) }] });
    expect((await rowsOf(w, '?kind=uspto_check'))[0]).toMatchObject({ fresh: true });
    await db.insertInto('tm_kills').values({ term: 'brightwidgets', by: 'test', created_at: new Date(NOW - HOUR) }).execute();
    expect((await rowsOf(w, '?kind=uspto_check'))[0]).toMatchObject({ fresh: false, stale_reason: 'tm_kills_changed' });
    expect((await rowsOf(w, '?kind=firm_screen'))[0]).toMatchObject({ fresh: null });
    expect(await rowsOf(w, '?fresh_only=true&kind=uspto_check')).toEqual([]);
    expect(await rowsOf(w, '?fresh_only=true&kind=firm_screen')).toHaveLength(1);
  });

  it("CEC-3: an '@' in evidence_ref, note, term or raw is refused with its own reason and nothing from that row is stored", async () => {
    const { b } = await setup();
    const res = await post(b, { rows: [uspto({ evidence_ref: 'mail to a@b.co' }), uspto({ note: 'x@y.z' }), { term: 'a@b', kind: 'other', verdict: 'unknown', checked_at: iso(NOW - HOUR) }, uspto({ raw: { who: 'a@b.co' } }), uspto({ evidence_ref: 'docs/requests/exports/uspto-1.json' })] });
    expect(res.json().rejects.map((r: { reason: string }) => r.reason)).toEqual(['EVIDENCE_REF_PII', 'NOTE_PII', 'TERM_PII', 'RAW_PII']);
    expect(res.json().accepted_n).toBe(1);
    expect(await db.selectFrom('card_evidence').select('evidence_ref').execute()).toEqual([{ evidence_ref: 'docs/requests/exports/uspto-1.json' }]);
  });

  it('CEC-4: raw must be an object of at most 8 KB', async () => {
    const { w, b } = await setup();
    const big = { blob: 'x'.repeat(8 * 1024) };
    const ok = { blob: 'x'.repeat(8 * 1024 - 20) };
    const res = await post(b, { rows: [uspto({ raw: big }), uspto({ domain: 'a.com', raw: [1] }), uspto({ domain: 'b.com', raw: 'str' }), uspto({ domain: 'c.com', raw: ok })] });
    expect(res.json().rejects.map((r: { reason: string }) => r.reason)).toEqual(['RAW_TOO_LARGE', 'RAW_INVALID', 'RAW_INVALID']);
    expect((await rowsOf(w))[0]!.raw).toEqual(ok);
  });

  it('CEC-5: scopes: READ cannot POST (403, audited), a data token can POST but gets 403 on GET, bots and WRITE can both; a request without a token is 401', async () => {
    const { w, b, d, r } = await setup();
    const denied = await post(r, { rows: [uspto()] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('SCOPE_FORBIDDEN');
    expect(await db.selectFrom('card_evidence').select('id').execute()).toEqual([]);
    expect((await post(d, { rows: [uspto()] })).statusCode).toBe(201);
    const dg = await get('/data/card-evidence', d);
    expect(dg.statusCode).toBe(403);
    expect(dg.json().error.code).toBe('SCOPE_FORBIDDEN');
    expect((await get('/data/card-evidence/1', d)).statusCode).toBe(403);
    expect((await get('/data/card-evidence', r)).statusCode).toBe(200);
    expect((await get('/data/card-evidence', b)).statusCode).toBe(200);
    expect((await get('/data/card-evidence', w)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/data/card-evidence' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/data/card-evidence', headers: { 'idempotency-key': randomUUID() }, payload: { rows: [uspto()] } })).statusCode).toBe(401);
  });

  it('CEC-6: fresh_only=true hides superseded rows and stale uspto_check rows and keeps fresh ones and other kinds', async () => {
    const { w, b } = await setup();
    const ids = (await post(b, { rows: [
      uspto({ domain: 'stale.com', checked_at: iso(NOW - 30 * HOUR) }), uspto({ domain: 'fresh.com' }), uspto({ domain: 'replaced.com' }),
      { domain: 'firm.com', kind: 'firm_screen', verdict: 'flag', checked_at: iso(NOW - 90 * HOUR) },
    ] })).json().ids as { id: number }[];
    await post(b, { rows: [uspto({ domain: 'replaced.com', verdict: 'kill', supersedes: ids[2]!.id })] });
    const all = await rowsOf(w);
    expect(all).toHaveLength(5);
    const fresh = await rowsOf(w, '?fresh_only=true');
    expect(fresh.map((r) => r.domain).sort()).toEqual(['firm.com', 'fresh.com', 'replaced.com']);
    expect(fresh.find((r) => r.domain === 'replaced.com')).toMatchObject({ verdict: 'kill' });
  });

  it('CEC-7: the same row twice is a duplicate; dry_run stores nothing; the Idempotency-Key is required; the same key replays', async () => {
    const { b } = await setup();
    expect((await post(b, { rows: [uspto()], dry_run: true })).json()).toMatchObject({ dry_run: true, accepted_n: 1, ids: [] });
    expect(await db.selectFrom('card_evidence').select('id').execute()).toEqual([]);
    await post(b, { rows: [uspto()] });
    expect((await post(b, { rows: [uspto(), uspto()] })).json()).toMatchObject({ accepted_n: 0, duplicate_n: 2 });
    expect(await db.selectFrom('card_evidence').select('id').execute()).toHaveLength(1);
    const noKey = await app.inject({ method: 'POST', url: '/data/card-evidence', headers: b, payload: { rows: [uspto()] } });
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const k = randomUUID();
    const one = await post(b, { rows: [uspto({ domain: 'k.com' })] }, k);
    const two = await post(b, { rows: [uspto({ domain: 'k.com' })] }, k);
    expect(two.body).toBe(one.body);
    expect(await db.selectFrom('card_evidence').select('id').where('domain', '=', 'k.com').execute()).toHaveLength(1);
  });

  it('CEC-8: row validation: subject required, kind and verdict from the enums, checked_at ISO with an offset and not in the future, 1..500 rows', async () => {
    const { b } = await setup();
    const res = await post(b, { rows: [
      { kind: 'uspto_check', verdict: 'clear', checked_at: iso(NOW) },
      uspto({ kind: 'rdap' }), uspto({ verdict: 'maybe' }), uspto({ checked_at: '2026-10-27T09:00:00' }), uspto({ checked_at: '2026-10-27' }),
      uspto({ checked_at: iso(NOW + 10 * 60_000) }), uspto({ checked_at: '2026-02-30T00:00:00+02:00' }), uspto({ domain: 'not a domain' }), 'junk',
      uspto({ domain: 'jer.com', checked_at: '2026-10-27T11:30:00+03:00' }),
    ] });
    expect(res.json().rejects.map((r: { reason: string }) => r.reason)).toEqual([
      'SUBJECT_REQUIRED', 'KIND_INVALID', 'VERDICT_INVALID', 'CHECKED_AT_INVALID', 'CHECKED_AT_INVALID', 'CHECKED_AT_IN_FUTURE', 'CHECKED_AT_INVALID', 'DOMAIN_INVALID', 'ROW_INVALID',
    ]);
    expect(res.json().accepted_n).toBe(1);
    const many = await post(b, { rows: Array.from({ length: 501 }, (_, i) => uspto({ domain: `n${i}.com` })) });
    expect(many.statusCode).toBe(422);
    expect((await post(b, { rows: [] })).statusCode).toBe(422);
    expect((await post(b, { rows: Array.from({ length: 500 }, (_, i) => uspto({ domain: `m${i}.com` })) })).json().accepted_n).toBe(500);
  });

  it('CEC-9: GET filters domain, term (case-insensitive), kind, limit and offset, newest first; GET /:id is 404 CARD_EVIDENCE_NOT_FOUND for an unknown id and 422 for a bad one', async () => {
    const { w, b } = await setup();
    await post(b, { rows: [uspto({ domain: 'one.com' }), uspto({ domain: 'two.com', kind: 'firm_screen' }), { term: 'Zed', kind: 'other', verdict: 'unknown', checked_at: iso(NOW - HOUR) }] });
    expect((await rowsOf(w, '?domain=ONE.com'))).toHaveLength(1);
    expect((await rowsOf(w, '?term=ZED'))[0]).toMatchObject({ term: 'zed', kind: 'other', fresh: null });
    expect((await rowsOf(w, '?kind=firm_screen'))).toHaveLength(1);
    const page = (await get('/data/card-evidence?limit=1&offset=1', w)).json();
    expect(page).toMatchObject({ count: 1, total: 3, limit: 1, offset: 1 });
    expect(page.rows[0].domain).toBe('two.com');
    expect((await rowsOf(w))[0]!.term).toBe('zed');
    const nf = await get('/data/card-evidence/99999', w);
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('CARD_EVIDENCE_NOT_FOUND');
    expect((await get('/data/card-evidence/abc', w)).statusCode).toBe(422);
    expect((await get('/data/card-evidence?kind=rdap', w)).statusCode).toBe(422);
    expect((await get('/data/card-evidence?limit=0', w)).statusCode).toBe(422);
  });

  it('CEC-10: a superseded firm_screen reads fresh null with stale_reason superseded; a POST is audited with the token name and a row count', async () => {
    const { w, b } = await setup();
    const id = (await post(b, { rows: [{ domain: 'f.com', kind: 'firm_screen', verdict: 'flag', checked_at: iso(NOW - HOUR) }] })).json().ids[0].id as number;
    await post(b, { rows: [{ domain: 'f.com', kind: 'firm_screen', verdict: 'clear', checked_at: iso(NOW - 60_000), supersedes: id }] });
    expect((await get(`/data/card-evidence/${id}`, w)).json()).toMatchObject({ fresh: null, stale_reason: 'superseded' });
    const audit = (await get('/audit?limit=20', w)).json().rows as { path: string; token_name: string; scope: string; summary?: string }[];
    expect(audit.filter((a) => a.path === '/data/card-evidence').every((a) => a.token_name === 'risk-gate' && a.scope === 'bots')).toBe(true);
    expect(audit.filter((a) => a.path === '/data/card-evidence')).toHaveLength(2);
  });
});
