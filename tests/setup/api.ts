import { afterAll, beforeEach } from 'vitest';
import { resetHostPacers } from '../../src/modules/selection/rdap-batch.js';
import { resetDb, testDb } from '../helpers/db.js';

beforeEach(async () => {
  resetHostPacers();
  await resetDb(testDb);
});

afterAll(async () => {
  await testDb.destroy();
});
