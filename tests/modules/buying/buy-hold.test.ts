// Task 8 (R1): BUY_HOLD on /buy for a screened name only; a dry run reports it; a never-screened name keeps today's behaviour.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../../src/core/rdap.js';
import { DOMAIN, T0, buyBody, readyToBuy } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { putBrandLists, screeningHarness } from '../../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';

async function setup() {
  const pb = new FakeAdapter('porkbun');
  const x = await screeningHarness({ start: T0, adapters: [pb], rdap: rdapFree });
  app = x.app;
  await putBrandLists();
  return { x, pb };
}
const buy = (x: Awaited<ReturnType<typeof setup>>['x'], body: object) => x.post('/buy', body);

describe('/buy BUY_HOLD (v1.1.0, additive)', () => {
  it('a screened name while buy_hold is on: 409 BUY_HOLD with the settings version and run, no registrar call, audited', async () => {
    const { x, pb } = await setup();
    const { id } = await x.runDone({ checks: ['form'], names: [{ domain: DOMAIN, lane: 'S3' }] });
    const res = await buy(x, buyBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'BUY_HOLD', details: { settings_version: 'v1', run_id: id } });
    expect(pb.calls).toEqual([]);
    const a = await db.selectFrom('audit_log').selectAll().where('path', '=', '/buy').execute();
    expect(a.some((r) => r.status_code === 409)).toBe(true);
    expect(await db.selectFrom('purchases').selectAll().execute()).toHaveLength(0);
  });

  it('dry_run is never blocked: it succeeds and reports would_be_blocked: BUY_HOLD', async () => {
    const { x } = await setup();
    await x.runDone({ checks: ['form'], names: [{ domain: DOMAIN, lane: 'S3' }] });
    const res = await buy(x, buyBody({ dry_run: true }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, would_be_blocked: 'BUY_HOLD' });
  });

  it('dry run, no pack: screening_pack status none + advisory SCREENING_PACK_REQUIRED; would_be_blocked is BUY_HOLD (screened) or SCREENING_PACK_REQUIRED (never screened, v2.0.0)', async () => {
    const { x } = await setup();
    await x.runDone({ checks: ['form'], names: [{ domain: DOMAIN, lane: 'S3' }] });
    const screened = (await buy(x, buyBody({ dry_run: true }))).json();
    expect(screened).toMatchObject({ would_be_blocked: 'BUY_HOLD', screening_pack: { status: 'none', pack_id: null, version: null }, advisories: ['SCREENING_PACK_REQUIRED'] });
    const never = (await buy(x, buyBody({ dry_run: true, domain: 'tampapoolsco.com' }))).json();
    expect(never.would_be_blocked).toBe('SCREENING_PACK_REQUIRED');
    expect(never).toMatchObject({ screening_pack: { status: 'none' }, advisories: ['SCREENING_PACK_REQUIRED'] });
  });

  it('dry run with a complete latest pack: its id and version, no advisory; an incomplete one keeps the advisory; a real buy without a pack is refused (v2.0.0)', async () => {
    const { x, pb } = await setup();
    const { id } = await x.runDone({ checks: ['form'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    const put = (version: number, status: 'complete' | 'incomplete') => db.insertInto('screening_packs').values({
      id: `pk_00000000000${version}`, domain: 'tampapoolsco.com', version, run_id: id, item_idx: 0, status, missing: '[]', content: '{}', content_sha256: String(version).repeat(64),
      settings_label: 'v1', issued_at: new Date(T0), issued_by: 'test',
    }).execute();
    await put(1, 'complete');
    const d1 = (await buy(x, buyBody({ dry_run: true, domain: 'tampapoolsco.com' }))).json();
    expect(d1.screening_pack).toMatchObject({ status: 'complete', pack_id: 'pk_000000000001', version: 1 });
    expect(d1.advisories).toEqual([]);
    await put(2, 'incomplete');
    const d2 = (await buy(x, buyBody({ dry_run: true, domain: 'tampapoolsco.com' }))).json();
    expect(d2).toMatchObject({ screening_pack: { status: 'incomplete', version: 2 }, advisories: ['SCREENING_PACK_REQUIRED'] });
    const real = await buy(x, buyBody()); // DOMAIN: never screened, no pack
    expect([real.statusCode, real.json().error.details.reason, pb.realRegisterCalls]).toEqual([409, 'NO_PACK', 0]);
  });

  it('dry run: a pack from an older run than the domain\'s latest screening run adds PACK_NOT_FROM_LATEST_RUN', async () => {
    const { x } = await setup();
    const { id } = await x.runDone({ checks: ['form'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    await db.insertInto('screening_packs').values({
      id: 'pk_000000000001', domain: 'tampapoolsco.com', version: 1, run_id: id, item_idx: 0, status: 'complete', missing: '[]', content: '{}', content_sha256: '1'.repeat(64),
      settings_label: 'v1', issued_at: new Date(T0), issued_by: 'test',
    }).execute();
    expect((await buy(x, buyBody({ dry_run: true, domain: 'tampapoolsco.com' }))).json().advisories).toEqual([]);
    await x.runDone({ checks: ['form'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    expect((await buy(x, buyBody({ dry_run: true, domain: 'tampapoolsco.com' }))).json().advisories).toEqual(['PACK_NOT_FROM_LATEST_RUN']);
  });

  it('a name never screened: no BUY_HOLD; since v2.0.0 it is refused for the missing pack instead (and needs a tranche)', async () => {
    const { x, pb } = await setup();
    const dry = await buy(x, buyBody({ dry_run: true }));
    expect(dry.statusCode).toBe(200);
    expect(dry.json().would_be_blocked).toBe('SCREENING_PACK_REQUIRED');
    const real = await buy(x, buyBody());
    expect(real.statusCode).toBe(409);
    expect(real.json().error).toMatchObject({ code: 'SCREENING_PACK_REQUIRED', details: { reason: 'NO_PACK' } });
    expect(pb.realRegisterCalls).toBe(0);
  });

  it('a screening of a different name does not hold this name', async () => {
    const { x } = await setup();
    await x.runDone({ checks: ['form'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    await readyToBuy(DOMAIN); // v2.0.0: pack + tranche for this name; the other name's run stays held
    expect((await buy(x, buyBody())).statusCode).toBe(201);
  });

  it('a later backtest run of the name still holds it (a backtest counts as held)', async () => {
    const { x } = await setup();
    await x.runDone({ checks: ['form'], names: [{ domain: DOMAIN, lane: 'S3' }] });
    await x.post('/selection/settings', { label: 'bt', set: { 'tranche.size': 12 } });
    const bt = await x.runDone({ checks: ['form'], mode: 'full', settings: 'bt', names: [{ domain: DOMAIN, lane: 'S3' }] });
    expect(bt.body.backtest).toBe(true);
    const res = await buy(x, buyBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'BUY_HOLD', details: { run_id: bt.id } });
  });

  it('a run under a version that is no longer active still holds', async () => {
    const { x, pb } = await setup();
    const { id } = await x.runDone({ checks: ['form'], names: [{ domain: DOMAIN, lane: 'S3' }] });
    await x.post('/selection/settings', { label: 'v1b', set: { 'tranche.size': 12 } });
    const act = await x.post('/selection/settings/v1b/activate', { approval_ref: { text: 'Dvir: activate v1b', approved_at: new Date(T0 - 3_600_000).toISOString() } });
    expect(act.statusCode).toBe(200);
    const res = await buy(x, buyBody());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'BUY_HOLD', details: { run_id: id, settings_version: 'v1' } });
    expect(pb.calls).toEqual([]);
  });

  it('a mixed-case domain against a screened name is held', async () => {
    const { x } = await setup();
    await x.runDone({ checks: ['form'], names: [{ domain: DOMAIN, lane: 'S3' }] });
    const mixed = 'ExampleCityRoofing.COM';
    const res = await buy(x, buyBody({ domain: mixed, approval_ref: { text: `yes buy ${mixed} up to $11.50`, approved_at: new Date(T0 - 3_600_000).toISOString() } }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUY_HOLD');
  });

  it('a run that lists the name but has written no result yet holds it', async () => {
    const { x } = await setup();
    const t = Date.now();
    const sel = await db.selectFrom('selection_settings').select(['id', 'label']).where('label', '=', 'v1').executeTakeFirstOrThrow();
    await db.insertInto('screening_runs').values({
      id: 'run_pending', created_by: 't', mode: 'live', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
      input: JSON.stringify({ names: [{ idx: 0, domain: DOMAIN, lane: 'S3', leads_ab: 0 }] }), gate_plan: JSON.stringify({ S3: ['form'] }), list_versions: '{}',
      status: 'running', deadline_at: new Date(t + 3_600_000),
    }).execute();
    const res = await buy(x, buyBody());
    expect(res.json().error).toMatchObject({ code: 'BUY_HOLD', details: { run_id: 'run_pending' } });
  });

  it('a run under a version with the hold off does not hold the name', async () => {
    const { x } = await setup();
    const v1 = await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow();
    await db.insertInto('selection_settings').values({
      values: JSON.stringify({ ...(v1.values as object), buy_hold: false }), created_by: 't', activated_by: 't', activation_approval_text: 'a',
      activation_approval_at: new Date(), activated_at: new Date(), label: 'vh', activation_seq: 2,
    }).execute();
    const r = await x.runDone({ checks: ['form'], names: [{ domain: DOMAIN, lane: 'S3' }] });
    expect(r.body).toMatchObject({ settings_version: 'vh', buy_hold: false });
    await readyToBuy(DOMAIN); // v2.0.0: a pack from the latest run + a tranche
    expect((await buy(x, buyBody())).statusCode).toBe(201);
  });
});
