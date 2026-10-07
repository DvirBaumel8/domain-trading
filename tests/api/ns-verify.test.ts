import { describe, expect, it } from 'vitest';
import { NsVerifier } from '../../src/jobs/ns-verify.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';

const NOW = Date.parse('2026-10-06T03:00:00Z');
const v = (lookup: (d: string) => Promise<string[] | null>) => new NsVerifier({ db, nsLookup: lookup, now: () => NOW });
const row = (d: string) => db.selectFrom('domains').select(['ns_verified_at']).where('domain', '=', d).executeTakeFirstOrThrow();

describe('NsVerifier', () => {
  it('L-13: DNS shows the afternic pair → ns_verified_at set', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    expect(await v(async () => ['NS2.AFTERNIC.COM', 'ns1.afternic.com']).runOnce()).toMatchObject({ checked: 1, verified: 1 });
    expect((await row('a.com')).ns_verified_at?.getTime()).toBe(NOW);
  });

  it('mismatch clears a previous verification', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: new Date(NOW - 86_400_000) });
    expect(await v(async () => ['ns1.porkbun.com', 'ns2.porkbun.com']).runOnce()).toMatchObject({ cleared: 1 });
    expect((await row('a.com')).ns_verified_at).toBeNull();
  });

  it('lookup failure (null) changes nothing', async () => {
    const at = new Date(NOW - 86_400_000);
    await insertOwnedDomain(db, { domain: 'a.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: at });
    expect(await v(async () => null).runOnce()).toMatchObject({ unknown: 1 });
    expect((await row('a.com')).ns_verified_at?.getTime()).toBe(at.getTime());
  });

  it('skips sold/dropped domains and domains without a lander target', async () => {
    await insertOwnedDomain(db, { domain: 'sold.com', status: 'sold', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    await insertOwnedDomain(db, { domain: 'none.com' });
    expect(await v(async () => ['x']).runOnce()).toMatchObject({ checked: 0 });
  });

  it('overlapping runs: the second is skipped', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    const job = v(async () => ['ns1.afternic.com', 'ns2.afternic.com']);
    const [a, b] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  });

  it('race: a lander_ns changed by /list after the read is not marked verified', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    const lookup = async () => {
      await db.updateTable('domains').set({ lander_ns: ['ns1.sedo.com', 'ns2.sedo.com'] }).where('domain', '=', 'a.com').execute(); // concurrent change during the DNS lookup
      return ['ns1.afternic.com', 'ns2.afternic.com'];
    };
    await v(lookup).runOnce();
    expect((await row('a.com')).ns_verified_at).toBeNull();
  });
});
