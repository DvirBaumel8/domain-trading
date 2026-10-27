// v5.65.0 (F44): the renew-or-drop signal in GET /report per_domain and the RENEWAL_SIGNAL_DROP info warning. Rules: docs/internal/renewal-signal.md. Test ids RS44-*.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { judgeRenewal } from '../../../src/modules/reporting/report/renewal-signal.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2027-08-10T09:00:00Z');
const base = { views: 0, leads: 0, offers365: 0, daysToExpiry: 30, viewsMin: 10 };

const own = (domain: string, status: 'listed' | 'dropped', expiry: string) =>
  insertOwnedDomain(db, { domain, status, expiry_date: expiry, drop_date: `${Number(expiry.slice(0, 4)) + 1}${expiry.slice(4)}`, buy_date: '2026-10-04' });
const visit = (domain: string, date: string, views: number, leads: number) =>
  db.insertInto('visit_daily').values({ domain, date_utc: date, source: 'afternic', views_30d: views, leads_30d: leads } as never).execute();

async function report() {
  app = await makeApp({ now: () => NOW });
  const r = await app.inject({ method: 'GET', url: '/report', headers: (await issueToken('read')).auth });
  return r.json() as { per_domain: { domain: string; renewal_signal: Record<string, any> | null }[]; warnings: { code: string; level: string; domain?: string }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('RS44 renewal signal', () => {
  it('RS44-1 rules: too_early over 90 days; renew on a lead, an offer or enough views; reprice on a few views; drop on none; no data = null', () => {
    expect(judgeRenewal({ ...base, daysToExpiry: 91 }).signal).toBe('too_early');
    expect(judgeRenewal({ ...base, daysToExpiry: null }).signal).toBe('too_early');
    expect(judgeRenewal({ ...base, daysToExpiry: 90, leads: 1 }).signal).toBe('renew');
    expect(judgeRenewal({ ...base, offers365: 1 }).signal).toBe('renew');
    expect(judgeRenewal({ ...base, views: 10 }).signal).toBe('renew');
    expect(judgeRenewal({ ...base, views: 9 }).signal).toBe('reprice');
    expect(judgeRenewal({ ...base, views: 1 }).signal).toBe('reprice');
    expect(judgeRenewal({ ...base, views: 0 }).signal).toBe('drop');
    expect(judgeRenewal({ ...base, views: null }).signal).toBeNull();
    expect(judgeRenewal({ ...base, views: null, leads: null, offers365: 2 }).signal).toBe('renew');
  });

  it('RS44-2 per_domain carries views, leads, trend (latest 30 d vs the 30 d before), days to expiry; sold names get null', async () => {
    await own('alpha.com', 'listed', '2027-09-09'); // 30 days
    await own('beta.com', 'dropped', '2027-09-09');
    await visit('alpha.com', '2027-07-05', 20, 0);
    await visit('alpha.com', '2027-08-09', 5, 0);
    const r = await report();
    const a = r.per_domain.find((d) => d.domain === 'alpha.com')!.renewal_signal!;
    expect(a).toMatchObject({ views_30d: 5, leads_30d: 0, days_to_expiry: 30, signal: 'reprice', views_trend: { previous_30d: 20, delta: -15, direction: 'down' }, renewal_available: true });
    expect(r.per_domain.find((d) => d.domain === 'beta.com')!.renewal_signal).toBeNull();
  });

  it('RS44-3 drop + RENEWAL_SIGNAL_DROP (info) within 60 days; too_early and a name with an offer raise nothing; an offer in the last 365 days gives renew', async () => {
    await own('dead.com', 'listed', '2027-09-20'); // 41 days, 0 views
    await own('dead80.com', 'listed', '2027-10-29'); // 80 days, 0 views: drop, but no warning yet
    await own('early.com', 'listed', '2028-06-01');
    const id = await own('offered.com', 'listed', '2027-09-20');
    for (const d of ['dead.com', 'dead80.com', 'early.com', 'offered.com']) await visit(d, '2027-08-09', 0, 0);
    await db.insertInto('offers').values({ domain_id: id, amount_cents: 15000, source: 'afternic', received_at: new Date(NOW - 200 * 86_400_000), band: 'mid_range', routing: 'dvir', outcome: 'expired', recorded_by: 'gavriel' }).execute();
    const r = await report();
    const sig = (n: string) => r.per_domain.find((d) => d.domain === n)!.renewal_signal!.signal;
    expect([sig('dead.com'), sig('dead80.com'), sig('early.com'), sig('offered.com')]).toEqual(['drop', 'drop', 'too_early', 'renew']);
    const w = r.warnings.filter((x) => x.code === 'RENEWAL_SIGNAL_DROP');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'info', domain: 'dead.com' });
  });

  it('RS44-4 renew_views_min comes from settings', async () => {
    await own('gamma.com', 'listed', '2027-09-20');
    await visit('gamma.com', '2027-08-09', 12, 0);
    expect((await report()).per_domain[0]!.renewal_signal!.signal).toBe('renew');
    await app.close();
    await db.updateTable('settings').set({ renew_views_min: 20 }).execute();
    expect((await report()).per_domain[0]!.renewal_signal!.signal).toBe('reprice');
    await db.updateTable('settings').set({ renew_views_min: 10 }).execute();
  });
});
