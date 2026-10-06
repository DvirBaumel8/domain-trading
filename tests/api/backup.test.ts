import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { http, HttpResponse } from 'msw';
import type { FastifyInstance } from 'fastify';
import { BackupExporter, collectBackupFiles, gitBlobSha } from '../../src/jobs/backup-export.js';
import { importBackup } from '../../src/jobs/backup-import.js';
import { newAuditId } from '../../src/http/audit.js';
import { readEvidence, storeEvidence } from '../../src/screening/evidence.js';
import { loadConfig } from '../../src/config.js';
import { buildReport } from '../../src/services/report/index.js';
import { makeApp } from '../helpers/app.js';
import { COMPS, buyBody, postBuy } from '../helpers/buy.js';
import { resetDb, testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

const TOKEN = 'github_pat_fake_000000000000';
const REPO = 'dvir/domain-trading-data';
const BILLING = '12 Secret Street, Tel Aviv';
const T = 'promptinjectionaudit.com';
const G = 'examplecityroofing.com';

// ---- a stateful fake of the GitHub git data API ----
function fakeGithub(opts: { meta?: { status?: number; body?: object }; truncated?: boolean; seedStale?: boolean } = {}) {
  const branch = 'data-backup';
  const st = {
    ref: null as string | null,
    commits: new Map<string, { tree: string; parents: string[] }>(),
    trees: new Map<string, Map<string, string>>(),
    blobs: new Map<string, string>(),
    requests: [] as { method: string; url: string; auth: string | null; body: string }[],
    commitCount: 0,
  };
  const sha = (s: string) => createHash('sha1').update(s).digest('hex');
  const base = `https://api.github.com/repos/${REPO}`;
  mswServer.use(
    http.all(/api\.github\.com/, async ({ request }) => {
      st.requests.push({ method: request.method, url: request.url, auth: request.headers.get('authorization'), body: request.method === 'GET' ? '' : await request.clone().text() });
      return undefined; // fall through to the specific handlers
    }),
    http.get(base, () => HttpResponse.json(opts.meta?.body ?? { private: true, visibility: 'private' }, { status: opts.meta?.status ?? 200 })),
    http.get(`${base}/git/ref/heads/${branch}`, () => (st.ref ? HttpResponse.json({ object: { sha: st.ref } }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 }))),
    http.get(`${base}/git/commits/:sha`, ({ params }) => HttpResponse.json({ tree: { sha: st.commits.get(params.sha as string)!.tree } })),
    http.get(`${base}/git/trees/:sha`, ({ params }) =>
      HttpResponse.json({ tree: [...st.trees.get(params.sha as string)!].map(([path, s]) => ({ path, type: 'blob', sha: s })), truncated: opts.truncated ?? false })),
    http.post(`${base}/git/blobs`, async ({ request }) => {
      const b = (await request.json()) as { content: string; encoding: string };
      const content = Buffer.from(b.content, 'base64').toString('utf8');
      const s = gitBlobSha(content);
      st.blobs.set(s, content);
      return HttpResponse.json({ sha: s }, { status: 201 });
    }),
    http.post(`${base}/git/trees`, async ({ request }) => {
      const b = (await request.json()) as { base_tree?: string; tree: { path: string; sha: string | null }[] };
      const m = new Map(b.base_tree ? st.trees.get(b.base_tree)! : []);
      for (const e of b.tree) (e.sha === null ? m.delete(e.path) : m.set(e.path, e.sha));
      const s = sha(JSON.stringify([...m]));
      st.trees.set(s, m);
      return HttpResponse.json({ sha: s }, { status: 201 });
    }),
    http.post(`${base}/git/commits`, async ({ request }) => {
      const b = (await request.json()) as { tree: string; parents: string[] };
      const s = sha(`commit${++st.commitCount}${b.tree}`);
      st.commits.set(s, { tree: b.tree, parents: b.parents });
      return HttpResponse.json({ sha: s }, { status: 201 });
    }),
    http.post(`${base}/git/refs`, async ({ request }) => {
      const b = (await request.json()) as { ref: string; sha: string };
      expect(b.ref).toBe(`refs/heads/${branch}`);
      st.ref = b.sha;
      return HttpResponse.json({}, { status: 201 });
    }),
    http.patch(`${base}/git/refs/heads/${branch}`, async ({ request }) => {
      st.ref = ((await request.json()) as { sha: string }).sha;
      return HttpResponse.json({});
    }),
  );
  const files = () => {
    const tree = st.trees.get(st.commits.get(st.ref!)!.tree)!;
    return new Map([...tree].map(([p, s]) => [p, st.blobs.get(s)!]));
  };
  return { st, files };
}

