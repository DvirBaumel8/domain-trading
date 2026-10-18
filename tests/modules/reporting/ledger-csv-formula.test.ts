import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';
import { csvSafeText } from '../../../src/modules/reporting/report/portfolio.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('L516-1 ledger CSV formula guard (G-98)', () => {
  it('L516-1: free-text cells starting with = + - @ tab CR get a leading apostrophe; numbers and plain text do not', () => {
    for (const v of ['=SUM(A1)', '+1', '-2', '@x', '\tx', '\rx']) expect(csvSafeText(v)).toBe(`'${v}`);
    for (const v of ['', 'porkbun:ord-1', 'a=b', 'x-y', '1995.00']) expect(csvSafeText(v)).toBe(v);
  });

  it('L516-1: GET /ledger?format=csv prefixes a formula-looking note and counterparty, keeps amount_usd numeric (negative stays -11.08)', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => Date.parse('2026-10-12T09:00:00Z'), rdap: async () => 'not_registered' });
    const read = await issueToken('read');
    const a = await insertOwnedDomain(db, { domain: 'alpha-one.com', deal_id: 'D-009' });
    await db.insertInto('ledger_entries').values([
      { occurred_on: '2026-10-04', domain_id: a, deal_id: 'D-009', type: 'registration', amount_cents: -1108, counterparty: '@porkbun', receipt_ref: '+ord-1', note: '=HYPERLINK("http://x","y")' },
      { occurred_on: '2026-10-12', domain_id: a, deal_id: 'D-009', type: 'sale', amount_cents: 199500, counterparty: 'afternic', receipt_ref: null, note: '-cmd|calc' },
    ]).execute();
    const r = await app.inject({ method: 'GET', url: '/ledger?format=csv', headers: read.auth });
    expect(r.body).toBe([
      'date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note',
      `2026-10-04,registration,alpha-one.com,D-009,-11.08,'@porkbun,'+ord-1,"'=HYPERLINK(""http://x"",""y"")"`,
      "2026-10-12,sale,alpha-one.com,D-009,1995.00,afternic,,'-cmd|calc",
    ].join('\r\n') + '\r\n');
  });
});
