// Versioned lists (append-only) and frozen census lists (ruling R3: Dvir's approval_ref; Review Focus 4: odd spellings).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const approval = (text = 'Dvir: freeze bt1_netextend and s6_regime_audit') => ({ text, approved_at: new Date(Date.now() - 3_600_000).toISOString() });

async function setup() {
  let clock = Date.now();
  app = await makeApp({ now: () => clock });
  const w = await issueToken('write', 'gavriel');
  const r = await issueToken('read');
  const post = (name: string, payload: object) => (clock += 7_000, app.inject({ method: 'POST', url: `/selection/lists/${name}`, headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload }));
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r.auth });
  return { post, get, w, r };
}
const err = (res: { statusCode: number; json(): { error: { code: string; details: Record<string, unknown> } } }) => [res.statusCode, res.json().error.code];
const siblings = (n: number, extra: string[] = []) => [...Array.from({ length: n - extra.length }, (_, i) => `sibling${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}.com`), ...extra];

describe('word lists', () => {
  it('brand: replace -> v1, add -> v2 with the union, remove -> v3, a no-op -> 422 LIST_NO_CHANGE', async () => {
    const { post, get } = await setup();
    const a = await post('brand', { replace: ['Acme', ' globex ', 'initech'], note: 'first upload' });
    expect([a.statusCode, a.json()]).toEqual([201, { name: 'brand', version: 1, terms_n: 3 }]);
    const b = await post('brand', { add: ['umbrella', 'acme'] });
    expect(b.json()).toEqual({ name: 'brand', version: 2, terms_n: 4 });
    const c = await post('brand', { remove: ['globex', 'nothere'] });
    expect(c.json()).toEqual({ name: 'brand', version: 3, terms_n: 3 });
    expect(err(await post('brand', { add: ['acme'] }))).toEqual([422, 'LIST_NO_CHANGE']);
    expect(err(await post('brand', { remove: ['zzzz'] }))).toEqual([422, 'LIST_NO_CHANGE']);
    expect(err(await post('brand', { replace: ['acme', 'initech', 'umbrella'] }))).toEqual([422, 'LIST_NO_CHANGE']);
    expect((await get('/selection/lists/brand')).json()).toMatchObject({ name: 'brand', version: 3, terms: ['acme', 'initech', 'umbrella'], created_by: 'gavriel' });
  });

  it('GET ?version=1 returns the old terms; unknown version or name: 404 LIST_NOT_FOUND', async () => {
    const { post, get } = await setup();
    await post('brand', { replace: ['acme', 'globex'] });
    await post('brand', { replace: ['acme'] });
    expect((await get('/selection/lists/brand?version=1')).json().terms).toEqual(['acme', 'globex']);
    expect((await get('/selection/lists/brand?version=2')).json().terms).toEqual(['acme']);
    expect(err(await get('/selection/lists/brand?version=3'))).toEqual([404, 'LIST_NOT_FOUND']);
    expect(err(await get('/selection/lists/event'))).toEqual([404, 'LIST_NOT_FOUND']);
    expect(err(await get('/selection/lists/not_a_list'))).toEqual([404, 'LIST_NOT_FOUND']);
    expect((await get('/selection/lists/brand?version=0')).statusCode).toBe(400);
  });

  it('seeded lists are readable at v1 (trade, legal, signature lists)', async () => {
    const { get } = await setup();
    expect((await get('/selection/lists/legal')).json().terms).toContain('lawyer');
    expect((await get('/selection/lists/trade')).json().terms).toEqual(expect.arrayContaining(['roofing', 'plumbing']));
    expect((await get('/selection/lists/trade')).json().terms).not.toContain('lawyer');
    expect((await get('/selection/lists/sig_harmful_strong')).json().terms).toEqual(expect.arrayContaining(['pharma:viagra', 'adult:xxx']));
    expect(err(await get('/selection/lists/brand'))).toEqual([404, 'LIST_NOT_FOUND']);
  });

  it('a phrase list keeps multi-word phrases and treats two spellings of one phrase as one term', async () => {
    const { post, get } = await setup();
    expect((await post('bigco', { replace: ['New Balance', 'newbalance', 'coca  cola'] })).json().terms_n).toBe(2);
    expect((await get('/selection/lists/bigco')).json().terms).toEqual(['coca cola', 'new balance']);
    expect((await post('bigco', { add: ['newbalance'] })).statusCode).toBe(422);
    const rm = await post('bigco', { remove: ['newbalance'] });
    expect(rm.json().terms_n).toBe(1);
  });

  it('term shape is checked per list kind: LIST_TERM_INVALID', async () => {
    const { post } = await setup();
    const bad = async (name: string, body: object) => { const r = await post(name, body); return [r.statusCode, r.json().error.code, r.json().error.details.terms]; };
    expect(await bad('trade', { add: ['two words'] })).toEqual([422, 'LIST_TERM_INVALID', ['two words']]);
    expect((await bad('trade', { add: ['ab1'] }))[1]).toBe('LIST_TERM_INVALID');
    expect((await bad('trade', { add: ['x'] }))[1]).toBe('LIST_TERM_INVALID');
    expect((await bad('brand', { replace: ['ok', 'not ok!'] }))[1]).toBe('LIST_TERM_INVALID');
    expect((await bad('sig_parked', { replace: ['forsale:this domain is for sale'] }))[1]).toBe('LIST_TERM_INVALID'); // class must be parked
    expect((await bad('sig_harmful_strong', { replace: ['nonsense:foo'] }))[1]).toBe('LIST_TERM_INVALID');
    expect((await bad('sig_harmful_strong', { replace: ['no class here'] }))[1]).toBe('LIST_TERM_INVALID');
    expect((await post('sig_parked', { add: ['parked:page under maintenance'] })).statusCode).toBe(201);
    // CR-039: a regime term may carry digits after a letter; no other word list may
    expect((await post('regime', { add: ['ets2', 'iso27001'] })).statusCode).toBe(201);
    expect((await bad('regime', { add: ['2ets'] }))[1]).toBe('LIST_TERM_INVALID');
  });

  it('at most 5000 terms per list', async () => {
    const { post } = await setup();
    const many = Array.from({ length: 5001 }, (_, i) => `t${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + Math.floor(i / 676))}`);
    const r = await post('event', { replace: many });
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'LIST_TERM_INVALID']);
  });

  it('LIST_NAME_INVALID for a name that is neither a fixed list nor a census list; replace and add together; READ token 403', async () => {
    const { post, r } = await setup();
    expect(err(await post('brandx', { replace: ['acme'] }))).toEqual([422, 'LIST_NAME_INVALID']);
    expect(err(await post('Bt1_X', { replace: ['acme'] }))).toEqual([422, 'LIST_NAME_INVALID']);
    expect(err(await post('brand', { replace: ['acme'], add: ['x1x'] }))).toEqual([422, 'LIST_NO_CHANGE']);
    const res = await app.inject({ method: 'POST', url: '/selection/lists/brand', headers: { ...r.auth, 'idempotency-key': randomUUID() }, payload: { replace: ['acme'] } });
    expect(res.statusCode).toBe(403);
  });

  it('lists are append-only', async () => {
    const { post } = await setup();
    await post('brand', { replace: ['acme'] });
    await expect(db.updateTable('selection_lists').set({ note: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('selection_lists').execute()).rejects.toThrow(/append-only/);
  });

  it('concurrent writes get distinct versions (no lost update)', async () => {
    const { post } = await setup();
    const rs = await Promise.all([post('event', { add: ['election'] }), post('event', { add: ['eclipse'] }), post('event', { add: ['olympics'] })]);
    expect(rs.map((x) => x.statusCode)).toEqual([201, 201, 201]);
    const rows = await db.selectFrom('selection_lists').select(['version', 'terms']).where('name', '=', 'event').orderBy('version').execute();
    expect(rows.map((x) => x.version)).toEqual([1, 2, 3]);
    expect(rows[2]!.terms).toEqual(['eclipse', 'election', 'olympics']);
  });
});