const exporter = (over: Record<string, string> = {}, log = { warn: (_m: string) => {} }) =>
  new BackupExporter({ db, config: loadConfig(testEnv({ GITHUB_BACKUP_REPO: REPO, ...over })), now: () => Date.parse('2026-12-03T00:00:00Z'), log });

// ---- a realistic fixture: buy + listing, an offer, a sale with a payout fee, a receipt with a billing address ----
let app: FastifyInstance;
afterEach(async () => app?.close());
let clock = 0;
const REPORT_AT = new Date('2026-12-03T00:00:00Z');
async function seed() {
  clock = Date.parse('2026-10-05T10:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun', { domainInfo: { expiryDate: '2027-10-05' } })], rdap: async () => 'not_registered', now: () => clock });
  const w = (await issueToken('write', 'gavriel')).auth;
  const { price_grade: _g, ...b } = buyBody({ domain: T, category: 'trend', approval_ref: { text: `yes buy ${T}`, approved_at: new Date(clock - 3_600_000).toISOString() } });
  const buy = await postBuy(app, { ...b, proposed_listing: { mode: 'hybrid', bin: 1995 }, expected_settings_version: 2, pricing_evidence: { comps: COMPS, rationale: 'fixture' } }, w);
  expect(buy.statusCode).toBe(201);
  const purchase = await db.selectFrom('purchases').select('id').executeTakeFirstOrThrow();
  await db.updateTable('receipts').set({
    order_id: 'ORD-1',
    raw: JSON.stringify({ invoice: { id: 'ORD-1', billTo: { address1: BILLING }, url: 'https://x/pdf', items: [{ domain: T, price_cents: 1108 }] } }),
  }).where('purchase_id', '=', purchase.id).execute();
  // Realistic Porkbun payloads (OpenAPI v3.53 examples): create returns the prepaid `balance`; check returns `limits`.
  await db.updateTable('purchases').set({ response: JSON.stringify({ status: 'SUCCESS', domain: T, cost: 973, orderId: 12345678, balance: 4027, ttlRemaining: 86400, requestId: '019e04fa-258d-7d11-aa86-4d5795c3fe8f', limits: { success: { TTL: 86400, limit: 50, used: 1 } } }) }).where('id', '=', purchase.id).execute();
  await db.insertInto('quotes').values({
    check_id: 'chk_fixture', domain: T, registrar: 'porkbun', eligible: true,
    raw: JSON.stringify({ status: 'SUCCESS', response: { avail: 'yes', type: 'registration', price: '9.73', regularPrice: '9.73', premium: 'no', additional: { renewal: { price: '9.73' } } }, limits: { TTL: 10, limit: 1, used: 1 }, balance: 4027 }),
  }).execute();
  clock = Date.parse('2026-12-02T09:00:00Z');
  const offer = await app.inject({ method: 'POST', url: '/offers', headers: { ...w, 'idempotency-key': randomUUID() }, payload: { domain: T, amount_usd: '450.00', source: 'afternic', received_at: '2026-12-01T09:12:00+02:00' } });
  expect(offer.statusCode).toBe(201);
  // CR-001 tables: a draft settings version, a list, evidence, a run with a result, a manual quote
  const v1 = await db.selectFrom('selection_settings').select(['id', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  await db.insertInto('selection_settings').values({ label: 'v1b', values: JSON.stringify(v1.values), based_on_id: v1.id, created_by: 'gavriel', note: 'draft' }).execute();
  await db.insertInto('selection_lists').values({ name: 'brand', version: 1, terms: ['acme'], created_by: 'gavriel' }).execute();
  const ev = await storeEvidence(db, { source: 'manual', url: 'https://example.com/e', retrievedAt: new Date('2026-10-06T07:00:00Z'), httpStatus: null, contentType: 'application/json', body: '{"a":1}', text: '{"a":1}', maxBytes: 1000 });
  await db.insertInto('screening_runs').values({
    id: 'run_bk', created_by: 'gavriel', mode: 'live', backtest: false, settings_id: v1.id, settings_label: 'v1', buy_hold: true,
    input: JSON.stringify({ names: [{ idx: 0, domain: T, lane: 'S3', leads_ab: 0 }] }), gate_plan: JSON.stringify({ S3: ['form'] }), list_versions: '{}',
    status: 'done', deadline_at: new Date('2026-10-06T08:30:00Z'), finished_at: new Date('2026-10-06T08:01:00Z'), summary: JSON.stringify({ names: 1 }),
  }).execute();
  await db.insertInto('screening_results').values({
    run_id: 'run_bk', item_idx: 0, domain: T, lane: 'S3', check_id: 'web_risk', gate: 'G5', rule_ids: ['WEB-RISK-1'], status: 'PASS', fields: '{}',
    checked_at: new Date('2026-10-06T07:30:00Z'), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, evidence_ids: [String(ev)], source: 'manual', recorded_by: 'gavriel',
  }).execute();
  await db.insertInto('manual_quotes').values({ domain: T, registrar: 'godaddy', renewal_cents: 2299, source_note: 'page', observed_at: new Date('2026-10-05T12:00:00Z'), recorded_by: 'gavriel' }).execute();
  const gid = await listedDomain({ domain: G, lander: 'afternic', lander_set_at: new Date('2026-10-10T00:00:00Z') });
  await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: gid, type: 'registration', amount_cents: -1108, note: 'has, "quotes"\nand a newline' }).execute();
  const sold = await app.inject({
    method: 'POST', url: `/sold/${G}`, headers: { ...w, 'idempotency-key': randomUUID() },
    payload: {
      venue: 'afternic', sale_price: 1995, commission: 299.25, sold_at: '2026-12-01T11:00:00+02:00', transaction_ref: 'AFN-1',
      approval_ref: { text: `it sold on afternic for 1995 (${G})`, approved_at: new Date(clock - 30_000).toISOString() },
      payout_fee: 15,
    },
  });
  expect(sold.statusCode).toBe(200);
  await app.close();
}

