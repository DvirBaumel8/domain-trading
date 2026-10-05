import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const get = async (qs: string, auth: Record<string, string>) => app.inject({ method: 'GET', url: `/pricing/preview?${qs}`, headers: auth });

describe('GET /pricing/preview (§10.6)', () => {
  it('matches the spec example: trend 1995, listed 2026-10-12, drop 2028-10-04', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const res = await get('category=trend&bin=1995&listed_on=2026-10-12&drop_date=2028-10-04', auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      settings_version: 2, category: 'trend', mode: 'hybrid', pricing_source: 'formula', grade: null,
      bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, min_offer_cents: 10000,
      display: { bin: '$1,995', floor: '$1,295', walkaway: '$960 (private)', min_offer: '$100' },
      net_at_15pct: { bin: '$1,695.75', floor: '$1,100.75', walkaway: '$816.00' },
      schedule: [
        { event: 'drop1_m6', due_on: '2027-04-12', bin: '$1,595', floor: '$1,035', walkaway: '$770', status: 'planned' },
        { event: 'drop2_m18', due_on: '2028-04-12', bin: '$1,295', floor: '$830', walkaway: '$615', status: 'planned' },
        { event: 'final_push', due_on: '2028-07-06', bin: '$895', floor: '$830', walkaway: '$615', status: 'planned' },
        { event: 'delist', due_on: '2028-09-27', status: 'planned' },
      ],
      afternic_row: 'example.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N',
      sell_plan_line: 'hybrid · BIN $1,995 · floor (auto-accept) $1,295 · walk-away (private) $960 · min offer $100 · LTO off · M6 2027-04-12 $1,595/$1,035/$770 · M18 2028-04-12 $1,295/$830/$615 · final push 2028-07-06 $895/$830/$615 · delist 2028-09-27 · settings v2',
      warnings: ['FLOOR_AUTO_ACCEPT'],
    });
  });

  it('D-001 exception via domain: afternic_row uses display_name; 950 never in afternic_row (OF-14 part)', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await insertOwnedDomain(db, { domain: 'promptinjectionaudit.com', display_name: 'PromptInjectionAudit.com', category: 'trend', expiry_date: '2027-10-04', drop_date: '2028-10-04' });
    const b = (await get('category=trend&bin=1995&floor=1295&walkaway=950&listed_on=2026-10-12&domain=promptinjectionaudit.com', auth)).json();
    expect(b).toMatchObject({ pricing_source: 'approved_exception', walkaway_cents: 95000, afternic_row: 'PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N' });
    expect(b.afternic_row).not.toContain('950');
    expect(b.warnings).toEqual(expect.arrayContaining(['PRICING_EXCEPTION', 'FLOOR_AUTO_ACCEPT']));
    expect(b.schedule[2]).toMatchObject({ event: 'final_push', due_on: '2028-07-06', bin: '$895', floor: '$830', walkaway: '$610' });
  });

  it('geo strong preview: bin row, M12 + delist, sell_plan_line starts with the geo prefix', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const b = (await get('category=geo&grade=strong&listed_on=2026-11-01&drop_date=2028-11-01', auth)).json();
    expect(b).toMatchObject({ mode: 'bin', grade: 'strong', bin_cents: 49900, min_offer_cents: 49900, afternic_row: 'example.com,499,499,499,N,,Buy It Now,Y,N,N,N' });
    expect(b.schedule.map((e: { event: string }) => e.event)).toEqual(['geo_drop_m12', 'delist']);
    expect(b.sell_plan_line).toMatch(/^bin \(geo strong\) · BIN \$499 · no offers · M12 2027-11-01 \$399 · delist 2028-10-25 · settings v2$/);
  });

  it('errors use the V2/V5/V6 codes (422) and the preview has no side effects', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    expect((await get('category=trend&bin=1990', auth)).json().error.code).toBe('BIN_NOT_NICE');
    expect((await get('category=trend&bin=695', auth)).json().error.code).toBe('BIN_BELOW_FLOOR_MIN');
    expect((await get('category=geo', auth)).json().error.code).toBe('GEO_GRADE_REQUIRED');
    expect((await get('category=trend&bin=1995&floor=1295&walkaway=450', auth)).json().error.code).toBe('WALKAWAY_BELOW_MIN');
    expect((await get('category=nope&bin=1995', auth)).json().error.code).toBe('CATEGORY_REQUIRED');
    expect((await get('bin=1995', auth)).json().error.code).toBe('CATEGORY_REQUIRED');
    expect((await get('category=trend&bin=1995&listed_on=2026-13-01', auth)).statusCode).toBe(422);
    expect(await db.selectFrom('audit_log').selectAll().where('method', '<>', 'ADMIN').execute()).toHaveLength(0);
  });

  it('default dates: listed today (IDT), drop_date = listed + 2 years; skipped events shown in the line', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const b = (await get('category=trend&bin=795', auth)).json();
    expect(b.schedule[0]).toMatchObject({ event: 'drop1_m6', status: 'skipped_at_minimum' });
    expect(b.sell_plan_line).toMatch(/M6 skipped \(minimum\)/);
    expect(b.warnings).toContain('FLOOR_RAISED_TO_MIN');
  });

  it('READ token 200; no token 401', async () => {
    app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/pricing/preview?category=trend&bin=1995' })).statusCode).toBe(401);
  });
});
