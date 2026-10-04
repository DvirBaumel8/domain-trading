import { describe, expect, it } from 'vitest';
import { CheckService } from '../../src/services/check.js';
import { BuyService } from '../../src/services/buy.js';
import { spentCents } from '../../src/services/budget.js';
import { resetDb, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { seedSpent } from '../helpers/buy.js';

describe('CAP-6: −Σ(registration+renewal+fee) ≤ poc_cap_cents after any sequence', () => {
  it('200 random sequences of parallel buys', { timeout: 180_000 }, async () => {
    let seed = 42;
    const rnd = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    for (let s = 0; s < 200; s++) {
      await resetDb(db);
      const start = rnd(50001);
      if (start > 0) await seedSpent(start);
      const price = 500 + rnd(20000);
      const pb = new FakeAdapter('porkbun', { quote: { firstYearCents: price, renewalCents: price }, account: { spendLimitRemainingCents: null } });
      const checkService = new CheckService({ db, adapters: [pb], rdap: async () => 'not_registered', now: Date.now });
      const svc = new BuyService({ db, adapters: [pb], checkService, rdap: async () => 'not_registered', now: Date.now, sleep: async () => {} });
      const n = 1 + rnd(4);
      await Promise.allSettled(Array.from({ length: n }, (_, i) => {
        const domain = `p${s}x${i}.com`;
        return svc.buy(
          { domain, maxPriceCents: 100_000, maxTwoYearCents: null, approval: { text: domain, approved_at: new Date().toISOString() },
            dealId: null, category: 'geo', proposedListing: null, override: false, overrideReason: null, registrar: null,
            dryRun: false, autoList: false, requestBody: { domain } },
          { idempotencyKey: `cap-${s}-${i}`, requestHash: 'h', auditId: `aud_${'0'.repeat(32)}` },
        );
      }));
      const cap = (await db.selectFrom('settings').select('poc_cap_cents').executeTakeFirstOrThrow()).poc_cap_cents;
      expect(await spentCents(db), `sequence ${s}`).toBeLessThanOrEqual(cap);
    }
  });
});
