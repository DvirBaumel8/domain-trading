// v2.3.0 (CR-007 T-3): a token with expires_at <= now is an unknown token.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expireApiToken, listApiTokens } from '../../../src/modules/ops/admin/tokens.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('api token expiry', () => {
  it('works before expires_at and is 401 UNAUTHORIZED (same message as an unknown token) from expires_at on', async () => {
    const clock = { t: Date.parse('2026-10-20T09:00:00Z') };
    app = await makeApp({ now: () => clock.t, testRoutes: false });
    const tok = await issueToken('read');
    expect(await expireApiToken(db, tok.id, new Date('2026-10-20T09:30:00Z'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/portfolio', headers: tok.auth })).statusCode).toBe(200);
    clock.t = Date.parse('2026-10-20T09:30:00Z');
    const res = await app.inject({ method: 'GET', url: '/portfolio', headers: tok.auth });
    const unknown = await app.inject({ method: 'GET', url: '/portfolio', headers: { authorization: 'Bearer dt_unknown_token' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(res.json()).toEqual(unknown.json());
  });

  it('a past time expires at once; list shows the expiry; an unknown or revoked id is false', async () => {
    const tok = await issueToken('write', 'w1');
    expect(await expireApiToken(db, tok.id, new Date('2020-01-01T00:00:00Z'))).toBe(true);
    expect(await expireApiToken(db, 99999, new Date())).toBe(false);
    const row = (await listApiTokens(db)).find((t) => t.id === tok.id)!;
    expect(row.expires_at?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    app = await makeApp({ testRoutes: false });
    expect((await app.inject({ method: 'GET', url: '/portfolio', headers: tok.auth })).statusCode).toBe(401);
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', 'token expire').execute();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(tok.token);
  });
});

describe('npm run admin -- token expire', () => {
  const run = promisify(execFile);
  const cli = (args: string[]) => run('npx', ['tsx', 'src/modules/ops/admin.ts', ...args], { env: { ...process.env, ...testEnv() } });
  it('refuses an unparseable time (exit 2) and lists an expiry', async () => {
    const tok = await issueToken('read', 'cli-exp');
    await expect(cli(['token', 'expire', '--id', String(tok.id), '--at', 'tomorrow'])).rejects.toMatchObject({ code: 2 });
    await cli(['token', 'expire', '--id', String(tok.id), '--at', '2031-01-01T00:00:00+02:00']);
    const list = (await cli(['token', 'list'])).stdout;
    expect(list).toContain('expires 2030-12-31T22:00:00.000Z');
  });
});