const HEADERS = {
  'backup/ledger.csv': 'date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note',
  'backup/portfolio.csv': 'domain,display_name,status,registrar,category,deal_id,buy_date,cost_usd,expiry_date,renewals_used,drop_date,listing_mode,bin_usd,floor_usd,min_offer_usd,price_grade,sold_at',
  'backup/offers.csv': 'id,domain,amount_usd,source,received_at,buyer_type,external_ref,band,routing,outcome,note',
};

describe('BK-1 backup export files', () => {
  it('writes every file with exact headers, deterministic bytes, and no secrets', async () => {
    await seed();
    const a = await collectBackupFiles(db);
    for (const f of ['portfolio.csv', 'ledger.csv', 'purchases.json', 'receipts.json', 'audit.jsonl', 'offers.csv', 'sales.json']) expect(a.has(`backup/${f}`)).toBe(true);
    for (const [f, h] of Object.entries(HEADERS)) expect(a.get(f)!.split('\r\n')[0]).toBe(h);
    expect(a.get('backup/ledger.csv')).toContain('"has, ""quotes""\nand a newline"');
    expect(JSON.parse(a.get('backup/sales.json')!)).toHaveLength(1);
    expect(a.get('backup/offers.csv')).toContain('450.00');
    const dbNames = (await sql<{ name: string }>`select name from pgmigrations order by id`.execute(db)).rows.map((r) => r.name);
    expect(dbNames.length).toBeGreaterThan(0);
    expect(JSON.parse(a.get('backup/migrations.json')!)).toEqual(dbNames); // names only, in run order

    const receipts = JSON.parse(a.get('backup/receipts.json')!) as { raw: { invoice: Record<string, unknown> } }[];
    expect(receipts[0]!.raw.invoice).toEqual({ id: 'ORD-1', items: [{ domain: T, price_cents: 1108 }] });
    const audit = a.get('backup/audit.jsonl')!;
    expect(audit).toContain(`yes buy ${T}`); // approval text kept
    expect(audit).not.toContain('client_ip');
    expect(audit).not.toContain('127.0.0.1');
    const all = [...a.values()].join('\n');
    for (const leak of ['pk1_', 'sk1_', TOKEN, BILLING, 'token_sha256', 'billTo', '"balance"', 'apikey']) expect(all).not.toContain(leak);
    expect(a.get('backup/purchases.json')).toContain('12345678'); // the order id stays
    expect(a.get('backup/tables/quotes.json')).toContain('"price": "9.73"');
    expect(all).not.toMatch(/Bearer /);

    const b = await collectBackupFiles(db);
    expect([...b]).toEqual([...a]); // unchanged data -> identical bytes, same order
  });
});

