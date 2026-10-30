// CR-078 phase 1 (v5.43.0): POST /kb/*, the verdict routes, supersede, echo candidates, recheck, scopes, audit, size guard and the repo load (kbLoad).
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { KbLoadJob } from '../../../src/modules/knowledge/index.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-26T09:00:00Z');
// the general limit is 10 writes a minute per token: every write moves the test clock on by 7 seconds
let clock = NOW;
async function setup(extra: Record<string, unknown> = {}) {
  clock = NOW;
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock, ...extra });
  return { w: (await issueToken('write', 'gavriel')).auth, d: (await issueToken('data', 'data-engineer')).auth, r: (await issueToken('read')).auth, b: (await issueToken('bots', 'shomer')).auth };
}
const post = (url: string, h: Record<string, string>, rows: unknown[], extra: object = {}, key: string = randomUUID()) => {
  clock += 7000;
  return app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': key }, payload: { rows, ...extra } });
};
const get = (url: string, h: Record<string, string>) => app.inject({ method: 'GET', url, headers: h });

const src = (n: string, o: Record<string, unknown> = {}) => ({
  url: `https://example.test/${n}`, type: 'practitioner_blog', reliability: 'A', reliability_reason: 'test grade', conflict_of_interest: 'none', status: 'graded', ...o,
});
const CLAIM = { topic: 'auction_tactics', questions: ['q1'], option: 'auctions', statement: 'Bids show demand.', variable: 'resell rate with bids', direction: 'increases', population: 'S8 .com', date_range_end: '2026-09-01' };
const KEY = 'auction_tactics|resell rate with bids|s8 .com';
const ev = (n: string, o: Record<string, unknown> = {}) => ({ source: `https://example.test/${n}`, claim_key: KEY, stance: 'supports', credibility: 1, sample_size: 1000, evidence_kind: 'measured', locator: n, ...o });
async function base(h: Record<string, string>) {
  expect((await post('/kb/questions', h, [{ slug: 'q1', text: 'Auctions or closeouts?', options: ['auctions', 'closeouts'] }])).statusCode).toBe(201);
  expect((await post('/kb/claims', h, [CLAIM])).statusCode).toBe(201);
}

