import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb as db } from '../helpers/db.js';
import { currentSettings, rowToSettings, settingsByVersion } from '../../src/pricing/settings.js';

async function insertV3(effectiveAt: Date): Promise<void> {
  const v2 = await db.selectFrom('pricing_settings').selectAll().where('version', '=', 2).executeTakeFirstOrThrow();
  await db.insertInto('pricing_settings').values({
    ...v2, version: 3, effective_at: effectiveAt,
    geo_drops: JSON.stringify(v2.geo_drops), drops: JSON.stringify(v2.drops),
  } as never).execute();
}

describe('pricing settings loader', () => {
  beforeEach(async () => { await resetDb(db); });

  it('currentSettings returns v2 with camelCase jsonb', async () => {
    const s = await currentSettings(db, new Date());
    expect(s.version).toBe(2);
    expect(s.drops).toEqual([{ afterMonths: 6, pctBps: 2000 }, { afterMonths: 18, pctBps: 2000 }]);
    expect(s.geoDrops).toEqual([{ afterMonths: 12, fromCents: 49900, toCents: 39900 }]);
    expect(s.finalPushMode).toBe('bin_to_floor_ceil95');
  });
  it('a future v3 is not yet in effect', async () => {
    await insertV3(new Date(Date.now() + 86_400_000));
    expect((await currentSettings(db, new Date())).version).toBe(2);
  });
  it('a past v3 is current', async () => {
    await insertV3(new Date(Date.now() - 86_400_000));
    expect((await currentSettings(db, new Date())).version).toBe(3);
  });
  it('settingsByVersion(99) is null', async () => {
    expect(await settingsByVersion(db, 99)).toBeNull();
  });
  it('rowToSettings rejects camelCase keys or extra keys in drops', async () => {
    const v2 = await db.selectFrom('pricing_settings').selectAll().where('version', '=', 2).executeTakeFirstOrThrow();
    expect(() => rowToSettings({ ...v2, drops: [{ afterMonths: 6, pctBps: 2000 }] })).toThrow();
    expect(() => rowToSettings({ ...v2, drops: [{ after_months: 6, pct_bps: 2000, extra: 1 }] })).toThrow();
  });
});