describe('census lists (CR-002 CAP-10)', () => {
  it('19 names: 422 CENSUS_LIST_SIZE', async () => {
    const { post } = await setup();
    const r = await post('bt1_netextend', { replace: siblings(19), approval_ref: approval() });
    expect([r.statusCode, r.json().error.code, r.json().error.details]).toEqual([422, 'CENSUS_LIST_SIZE', { list: 'bt1_netextend', expected: 20, got: 19 }]);
  });

  it('20 names with odd spellings are normalised; the list is stored lowercase and sorted; the approval is required first', async () => {
    const { post, get } = await setup();
    const names = siblings(20, ['NetXpand.COM.', ' Net-Stretch.com ']);
    expect(err(await post('bt1_netextend', { replace: names }))).toEqual([422, 'APPROVAL_REQUIRED']);
    const r = await post('bt1_netextend', { replace: names, approval_ref: approval() });
    expect([r.statusCode, r.json()]).toEqual([201, { name: 'bt1_netextend', version: 1, terms_n: 20 }]);
    const got = (await get('/selection/lists/bt1_netextend')).json().terms as string[];
    expect(got).toHaveLength(20);
    expect(got).toContain('netxpand.com');
    expect(got).toContain('net-stretch.com');
    expect([...got].sort()).toEqual(got);
  });

  it('rows that cannot be normalised (.net, www., IDN, subdomain, empty) -> 422 CENSUS_LIST_INVALID naming them', async () => {
    const { post } = await setup();
    for (const odd of ['sibling.net', 'www.sibling.com', 'bücher.com', 'a.b.com', '']) {
      const r = await post('bt1_netextend', { replace: siblings(20, [odd]), approval_ref: approval() });
      expect([odd, r.statusCode, r.json().error.code]).toEqual([odd, 422, 'CENSUS_LIST_INVALID']);
      expect(r.json().error.details.invalid[0].term).toBe(odd);
    }
  });

  it('duplicates (after normalising) and the target name itself are refused', async () => {
    const { post } = await setup();
    const dup = await post('bt1_netextend', { replace: siblings(19, ['SiblingAa.com']).concat('siblingaa.com'), approval_ref: approval() });
    expect([dup.statusCode, dup.json().error.code, dup.json().error.details.duplicates]).toEqual([422, 'CENSUS_LIST_INVALID', ['siblingaa.com']]);
    const self = await post('bt1_netextend', { replace: siblings(20, ['NetExtend.com.']), approval_ref: approval() });
    expect([self.statusCode, self.json().error.code, self.json().error.details.invalid[0].reason]).toEqual([422, 'CENSUS_LIST_INVALID', 'the target name is not its own sibling']);
  });

  it('a census list is replaced whole (add/remove refused) and re-freezing the same names is no change; a new set is version 2', async () => {
    const { post } = await setup();
    const names = siblings(20);
    expect((await post('s6_regime_audit', { replace: names, approval_ref: approval() })).json().version).toBe(1);
    expect(err(await post('s6_regime_audit', { add: ['x.com'], approval_ref: approval() }))).toEqual([422, 'CENSUS_LIST_INVALID']);
    expect(err(await post('s6_regime_audit', { replace: names, approval_ref: approval() }))).toEqual([422, 'LIST_NO_CHANGE']);
    const other = siblings(19).concat('another.com');
    expect((await post('s6_regime_audit', { replace: other, approval_ref: approval() })).json().version).toBe(2);
  });

  it('the approval must name the list (or the target sld): a valid but unrelated one is APPROVAL_INVALID; the text is stored with the list', async () => {
    const { post } = await setup();
    const names = siblings(20);
    for (const text of ['Dvir: freeze the census', 'Dvir: freeze bt1_netextendx', 'Dvir: freeze xbt1_netextend']) {
      expect(err(await post('bt1_netextend', { replace: names, approval_ref: approval(text) }))).toEqual([422, 'APPROVAL_INVALID']);
    }
    expect(err(await post('s6_regime_audit', { replace: names, approval_ref: approval('Dvir: freeze bt1_netextend') }))).toEqual([422, 'APPROVAL_INVALID']);
    expect((await post('bt1_netextend', { replace: names, approval_ref: approval('Dvir: ok, freeze netextend.com census') })).statusCode).toBe(201);
    const row = await db.selectFrom('selection_lists').select('approval_text').where('name', '=', 'bt1_netextend').executeTakeFirstOrThrow();
    expect(row.approval_text).toBe('Dvir: ok, freeze netextend.com census');
    await post('brand', { replace: ['acme'] });
    expect((await db.selectFrom('selection_lists').select('approval_text').where('name', '=', 'brand').executeTakeFirstOrThrow()).approval_text).toBeNull();
  });

  it('approval problems on a census list: invalid, expired', async () => {
    const { post } = await setup();
    const stale = { text: 'old', approved_at: new Date(Date.now() - 100 * 3_600_000).toISOString() };
    expect(err(await post('bt1_netextend', { replace: siblings(20), approval_ref: stale }))).toEqual([422, 'APPROVAL_EXPIRED']);
    expect(err(await post('bt1_netextend', { replace: siblings(20), approval_ref: { text: '', approved_at: new Date().toISOString() } }))).toEqual([422, 'APPROVAL_INVALID']);
    expect(await db.selectFrom('selection_lists').select('name').where('name', 'like', 'bt1_%').execute()).toHaveLength(0);
  });

  it('the census size is the sibling_count setting of the active version (data, not code)', async () => {
    const { post } = await setup();
    await app.inject({ method: 'POST', url: '/selection/settings', headers: { ...(await issueToken('write', 'g2')).auth, 'idempotency-key': randomUUID() }, payload: { label: 'v1b', set: { 'census.sibling_count': 10 } } });
    const w3 = await issueToken('write', 'g3');
    await app.inject({ method: 'POST', url: '/selection/settings/v1b/activate', headers: { ...w3.auth, 'idempotency-key': randomUUID() }, payload: { approval_ref: approval('Dvir: activate v1b') } });
    expect((await post('bt1_netextend', { replace: siblings(10), approval_ref: approval() })).statusCode).toBe(201);
  });
});