describe('knowledge base routes (CR-078)', () => {
  it('KB543-10: write routes take WRITE, bots and data tokens, refuse READ; idempotent by key and by content; the audit keeps row counts', async () => {
    const { w, d, b, r } = await setup();
    const key = randomUUID();
    const first = await post('/kb/sources', w, [src('a'), src('b')], {}, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ kind: 'source', received_n: 2, accepted_n: 2, duplicate_n: 0, superseded_n: 0, rejected_n: 0, dry_run: false });
    const again = await post('/kb/sources', w, [src('a'), src('b')], {}, key);
    expect(again.json()).toEqual(first.json());
    const repost = await post('/kb/sources', d, [src('a', { url: 'https://EXAMPLE.test/a/?utm_campaign=z#x' }), src('c')]);
    expect(repost.json()).toMatchObject({ accepted_n: 1, duplicate_n: 1 });
    expect((await post('/kb/sources', b, [src('d')])).statusCode).toBe(201);
    expect((await post('/kb/sources', r, [src('e')])).statusCode).toBe(403);
    expect((await get('/kb/sources', d)).statusCode).toBe(403);
    expect(await db.selectFrom('kb_sources').select('id').execute()).toHaveLength(4);
    const audit = await db.selectFrom('audit_log').select('request').where('path', '=', '/kb/sources').orderBy('at').execute();
    expect(JSON.stringify(audit[0]!.request)).toContain('[2 rows]');
    expect(JSON.stringify(audit[0]!.request)).not.toContain('example.test');
    const dry = await post('/kb/sources', w, [src('zz')], { dry_run: true });
    expect(dry.json()).toMatchObject({ dry_run: true, accepted_n: 1 });
    expect(await db.selectFrom('kb_sources').select('id').execute()).toHaveLength(4);
  });

  it('KB543-11: a batch with a bad row is rejected whole with the reasons and writes nothing; limits: quote 15 words, excerpt 300 chars, reason required unless F, D allowed', async () => {
    const { w } = await setup();
    await base(w);
    await post('/kb/sources', w, [src('a')]);
    const long = 'word '.repeat(16).trim();
    const res = await post('/kb/sources', w, [src('ok1'), src('ex', { excerpt: 'x'.repeat(301) }), src('nor', { reliability_reason: undefined }), src('badurl', { url: 'ftp://x.test/a' }), src('topic', { topics: ['nope'] }), src('auth', { author: 'Nobody' })]);
    expect(res.statusCode).toBe(422);
    const j = res.json();
    expect(j.error.code).toBe('KB_ROWS_REJECTED');
    expect(j.error.details.rejects.map((x: { row: number; reason: string }) => [x.row, x.reason])).toEqual([[1, 'ROW_INVALID'], [2, 'ROW_INVALID'], [3, 'URL_INVALID'], [4, 'TOPIC_UNKNOWN'], [5, 'AUTHOR_UNKNOWN']]);
    expect(await db.selectFrom('kb_sources').select('id').execute()).toHaveLength(1);
    const q = await post('/kb/evidence', w, [ev('a', { quote: long })]);
    expect(q.json().error.details.rejects[0].message).toMatch(/at most 15 words/);
    expect((await post('/kb/evidence', w, [ev('missing')])).json().error.details.rejects[0].reason).toBe('SOURCE_UNKNOWN');
    expect((await post('/kb/evidence', w, [ev('a', { claim_key: 'nope|x|y' })])).json().error.details.rejects[0].reason).toBe('CLAIM_UNKNOWN');
    expect((await post('/kb/claims', w, [{ ...CLAIM, questions: ['zz'] }])).json().error.details.rejects[0].reason).toBe('QUESTION_UNKNOWN');
    expect((await post('/kb/claims', w, [{ ...CLAIM, option: 'bananas' }])).json().error.details.rejects[0].reason).toBe('OPTION_UNKNOWN');
    expect((await post('/kb/sources', w, [src('dgrade', { reliability: 'D', reliability_reason: 'single anecdote', status: 'read' })])).statusCode).toBe(201);
    expect((await post('/kb/sources', w, [src('fnew', { reliability: 'F', reliability_reason: undefined, status: 'lead' })])).statusCode).toBe(201);
    expect((await post('/kb/sources', w, [src('x', { status: 'graded', reliability: 'F', reliability_reason: undefined })])).statusCode).toBe(422);
    expect((await post('/kb/links', w, [{ from: 'https://example.test/a', to: 'https://example.test/dgrade', kind: 'same_author' }])).statusCode).toBe(422); // note required
    expect((await post('/kb/links', w, [{ from: 'https://example.test/a', to: 'https://example.test/a/', kind: 'echo_of' }])).json().error.details.rejects[0].reason).toBe('LINK_SELF');
    expect((await post('/kb/evidence', w, [ev('dgrade', { claim_grade: 'A' })])).json().error.details.rejects[0].reason).toBe('CLAIM_GRADE_ABOVE_SOURCE');
    expect((await post('/kb/sources', w, [])).statusCode).toBe(422);
    expect((await post('/kb/sources', w, [src('twin'), src('twin', { title: 'other' })])).json().error.details.rejects[0].reason).toBe('CONFLICTING_DUPLICATE_IN_BATCH');
    expect((await post('/kb/sources', w, [src('twin2'), src('twin2')])).json()).toMatchObject({ accepted_n: 1, duplicate_n: 1 });
  });

  it('KB543-12: acceptance: 3 independent A/B clusters that agree give moderate or high, with the sources and grades in the answer; a second read stores nothing new', async () => {
    const { w, r } = await setup();
    await base(w);
    await post('/kb/sources', w, [src('a'), src('b', { reliability: 'B' }), src('c')]);
    await post('/kb/evidence', w, [ev('a'), ev('b'), ev('c')]);
    const q = (await get('/kb/questions', r)).json().questions[0];
    expect(q).toMatchObject({ slug: 'q1', latest_verdict: null });
    const v = await get(`/kb/questions/${q.id}/verdict`, r);
    expect(v.statusCode, v.body).toBe(200);
    const j = v.json();
    expect(['moderate', 'high']).toContain(j.certainty);
    expect(j).toMatchObject({ appended: true, settings_version: 1, evidence_n: 3, verdict: { leading_option: 'auctions', clusters_n: 3 } });
    expect(j.clusters.map((c: { sources: { url: string }[] }) => c.sources[0]!.url).sort()).toEqual(['https://example.test/a', 'https://example.test/b', 'https://example.test/c']);
    expect(j.clusters[0]).toMatchObject({ grade: 'A' });
    const again = (await get('/kb/questions/q1/verdict', r)).json();
    expect(again).toMatchObject({ appended: false, verdict_id: j.verdict_id });
    expect(await db.selectFrom('kb_verdicts').select('id').execute()).toHaveLength(1);
    await post('/kb/sources', w, [src('d')]);
    await post('/kb/evidence', w, [ev('d', { stance: 'contradicts' })]);
    const changed = (await get(`/kb/questions/${q.id}/verdict`, r)).json();
    expect(changed).toMatchObject({ appended: true });
    expect(changed.verdict_id).toBeGreaterThan(j.verdict_id);
    expect((await get('/kb/questions', r)).json().questions[0].latest_verdict).toMatchObject({ id: changed.verdict_id });
    expect((await get('/kb/questions/999/verdict', r)).json().error.code).toBe('KB_QUESTION_NOT_FOUND');
    const snap = await db.selectFrom('kb_verdicts').select('inputs_snapshot').where('id', '=', changed.verdict_id).executeTakeFirstOrThrow();
    expect(JSON.stringify(snap.inputs_snapshot)).toContain('"items_total":4');
  });

  it('KB543-13: the same evidence posted as 5 echoes of one post is 1 cluster and very low; D-only sources weigh 0', async () => {
    const { w, r } = await setup();
    await base(w);
    await post('/kb/sources', w, [src('orig'), ...[1, 2, 3, 4].map((n) => src(`echo${n}`, { reliability: 'B' }))]);
    await post('/kb/links', w, [1, 2, 3, 4].map((n) => ({ from: `https://example.test/echo${n}`, to: 'https://example.test/orig', kind: n % 2 ? 'echo_of' : 'syndicated' })));
    await post('/kb/evidence', w, [ev('orig'), ...[1, 2, 3, 4].map((n) => ev(`echo${n}`))]);
    const j = (await get('/kb/questions/q1/verdict', r)).json();
    expect(j.verdict).toMatchObject({ clusters_n: 1 });
    expect(j.certainty).toBe('very_low');
    expect(j.clusters[0].members).toBe(5);
    // retracting a wrong link splits the cluster again (a correction is a new version)
    const fix = await post('/kb/links', w, [{ from: 'https://example.test/echo1', to: 'https://example.test/orig', kind: 'echo_of', retracted: true, supersede: true }]);
    expect(fix.json()).toMatchObject({ superseded_n: 1 });
    expect((await get('/kb/questions/q1/verdict', r)).json().verdict.clusters_n).toBe(2);
  });

  it('KB543-14: D-grade only: weight 0, very low, the plain reason', async () => {
    const { w, r } = await setup();
    await base(w);
    await post('/kb/sources', w, [1, 2, 3].map((n) => src(`d${n}`, { reliability: 'D', reliability_reason: 'anonymous posts', status: 'read' })));
    await post('/kb/evidence', w, [1, 2, 3].map((n) => ev(`d${n}`)));
    const j = (await get('/kb/questions/q1/verdict', r)).json();
    expect(j).toMatchObject({ certainty: 'very_low', weight_for: 0, weight_against: 0 });
    expect(j.downgrades[0]).toMatch(/weigh nothing/);
  });

  it('KB543-15: supersede: other content under the same key is refused until "supersede": true appends version 2; references keep working; reads show the newest', async () => {
    const { w, r } = await setup();
    await base(w);
    await post('/kb/sources', w, [src('a', { reliability: 'C', reliability_reason: 'unverified', status: 'read' })]);
    await post('/kb/evidence', w, [ev('a')]);
    const refused = await post('/kb/sources', w, [src('a')]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.details.rejects[0].reason).toBe('EXISTS_DIFFERENT');
    const done = await post('/kb/sources', w, [src('a', { supersede: true })]);
    expect(done.json()).toMatchObject({ superseded_n: 1, accepted_n: 0 });
    const rows = await db.selectFrom('kb_sources').select(['id', 'version', 'supersedes', 'reliability']).orderBy('id').execute();
    expect(rows).toEqual([{ id: rows[0]!.id, version: 1, supersedes: null, reliability: 'C' }, { id: rows[1]!.id, version: 2, supersedes: rows[0]!.id, reliability: 'A' }]);
    expect((await post('/kb/sources', w, [src('a', { supersede: true })])).json()).toMatchObject({ duplicate_n: 1, superseded_n: 0 });
    const list = (await get('/kb/sources?status=graded', r)).json().sources;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ url: 'https://example.test/a', reliability: 'A', version: 2 });
    expect((await get('/kb/sources?status=read', r)).json().sources).toHaveLength(0);
    expect((await get('/kb/questions/q1/verdict', r)).json().clusters[0].grade).toBe('A');
    await expect(db.updateTable('kb_sources').set({ title: 'x' }).execute()).rejects.toThrow(/append-only/);
    // questions cannot be corrected
    expect((await post('/kb/questions', w, [{ slug: 'q1', text: 'Other text' }])).json().error.details.rejects[0].reason).toBe('EXISTS_DIFFERENT');
  });

  it('KB543-16: echo candidates list similar excerpts that no link joins; a link removes the pair; same canonical URL is the same source', async () => {
    const { w, r } = await setup();
    const text = 'Hand-registered dot com names sell through at about one percent a year according to a portfolio of two thousand names held for five years.';
    expect((await post('/kb/sources', w, [src('p1', { excerpt: text }), src('p2', { excerpt: text.replace('five', 'six') }), src('p3', { excerpt: 'Something else entirely about registrar closeout prices and expiry dates this morning.' })])).statusCode).toBe(201);
    const c = (await get('/kb/echo-candidates', r)).json();
    expect(c.pairs).toHaveLength(1);
    expect(c.pairs[0]).toMatchObject({ a: { url: 'https://example.test/p1' }, b: { url: 'https://example.test/p2' } });
    expect(c.pairs[0].jaccard).toBeGreaterThanOrEqual(0.5);
    await post('/kb/links', w, [{ from: 'https://example.test/p2', to: 'https://example.test/p1', kind: 'echo_of' }]);
    expect((await get('/kb/echo-candidates', r)).json().pairs).toHaveLength(0);
    expect((await post('/kb/sources', w, [src('p1', { url: 'https://Example.test/p1/?utm_source=a', excerpt: text })])).json()).toMatchObject({ duplicate_n: 1 });
  });

  it('KB543-17: recheck lists claims whose evidence weight has aged below 0.5; claims and sources filter by topic', async () => {
    const { w, r } = await setup();
    await post('/kb/questions', w, [{ slug: 'q1', text: 'Q?', options: [] }]);
    await post('/kb/claims', w, [
      { ...CLAIM, option: undefined, variable: 'old thing', date_range_end: '2020-01-01' },
      { ...CLAIM, option: undefined, variable: 'fresh thing', date_range_end: '2026-10-01', topic: 'platform_rules' },
    ]);
    await post('/kb/sources', w, [src('a', { topics: ['auction_tactics'] }), src('b', { topics: ['platform_rules'] })]);
    await post('/kb/evidence', w, [ev('a', { claim_key: 'auction_tactics|old thing|s8 .com' }), ev('b', { claim_key: 'platform_rules|fresh thing|s8 .com' })]);
    const rc = (await get('/kb/recheck', r)).json();
    expect(rc).toMatchObject({ settings_version: 1, threshold: 0.5 });
    expect(rc.claims.map((c: { claim_key: string }) => c.claim_key)).toEqual(['auction_tactics|old thing|s8 .com']);
    expect(rc.claims[0].weighted_r).toBeLessThan(0.5);
    expect((await get('/kb/claims?topic=platform_rules', r)).json().claims.map((c: { variable: string }) => c.variable)).toEqual(['fresh thing']);
    expect((await get('/kb/claims?question=q1', r)).json().claims).toHaveLength(2);
    expect((await get('/kb/sources?topic=auction_tactics', r)).json().sources.map((s: { url: string }) => s.url)).toEqual(['https://example.test/a']);
    expect((await get('/kb/claims?topic=Bad', r)).statusCode).toBe(400);
  });

  it('KB543-18: the size guard refuses a write when the database is near its limit (409 DB_SIZE_HIGH)', async () => {
    const { w } = await setup({ engineDbSize: { limitBytes: 1000, bytes: async () => 990 } });
    const res = await post('/kb/sources', w, [src('a')]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DB_SIZE_HIGH');
    expect(await db.selectFrom('kb_sources').select('id').execute()).toHaveLength(0);
  });

  it('KB543-19: kb_settings v1 carries the research weights and cannot be changed', async () => {
    await setup();
    const row = await db.selectFrom('kb_settings').selectAll().executeTakeFirstOrThrow();
    expect(row.version).toBe(1);
    expect(row.values).toMatchObject({ grade_weight: { A: 1, B: 0.6, C: 0.25, D: 0, F: 0 }, thresholds: { min_clusters: 3, echo_jaccard: 0.5 } });
    await expect(db.updateTable('kb_settings').set({ note: 'x' }).execute()).rejects.toThrow(/append-only/);
  });
});

