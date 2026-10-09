import { describe, expect, it } from 'vitest';
import { CheckService } from '../../../src/modules/registrars/check.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';

const make = (adapter: FakeAdapter) =>
  new CheckService({ db, adapters: [adapter], rdap: async () => 'not_registered', now: () => 1_000_000 });

describe('CheckService cache bypass', () => {
  it('useCache:false always calls the adapter', async () => {
    const a = new FakeAdapter('porkbun');
    const s = make(a);
    await s.check('x.com', { useCache: false });
    await s.check('x.com', { useCache: false });
    expect(a.calls.filter((c) => c.startsWith('quote'))).toHaveLength(2);
  });

  it('a useCache:false result is not written to the cache', async () => {
    const a = new FakeAdapter('porkbun');
    const s = make(a);
    const live = await s.check('x.com', { useCache: false });
    const next = await s.check('x.com');
    expect(a.calls.filter((c) => c.startsWith('quote'))).toHaveLength(2);
    expect(next.checkId).not.toBe(live.checkId);
  });
});
