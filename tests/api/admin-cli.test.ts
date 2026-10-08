import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';

const run = promisify(execFile);
const cli = (args: string[]) =>
  run('npx', ['tsx', 'src/modules/ops/admin.ts', ...args], { env: { ...process.env, ...testEnv() } });

describe('admin CLI', () => {
  it('token create prints the token once and stores only its hash', async () => {
    const { stdout } = await cli(['token', 'create', '--scope', 'read', '--name', 'gavriel-read']);
    const token = /dt_[A-Za-z0-9_-]{43}/.exec(stdout)?.[0];
    expect(token).toBeDefined();
    const rows = await db.selectFrom('api_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('V214 token create accepts --scope intake (v2.14.0)', async () => {
    const { stdout } = await cli(['token', 'create', '--scope', 'intake', '--name', 'scout-cli']);
    expect(stdout).toContain('(intake, "scout-cli")');
    expect((await db.selectFrom('api_tokens').select('scope').executeTakeFirstOrThrow()).scope).toBe('intake');
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
    expect(stdout).toMatch(/migrations: 24 applied/);
    expect(stdout).toMatch(/porkbun: enabled/);
    for (const secret of ['pk1_', 'sk1_', 'fake_godaddy_pat', 'github_pat_fake', ':dt@']) {
      expect(stdout).not.toContain(secret);
    }
  });

  describe('resolve-purchase (v2.16.0)', () => {
    async function seed(state: 'unknown' | 'register_sent' | 'succeeded' | 'created', domain = 'stuck.com') {
      await db.insertInto('quotes').values({
        check_id: `chk_${domain}`, domain, registrar: 'porkbun', available: true, premium: false, first_year_cents: 1108, renewal_cents: 1108,
        privacy_cents_per_year: 0, two_year_cents: 2216, eligible: true, exclusion_reason: null, raw: null,
      }).execute();
      const p = await db.insertInto('purchases').values({
        idempotency_key: `k-${domain}`, request_hash: 'h', domain, state, registrar: 'porkbun', check_id: `chk_${domain}`,
        max_price_cents: 1150, approval_text: `buy ${domain}`, approval_at: new Date(), expected_cents: 1108,
        request: JSON.stringify({ domain }), audit_id: `aud_${'a'.repeat(32)}`,
      }).returning('id').executeTakeFirstOrThrow();
      await db.insertInto('domains').values({ domain, status: 'pending_purchase', registrar: 'porkbun', category: 'geo' }).execute();
      return p.id;
    }

    it('marks an unknown purchase failed, releases the pending domain row and audits it (scope admin)', async () => {
      const id = await seed('unknown');
      const { stdout } = await cli(['resolve-purchase', '--id', String(id), '--fail', '--reason', 'checked the Porkbun account: not registered']);
      expect(stdout).toContain('unknown -> failed');
      expect((await db.selectFrom('purchases').select('state').where('id', '=', id).executeTakeFirstOrThrow()).state).toBe('failed');
      expect(await db.selectFrom('domains').select('id').where('domain', '=', 'stuck.com').execute()).toHaveLength(0);
      const a = await db.selectFrom('audit_log').selectAll().where('path', '=', 'resolve-purchase').executeTakeFirstOrThrow();
      expect(a).toMatchObject({ scope: 'admin', status_code: 200 });
      expect(JSON.stringify(a.request)).toContain('not registered');
    });

    it('also resolves register_sent; refuses succeeded and created, and a missing --reason or --fail', async () => {
      const sent = await seed('register_sent', 'sent.com');
      await cli(['resolve-purchase', '--id', String(sent), '--fail', '--reason', 'x']);
      expect((await db.selectFrom('purchases').select('state').where('id', '=', sent).executeTakeFirstOrThrow()).state).toBe('failed');
      for (const [state, domain] of [['succeeded', 'done.com'], ['created', 'new.com']] as const) {
        const id = await seed(state, domain);
        await expect(cli(['resolve-purchase', '--id', String(id), '--fail', '--reason', 'x'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('INVALID_STATE') });
        expect((await db.selectFrom('purchases').select('state').where('id', '=', id).executeTakeFirstOrThrow()).state).toBe(state);
        expect(await db.selectFrom('domains').select('id').where('domain', '=', domain).execute()).toHaveLength(1);
      }
      await expect(cli(['resolve-purchase', '--id', String(sent), '--fail'])).rejects.toMatchObject({ code: 2 });
      await expect(cli(['resolve-purchase', '--id', String(sent), '--reason', 'x'])).rejects.toMatchObject({ code: 2 });
      await expect(cli(['resolve-purchase', '--id', '99999', '--fail', '--reason', 'x'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('PURCHASE_NOT_FOUND') });
    });
  });
});