describe('knowledge repo load (CR-078 rule 9)', () => {
  const FIXTURES = 'tests/fixtures/knowledge';

  it('KB543-24 (v5.45.0): the shipped data/knowledge files load without a failed file, and every question gets a verdict', async () => {
    const { r } = await setup();
    const res = await new KbLoadJob({ db, now: () => clock, dir: new URL('../../../data/knowledge/', import.meta.url).pathname }).runOnce();
    expect(res.failed).toEqual([]);
    const files = res.loaded.map((l: { file: string }) => l.file);
    expect(files.slice(0, 2)).toEqual(['0001-questions.jsonl', '0002-october-research.jsonl']);
    expect(files).toEqual([...files].sort()); // loaded in name order; later research rounds add files
    const qs = (await get('/kb/questions', r)).json().questions as { slug: string }[];
    expect(qs.length).toBeGreaterThanOrEqual(25);
    for (const q of qs) expect((await get(`/kb/questions/${q.slug}/verdict`, r)).statusCode).toBe(200);
  }, 60_000);

  it('KB543-20: kbLoad loads a fixture file once and skips it the second time; the loaded rows give a verdict', async () => {
    const { r } = await setup();
    const job = new KbLoadJob({ db, now: () => clock, dir: FIXTURES });
    const first = await job.runOnce();
    expect(first).toMatchObject({ files_seen: 1, unchanged: [], failed: [] });
    expect(first.loaded[0]).toMatchObject({ file: '0000-example.jsonl', counts: { author: { accepted: 1 }, source: { accepted: 4 }, question: { accepted: 1 }, claim: { accepted: 1 }, evidence: { accepted: 4 }, link: { accepted: 1 } } });
    const second = await job.runOnce();
    expect(second).toMatchObject({ files_seen: 1, loaded: [], unchanged: ['0000-example.jsonl'], failed: [] });
    const loads = await db.selectFrom('kb_loads').selectAll().execute();
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ ok: true, file_name: '0000-example.jsonl' });
    expect(loads[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.selectFrom('kb_evidence').select('id').execute()).toHaveLength(4);
    const j = (await get('/kb/questions/fixture-auctions/verdict', r)).json();
    expect(j.verdict).toMatchObject({ leading_option: 'auctions', clusters_n: 3 }); // the repost is an echo of source a
    expect(['moderate', 'high']).toContain(j.certainty);
    // the same rows under another file name (other bytes) are a row-level no-op
    const dir = await mkdtemp(join(tmpdir(), 'kb-'));
    await writeFile(join(dir, '0001-copy.jsonl'), `${await readFile(join(FIXTURES, '0000-example.jsonl'), 'utf8')}\n`);
    const third = await new KbLoadJob({ db, now: () => clock, dir }).runOnce();
    expect(third.loaded[0]!.counts).toMatchObject({ source: { accepted: 0, duplicate: 4 }, evidence: { accepted: 0, duplicate: 4 } });
    expect(await db.selectFrom('kb_sources').select('id').execute()).toHaveLength(4);
  });

  it('KB543-21: a bad line fails that file only, recorded once with its error; the other files still load; a missing folder is a no-op', async () => {
    await setup();
    const dir = await mkdtemp(join(tmpdir(), 'kb-'));
    await writeFile(join(dir, '0001-bad.jsonl'), '{"kind":"source","url":"https://example.test/x","type":"news","reliability":"A"}\n');
    await writeFile(join(dir, '0002-notjson.jsonl'), 'not json\n');
    await writeFile(join(dir, '0003-good.jsonl'), '{"kind":"source","url":"https://example.test/good","type":"news"}\n');
    const job = new KbLoadJob({ db, now: () => clock, dir });
    const s = await job.runOnce();
    expect(s.loaded.map((x) => x.file)).toEqual(['0003-good.jsonl']);
    expect(s.failed.map((x) => x.file)).toEqual(['0001-bad.jsonl', '0002-notjson.jsonl']);
    expect(s.failed[0]!.error).toMatch(/reliability_reason is required/);
    expect(s.failed[1]!.error).toMatch(/line 1: not valid JSON/);
    expect(await db.selectFrom('kb_sources').select('url').execute()).toEqual([{ url: 'https://example.test/good' }]);
    await job.runOnce();
    const rows = await db.selectFrom('kb_loads').select(['file_name', 'ok']).orderBy('id').execute();
    expect(rows).toEqual([{ file_name: '0001-bad.jsonl', ok: false }, { file_name: '0002-notjson.jsonl', ok: false }, { file_name: '0003-good.jsonl', ok: true }]);
    expect(await new KbLoadJob({ db, now: () => clock, dir: join(dir, 'missing') }).runOnce()).toEqual({ files_seen: 0, loaded: [], unchanged: [], failed: [] });
  });

  it('KB543-22: the daily job has the step kbLoad right after referenceRefresh; it reads the configured folder', async () => {
    await setup({ knowledgeDir: FIXTURES });
    const plan = app.jobRunner.plan('daily').map((s) => s.name);
    expect(plan.slice(plan.indexOf('referenceRefresh'), plan.indexOf('referenceRefresh') + 2)).toEqual(['referenceRefresh', 'kbLoad']);
    const step = app.jobRunner.plan('daily').find((s) => s.name === 'kbLoad')!;
    expect(await step.exec()).toMatchObject({ files_seen: 1, loaded: [{ file: '0000-example.jsonl' }] });
  });

  it('KB-098-1 (v5.79.0, CR-098): a file row replaces a route row with the same key without "supersede" (logged per kind); a clash with an earlier file still fails and names the line, key and fields', async () => {
    const { w } = await setup();
    await post('/kb/sources', w, [src('a', { title: 'route title' })]);
    const dir = await mkdtemp(join(tmpdir(), 'kb-'));
    const line = (o: Record<string, unknown>) => JSON.stringify({ kind: 'source', ...src('a', o) });
    await writeFile(join(dir, '0001-file.jsonl'), `// header\n${line({ title: 'file title' })}\n`);
    const s = await new KbLoadJob({ db, now: () => clock, dir }).runOnce();
    expect(s.failed).toEqual([]);
    expect(s.loaded[0]!.counts.source).toEqual({ accepted: 0, duplicate: 0, superseded: 1, auto_superseded: ['https://example.test/a'] });
    expect((await db.selectFrom('kb_loads').select('counts').executeTakeFirstOrThrow()).counts).toMatchObject({ source: { auto_superseded: ['https://example.test/a'] } });
    const rows = await db.selectFrom('kb_sources').select(['version', 'title', 'by']).orderBy('id').execute();
    expect(rows).toEqual([{ version: 1, title: 'route title', by: 'gavriel' }, { version: 2, title: 'file title', by: 'repo-load' }]);
    // a later file that differs from an earlier file's row: an explicit supersede is still needed, and the error says where
    await writeFile(join(dir, '0002-later.jsonl'), `// header\n\n${line({ title: 'later title' })}\n`);
    const t = await new KbLoadJob({ db, now: () => clock, dir }).runOnce();
    expect(t.failed).toHaveLength(1);
    expect(t.failed[0]!.error).toBe('0002-later.jsonl: source: 1 rejected: line 3 EXISTS_DIFFERENT https://example.test/a [title]');
    // the routes never auto-supersede, and their reject names the key and the fields too
    const refused = (await post('/kb/sources', w, [src('a', { title: 'again' })])).json();
    expect(refused.error.details.rejects[0]).toMatchObject({ reason: 'EXISTS_DIFFERENT', key: 'https://example.test/a', fields: ['title'] });
  });

  it('KB-098-2 (v5.79.0, CR-098): GET /kb/load-preview runs the files not yet loaded and keeps nothing; the shipped files preview clean', async () => {
    const dir = new URL('../../../data/knowledge/', import.meta.url).pathname;
    const { r, w } = await setup({ knowledgeDir: dir });
    const res = await get('/kb/load-preview', r);
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ dry_run: true, unchanged: [], failed: [] });
    expect(j.loaded.map((l: { file: string }) => l.file)).toContain('0008-fertilize-2026-10-28.jsonl');
    expect(await db.selectFrom('kb_sources').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('kb_loads').select('id').execute()).toEqual([]);
    expect((await get('/kb/load-preview?x=1', r)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/kb/load-preview' })).statusCode).toBe(401);
    void w;
  }, 60_000);
});
