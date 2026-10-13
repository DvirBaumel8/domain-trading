// v4.0.0: CR-048: LTO_NOT_ALLOWED by name type through POST /list (the /buy side is in tests/modules/buying/portfolio-buy.test.ts).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const approval = { text: `yes list ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() };
const body = { mode: 'hybrid', bin: 1995, lto_max_months: 12, override: true, override_reason: 'lease test', approval_ref: approval };

async function list(over: Parameters<typeof insertOwnedDomain>[1], payload: object = body) {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  const auth = (await issueToken('write')).auth;
  await insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null, ...over });
  return app.inject({ method: 'POST', url: `/list/${D}`, headers: { ...auth, 'idempotency-key': randomUUID() }, payload });
}

describe('LTO by name type (CR-048)', () => {
  it('LTO-2: lto_max_months is 422 LTO_NOT_ALLOWED on a trend name, even with an override and an approval', async () => {
    const res = await list({ horizon: 'trend' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('LTO_NOT_ALLOWED');
  });

  it('LTO-3: it is refused on a regulation name and on a name whose drop_date is its first expiry', async () => {
    expect((await list({ horizon: 'regulation' })).json().error.code).toBe('LTO_NOT_ALLOWED');
    await app.close();
    await db.deleteFrom('domains').execute();
    expect((await list({ drop_date: '2027-10-04' })).json().error.code).toBe('LTO_NOT_ALLOWED');
  });

  it('LTO-4: an evergreen name that renews is not refused by the horizon rule (the existing rules, an override with approval, still apply)', async () => {
    const res = await list({});
    expect(res.json().error?.message ?? '').not.toMatch(/first expiry/);
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.selectFrom('domains').select('lto_max_months').where('domain', '=', D).executeTakeFirstOrThrow()).lto_max_months).toBe(12);
  });
});
