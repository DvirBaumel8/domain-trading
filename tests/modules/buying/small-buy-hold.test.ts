// v3.7.0: CR-031 B (offer dry run), CR-031 C (hand listings per venue), CR-033 G-1, G-2, G-3, G-6, G-8, G-9.
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { newAuditId } from '../../../src/http/audit.js';
import { RegistrarCheckJob } from '../../../src/modules/ops/jobs/registrar-check.js';
import { PorkbunAdapter } from '../../../src/modules/registrars/porkbun.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { buyBody, postBuy } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { FAKE_KEYS, PORKBUN_BASE } from '../../helpers/porkbun-msw.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const AFN = ['ns1.afternic.com', 'ns2.afternic.com'];
const key = () => randomUUID();
const get = (url: string, auth: Record<string, string>) => app.inject({ method: 'GET', url, headers: auth });
const post = (url: string, auth: Record<string, string>, payload: object) =>
  app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': key() }, payload });
const reportWarnings = async (auth: Record<string, string>) =>
  (await get('/report', auth)).json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('v3.7.0 CR-033 G-3: small_buy in GET /selection/buy-hold', () => {
  it('T33-G3: spent, remaining, next_freed_at and the purchases', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read')).auth;
    const empty = (await get('/selection/buy-hold', read)).json().small_buy;
    expect(empty).toMatchObject({ cap_cents: 5000, spent_7d_cents: 0, remaining_cents: 5000, next_freed_at: null, purchases: [] });
    const first = new Date(Date.now() - 2 * 3_600_000);
    const second = new Date(Date.now() - 3_600_000);
    for (const [domain, at] of [['one.com', first], ['two.com', second]] as const) {
      await db.insertInto('purchases').values({
        idempotency_key: randomUUID(), request_hash: 'h', domain, state: 'succeeded', dry_run: false, registrar: 'porkbun', max_price_cents: 1108,
        approval_text: 'small buy', approval_at: at, expected_cents: 1108, charged_cents: 1108, small_buy_exception: true, created_at: at, updated_at: at,
      }).execute();
    }
    const sb = (await get('/selection/buy-hold', read)).json().small_buy;
    expect(sb).toMatchObject({ cap_cents: 5000, spent_7d_cents: 2216, remaining_cents: 2784 });
    expect(new Date(sb.next_freed_at).getTime()).toBe(first.getTime() + 7 * 86_400_000 - (first.getTime() % 1000));
    expect(sb.purchases.map((p: { domain: string; cost_cents: number }) => [p.domain, p.cost_cents])).toEqual([['one.com', 1108], ['two.com', 1108]]);
  });
});
