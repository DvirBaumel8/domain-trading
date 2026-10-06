// Task 8 (R1): BUY_HOLD on /buy for a screened name only; a dry run reports it; a never-screened name keeps today's behaviour.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../src/rdap.js';
import { DOMAIN, T0, buyBody } from '../helpers/buy.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { putBrandLists, screeningHarness } from '../helpers/screening.js';

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

  it('a name never screened: /buy behaves as before (no BUY_HOLD, no would_be_blocked), with or without a tranche', async () => {
    const { x, pb } = await setup();
    const dry = await buy(x, buyBody({ dry_run: true }));
    expect(dry.statusCode).toBe(200);
    expect(dry.json().would_be_blocked).toBeUndefined();
    const real = await buy(x, buyBody());
    expect(real.statusCode).toBe(201);
    expect(pb.realRegisterCalls).toBe(1);
  });

  it('a screening of a different name does not hold this one', async () => {
    const { x } = await setup();
    await x.runDone({ checks: ['form'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    expect((await buy(x, buyBody())).statusCode).toBe(201);
  });
});
