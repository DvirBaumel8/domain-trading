// v4.0.0: CR-045 item 5 (as amended): the outreach log, the per-name cap, replies and sales per 100 emails. The service sends nothing.
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
const NOW = Date.parse('2027-03-10T09:00:00Z');
const at = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  await insertOwnedDomain(db, { domain: D, status: 'listed', category: 'trend', price_grade: null });
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
}
const send = (w: Record<string, string>, over: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/outreach/emails', headers: { ...w, 'idempotency-key': randomUUID() }, payload: { domain: D, recipient_domain: 'acme-roofing.com', sent_at: at(1), ...over } });

describe('POST /outreach/emails', () => {
  it('EM-1: logs a send with the company domain only, no reply yet', async () => {
    const { w } = await setup();
    const res = await send(w);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ domain: D, recipient_domain: 'acme-roofing.com', reply: false, outcome: null, emails_for_name: 1, max_emails_per_name: 5 });
  });

  it('EM-2: the 6th email for one name is 409 EMAIL_CAP and nothing is stored; other names are unaffected', async () => {
    const { w } = await setup();
    for (let i = 1; i <= 5; i++) expect((await send(w, { recipient_domain: `firm${i}.com`, sent_at: at(i) })).statusCode).toBe(201);
    const sixth = await send(w, { recipient_domain: 'firm6.com', sent_at: at(9) });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error).toMatchObject({ code: 'EMAIL_CAP', details: { domain: D, emails: 5, max_emails_per_name: 5 } });
    expect(await db.selectFrom('outreach_emails').select('id').execute()).toHaveLength(5);
    await insertOwnedDomain(db, { domain: 'secondname.com', status: 'listed', category: 'trend', price_grade: null });
    expect((await send(w, { domain: 'secondname.com' })).statusCode).toBe(201);
  });

  it('EM-3: the same send again (domain, recipient, sent_at) only sets its reply and outcome; it is not another email', async () => {
    const { w } = await setup();
    const a = await send(w);
    for (let i = 2; i <= 5; i++) await send(w, { recipient_domain: `firm${i}.com`, sent_at: at(i) });
    const upd = await send(w, { reply: true, outcome: 'interested' });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json()).toMatchObject({ id: a.json().id, reply: true, outcome: 'interested', emails_for_name: 5 });
    expect(await db.selectFrom('outreach_emails').select('id').execute()).toHaveLength(5);
  });

  it('EM-4: anything that looks like an address or a person is refused in recipient_domain (NO_PII); a bad domain, a future time and an unknown name are refused', async () => {
    const { w } = await setup();
    for (const rc of ['john@acme.com', 'John Smith', 'mailto:a@b.com', 'https://acme.com/x', '<a@b.co>', ' ']) {
      const res = await send(w, { recipient_domain: rc });
      expect([422], rc).toContain(res.statusCode);
    }
    expect((await send(w, { recipient_domain: 'john@acme.com' })).json().error.code).toBe('NO_PII');
    expect((await send(w, { recipient_domain: 'nodots' })).json().error.code).toBe('VALIDATION_ERROR');
    expect(await db.selectFrom('outreach_emails').select('id').execute()).toHaveLength(0);
  });

  it('EM-4b: a future time, a bad time, an unknown name and a non-boolean reply are refused', async () => {
    const { w } = await setup();
    expect((await send(w, { sent_at: new Date(NOW + 3_600_000).toISOString() })).statusCode).toBe(422);
    expect((await send(w, { sent_at: '2027-03-10 09:00' })).statusCode).toBe(422);
    expect((await send(w, { domain: 'nothere.com' })).statusCode).toBe(404);
    expect((await send(w, { reply: 'yes' })).statusCode).toBe(422);
    expect(await db.selectFrom('outreach_emails').select('id').execute()).toHaveLength(0);
  });

  it('EM-5: a READ token cannot write; the same Idempotency-Key replays one row', async () => {
    const { w, r } = await setup();
    expect((await send(r)).statusCode).toBe(403);
    const k = randomUUID();
    const body = { domain: D, recipient_domain: 'acme.com', sent_at: at(1) };
    const a = await app.inject({ method: 'POST', url: '/outreach/emails', headers: { ...w, 'idempotency-key': k }, payload: body });
    const b = await app.inject({ method: 'POST', url: '/outreach/emails', headers: { ...w, 'idempotency-key': k }, payload: body });
    expect(b.json()).toEqual(a.json());
    expect(await db.selectFrom('outreach_emails').select('id').execute()).toHaveLength(1);
  });
});

describe('GET /outreach/emails/summary', () => {
  it('EM-6: replies and sales per 100 emails, per name; a sale before the first email does not count', async () => {
    const { w, r } = await setup();
    expect((await app.inject({ method: 'GET', url: '/outreach/emails/summary', headers: r })).json()).toMatchObject({ emails: 0, replies_per_100_emails: null, sales_per_100_emails: null, names: [] });
    for (let i = 1; i <= 4; i++) await send(w, { recipient_domain: `firm${i}.com`, sent_at: at(10 - i), reply: i <= 1 });
    const id = (await db.selectFrom('domains').select('id').where('domain', '=', D).executeTakeFirstOrThrow()).id;
    await db.insertInto('ledger_entries').values({ occurred_on: '2027-03-10', type: 'sale', amount_cents: 148800, domain_id: id }).execute();
    const ledgerId = (await db.selectFrom('ledger_entries').select('id').where('type', '=', 'sale').executeTakeFirstOrThrow()).id;
    await db.insertInto('sales').values({ domain_id: id, sale_ledger_id: ledgerId, venue: 'afternic', sale_price_cents: 148800, commission_cents: 1, sold_at: new Date(NOW), recorded_by: 'x', confirmed: true }).execute();
    const s = (await app.inject({ method: 'GET', url: '/outreach/emails/summary', headers: r })).json();
    expect(s).toMatchObject({ emails: 4, replies: 1, sales_after_outreach: 1, replies_per_100_emails: 25, sales_per_100_emails: 25, max_emails_per_name: 5 });
    expect(s.names).toEqual([{ domain: D, emails: 4, replies: 1, sold_after_outreach: true, at_cap: false }]);
  });
});
