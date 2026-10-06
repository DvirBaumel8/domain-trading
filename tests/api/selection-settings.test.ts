// CR-001 CAP-00 acceptance + SEL9-2 + approval gates (founder rule 4: priors and pricing are not API-editable).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SELECTION_VALUES } from '../../src/screening/settings.js';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const approval = (text = 'Dvir: activate it', ageMs = 3_600_000) => ({ text, approved_at: new Date(Date.now() - ageMs).toISOString() });

async function setup(opts: Parameters<typeof makeApp>[0] = {}) {
  // The write limiter allows 10 POSTs a minute per token: every request moves this clock on by 7 s.
  let clock = Date.now();
  app = await makeApp({ ...opts, now: () => clock });
  const w = await issueToken('write', 'gavriel');
  const r = await issueToken('read', 'gizbar');
  const post = (url: string, payload: object, auth = w.auth) => (clock += 7_000, app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': randomUUID() }, payload }));
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r.auth });
  return { w, r, post, get };
}

describe('selection settings (CAP-00)', () => {
  it('the seeded v1 is active and equals the defaults; GET without a label lists the versions', async () => {
    const { get } = await setup();
    const res = await get('/selection/settings');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.active.label).toBe('v1');
    expect(b.active.values).toEqual(DEFAULT_SELECTION_VALUES);
    expect(b.active.approval_text).toMatch(/CR-001 approved by Dvir/);
    expect(b.versions).toEqual([expect.objectContaining({ label: 'v1', created_by: 'migration', based_on: null, active: true })]);
  });

  it('the seed SQL equals DEFAULT_SELECTION_VALUES, including the v1 lists', async () => {
    await setup();
    const row = await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow();
    expect(row.values).toEqual(DEFAULT_SELECTION_VALUES);
    const lists = await db.selectFrom('selection_lists').select(['name', 'version']).orderBy('name').execute();
    expect(lists.map((l) => `${l.name}@${l.version}`)).toEqual([
      'generic_head@1', 'legal@1', 'regime@1', 'sig_forsale@1', 'sig_harmful_strong@1', 'sig_harmful_weak@1', 'sig_parked@1', 'state@1', 'tech@1', 'trade@1',
    ]);
  });

  it('draft v1b changes registered_share_min; v1 stays active until an approved activation (CAP-00 acceptance)', async () => {
    const { post, get } = await setup();
    const d = await post('/selection/settings', { label: 'v1b', set: { 'thresholds.registered_share_min': 0.4 }, note: 'looser share' });
    expect(d.statusCode).toBe(201);
    expect(d.json()).toMatchObject({ label: 'v1b', based_on: 'v1' });
    expect(d.json().values.thresholds.registered_share_min).toBe(0.4);

    const v1 = (await get('/selection/settings?label=v1')).json();
    expect([v1.active, v1.values.thresholds.registered_share_min]).toEqual([true, 0.5]);
    const v1b = (await get('/selection/settings?label=v1b')).json();
    expect([v1b.active, v1b.activated_at, v1b.based_on, v1b.created_by]).toEqual([false, null, 'v1', 'gavriel']);

    const noRef = await post('/selection/settings/v1b/activate', {});
    expect([noRef.statusCode, noRef.json().error.code]).toEqual([422, 'APPROVAL_REQUIRED']);
    expect((await get('/selection/settings')).json().active.label).toBe('v1');

    const ok = await post('/selection/settings/v1b/activate', { approval_ref: approval('Dvir: activate v1b') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().active).toBe('v1b');
    const now = (await get('/selection/settings')).json();
    expect(now.active.label).toBe('v1b');
    expect(now.active.values.thresholds.registered_share_min).toBe(0.4);
    expect(now.active.approval_text).toBe('Dvir: activate v1b');
    expect(now.versions.map((v: { label: string; active: boolean }) => [v.label, v.active])).toEqual([['v1', false], ['v1b', true]]);
  });

  it('activation approval problems: invalid, expired, future; nothing changes', async () => {
    const { post, get } = await setup();
    await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    const cases: [object, string][] = [
      [{ text: '', approved_at: new Date().toISOString() }, 'APPROVAL_INVALID'],
      [{ text: 'ok', approved_at: 'yesterday' }, 'APPROVAL_INVALID'],
      [approval('ok', 80 * 3_600_000), 'APPROVAL_EXPIRED'],
      [{ text: 'ok', approved_at: new Date(Date.now() + 3_600_000).toISOString() }, 'APPROVAL_INVALID'],
    ];
    for (const [ref, code] of cases) {
      const r = await post('/selection/settings/v1b/activate', { approval_ref: ref });
      expect([r.statusCode, r.json().error.code]).toEqual([422, code]);
    }
    expect((await get('/selection/settings')).json().active.label).toBe('v1');
  });

  it('activating the active version: 409 SETTINGS_ALREADY_ACTIVE; an unknown label: 404; a superseded one: 409 SETTINGS_ALREADY_ACTIVATED', async () => {
    const { post } = await setup();
    const again = await post('/selection/settings/v1/activate', { approval_ref: approval('Dvir: activate v1') });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'SETTINGS_ALREADY_ACTIVE']);
    const nope = await post('/selection/settings/zzz/activate', { approval_ref: approval('Dvir: activate zzz') });
    expect([nope.statusCode, nope.json().error.code]).toEqual([404, 'SETTINGS_NOT_FOUND']);
    await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    expect((await post('/selection/settings/v1b/activate', { approval_ref: approval('Dvir: activate v1b') })).statusCode).toBe(200);
    const back = await post('/selection/settings/v1/activate', { approval_ref: approval('Dvir: activate v1') });
    expect([back.statusCode, back.json().error.code]).toEqual([409, 'SETTINGS_ALREADY_ACTIVATED']);
  });

  it('bringing an old version back: a new draft based on it (identical to a non-active base is allowed), then activation', async () => {
    const { post, get } = await setup();
    await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    await post('/selection/settings/v1b/activate', { approval_ref: approval('Dvir: activate v1b') });
    const back = await post('/selection/settings', { label: 'v1c', based_on: 'v1', set: { 'tranche.size': 15 } });
    expect(back.statusCode).toBe(201);
    expect((await post('/selection/settings/v1c/activate', { approval_ref: approval('Dvir: activate v1c') })).statusCode).toBe(200);
    expect((await get('/selection/settings')).json().active.values.tranche.size).toBe(15);
  });

  it('an approval that does not name the settings label is refused: valid but unrelated, or another label that only contains it', async () => {
    const { post, get } = await setup();
    await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    for (const text of ['Dvir: yes, go ahead', 'Dvir: activate v1bb', 'Dvir: activate v1b2', 'Dvir: activate xv1b']) {
      const r = await post('/selection/settings/v1b/activate', { approval_ref: approval(text) });
      expect([text, r.statusCode, r.json().error.code]).toEqual([text, 422, 'APPROVAL_INVALID']);
    }
    expect((await get('/selection/settings')).json().active.label).toBe('v1');
    expect((await post('/selection/settings/v1b/activate', { approval_ref: approval('Dvir: activate v1b.') })).statusCode).toBe(200);
  });

  it('a draft can not change the holdout settings (the gate that clears the hold is locked), by leaf or by parent', async () => {
    const { post } = await setup();
    for (const set of [{ 'holdout.min_n': 1 }, { 'holdout.required_suites': [] }, { holdout: { ...DEFAULT_SELECTION_VALUES.holdout, sold_accept_min: 0.1 } }]) {
      const r = await post('/selection/settings', { label: 'weak', set: { ...set, buy_hold: false } });
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'SETTINGS_KEY_LOCKED']);
    }
  });

  it('the priors lock also holds against the ACTIVE version: a draft based on an old version cannot carry other priors back', async () => {
    const { post } = await setup();
    // an old version with different priors can only exist by migration; simulate one directly
    const v1 = await db.selectFrom('selection_settings').selectAll().where('label', '=', 'v1').executeTakeFirstOrThrow();
    const alt = JSON.parse(JSON.stringify(v1.values));
    alt.priors_v91.p_passive.S2 = 0.5;
    await db.insertInto('selection_settings').values({ label: 'old', values: JSON.stringify(alt), created_by: 'migration' }).execute();
    const r = await post('/selection/settings', { label: 'fromold', based_on: 'old', set: { 'tranche.size': 3 } });
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'SETTINGS_KEY_LOCKED']);
  });

  it('an idempotent replay of one /selection POST returns the same answer and writes nothing twice', async () => {
    const { w } = await setup();
    const send = () => app.inject({ method: 'POST', url: '/selection/settings', headers: { ...w.auth, 'idempotency-key': 'fixed-key-1' }, payload: { label: 'rep', set: { 'tranche.size': 12 } } });
    const a = await send();
    const b = await send();
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.json()).toEqual(a.json());
    expect(await db.selectFrom('selection_settings').select('id').where('label', '=', 'rep').execute()).toHaveLength(1);
    expect(await db.selectFrom('audit_log').select('id').where('path', '=', '/selection/settings').execute()).toHaveLength(2);
  });

  it('the same label activated twice at once: one 200, the other a clean 409 (never a 500)', async () => {
    const { post } = await setup();
    await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    const rs = await Promise.all([1, 2, 3].map(() => post('/selection/settings/v1b/activate', { approval_ref: approval('Dvir: activate v1b') })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(rs.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'SETTINGS_ALREADY_ACTIVE')).toBe(true);
  });

  it('tranche.geo_max defaults to 1 (ruling R6)', async () => {
    const { get } = await setup();
    expect((await get('/selection/settings?label=v1')).json().values.tranche.geo_max).toBe(1);
  });

  it('draft errors: SETTINGS_KEY_UNKNOWN, SETTINGS_INVALID with issues, SETTINGS_NO_CHANGE, SETTINGS_LABEL_TAKEN, SETTINGS_NOT_FOUND (based_on), label shape', async () => {
    const { post } = await setup();
    const code = async (body: object) => { const r = await post('/selection/settings', body); return [r.statusCode, r.json().error.code, r.json().error.details]; };
    expect((await code({ label: 'x1', set: { 'nope.deeper': 1 } })).slice(0, 2)).toEqual([422, 'SETTINGS_KEY_UNKNOWN']);
    const inv = await code({ label: 'x1', set: { 'score.weights.S3.A': 14 } });
    expect(inv.slice(0, 2)).toEqual([422, 'SETTINGS_INVALID']);
    expect(JSON.stringify(inv[2])).toMatch(/sum to 100/);
    expect((await code({ label: 'x1', set: { 'run.gates.S3': ['form', 'foo'] } })).slice(0, 2)).toEqual([422, 'SETTINGS_INVALID']);
    expect((await code({ label: 'x1', set: { 'thresholds.registered_share_min': 0.5 } })).slice(0, 2)).toEqual([422, 'SETTINGS_NO_CHANGE']);
    expect((await code({ label: 'x1', based_on: 'zzz', set: { 'tranche.size': 3 } })).slice(0, 2)).toEqual([404, 'SETTINGS_NOT_FOUND']);
    expect((await post('/selection/settings', { label: 'x1', set: { 'tranche.size': 3 } })).statusCode).toBe(201);
    expect((await code({ label: 'x1', set: { 'tranche.size': 4 } })).slice(0, 2)).toEqual([409, 'SETTINGS_LABEL_TAKEN']);
    for (const bad of [{ label: 'V1', set: { a: 1 } }, { label: 'x2', set: {} }, { label: 'x2' }, { label: 'x2', set: { 'a b': 1 } }, { label: 'x2', set: { a: 1 }, extra: 1 }]) {
      const r = await post('/selection/settings', bad);
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    }
  });

  it('priors are locked against API drafts (SEL9-2): tier.p_passive, lead.p_lead, priors_v91', async () => {
    const { post } = await setup();
    for (const set of [
      { 'tier.p_passive.A': 0.03 }, { 'priors_v91.p_passive.S2': 0.02 }, { 'lead.p_lead.S3': 0.01 },
      { tier: { ...DEFAULT_SELECTION_VALUES.tier, p_passive: { A: 0.5, I: 0.02, B: 0.01, G: 0.01 } } },
    ]) {
      const r = await post('/selection/settings', { label: 'locked', set });
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'SETTINGS_KEY_LOCKED']);
    }
    expect(await db.selectFrom('selection_settings').select('label').execute()).toHaveLength(1);
  });

  it('a draft with buy_hold false is accepted, but its activation is refused until the holdout passes (409 HOLDOUT_NOT_PASSED)', async () => {
    const { post, get } = await setup();
    expect((await post('/selection/settings', { label: 'nohold', set: { buy_hold: false } })).statusCode).toBe(201);
    const r = await post('/selection/settings/nohold/activate', { approval_ref: approval('Dvir: activate nohold') });
    expect([r.statusCode, r.json().error.code, r.json().error.details]).toEqual([409, 'HOLDOUT_NOT_PASSED', { suites: [] }]);
    expect((await get('/selection/settings')).json().active.label).toBe('v1');
  });

  it('with a passing holdout check the hold clears; the check gets the target settings', async () => {
    const seen: unknown[] = [];
    const { post, get } = await setup({ holdoutCheck: async (_db, id, values, holdout) => { seen.push([id, values.buy_hold, holdout.min_n]); return { pass: true, suites: [] }; } });
    await post('/selection/settings', { label: 'nohold', set: { buy_hold: false } });
    expect((await post('/selection/settings/nohold/activate', { approval_ref: approval('Dvir: activate nohold') })).statusCode).toBe(200);
    expect(seen).toEqual([[2, false, 50]]);
    expect((await get('/selection/settings')).json().active.values.buy_hold).toBe(false);
  });

  it('a change that keeps buy_hold true needs no holdout; setting it back to true needs none either', async () => {
    const { post } = await setup({ holdoutCheck: async () => { throw new Error('must not run'); } });
    await post('/selection/settings', { label: 'a1', set: { 'tranche.size': 12 } });
    expect((await post('/selection/settings/a1/activate', { approval_ref: approval('Dvir: activate a1') })).statusCode).toBe(200);
  });

  it('a READ token cannot draft or activate (403); GET works for READ', async () => {
    const { r, get } = await setup();
    for (const url of ['/selection/settings', '/selection/settings/v1/activate', '/selection/lists/brand', '/selection/evaluate']) {
      const res = await app.inject({ method: 'POST', url, headers: { ...r.auth, 'idempotency-key': randomUUID() }, payload: {} });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    expect((await get('/selection/settings')).statusCode).toBe(200);
  });

  it('GET ?label unknown: 404 SETTINGS_NOT_FOUND; other query keys: 400', async () => {
    const { get } = await setup();
    const a = await get('/selection/settings?label=zzz');
    expect([a.statusCode, a.json().error.code]).toEqual([404, 'SETTINGS_NOT_FOUND']);
    expect((await get('/selection/settings?x=1')).statusCode).toBe(400);
  });

  it('every POST is audited with the token and the approval text; the draft row carries the audit id', async () => {
    const { post } = await setup();
    await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    await post('/selection/settings/v1b/activate', { approval_ref: approval('Dvir: activate v1b') });
    const row = await db.selectFrom('selection_settings').selectAll().where('label', '=', 'v1b').executeTakeFirstOrThrow();
    expect(row.audit_id).toMatch(/^aud_/);
    expect([row.activated_by, row.activation_approval_text, row.activation_seq]).toEqual(['gavriel', 'Dvir: activate v1b', 2]);
    const a = await db.selectFrom('audit_log').select(['path', 'approval_text', 'status_code']).where('path', 'like', '/selection/%').execute();
    expect(a.map((x) => [x.path, x.status_code]).sort()).toEqual([['/selection/settings', 201], ['/selection/settings/v1b/activate', 200]]);
    expect(a.find((x) => x.path.endsWith('/activate'))!.approval_text).toBe('Dvir: activate v1b');
  });
});

