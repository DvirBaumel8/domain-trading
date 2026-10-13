// v4.0.0: the two selection reads the portfolio jobs use: screenedNames (the holdout pool) and rerunLookalikes (the CR-043 check for one name, outside a run).
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { rerunLookalikes, screenedNames } from '../../../src/modules/selection/portfolio-support.js';
import { testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, screeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const HOUR = 3_600_000;
const facts = { registrar: 'Fake', created_at: '2020-01-01T00:00:00Z', expires_at: null, updated_at: null, statuses: [], nameservers: [] };
const registered = (): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(), body: '{}', facts });
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null });

async function seedRun(at: Date, names: { domain: string; fail?: boolean }[], over: { backtest?: boolean } = {}): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('activation_seq', 'is not', null).orderBy('activation_seq', 'desc').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const plan = planFor(sel.values as never, 'S3');
  await db.insertInto('screening_runs').values({
    id, created_at: at, created_by: 'intakeScreening', mode: 'full', backtest: over.backtest ?? false, settings_id: sel.id, settings_label: sel.label, buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify({ S3: plan, S4: plan, S6: plan }), list_versions: '{}', status: 'done', deadline_at: new Date(at.getTime() + HOUR), finished_at: at,
  }).execute();
  for (const [idx, n] of names.entries()) {
    for (const check of plan) {
      const failing = n.fail === true && check === 'form';
      let fields: Record<string, unknown> = {};
      if (check === 'price') fields = { bin_cents: 148800, ratio_at_bin: 3, ratio_at_floor: 2, score_0_100: 50, floor_cents: 96700, ev_cents: 301, P_sale: 0.1, p_passive: 0.01 };
      if (check === 'quote') fields = { registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1208, quoted_at: at.toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: true, fired: 'A' };
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: 'S3', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status: failing ? 'FAIL' : 'PASS',
        reason_code: failing ? 'SPELL' : null, reason: failing ? 'seeded' : null, fields: JSON.stringify(fields), checked_at: at, settings_label: sel.label, list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (!n.fail) for (const kind of ['tm_us', 'history'] as const) await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: at, created_by: 'gavriel' }).execute();
  }
  return id;
}

describe('screenedNames (the holdout pool)', () => {
  it('PSU-1: lists passed and rejected names of finished full-plan runs since a date, newest screening first, never a backtest or an older run', async () => {
    const x = await screeningHarness({ screening: { rdapLookup: async () => free() } });
    app = x.app;
    await patchActiveSettings(['buy_hold'], false);
    const recent = new Date(x.clock.t - 2 * HOUR);
    const runId = await seedRun(recent, [{ domain: 'goodname.com' }, { domain: 'badname.com', fail: true }]);
    await seedRun(new Date(x.clock.t - 40 * 24 * HOUR), [{ domain: 'oldname.com' }]);
    await seedRun(recent, [{ domain: 'backtested.com' }], { backtest: true });
    const got = await screenedNames(db, new Date(x.clock.t - 30 * 24 * HOUR));
    expect(got).toEqual(expect.arrayContaining([{ domain: 'goodname.com', run_id: runId, passed: true }, { domain: 'badname.com', run_id: runId, passed: false }]));
    expect(got.map((g) => g.domain)).not.toContain('oldname.com');
    expect(got.map((g) => g.domain)).not.toContain('backtested.com');
  });
});

describe('rerunLookalikes', () => {
  it('PSU-2: re-runs the CR-043 check for one name with the stored word split: registered and in-use counts; null when the check is switched off', async () => {
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
    const SLD = 'rooferdrone';
    const table: Record<string, RdapLookup> = { [`${SLD}.net`]: registered(), [`${SLD}.org`]: registered() };
    mswServer.use(
      http.get(`https://${SLD}.net/robots.txt`, () => new HttpResponse(null, { status: 404 })),
      http.get(`https://${SLD}.net/`, () => new HttpResponse('<html><body>' + 'We build drones that inspect roofs for insurers and contractors. '.repeat(10) + '</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })),
      http.get(`https://${SLD}.org/robots.txt`, () => new HttpResponse(null, { status: 404 })),
      http.get(`https://${SLD}.org/`, () => new HttpResponse('<html><body>This domain is for sale. Buy this domain.</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    const deps = {
      fetch: globalThis.fetch, sleep: async () => {}, checkService: undefined as never, rdapLookup: async (d: string) => table[d] ?? free(),
      dnsQuery: async () => ({ rcode: 3, answers: [] }), resolveNs: async () => [], resolve4: async () => [],
      siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch,
      lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    };
    const x = await screeningHarness({ screening: { rdapLookup: async () => free() } });
    app = x.app;
    const counts = await rerunLookalikes(db, deps, `${SLD}.com`, () => x.clock.t);
    expect(counts).not.toBeNull();
    expect(counts!.registered_n).toBe(2);
    expect(counts!.in_use_n).toBeGreaterThanOrEqual(1);
    await patchActiveSettings(['lookalikes'], { enabled: false, endings: ['net'], prefixes: [], timeout_ms: 5000, max_bytes: 100000, max_checks: 3 });
    expect(await rerunLookalikes(db, deps, `${SLD}.com`, () => x.clock.t)).toBeNull();
  });
});
