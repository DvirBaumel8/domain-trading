import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';

const run = promisify(execFile);
const cli = (args: string[]) =>
  run('npx', ['tsx', 'src/admin.ts', ...args], { env: { ...process.env, ...testEnv() } });

describe('admin CLI', () => {
  it('token create prints the token once and stores only its hash', async () => {
    const { stdout } = await cli(['token', 'create', '--scope', 'read', '--name', 'gavriel-read']);
    const token = /dt_[A-Za-z0-9_-]{43}/.exec(stdout)?.[0];
    expect(token).toBeDefined();
    const rows = await db.selectFrom('api_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('token list shows tokens without hashes; token revoke revokes', async () => {
    await cli(['token', 'create', '--scope', 'write', '--name', 'gavriel-write']);
    const list = (await cli(['token', 'list'])).stdout;
    expect(list).toContain('gavriel-write');
    expect(list).not.toMatch(/[0-9a-f]{64}/);
    await cli(['token', 'revoke', '--id', '1']);
    const row = await db.selectFrom('api_tokens').select('revoked_at').where('id', '=', 1).executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
  });

  it('bad usage exits 2', async () => {
    await expect(cli(['token', 'create', '--scope', 'admin', '--name', 'x'])).rejects.toMatchObject({ code: 2 });
    await expect(cli(['nope'])).rejects.toMatchObject({ code: 2 });
  });

  it('doctor reports DB, migrations and adapters and never prints a secret', async () => {
    const { stdout } = await cli(['doctor']);
    expect(stdout).toMatch(/db: ok/);
    expect(stdout).toMatch(/migrations: 9 applied/);
    expect(stdout).toMatch(/porkbun: enabled/);
    for (const secret of ['pk1_', 'sk1_', 'fake_godaddy_pat', 'github_pat_fake', ':dt@']) {
      expect(stdout).not.toContain(secret);
    }
  });
});
