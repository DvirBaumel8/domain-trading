import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { logCapture, makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { checkDomainBody, PORKBUN_BASE, pbError } from '../helpers/porkbun-msw.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const RDAP = 'https://rdap.verisign.com/com/v1/domain/:d';

describe('/check with the real Porkbun adapter (MSW)', () => {
  it('free .com → available, Porkbun winner, prices from the decimal strings', async () => {
    mswServer.use(
      http.get(RDAP, () => new HttpResponse(null, { status: 404, headers: { 'content-type': 'application/rdap+json' } })),
      http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => HttpResponse.json(checkDomainBody())),
    );
    app = await makeApp(); // default wiring: createAdapters(config) + rdapStatus
    const { auth } = await issueToken('read');
    const b = (await app.inject({ method: 'GET', url: '/check?domain=examplecityroofing.com', headers: auth })).json();
    expect(b).toMatchObject({ availability: 'available', winner: { registrar: 'porkbun', two_year: '$22.16' } });
  });

  it('AU-8 (step 2): a Porkbun error leaks no key into the response, logs or stored quotes', async () => {
    mswServer.use(
      http.get(RDAP, () => new HttpResponse(null, { status: 404, headers: { 'content-type': 'application/rdap+json' } })),
      http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => pbError('INVALID_API_KEYS_001', {}, { status: 403 })),
    );
    const logs = logCapture();
    app = await makeApp({ logStream: logs.stream });
    const { auth, token } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/check?domain=examplecityroofing.com', headers: auth });
    expect(res.json().quotes[0]).toMatchObject({ exclusion_reason: 'ADAPTER_ERROR', error_code: 'INVALID_API_KEYS_001' });
    const stored = JSON.stringify(await db.selectFrom('quotes').selectAll().execute());
    const haystack = [res.body, logs.text(), stored].join('\n');
    for (const s of [...loadConfig(testEnv()).secretValues.filter((v) => v.length >= 6), token]) {
      expect(haystack).not.toContain(s);
    }
    expect(haystack).not.toMatch(/pk1_|sk1_/);
  });
});
