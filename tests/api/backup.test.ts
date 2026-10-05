import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { http, HttpResponse } from 'msw';
import type { FastifyInstance } from 'fastify';
import { BackupExporter, collectBackupFiles, gitBlobSha } from '../../src/jobs/backup-export.js';
import { importBackup } from '../../src/jobs/backup-import.js';
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
const REPO = 'dvir/domain-trading';
const BILLING = '12 Secret Street, Tel Aviv';
const T = 'promptinjectionaudit.com';
const G = 'examplecityroofing.com';

// ---- a stateful fake of the GitHub git data API ----
function fakeGithub(opts: { branch?: string } = {}) {
  const branch = opts.branch ?? 'data-backup';
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
    http.get(`${base}/git/ref/heads/${branch}`, () => (st.ref ? HttpResponse.json({ object: { sha: st.ref } }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 }))),
    http.get(`${base}/git/commits/:sha`, ({ params }) => HttpResponse.json({ tree: { sha: st.commits.get(params.sha as string)!.tree } })),
    http.get(`${base}/git/trees/:sha`, ({ params }) =>
      HttpResponse.json({ tree: [...st.trees.get(params.sha as string)!].map(([path, s]) => ({ path, type: 'blob', sha: s })), truncated: false })),
    http.post(`${base}/git/blobs`, async ({ request }) => {
      const b = (await request.json()) as { content: string; encoding: string };
      const content = Buffer.from(b.content, 'base64').toString('utf8');
      const s = gitBlobSha(content);
      st.blobs.set(s, content);
      return HttpResponse.json({ sha: s }, { status: 201 });
    }),
    http.post(`${base}/git/trees`, async ({ request }) => {
      const b = (await request.json()) as { base_tree?: string; tree: { path: string; sha: string }[] };
      const m = new Map(b.base_tree ? st.trees.get(b.base_tree)! : []);
      for (const e of b.tree) m.set(e.path, e.sha);
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

// ---- a realistic fixture: buy + listing, an offer, a sale with a payout, a receipt with a billing address ----
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
  clock = Date.parse('2026-12-02T09:00:00Z');
  const offer = await app.inject({ method: 'POST', url: '/offers', headers: { ...w, 'idempotency-key': randomUUID() }, payload: { domain: T, amount_usd: '450.00', source: 'afternic', received_at: '2026-12-01T09:12:00+02:00' } });
  expect(offer.statusCode).toBe(201);
  const gid = await listedDomain({ domain: G, lander: 'afternic', lander_set_at: new Date('2026-10-10T00:00:00Z') });
  await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: gid, type: 'registration', amount_cents: -1108, note: 'has, "quotes"\nand a newline' }).execute();
  const sold = await app.inject({
    method: 'POST', url: `/sold/${G}`, headers: { ...w, 'idempotency-key': randomUUID() },
    payload: {
      venue: 'afternic', sale_price: 1995, commission: 299.25, sold_at: '2026-12-01T11:00:00+02:00', transaction_ref: 'AFN-1',
      approval_ref: { text: `it sold on afternic for 1995 (${G})`, approved_at: new Date(clock - 30_000).toISOString() },
      payout: { amount: 1680.75, method: 'wire', fee: 15, received_on: null },
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
    for (const f of ['portfolio.csv', 'ledger.csv', 'purchases.json', 'receipts.json', 'audit.jsonl', 'offers.csv', 'sales.json', 'payouts.json']) expect(a.has(`backup/${f}`)).toBe(true);
    for (const [f, h] of Object.entries(HEADERS)) expect(a.get(f)!.split('\r\n')[0]).toBe(h);
    expect(a.get('backup/ledger.csv')).toContain('"has, ""quotes""\nand a newline"');
    expect(JSON.parse(a.get('backup/sales.json')!)).toHaveLength(1);
    expect(JSON.parse(a.get('backup/payouts.json')!)).toHaveLength(1);
    expect(a.get('backup/offers.csv')).toContain('450.00');

    const receipts = JSON.parse(a.get('backup/receipts.json')!) as { raw: { invoice: Record<string, unknown> } }[];
    expect(receipts[0]!.raw.invoice).toEqual({ id: 'ORD-1', items: [{ domain: T, price_cents: 1108 }] });
    const audit = a.get('backup/audit.jsonl')!;
    expect(audit).toContain(`yes buy ${T}`); // approval text kept
    expect(audit).not.toContain('client_ip');
    expect(audit).not.toContain('127.0.0.1');
    const all = [...a.values()].join('\n');
    for (const leak of ['pk1_', 'sk1_', TOKEN, BILLING, 'token_sha256']) expect(all).not.toContain(leak);
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

  it('refuses main and master without any request', async () => {
    await seed();
    const gh = fakeGithub();
    for (const branch of ['main', 'master', 'Main']) await expect(exporter({ GITHUB_BACKUP_BRANCH: branch }).runOnce()).rejects.toThrow(/refusing to write to branch/);
    expect(gh.st.requests).toHaveLength(0);
  });

  it('a GitHub failure rejects with a message that has no token', async () => {
    await seed();
    mswServer.use(http.get(/api\.github\.com/, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })));
    const err = await exporter().runOnce().catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain(TOKEN);
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
    expect(counts).toMatchObject({ domains: 2, sales: 1, payouts: 1, offers: 1 });
    expect(await buildReport(db, REPORT_AT)).toEqual(reportBefore);

    // Everything re-exports byte-identically; audit rows differ only in token_id (api_tokens are not restored).
    const after = await collectBackupFiles(db);
    const noTok = (t: string) => t.replace(/"token_id":\d+/g, '"token_id":null');
    // pricing_settings: the migration-seeded rows keep the new database's own created_at (append-only; not replaced).
    for (const [p, c] of files) if (p !== 'backup/tables/pricing_settings.json') expect(after.get(p), p).toBe(p === 'backup/audit.jsonl' ? noTok(c) : c);

    // sequences continue after the restored ids
    const id = await db.insertInto('ledger_entries').values({ occurred_on: '2026-12-04', type: 'tool', amount_cents: -1 }).returning('id').executeTakeFirstOrThrow();
    const max = await db.selectFrom('ledger_entries').select(db.fn.max('id').as('m')).executeTakeFirstOrThrow();
    expect(id.id).toBe(max.m);
    expect(Number((await db.selectFrom('ledger_entries').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBe(ledgerCount + 1);
  });

  it('refuses a non-empty database and a directory without backup files', async () => {
    await seed();
    const dir = await writeDir(await collectBackupFiles(db));
    await expect(importBackup(db, dir)).rejects.toThrow(/not empty/);
    await resetDb(db);
    await expect(importBackup(db, await mkdtemp(join(tmpdir(), 'dt-empty-')))).rejects.toThrow(/missing backup file/);
    expect((await readFile(join(dir, 'backup/ledger.csv'), 'utf8')).length).toBeGreaterThan(10);
  });
});
