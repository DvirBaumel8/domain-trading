// v4.2.0 (CR-044 item 3 + CR-045 item 1): the renewal drop check keeps a name whose latest keyword upload shows at least demand.keep_min_searches searches.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { readyToBuy } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { patchActiveSettings } from '../../helpers/screening.js';
import { issueToken } from '../../helpers/tokens.js';
import { keywordsOfDomain, searchesOfDomain } from '../../../src/modules/selection/demand.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const clock = { t: Date.parse('2027-08-10T09:00:00Z') };
const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]).toString('base64');
const sheet = (kw: string, avg: string) => ['T', 'R', ['Keyword', 'Avg. monthly searches', 'Competition (indexed value)'].join('\t'), [kw, avg, '10'].join('\t')].join('\n');

async function setup() {
  clock.t = Date.parse('2027-08-10T09:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock.t });
  await insertOwnedDomain(db, { domain: D, status: 'listed', category: 'trend', price_grade: null });
  await db.insertInto('job_runs').values({ job: 'daily', trigger: 'scheduled', started_at: new Date(clock.t - 3_660_000), finished_at: new Date(clock.t - 3_600_000), skipped: false, ok: true, steps: '{}' }).execute();
  const ready = await readyToBuy(D);
  await db.insertInto('screening_results').values({
    run_id: ready.runId, item_idx: 0, domain: D, lane: 'S3', check_id: 'form', gate: 'G0', rule_ids: ['X'], status: 'PASS', reason_code: null, reason: null,
    fields: JSON.stringify({ tokens: ['example', 'city', 'roofing'] }), checked_at: new Date('2027-09-01T00:00:00Z'), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
  }).execute();
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
}
const upload = (w: Record<string, string>, kw: string, avg: string) =>
  app.inject({ method: 'POST', url: '/demand/keywords', headers: { ...w, 'idempotency-key': randomUUID() }, payload: { file_base64: utf16(sheet(kw, avg)) } });
const warns = async (r: Record<string, string>, code: string) =>
  ((await app.inject({ method: 'GET', url: '/report', headers: r })).json().warnings as { code: string; details: Record<string, any> }[]).filter((x) => x.code === code); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('the keyword keep-signal (CR-045 item 1 with CR-044 item 3)', () => {
  it('KK-1 no upload: no signal, the drop is suggested and the signals say so', async () => {
    const { r } = await setup();
    const d = await warns(r, 'RENEWAL_DROP_SUGGESTED');
    expect(d).toHaveLength(1);
    expect(d[0]!.details.signals).toMatchObject({ search_band_above_unmeasured: false, keyword_searches: null });
  });

  it('KK-2 searches at the threshold (10) keep the name; 9 do not; the threshold is the setting', async () => {
    const { w, r } = await setup();
    await upload(w, 'example city roofing', '9');
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(1);
    await upload(w, 'example city roofing', '10');
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0);
    await patchActiveSettings(['demand'], { ...DEFAULT_SELECTION_VALUES.demand, keep_min_searches: 11 });
    const d = await warns(r, 'RENEWAL_DROP_SUGGESTED');
    expect(d).toHaveLength(1);
    expect(d[0]!.details.signals).toMatchObject({ keyword_searches: 10, search_band_above_unmeasured: false });
  });

  it('KK-3 a newer upload with no number (unmeasured) removes the signal; a keyword of another name does not count', async () => {
    const { w, r } = await setup();
    await upload(w, 'example city roofing', '500');
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(0);
    await upload(w, 'example city roofing', '');
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(1);
    await upload(w, 'something else', '900');
    expect(await warns(r, 'RENEWAL_DROP_SUGGESTED')).toHaveLength(1);
  });

  it('KK-4 with no screening form row the newest intake words are the keyword', async () => {
    const { w } = await setup();
    const other = 'otherroofer.com';
    expect(await keywordsOfDomain(db, other)).toEqual([]);
    await db.insertInto('candidate_intake').values({ domain: other, lane: 'S3', source: 'test', token_name: 'scout', status: 'queued', words: ['other', 'roofer'] }).execute();
    expect(await keywordsOfDomain(db, other)).toEqual(['other roofer']);
    await upload(w, 'other roofer', '40');
    expect(await searchesOfDomain(db, other)).toBe(40);
    expect(await searchesOfDomain(db, 'nothing.com')).toBeNull();
  });
});
