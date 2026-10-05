import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { newPricingSettings } from '../../src/admin/pricing-settings.js';
import { currentSettings } from '../../src/pricing/settings.js';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { makeApp } from '../helpers/app.js';

const run = promisify(execFile);
// relative to the real clock: currentSettings(db, new Date()) must see the new version as effective
const now = new Date(Date.now() - 60_000);
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const approval = { approvalText: 'Dvir: set floor to 60%', approvalAt: hourAgo };

describe('pricing-settings admin (PR-31, PR-32)', () => {
  it('creates version 3 from current with --set, keeps v2 intact, records approval and an admin audit row', async () => {
    const { version } = await newPricingSettings(db, { set: { floor_bps: '6000' }, ...approval, now });
    expect(version).toBe(3);
    const rows = await db.selectFrom('pricing_settings').select(['version', 'floor_bps', 'walkaway_bps', 'approval_text']).orderBy('version').execute();
    expect(rows).toEqual([
      { version: 2, floor_bps: 6500, walkaway_bps: 4800, approval_text: expect.stringContaining('v2') },
      { version: 3, floor_bps: 6000, walkaway_bps: 4800, approval_text: 'Dvir: set floor to 60%' },
    ]);
    expect((await currentSettings(db, new Date())).version).toBe(3);
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', 'pricing-settings new').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.approval_text).toBe('Dvir: set floor to 60%');
    expect(audit[0]!.approval_at).toEqual(new Date(approval.approvalAt));
    expect(JSON.stringify(audit[0]!.request)).toContain('"floor_bps":"6000"');
  });

  it('refuses without approval text, with an unknown key, or with values that break an invariant', async () => {
    await expect(newPricingSettings(db, { set: { floor_bps: '6000' }, approvalText: '  ', approvalAt: approval.approvalAt, now })).rejects.toThrow(/approval/i);
    await expect(newPricingSettings(db, { set: { nope: '1' }, ...approval, now })).rejects.toThrow(/unknown/i);
    await expect(newPricingSettings(db, { set: { walkaway_bps: '7000' }, ...approval, now })).rejects.toThrow(/pricing_settings_check|check constraint/);
    await expectNothingWritten();
  });

  async function expectNothingWritten() {
    expect(await db.selectFrom('pricing_settings').select('version').execute()).toHaveLength(1);
    expect(await db.selectFrom('audit_log').select('id').where('path', '=', 'pricing-settings new').execute()).toHaveLength(0);
  }

  it('rejects unknown/protected keys: version, effective_at, approval_text', async () => {
    for (const k of ['version', 'effective_at', 'approval_text']) {
      await expect(newPricingSettings(db, { set: { [k]: '9' }, ...approval, now })).rejects.toThrow(/unknown/i);
    }
    await expectNothingWritten();
  });

  it('rejects cross-field violations and bad shapes, writing nothing', async () => {
    const bad: Record<string, string>[] = [
      { geo_bin_strong_cents: '44900' },
      { drops: '[{"after_months":4,"pct_bps":2000},{"after_months":8,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]' },
      { drops: '[{"after_months":18,"pct_bps":2000},{"after_months":6,"pct_bps":2000}]' },
      { hybrid_min_offer_cents: '60000' },
      { drops: '[{"afterMonths":4,"pctBps":2000}]' },
    ];
    for (const set of bad) await expect(newPricingSettings(db, { set, ...approval, now })).rejects.toThrow();
    await expectNothingWritten();
  });

  it('requires at least one --set and a strict ISO approval-at with offset', async () => {
    await expect(newPricingSettings(db, { set: {}, ...approval, now })).rejects.toThrow(/--set/);
    await expect(newPricingSettings(db, { set: { floor_bps: '6000' }, approvalText: 'x', approvalAt: 'Oct 5 2026', now })).rejects.toThrow(/ISO/);
    await expect(newPricingSettings(db, { set: { floor_bps: '6000' }, approvalText: 'x', approvalAt: '2026-10-05T10:00:00', now })).rejects.toThrow(/ISO/);
    await expectNothingWritten();
  });

  it('refuses an approval-at in the future', async () => {
    await expect(newPricingSettings(db, { set: { floor_bps: '6000' }, approvalText: 'Dvir: ok', approvalAt: new Date(Date.now() + 3_600_000).toISOString(), now })).rejects.toThrow(/future/i);
    expect(await db.selectFrom('pricing_settings').select('version').execute()).toHaveLength(1);
  });

  it('jsonb and boolean values parse (drops, geo_drops_enabled)', async () => {
    await newPricingSettings(db, { set: { drops: '[{"after_months":4,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]', geo_drops_enabled: 'false' }, ...approval, now });
    const s = await currentSettings(db, new Date());
    expect(s.drops[0]).toEqual({ afterMonths: 4, pctBps: 2000 });
    expect(s.geoDropsEnabled).toBe(false);
  });

  it('CLI: new + show work; missing --approval-text exits non-zero; output has no secret', async () => {
    const env = { ...process.env, ...testEnv() };
    await expect(run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'new', '--from-current', '--set', 'floor_bps=6000'], { env })).rejects.toMatchObject({ code: 2 });
    const ok = await run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'new', '--from-current', '--set', 'floor_bps=6000',
      '--approval-text', 'Dvir: 60%', '--approval-at', hourAgo], { env });
    expect(ok.stdout).toMatch(/version 3/);
    const show = await run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'show'], { env });
    expect(show.stdout).toMatch(/"floor_bps": 6000/);
    expect(show.stdout).not.toMatch(/pk1_|sk1_/);
  });

  it('CLI: --from-current is optional; no --set exits 2', async () => {
    const env = { ...process.env, ...testEnv() };
    await expect(run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'new', '--approval-text', 'x', '--approval-at', hourAgo], { env })).rejects.toMatchObject({ code: 2 });
    const ok = await run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'new', '--set', 'floor_bps=6000', '--approval-text', 'Dvir: 60%', '--approval-at', hourAgo], { env });
    expect(ok.stdout).toMatch(/version 3/);
  });

  it('PR-31: no API route writes pricing_settings (route table)', async () => {
    const app = await makeApp({ testRoutes: false });
    for (const r of app.routeTable) {
      if (r.method !== 'GET' && r.method !== 'HEAD') expect(r.url).not.toMatch(/pricing|settings/i);
    }
    await app.close();
  });
});
