// Task 6 checks: typo (CAP-02 TYPO-1), namebio (CAP-11), quote (CAP-17), tier (CAP-24 / DEMAND-2), price (CAP-18).
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RegistrarError } from '../../src/registrars/types.js';
import { NAMEBIO_NAME } from '../../src/screening/namebio.js';
import { POPULARITY_NAME, parsePopularityCsv } from '../../src/screening/popularity.js';
import { outcome, type Check, type CheckId } from '../../src/screening/types.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { testDb as db } from '../helpers/db.js';
import { createV3 } from '../helpers/pricing.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';

const DAY = 86_400_000;
const csv = readFileSync(new URL('../fixtures/screening/majestic-million-top.csv', import.meta.url), 'utf8');
const sample = readFileSync(new URL('../fixtures/screening/namebio/retailstats-sample.csv', import.meta.url), 'utf8');
let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(opts: Parameters<typeof screeningHarness>[0] = {}): Promise<ScreeningHarness> {
  const x = await screeningHarness(opts);
  app = x.app;
  return x;
}
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check);
const nonGeo = (domain: string, extra: object = {}) => ({ domain, lane: 'S3', ...extra });

async function seedPopularity(date: string): Promise<void> {
  const { rows } = parsePopularityCsv(csv, 10_000);
  const body = rows.map((r) => `${r.rank},${r.domain},${r.tld ?? ''}`).join('\n');
  await db.insertInto('reference_files').values({
    name: POPULARITY_NAME, source_url: 'x', fetched_at: new Date(`${date}T05:00:00Z`), data_date: date, sha256: date.padEnd(64, '0'), bytes: body.length, body_gz: gzipSync(Buffer.from(body)), same_as_id: null,
  }).execute();
}
const fake = (id: CheckId, gate: string, fields: Record<string, unknown>, status: 'PASS' | 'FLAG' = 'PASS'): Check => ({ id, gate, ruleIds: [], lists: [], run: async () => outcome(status, status === 'PASS' ? null : 'FAKE_FLAG', null, fields) });

