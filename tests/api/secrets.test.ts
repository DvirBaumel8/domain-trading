import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import { logCapture, makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('AU-8 (step-1 scope): secrets never leak', () => {
  it('responses, logs and audit rows contain no env secret, no pk1_/sk1_ prefix and no bearer token', async () => {
    const logs = logCapture();
    app = await makeApp({ logStream: logs.stream });
    const w = await issueToken('write');
    const r = await issueToken('read');
    const bodies: string[] = [];
    const reqs = [
      { method: 'GET' as const, url: '/health', headers: {} },
      { method: 'GET' as const, url: '/__test/ping', headers: r.auth },
      { method: 'GET' as const, url: '/__test/ping', headers: { authorization: 'Bearer dt_wrong' } },
      { method: 'POST' as const, url: '/__test/echo', headers: { ...w.auth, 'idempotency-key': 's1' }, payload: { value: 'x' } },
      { method: 'POST' as const, url: '/__test/echo', headers: { ...r.auth, 'idempotency-key': 's2' }, payload: { value: 'x' } },
      { method: 'POST' as const, url: '/__test/boom', headers: { ...w.auth, 'idempotency-key': 's3' }, payload: {} },
    ];
    for (const q of reqs) bodies.push((await app.inject(q)).body);
    const audit = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute());
    const haystack = [bodies.join('\n'), logs.text(), audit].join('\n');

    const secrets = loadConfig(testEnv()).secretValues.filter((s) => s.length >= 6); // skip the 2-char docker password
    for (const s of [...secrets, w.token, r.token]) expect(haystack).not.toContain(s);
    expect(haystack).not.toMatch(/pk1_|sk1_/);
  });
});