describe('GitHub commit', () => {
  it('creates the branch with an orphan commit when it is missing, then commits on top', async () => {
    await seed();
    const gh = fakeGithub();
    const r = await exporter().runOnce();
    expect(r).toMatchObject({ committed: true });
    const first = gh.st.commits.get(gh.st.ref!)!;
    expect(first.parents).toEqual([]);
    const local = await collectBackupFiles(db);
    expect([...gh.files()].sort()).toEqual([...local].sort());
    expect(gh.st.requests.some((q) => q.method === 'POST' && q.url.endsWith('/git/refs'))).toBe(true);
    const tree = gh.st.requests.find((q) => q.url.endsWith('/git/trees'))!;
    expect(JSON.parse(tree.body).base_tree).toBeUndefined();
  });

  it('BK-2: unchanged data makes no commit; a change commits only the changed files', async () => {
    await seed();
    const gh = fakeGithub();
    await exporter().runOnce();
    const head = gh.st.ref;
    const before = gh.st.requests.length;
    const r = await exporter().runOnce();
    expect(r).toMatchObject({ skipped: true, reason: 'unchanged', committed: false });
    expect(gh.st.ref).toBe(head);
    expect(gh.st.requests.slice(before).every((q) => q.method === 'GET')).toBe(true);

    await db.insertInto('ledger_entries').values({ occurred_on: '2026-12-03', type: 'tool', amount_cents: -500, note: 'more' }).execute();
    const r2 = await exporter().runOnce();
    expect(r2).toMatchObject({ committed: true });
    expect(r2.changed).toBe(2); // ledger.csv + tables/ledger_entries.json
    expect(gh.st.ref).not.toBe(head);
    expect(gh.st.commits.get(gh.st.ref!)!.parents).toEqual([head]);
  });

  it('the token travels only in the Authorization header', async () => {
    await seed();
    const gh = fakeGithub();
    await exporter().runOnce();
    expect(gh.st.requests.length).toBeGreaterThan(5);
    for (const q of gh.st.requests) {
      expect(q.auth).toBe(`Bearer ${TOKEN}`);
      expect(q.url).not.toContain(TOKEN);
      expect(q.body).not.toContain(TOKEN);
    }
  });

  it('the branch is fixed: GITHUB_BACKUP_BRANCH is ignored, every path uses heads/data-backup, none touches main', async () => {
    await seed();
    const gh = fakeGithub();
    for (const branch of ['../heads/main', 'main', 'master']) {
      await exporter({ GITHUB_BACKUP_BRANCH: branch }).runOnce();
      await db.insertInto('ledger_entries').values({ occurred_on: '2026-12-03', type: 'tool', amount_cents: -1, note: branch }).execute();
    }
    const urls = gh.st.requests.map((q) => new URL(q.url).pathname);
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) {
      expect(u.startsWith(`/repos/${REPO}`)).toBe(true);
      expect(u).not.toMatch(/heads\/(main|master)/);
      expect(u).not.toContain('..');
      if (u.includes('/heads/')) expect(u).toMatch(/heads\/data-backup$/);
    }
    for (const q of gh.st.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/git/refs'))) expect(JSON.parse(q.body).ref).toBe('refs/heads/data-backup');
  });

  it('config refuses the code repo, dot segments and a malformed repo', () => {
    for (const repo of ['DvirBaumel8/domain-trading', 'dvirbaumel8/Domain-Trading', 'a/..', '../x', 'a/b/c', 'a b/c']) {
      expect(() => loadConfig(testEnv({ GITHUB_BACKUP_REPO: repo })), repo).toThrow(/GITHUB_BACKUP_REPO/);
    }
    expect(loadConfig(testEnv({ GITHUB_BACKUP_REPO: 'DvirBaumel8/domain-trading-data' })).backup.repo).toBe('DvirBaumel8/domain-trading-data');
  });

  it('checks the repo is private on every run, before collecting or uploading anything', async () => {
    await seed();
    const cases: [string, { status?: number; body?: object }][] = [
      ['public', { body: { private: false, visibility: 'public' } }],
      ['internal', { body: { private: true, visibility: 'internal' } }],
      ['no private flag', { body: { name: 'x' } }],
      ['404', { status: 404, body: { message: 'Not Found' } }],
    ];
    for (const [name, meta] of cases) {
      const gh = fakeGithub({ meta });
      await expect(exporter().runOnce(), name).rejects.toThrow(meta.status === 404 ? /cannot read the backup repo/ : /backup repo is not private/);
      expect(gh.st.requests.every((q) => q.method === 'GET' && q.url.endsWith(`/repos/${REPO}`)), name).toBe(true);
    }
    const gh = fakeGithub();
    await exporter().runOnce();
    const metaCalls = () => gh.st.requests.filter((q) => q.url.endsWith(`/repos/${REPO}`)).length;
    expect(metaCalls()).toBe(1);
    await exporter().runOnce();
    expect(metaCalls()).toBe(2); // again on the next run
  });

  it('deletes files on the branch that are no longer exported; refuses a truncated tree', async () => {
    await seed();
    const gh = fakeGithub();
    await exporter().runOnce();
    const tree = gh.st.trees.get(gh.st.commits.get(gh.st.ref!)!.tree)!;
    tree.set('backup/old-table.json', gitBlobSha('x'));
    tree.set('README.md', gitBlobSha('keep'));
    gh.st.blobs.set(gitBlobSha('x'), 'x');
    const r = await exporter().runOnce();
    expect(r).toMatchObject({ committed: true, changed: 1 });
    const after = gh.files();
    expect(after.has('backup/old-table.json')).toBe(false);
    expect(after.has('README.md')).toBe(true); // only backup/* is managed

    fakeGithub({ truncated: true });
    const gh2 = fakeGithub({ truncated: true });
    gh2.st.ref = gh.st.ref; gh2.st.commits = gh.st.commits; gh2.st.trees = gh.st.trees; gh2.st.blobs = gh.st.blobs;
    await expect(exporter().runOnce()).rejects.toThrow(/truncated/);
  });

  it('a GitHub failure rejects with a message that has no token', async () => {
    await seed();
    mswServer.use(http.get(/api\.github\.com/, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })));
    const err = await exporter().runOnce().catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe('empty data repo', () => {
  it('a 409 "Git Repository is empty" gives a clear BackupError', async () => {
    await seed();
    fakeGithub();
    mswServer.use(http.get(`https://api.github.com/repos/${REPO}/git/ref/heads/data-backup`, () => HttpResponse.json({ message: 'Git Repository is empty.' }, { status: 409 })));
    await expect(exporter().runOnce()).rejects.toThrow('backup repo has no commits; initialize it with a README');
  });
});

describe('BK-4 missing token', () => {
  it('skips with a warning and does not throw; the daily runner step stays ok', async () => {
    const warnings: string[] = [];
    const ex = exporter({ GITHUB_BACKUP_TOKEN: '' }, { warn: (m) => warnings.push(m) });
    expect(await ex.runOnce()).toMatchObject({ skipped: true, reason: expect.stringContaining('GITHUB_BACKUP_TOKEN') });
    expect(warnings).toHaveLength(1);
    expect(await exporter({ GITHUB_BACKUP_REPO: '' }).runOnce()).toMatchObject({ skipped: true });

    app = await makeApp({ backupExport: ex });
    const r = await app.jobRunner.run('daily');
    expect(r.steps.backupExport).toMatchObject({ ok: true, skipped: true });
  });

  it('the job CLI exits 0 with a warning and {skipped:true}', async () => {
    const run = promisify(execFile);
    const { stdout, stderr } = await run('npx', ['tsx', 'src/job.ts', 'export-backup'], {
      env: { ...process.env, ...testEnv({ GITHUB_BACKUP_TOKEN: '', GITHUB_BACKUP_REPO: '' }) },
    });
    expect(JSON.parse(stdout)).toMatchObject({ skipped: true });
    expect(stderr).toContain('warning: backup export skipped');
  }, 30_000);
});

describe('BK-3 import round trip', () => {
  async function writeDir(files: Map<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'dt-backup-'));
    for (const [p, c] of files) {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await writeFile(join(dir, p), c);
    }
    return dir;
  }

  it('an empty database restored from the files gives an identical /report and identical re-exported files', async () => {
    await seed();
    const reportBefore = await buildReport(db, REPORT_AT);
    expect(reportBefore.per_domain.length).toBe(2);
    const files = await collectBackupFiles(db);
    const dir = await writeDir(files);
    const ledgerCount = Number((await db.selectFrom('ledger_entries').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

    await resetDb(db);
    const counts = await importBackup(db, dir);
    expect(counts).toMatchObject({ domains: 2, sales: 1, offers: 1, selection_settings: 2, selection_lists: 15, screening_evidence: 1, screening_runs: 1, screening_results: 1, manual_quotes: 1 });
    // the CR-001 rows are back with their ids; the evidence text survives the bytea round trip
    expect((await db.selectFrom('selection_settings').select('label').orderBy('id').execute()).map((r) => r.label)).toEqual(['v1', 'v1b']);
    expect((await db.selectFrom('selection_lists').select('terms').where('name', '=', 'brand').executeTakeFirstOrThrow()).terms).toEqual(['acme']);
    expect((await readEvidence(db, 1))!.text).toBe('{"a":1}');
    expect((await db.selectFrom('screening_results').select(['run_id', 'source']).executeTakeFirstOrThrow())).toEqual({ run_id: 'run_bk', source: 'manual' });
    expect(await buildReport(db, REPORT_AT)).toEqual(reportBefore);

    // Everything re-exports byte-identically; audit rows differ only in token_id (api_tokens are not restored).
    const after = await collectBackupFiles(db);
    const noTok = (t: string) => t.replace(/"token_id":\d+/g, '"token_id":null');
    // pricing_settings: the migration-seeded rows keep the new database's own created_at (append-only; not replaced).
    const noImportRow = (t: string) => t.split('\n').filter((l) => l && !l.includes('"path":"import-backup"')).map((l) => `${l}\n`).join('');
    for (const [p, c] of files) {
      // the migration-seeded rows (pricing v1/v2, selection v1 and its lists) keep the new database's own timestamps
      if (['pricing_settings', 'selection_settings', 'selection_lists'].some((t) => p === `backup/tables/${t}.json`)) continue;
      expect(p === 'backup/audit.jsonl' ? noImportRow(after.get(p)!) : after.get(p), p).toBe(p === 'backup/audit.jsonl' ? noTok(c) : c);
    }
    const audit = JSON.parse((after.get('backup/audit.jsonl')!.trim().split('\n').at(-1))!);
    expect(audit).toMatchObject({ scope: 'admin', method: 'ADMIN', path: 'import-backup', request: { source_dir: dir, counts: { domains: 2 } } });

    // sequences continue after the restored ids
    const id = await db.insertInto('ledger_entries').values({ occurred_on: '2026-12-04', type: 'tool', amount_cents: -1 }).returning('id').executeTakeFirstOrThrow();
    const max = await db.selectFrom('ledger_entries').select(db.fn.max('id').as('m')).executeTakeFirstOrThrow();
    expect(id.id).toBe(max.m);
    expect(Number((await db.selectFrom('ledger_entries').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBe(ledgerCount + 1);
  });

  it('refuses when a migration-seeded pricing_settings version differs from the backup', async () => {
    await seed();
    const files = await collectBackupFiles(db);
    const rows = JSON.parse(files.get('backup/tables/pricing_settings.json')!) as Record<string, unknown>[];
    rows[0]!.floor_bps = 6000;
    files.set('backup/tables/pricing_settings.json', JSON.stringify(rows));
    const dir = await writeDir(files);
    await resetDb(db);
    await expect(importBackup(db, dir)).rejects.toThrow(/pricing_settings version 2 differs/);
    expect(Number((await db.selectFrom('domains').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBe(0);
  });

  it('refuses a non-empty database and a directory without backup files', async () => {
    await seed();
    const dir = await writeDir(await collectBackupFiles(db));
    await expect(importBackup(db, dir)).rejects.toThrow(/not empty/);
    for (const t of ['deals', 'purchases', 'sales', 'offers', 'audit_log']) {
      await resetDb(db);
      if (t === 'deals') await db.insertInto('deals').values({ id: 'D-001', domain: null, strategy: null, status_note: null }).execute();
      else if (t === 'audit_log') await db.insertInto('audit_log').values({ id: newAuditId(), scope: 'admin', method: 'ADMIN', path: 'x', status_code: 200 }).execute();
      else continue; // purchases/sales/offers need a domain; the domains check already covers those rows
      await expect(importBackup(db, dir), t).rejects.toThrow(new RegExp(`${t} is not empty`));
    }
    await resetDb(db);
    await expect(importBackup(db, await mkdtemp(join(tmpdir(), 'dt-empty-')))).rejects.toThrow(/missing backup file/);
    expect((await readFile(join(dir, 'backup/ledger.csv'), 'utf8')).length).toBeGreaterThan(10);
  });
});

describe('BK-8 import refusals', () => {
  async function dirOf(files: Map<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'dt-backup-'));
    for (const [p, c] of files) {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await writeFile(join(dir, p), c);
    }
    return dir;
  }
  const count = async (t: 'domains' | 'ledger_entries' | 'audit_log' | 'offers' | 'deals' | 'purchases' | 'sales') =>
    Number((await db.selectFrom(t).select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  const nothingWritten = async (domains = 0) => {
    expect(await count('domains')).toBe(domains);
    for (const t of ['ledger_entries', 'audit_log', 'offers', 'deals', 'purchases', 'sales'] as const) expect(await count(t), t).toBe(0);
  };
  const migrations = (f: Map<string, string>) => JSON.parse(f.get('backup/migrations.json')!) as string[];

  async function backupOfSeed() {
    await seed();
    const files = await collectBackupFiles(db);
    await resetDb(db);
    return files;
  }

  it('(a) a database with one domains row is refused', async () => {
    const files = await backupOfSeed();
    const dir = await dirOf(files);
    await listedDomain({ domain: G, lander: 'afternic', lander_set_at: new Date('2026-10-10T00:00:00Z') });
    await expect(importBackup(db, dir)).rejects.toThrow(/domains is not empty/);
    expect(await count('domains')).toBe(1);
    for (const t of ['ledger_entries', 'audit_log', 'offers', 'deals', 'purchases', 'sales'] as const) expect(await count(t), t).toBe(0);
  });

  it('(b) a backup whose seeded pricing_settings version differs is refused', async () => {
    const files = await backupOfSeed();
    const rows = JSON.parse(files.get('backup/tables/pricing_settings.json')!) as Record<string, unknown>[];
    rows[0]!.floor_bps = 6000;
    files.set('backup/tables/pricing_settings.json', JSON.stringify(rows));
    await expect(importBackup(db, await dirOf(files))).rejects.toThrow(/pricing_settings version 2 differs/);
    await nothingWritten();
  });

  it('(c) migrations.json with an extra name is refused with MIGRATION_LEVEL_MISMATCH', async () => {
    const files = await backupOfSeed();
    files.set('backup/migrations.json', JSON.stringify([...migrations(files), '9999999999999_future']));
    await expect(importBackup(db, await dirOf(files))).rejects.toThrow(/MIGRATION_LEVEL_MISMATCH.*9999999999999_future/s);
    await nothingWritten();
  });

  it('(d) migrations.json missing a name is refused with MIGRATION_LEVEL_MISMATCH', async () => {
    const files = await backupOfSeed();
    const names = migrations(files);
    files.set('backup/migrations.json', JSON.stringify(names.slice(0, -1)));
    await expect(importBackup(db, await dirOf(files))).rejects.toThrow(new RegExp(`MIGRATION_LEVEL_MISMATCH.*${names.at(-1)}`, 's'));
    await nothingWritten();
  });

  it('(e) an absent migrations.json is refused', async () => {
    const files = await backupOfSeed();
    files.delete('backup/migrations.json');
    await expect(importBackup(db, await dirOf(files))).rejects.toThrow(/MIGRATION_LEVEL_MISMATCH.*predates/s);
    await nothingWritten();
  });

  it('a reordered migrations.json is refused too', async () => {
    // A temporary pgmigrations row keeps the reorder test independent of how many real migrations exist.
    await sql`insert into pgmigrations (name, run_on) values ('9999999999998_order_probe', now())`.execute(db);
    try {
      const files = await backupOfSeed();
      expect(migrations(files).length).toBe(3); // baseline, v1-2-0, probe
      files.set('backup/migrations.json', JSON.stringify([...migrations(files)].reverse()));
      await expect(importBackup(db, await dirOf(files))).rejects.toThrow(/MIGRATION_LEVEL_MISMATCH/);
      await nothingWritten();
    } finally {
      await sql`delete from pgmigrations where name = '9999999999998_order_probe'`.execute(db);
    }
  });
});