describe('typo (CAP-02, TYPO-1)', () => {
  it('10 one-letter typos of top-1,000 names: FAIL TYPO_MATCH with the match, rank and distance', async () => {
    await seedPopularity('2026-10-06');
    const { runDone } = await h();
    const typos = ['gooogle', 'amazn', 'facebok', 'wikipedai', 'yotube', 'twiter', 'linkedn', 'netflx', 'micrsoft', 'instagam'];
    const { body } = await runDone({ checks: ['typo'], names: typos.map((t) => nonGeo(`${t}.com`)) });
    for (const n of body.names) {
      expect(res(n, 'typo')).toMatchObject({ status: 'FAIL', reason_code: 'TYPO_MATCH', gate: 'G1', fields: { typo_list_date: '2026-10-06', list_id: 'majestic-2026-10-06' } });
      expect(res(n, 'typo').fields.typo_matches[0]).toMatchObject({ distance: 1, rank: expect.any(Number) });
      expect(n.final_status).toBe('rejected');
    }
    expect(res(body.names[0], 'typo').fields.typo_matches[0]).toMatchObject({ domain: 'google', rank: 1 });
  });

  it('10 clean names pass (SEL7-2); data_as_of is the list date; a top_n above the 1,000 stored rows is noted; attribution is on the card', async () => {
    await seedPopularity('2026-10-06');
    const { runDone } = await h();
    const clean = ['boisesolarco', 'paytransparencyaudit', 'ragsecurityaudit', 'tampapoolsco', 'memphisplumbingpros', 'pittsburghroofpros', 'doraictcompliance', 'promptinjectionaudit', 'hvacchicago', 'netextend'];
    const { body } = await runDone({ checks: ['typo'], names: clean.map((t) => nonGeo(`${t}.com`)) });
    for (const n of body.names) expect(res(n, 'typo')).toMatchObject({ status: 'PASS', data_as_of: '2026-10-06T03:00:00+03:00', fields: { attribution: 'Majestic Million, Majestic (https://majestic.com), CC BY 3.0', typo_note: 'TOP_N_EXCEEDS_LIST', list_rows: 1000 } });
  });

  it('a 9-day-old list is UNKNOWN STALE_DATA (7 days is still fine); no list at all is the same', async () => {
    const { runDone } = await h();
    const one = async (d = 'gooogle') => res((await runDone({ checks: ['typo'], names: [nonGeo(`${d}.com`)] })).body.names[0], 'typo'); // (a FAIL is cached 24 h: a new name each time)
    await seedPopularity('2026-09-27');
    expect(await one()).toMatchObject({ status: 'UNKNOWN', reason_code: 'STALE_DATA', fields: { typo_list_date: '2026-09-27' } });
    await db.deleteFrom('reference_files').execute();
    await seedPopularity('2026-09-29'); // exactly 7 days before 2026-10-06 08:00: allowed
    expect((await one('amazn')).status).toBe('FAIL');
    await db.deleteFrom('reference_files').execute();
    expect(await one('twiter')).toMatchObject({ status: 'UNKNOWN', reason_code: 'STALE_DATA' });
  });

  it('sources.popularity false: UNKNOWN SOURCE_DISABLED', async () => {
    await seedPopularity('2026-10-06');
    const { runDone, post } = await h();
    await post('/selection/settings', { label: 'v1t', set: { 'sources.popularity': false } });
    const { body } = await runDone({ checks: ['typo'], mode: 'full', settings: 'v1t', names: [nonGeo('gooogle.com')] });
    expect(res(body.names[0], 'typo')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED' });
  });
});

describe('namebio (CAP-11)', () => {
  const seedNameBio = async (ageDays: number, clockT: number) => {
    await db.insertInto('reference_files').values({
      name: NAMEBIO_NAME, source_url: 'file', fetched_at: new Date(clockT - ageDays * DAY), data_date: new Date(clockT - ageDays * DAY).toISOString().slice(0, 10), sha256: 'n'.padEnd(64, '0'),
      bytes: sample.length, body_gz: gzipSync(Buffer.from(sample)), same_as_id: null,
    }).execute();
  };
  const on = async (x: ScreeningHarness) => { await x.post('/selection/settings', { label: 'v1n', set: { 'sources.namebio': true } }); return { mode: 'full', settings: 'v1n' }; };
  const geo = (trade: string) => ({ domain: `tulsa${trade}.com`, lane: 'S2', city: 'tulsa', state: 'ok', trade });

  it('disabled by default: UNKNOWN SOURCE_DISABLED, and it never gates (a feature check)', async () => {
    const x = await h();
    const { body } = await x.runDone({ checks: ['namebio'], names: [geo('plumbing')] });
    expect(res(body.names[0], 'namebio')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED', fields: { attribution: 'Data from NameBio' } });
    expect(body.names[0].final_status).toBe('not_screened'); // v2.6.0 (N-7): a plan of feature checks only has no gate
  });

  it('geo bands from the cache: 73+22 -> 9, 1+1 -> 2, 3+8 -> 6 (CAP-11 #1-#3); attribution on the card', async () => {
    const x = await h();
    await seedNameBio(0, x.clock.t);
    const opts = await on(x);
    const { body } = await x.runDone({ checks: ['namebio'], ...opts, names: [geo('plumbing'), geo('solar'), geo('hvac')] });
    const [a, b, c] = body.names.map((n: any) => res(n, 'namebio'));
    expect(a).toMatchObject({ status: 'PASS', fields: { geo_d_raw: 9, retail_start: 73, retail_end: 22, attribution: 'Data from NameBio', keywords: { plumbing: { start_count: 73, end_count: 22, exact_count: 4 } } } });
    expect(b.fields).toMatchObject({ geo_d_raw: 2 });
    expect(c.fields).toMatchObject({ geo_d_raw: 6 });
  });

  it('a keyword not in the cache: counts null and NOT_IN_CACHE (no spot API in P1a); all missing is UNKNOWN', async () => {
    const x = await h();
    await seedNameBio(0, x.clock.t);
    const opts = await on(x);
    const { body } = await x.runDone({ checks: ['namebio'], ...opts, names: [geo('zzzz')] });
    expect(res(body.names[0], 'namebio')).toMatchObject({ status: 'UNKNOWN', reason_code: 'NOT_IN_CACHE', fields: { keywords: { zzzz: null }, retail_start: null } });
  });

  it('a 3-day-old cache: UNKNOWN STALE_DATA (CAP-11 #5); GET /selection/namebio says the same', async () => {
    const x = await h();
    await seedNameBio(3, x.clock.t);
    const opts = await on(x);
    const { body } = await x.runDone({ checks: ['namebio'], ...opts, names: [geo('plumbing')] });
    expect(res(body.names[0], 'namebio')).toMatchObject({ status: 'UNKNOWN', reason_code: 'STALE_DATA' });
  });
});

describe('GET /selection/namebio', () => {
  it('validates the list (1-50 words)', async () => {
    const x = await h();
    for (const q of ['', 'keywords=', `keywords=${Array.from({ length: 51 }, (_, i) => `w${i}`).join(',')}`, 'keywords=a%20b', 'x=1']) {
      const r = await x.get(`/selection/namebio?${q}`);
      expect([r.statusCode, r.json().error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
  });

  it('disabled source: 200 UNKNOWN SOURCE_DISABLED with attribution', async () => {
    const x = await h();
    const r = await x.get('/selection/namebio?keywords=Plumbing,roofing');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ stale: true, status: 'UNKNOWN', reason_code: 'SOURCE_DISABLED', source: 'nightly_csv', attribution: 'Data from NameBio', keywords: { plumbing: null, roofing: null } });
  });
});

describe('quote (CAP-17), tier (CAP-24 / DEMAND-2) and price (CAP-18)', () => {
  const rdap = async () => 'not_registered' as const;
  const name = 'rocksolid.com';
  /** form is real; census / history / ext_dates are fakes that stand in for later tasks' checks. */
  const withFakes = (x: ScreeningHarness, over: { share?: number; prior?: number; alt?: number } = {}) => {
    const c = x.app.screeningWorker.checks;
    c.census = fake('census', 'G8', { registered_share: over.share ?? 0.65 });
    c.history = fake('history', 'G6', { prior_history: over.prior ?? 1 });
    c.ext_dates = fake('ext_dates', 'G8', { alt_tld_before_n: over.alt ?? 0 });
  };
  const checks = ['form', 'history', 'census', 'ext_dates', 'tier', 'quote', 'price'];

  it('a fresh name, tier A, Porkbun $11.08 / $11.08 at $1,488: ratios 2.28 / 1.48, PASS, would_buy while buy_hold is on', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun', { capabilities: { afternicFastTransfer: true } })], rdap });
    await createV3(db);
    withFakes(x);
    const { body } = await x.runDone({ checks, names: [nonGeo(name, { bin_usd: 1488 })] });
    const n = body.names[0];
    expect(res(n, 'quote')).toMatchObject({ status: 'PASS', gate: 'G9', fields: { registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1108, two_year_cents: 2216, two_year: '$22.16', registrar_ft_capable: true, quote_source: 'live', fallback_reason: null } });
    expect(res(n, 'tier')).toMatchObject({ status: 'PASS', fields: { tier: 'A', demand2: 'PASS' } });
    const p = res(n, 'price');
    expect(p).toMatchObject({ status: 'PASS', reason_code: null, fields: { bin_cents: 148800, lifetime_cost_cents: 2216 } });
    expect(p.fields.ratio_at_bin).toBeCloseTo(2.28, 2);
    expect(p.fields.ratio_at_floor).toBeCloseTo(1.48, 2);
    expect(n).toMatchObject({ tier: 'A', final_status: 'would_buy', score: p.fields.score_0_100 });
    expect(body.ranking).toEqual([name]);
    // it is the same number the pure evaluator gives
    const ev = await x.post('/selection/evaluate', { lane: 'S3', features: { registered_share: 0.65, prior_history: 1, alt_tld_before_n: 0, n_words: res(n, 'form').fields.word_count, sld_chars: res(n, 'form').fields.sld_len, short: res(n, 'form').fields.short, gform1_pass: 1 }, leads_ab: 0, bin_usd: 1488, first_year_usd: 11.08, renewal_usd: 11.08, domain: name, form: { sld_len: res(n, 'form').fields.sld_len, word_count: res(n, 'form').fields.word_count, short: res(n, 'form').fields.short } });
    expect(ev.json().money.ev_cents).toBe(p.fields.ev_cents);
  });

  it('ranking is exact: tier order (A, I, B), then short names first, then score', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun', { quote: { firstYearCents: 500, renewalCents: 500 } })], rdap });
    await createV3(db);
    // domain -> [registered_share, prior_history, alt_tld_before_n, word_count, sld_len, short]; the checks are fakes so each name's tier and form are set.
    const T: Record<string, [number, number, number, number, number, 0 | 1]> = {
      'atierb.com': [0.6, 0, 0, 2, 9, 0],   // tier B
      'dtieri.com': [0.3, 0, 1, 2, 9, 0],   // tier I (alt TLD before)
      'elong.com': [0.65, 1, 0, 4, 25, 0],  // tier A, long, many words: the lower score
      'bmid.com': [0.65, 1, 0, 2, 9, 0],    // tier A, normal
      'cshort.com': [0.65, 1, 0, 1, 5, 1],  // tier A, short (FORM-2)
    };
    const c = x.app.screeningWorker.checks;
    const row = (ctx: { item: { domain: string } }) => T[ctx.item.domain]!;
    c.form = { id: 'form', gate: 'G0', ruleIds: [], lists: [], run: async (ctx) => { const r = row(ctx); return outcome('PASS', null, null, { domain: ctx.item.domain, sld: ctx.item.domain.slice(0, -4), sld_len: r[4], word_count: r[3], short: r[5], gform1_pass: true, geo_length_band: 0, keywords: [], tokens: ['x'], status: 'PASS' }); } };
    c.census = { id: 'census', gate: 'G8', ruleIds: [], lists: [], run: async (ctx) => outcome('PASS', null, null, { registered_share: row(ctx)[0] }) };
    c.history = { id: 'history', gate: 'G6', ruleIds: [], lists: [], run: async (ctx) => outcome('PASS', null, null, { prior_history: row(ctx)[1] }) };
    c.ext_dates = { id: 'ext_dates', gate: 'G8', ruleIds: [], lists: [], run: async (ctx) => outcome('PASS', null, null, { alt_tld_before_n: row(ctx)[2] }) };
    const names = Object.keys(T).map((d) => nonGeo(d, { bin_usd: 1488 }));
    const { body } = await x.runDone({ checks, names });
    const by = (d: string) => body.names.find((n: any) => n.domain === d);
    expect(body.names.map((n: any) => [n.domain, n.tier, n.final_status])).toEqual([
      ['atierb.com', 'B', 'would_buy'], ['dtieri.com', 'I', 'would_buy'], ['elong.com', 'A', 'would_buy'], ['bmid.com', 'A', 'would_buy'], ['cshort.com', 'A', 'would_buy'],
    ]);
    expect(by('bmid.com').score).toBeGreaterThan(by('elong.com').score); // the premise for the order inside tier A
    expect(body.ranking).toEqual(['cshort.com', 'bmid.com', 'elong.com', 'dtieri.com', 'atierb.com']);
  });

  it('history FLAG with share 0.65: tier A is PASS_WITH_NOTE TIER_FROM_FLAGGED_INPUT, tier_exact false, flagged_inputs lists history', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun')], rdap });
    await createV3(db);
    withFakes(x);
    x.app.screeningWorker.checks.history = fake('history', 'G6', { prior_history: 1 }, 'FLAG');
    const { body } = await x.runDone({ checks, names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'tier')).toMatchObject({ status: 'PASS_WITH_NOTE', reason_code: 'TIER_FROM_FLAGGED_INPUT', fields: { tier: 'A', tier_exact: false, flagged_inputs: ['history'], demand2: 'PASS' } });
    expect(body.names[0]).toMatchObject({ tier: 'A', flags: ['history'] });
    // a flagged input the deciding clause does not read adds no note: ext_dates FLAG, tier A decided by census + history
    x.app.screeningWorker.checks.history = fake('history', 'G6', { prior_history: 1 });
    x.app.screeningWorker.checks.ext_dates = fake('ext_dates', 'G8', { alt_tld_before_n: 0 }, 'FLAG');
    const b2 = await x.runDone({ checks, names: [nonGeo('other.com', { bin_usd: 1488 })] });
    expect(res(b2.body.names[0], 'tier')).toMatchObject({ status: 'PASS', fields: { tier: 'A', flagged_inputs: ['ext_dates'] } });
  });

  it('the s6_regime_audit pattern (census 0.20, prior 1, alt 0): tier FAIL DEMAND2_FAIL (CR-002 CAP-10 #2); price still computed from the facts it has', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun')], rdap });
    await createV3(db);
    withFakes(x, { share: 0.2, prior: 1, alt: 0 });
    const { body } = await x.runDone({ checks, names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'tier')).toMatchObject({ status: 'FAIL', reason_code: 'DEMAND2_FAIL', fields: { tier: 'none', demand2: 'FAIL' } });
    expect(body.names[0]).toMatchObject({ final_status: 'rejected', first_fail: { check: 'tier', reason_code: 'DEMAND2_FAIL' } });
    expect(res(body.names[0], 'price')).toBeUndefined(); // a live run stops at the first gating failure
  });

  it('a missing feature (history not run) leaves DEMAND-2 undecided: UNKNOWN DEMAND2_UNDECIDED', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun')], rdap });
    await createV3(db);
    withFakes(x);
    const { body } = await x.runDone({ checks: ['form', 'tier'], names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'tier')).toMatchObject({ status: 'UNKNOWN', reason_code: 'DEMAND2_UNDECIDED' });
  });

  it('an adapter error: quote UNKNOWN SOURCE_ERROR, never a manual fallback, renewal never 0; price needs a quote', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun', { error: new RegistrarError('porkbun', 'REGISTRAR_UNAVAILABLE', 'down') })], rdap });
    await createV3(db);
    withFakes(x);
    const { body } = await x.runDone({ checks, names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'quote')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR', fields: { renewal_cents: null } });
    // a fresh manual quote for another registrar is no substitute for a live error
    await x.post('/quotes/manual', { domain: name, registrar: 'godaddy', renewal_usd: 12.99, first_year_usd: 9.99, source_note: 'renewal page', observed_at: new Date(x.clock.t - DAY).toISOString() });
    const again = await x.runDone({ checks: ['quote'], mode: 'full', names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(again.body.names[0], 'quote')).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR' });
    const full = await x.runDone({ checks, mode: 'full', names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(full.body.names[0], 'price')).toMatchObject({ status: 'UNKNOWN', reason_code: 'NO_QUOTE' });
  });

  it('a management-only registrar (no quote access) may be quoted by hand: fallback_reason REGISTRAR_NOT_MACHINE_QUOTABLE; a machine-quotable registrar may not', async () => {
    const gd = new FakeAdapter('godaddy', { capabilities: { canQuote: false, canRegister: false, afternicFastTransfer: true } });
    const x = await h({ start: Date.now(), adapters: [gd], rdap });
    await createV3(db);
    withFakes(x);
    await x.post('/quotes/manual', { domain: name, registrar: 'godaddy', renewal_usd: 12.99, first_year_usd: 9.99, source_note: 'renewal page', observed_at: new Date(x.clock.t - DAY).toISOString() });
    const { body } = await x.runDone({ checks: ['quote'], names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'quote')).toMatchObject({ status: 'PASS', fields: { quote_source: 'manual', fallback_reason: 'REGISTRAR_NOT_MACHINE_QUOTABLE', registrar: 'godaddy' } });
  });

  it('a manual quote for a registrar that can be machine-quoted is ignored (porkbun taken name: no winner, no fallback)', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun', { quote: { available: false } })], rdap: async () => 'registered' });
    await createV3(db);
    await x.post('/quotes/manual', { domain: name, registrar: 'porkbun', renewal_usd: 12.99, first_year_usd: 9.99, source_note: 'by hand', observed_at: new Date(x.clock.t - DAY).toISOString() });
    const { body } = await x.runDone({ checks: ['quote'], names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'quote')).toMatchObject({ status: 'UNKNOWN', reason_code: 'NO_QUOTE' });
  });

  it('a cheaper Cloudflare adapter never wins (the database refuses it in allowed_registrars; the check also filters it): the next live quote is used (founder rule 5)', async () => {
    const cf = new FakeAdapter('cloudflare', { quote: { firstYearCents: 800, renewalCents: 800 } });
    const x = await h({ start: Date.now(), adapters: [cf, new FakeAdapter('porkbun')], rdap });
    const { body } = await x.runDone({ checks: ['quote'], names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'quote')).toMatchObject({ status: 'PASS', fields: { registrar: 'porkbun', quote_source: 'live' } });
  });

  it('price judges the quote by its original quoted_at: a live quote over quote.max_age_hours (24) or a manual one over 30 days is UNKNOWN STALE_DATA', async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun')], rdap });
    await createV3(db);
    withFakes(x);
    const at = (ms: number) => new Date(x.clock.t - ms).toISOString();
    const base = { registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1108 };
    const price = async (fields: object, d: string) => {
      x.app.screeningWorker.checks.quote = fake('quote', 'G9', { ...base, ...fields });
      return res((await x.runDone({ checks, mode: 'full', names: [nonGeo(d, { bin_usd: 1488 })] })).body.names[0], 'price');
    };
    expect(await price({ quote_source: 'live', quoted_at: at(25 * 3_600_000) }, 'aone.com')).toMatchObject({ status: 'UNKNOWN', reason_code: 'STALE_DATA' });
    expect((await price({ quote_source: 'live', quoted_at: at(23 * 3_600_000) }, 'btwo.com')).status).toBe('PASS');
    expect(await price({ quote_source: 'manual', quoted_at: at(31 * DAY) }, 'cthree.com')).toMatchObject({ status: 'UNKNOWN', reason_code: 'STALE_DATA' });
    expect((await price({ quote_source: 'manual', quoted_at: at(29 * DAY) }, 'dfour.com')).status).toBe('PASS');
    expect(await price({ quote_source: 'live' }, 'efive.com')).toMatchObject({ status: 'UNKNOWN', reason_code: 'STALE_DATA' }); // no quoted_at: never assumed fresh
  });

  it('a fresh manual quote is used when no adapter quotes (GoDaddy-style); an old one is not; Cloudflare is never used', async () => {
    const x = await h({ start: Date.now(), adapters: [], rdap });
    await createV3(db);
    withFakes(x);
    const q = (extra: object) => x.post('/quotes/manual', { domain: name, registrar: 'godaddy', renewal_usd: 12.99, first_year_usd: 9.99, source_note: 'renewal page', observed_at: new Date(x.clock.t - 2 * DAY).toISOString(), ...extra });
    expect((await q({ observed_at: new Date(x.clock.t - 2 * DAY).toISOString() })).statusCode).toBe(201);
    const { body } = await x.runDone({ checks, names: [nonGeo(name, { bin_usd: 1488 })] });
    expect(res(body.names[0], 'quote')).toMatchObject({ status: 'PASS', fields: { quote_source: 'manual', fallback_reason: 'NO_ADAPTER', registrar: 'godaddy', renewal_cents: 1299, first_year_cents: 999, two_year_cents: 2298, registrar_ft_capable: null } });
    expect(res(body.names[0], 'price')).toMatchObject({ status: 'PASS', fields: { lifetime_cost_cents: 2298 } });
    // 31 days later the manual quote is too old (quote.manual_max_age_days 30)
    x.clock.t += 40 * DAY;
    await db.deleteFrom('screening_results').execute().catch(() => undefined);
    const late = await x.runDone({ checks: ['quote'], names: [nonGeo('other.com')] });
    expect(res(late.body.names[0], 'quote')).toMatchObject({ status: 'UNKNOWN', reason_code: 'NO_QUOTE' });
  });

  const failure = (code: string, quote: object, bin: number, settings?: object) => async () => {
    const x = await h({ start: Date.now(), adapters: [new FakeAdapter('porkbun', { quote })], rdap });
    await createV3(db);
    withFakes(x);
    if (settings) await x.post('/selection/settings', { label: 'v1c', set: settings });
    const { body } = await x.runDone({ checks, mode: 'full', ...(settings && { settings: 'v1c' }), names: [nonGeo(name, { bin_usd: bin })] });
    expect(res(body.names[0], 'price')).toMatchObject({ status: 'FAIL', reason_code: code });
  };
  it('price EV_NOT_POSITIVE', failure('EV_NOT_POSITIVE', { firstYearCents: 1108, renewalCents: 60_000 }, 1488));
  it('price RATIO_BELOW_1 (EV is positive, the renewal is not covered at the floor)', failure('RATIO_BELOW_1', { firstYearCents: 100, renewalCents: 3000 }, 1488));
  it('price LANDER1_FAIL (a $1,995 BIN is off the list)', failure('LANDER1_FAIL', {}, 1995));
  it('price COVERAGE_LOW (only when score.coverage_gate is on)', failure('COVERAGE_LOW', {}, 1488, { 'score.coverage_gate': true }));
});
