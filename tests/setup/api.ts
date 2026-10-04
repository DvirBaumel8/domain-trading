import { afterAll, beforeEach } from 'vitest';
import { resetDb, testDb } from '../helpers/db.js';

beforeEach(async () => {
  await resetDb(testDb);
});

afterAll(async () => {
  await testDb.destroy();
});