describe('selection_settings is append-only (activation columns are set once)', () => {
  it('values cannot be changed, a row cannot be deleted, an activation cannot be changed or moved', async () => {
    await setup();
    await expect(db.updateTable('selection_settings').set({ note: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('selection_settings').set({ values: '{}' }).where('label', '=', 'v1').execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('selection_settings').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('selection_settings').set({ activation_seq: 9 }).where('label', '=', 'v1').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('selection_settings').set({ activated_by: 'x' }).where('label', '=', 'v1').execute()).rejects.toThrow(/append-only/);
  });

  it('activation columns are all set or all null (CHECK)', async () => {
    const { post } = await setup();
    await post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    await expect(db.updateTable('selection_settings').set({ activation_seq: 5 }).where('label', '=', 'v1b').execute()).rejects.toThrow();
  });

  it('two activations at once: both succeed in order, the last one is active, sequence numbers are unique', async () => {
    const { post, get } = await setup();
    await post('/selection/settings', { label: 'a1', set: { 'tranche.size': 12 } });
    await post('/selection/settings', { label: 'a2', set: { 'tranche.size': 11 } });
    const [x, y] = await Promise.all([
      post('/selection/settings/a1/activate', { approval_ref: approval('Dvir: activate a1') }),
      post('/selection/settings/a2/activate', { approval_ref: approval('Dvir: activate a2') }),
    ]);
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    const rows = await db.selectFrom('selection_settings').select(['label', 'activation_seq']).orderBy('activation_seq').execute();
    expect(rows.map((r) => r.activation_seq)).toEqual([1, 2, 3]);
    const act = (await get('/selection/settings')).json().active.label;
    expect(act).toBe(rows[2]!.label);
  });
});
