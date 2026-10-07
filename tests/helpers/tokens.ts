import { createApiToken } from '../../src/admin/tokens.js';
import { testDb } from './db.js';

let n = 0;
export async function issueToken(scope: 'read' | 'write' | 'intake', name?: string) {
  const { id, token } = await createApiToken(testDb, { name: name ?? `test-${scope}-${++n}`, scope });
  return { id, token, auth: { authorization: `Bearer ${token}` } };
}
