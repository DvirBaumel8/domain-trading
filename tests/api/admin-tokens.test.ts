import { describe, expect, it } from 'vitest';
import { createApiToken, listApiTokens, revokeApiToken } from '../../src/admin/tokens.js';
import { hashToken } from '../../src/auth/tokens.js';
import { testDb as db } from '../helpers/db.js';

describe('admin token functions', () => {
  it('stores only the SHA-256, never the plain token', async () => {
    const { id, token } = await createApiToken(db, { name: 'gavriel-read', scope: 'read' });
    const row = await db.selectFrom('api_tokens').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.token_sha256).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('writes an admin audit row without the token', async () => {
    const { token } = await createApiToken(db, { name: 'gavriel-write', scope: 'write' });
    const rows = await db.selectFrom('audit_log').selectAll().where('scope', '=', 'admin').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'ADMIN', path: 'token create', status_code: 200 });
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('rejects a second active token with the same name, allows it after revoke', async () => {
    const { id } = await createApiToken(db, { name: 'gavriel-read', scope: 'read' });
    await expect(createApiToken(db, { name: 'gavriel-read', scope: 'read' })).rejects.toThrow();
    expect(await revokeApiToken(db, id)).toBe(true);
    await expect(createApiToken(db, { name: 'gavriel-read', scope: 'read' })).resolves.toBeDefined();
  });

  it('revoke is false for an unknown or already revoked id', async () => {
    const { id } = await createApiToken(db, { name: 'x', scope: 'read' });
    expect(await revokeApiToken(db, id)).toBe(true);
    expect(await revokeApiToken(db, id)).toBe(false);
    expect(await revokeApiToken(db, 99999)).toBe(false);
  });

  it('list never includes the hash', async () => {
    await createApiToken(db, { name: 'x', scope: 'read' });
    const list = await listApiTokens(db);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!)).not.toContain('token_sha256');
  });
});
