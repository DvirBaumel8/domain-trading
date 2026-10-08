// R1b item 5: GET /selection/test-sets/{name} does not load result rows while the run is going, and remembers the features of a finished run.
import { http } from 'msw';
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../src/core/rdap.js';
import { clearFeaturesCache } from '../../src/modules/selection/test-sets.js';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const rdap: RdapLookupFn = async () => notRegistered();
const sqls: string[] = [];
const counter: KyselyPlugin = {
  transformQuery(args: PluginTransformQueryArgs) { sqls.push(db.getExecutor().compileQuery(args.node, args.queryId).sql); return args.node; },
  async transformResult(args: PluginTransformResultArgs) { return args.result; },
};
const rowReads = () => sqls.filter((s) => /from "screening_results"/.test(s) && /^select/.test(s) && !/count\(\*\)|array_agg/.test(s)).length;

describe('R1b-5 light progress reads', () => {
  it('no result rows are read while the run is going; the finished set is read once and then remembered per run', async () => {
    clearFeaturesCache();
    mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
    const x = await screeningHarness({ stopAfterResults: 1, screening: { rdapLookup: rdap }, db: db.withPlugin(counter) });
    app = x.app;
    const when = new Date(x.clock.t - 3_600_000).toISOString();
    expect((await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: { text: 'sibling method bt1@v1 approved', approved_at: when } })).statusCode).toBe(201);
    const row = (domain: string, label: 'sold' | 'dropped') => ({ domain, label, as_of: '2024-06-01', source: 'unit', ...(label === 'sold' && { price_usd: 900 }) });
    const r = await x.post('/selection/test-sets', { name: 'TS-LIGHT', purpose: 'new', sibling_method: 'bt1@v1', seed: 'k', rows: [row('superhealth.com', 'sold'), row('supertech.com', 'dropped')] });
    expect(r.statusCode, r.body).toBe(202);
    await app.screeningWorker.idle();

    sqls.length = 0;
    const early = (await x.get('/selection/test-sets/TS-LIGHT')).json();
    expect(early).toMatchObject({ status: 'computing', run: { status: 'running', names_n: 2, done_n: 0 }, features: null });
    expect(rowReads()).toBe(0);
    expect(early.run.done_n).toBeGreaterThanOrEqual(0);

    await app.screeningWorker.runToEnd(r.json().run_id);
    sqls.length = 0;
    const a = (await x.get('/selection/test-sets/TS-LIGHT')).json();
    expect(a).toMatchObject({ status: 'ready', run: { status: 'done', names_n: 2, done_n: 2 }, features: { census_known_n: 2 } });
    expect(rowReads()).toBe(1);
    sqls.length = 0;
    const b = (await x.get('/selection/test-sets/TS-LIGHT')).json();
    expect(b).toEqual(a);
    expect(rowReads()).toBe(0);
  });
});
