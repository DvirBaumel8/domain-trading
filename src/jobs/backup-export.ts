import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/types.js';
import { redactInvoice } from '../registrars/porkbun.js';
import { ledgerCsvRows, ledgerRows, usdSigned } from '../services/report/portfolio.js';
import { toCsv } from '../services/export.js';

/** Tables written in full (all columns, every row) under backup/tables/ so a restore is lossless. */
export const TABLE_FILES = [
  'settings', 'deals', 'pricing_settings', 'domains', 'ledger_entries', 'listing_history', 'quotes', 'price_schedule',
  'pricing_evidence', 'offers', 'export_runs', 'export_uploads', 'registrar_presence',
  'selection_settings', 'selection_lists', 'sibling_method_approvals', 'screening_evidence', 'screening_runs', 'screening_results', 'screening_verdicts', 'screening_packs', 'manual_quotes',
  'tranches', 'tranche_members',
] as const;
type Row = Record<string, unknown>;

const PK: Record<string, string> = {
  settings: 'id', deals: 'id', pricing_settings: 'version', registrar_presence: 'domain_id', tranches: 'id', audit_log: 'at, id',
};

/** Every row of a table as the database's own JSON (exact timestamp precision), in primary-key order. */
async function dump(trx: Kysely<Database>, table: string): Promise<Row[]> {
  const order = PK[table] ?? 'id';
  const r = await sql<{ j: Row }>`select to_jsonb(t) as j from ${sql.table(table)} t order by ${sql.raw(order)}`.execute(trx);
  return r.rows.map((x) => x.j);
}

/** Account/billing fields dropped from stored registrar payloads before export (Porkbun create returns the prepaid `balance`). */
const PAYLOAD_DROP = new Set(['balance', 'billTo', 'paymentMethods', 'url', 'pdfUrl', 'downloadUrl', 'downloadExpires', 'apikey', 'secretapikey']);
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !PAYLOAD_DROP.has(k)).map(([k, x]) => [k, scrub(x)]));
  return v;
}

export const MIGRATIONS_FILE = 'backup/migrations.json';

/** node-pg-migrate's table is `pgmigrations` (id serial, name, run_on). Names in run order. */
export async function migrationNames(db: Kysely<Database>): Promise<string[]> {
  const r = await sql<{ name: string }>`select name from pgmigrations order by id`.execute(db);
  return r.rows.map((x) => x.name);
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const dollars = (c: unknown) => (typeof c === 'number' ? usdSigned(c) : '');
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

const PORTFOLIO_HEADER = [
  'domain', 'display_name', 'status', 'registrar', 'category', 'deal_id', 'buy_date', 'cost_usd', 'expiry_date', 'renewals_used',
  'drop_date', 'listing_mode', 'bin_usd', 'floor_usd', 'min_offer_usd', 'price_grade', 'sold_at',
];
const OFFERS_HEADER = ['id', 'domain', 'amount_usd', 'source', 'received_at', 'buyer_type', 'external_ref', 'band', 'routing', 'outcome', 'note'];

/**
 * All backup files, deterministic: rows are ordered by primary key, so unchanged data gives identical bytes.
 * One repeatable-read transaction so the files agree with each other. Never includes api_tokens or idempotency_keys.
 * The walk-away is kept in tables/domains.json (a restore needs it) but not in portfolio.csv; the data-backup branch must stay private.
 */
export async function collectBackupFiles(db: Kysely<Database>): Promise<Map<string, string>> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
    await sql`select set_config('TimeZone', 'UTC', true)`.execute(trx);
    const files = new Map<string, string>();
    const t: Record<string, Row[]> = {};
    for (const name of [...TABLE_FILES, 'purchases', 'receipts', 'sales', 'audit_log']) t[name] = await dump(trx, name);
    t.purchases = t.purchases!.map((p) => ({ ...p, response: scrub(p.response), request: scrub(p.request) }));
    t.quotes = t.quotes!.map((q) => ({ ...q, raw: scrub(q.raw) }));

    const names = new Map(t.domains!.map((d) => [d.id as number, d.domain as string]));
    files.set('backup/portfolio.csv', toCsv([
      PORTFOLIO_HEADER,
      ...t.domains!.map((d) => [
        str(d.domain), str(d.display_name), str(d.status), str(d.registrar), str(d.category), str(d.deal_id), str(d.buy_date), dollars(d.cost_cents),
        str(d.expiry_date), str(d.renewals_used), str(d.drop_date), str(d.listing_mode), dollars(d.bin_cents), dollars(d.floor_cents),
        dollars(d.min_offer_cents), str(d.price_grade), str(d.sold_at),
      ]),
    ]));
    files.set('backup/ledger.csv', toCsv(ledgerCsvRows(await ledgerRows(trx, {}))));
    files.set('backup/offers.csv', toCsv([
      OFFERS_HEADER,
      ...t.offers!.map((o) => [
        str(o.id), names.get(o.domain_id as number) ?? '', dollars(o.amount_cents), str(o.source), str(o.received_at), str(o.buyer_type),
        str(o.external_ref), str(o.band), str(o.routing), str(o.outcome), str(o.note),
      ]),
    ]));
    files.set('backup/purchases.json', json(t.purchases));
    files.set('backup/receipts.json', json(t.receipts!.map((r) => ({ ...r, raw: scrub(redactInvoice(r.raw)) }))));
    files.set('backup/sales.json', json(t.sales));
    // Approval text stays (it is the audit trail); client_ip is dropped (personal data).
    files.set('backup/audit.jsonl', t.audit_log!.map((a) => { const { client_ip: _ip, ...rest } = a; return JSON.stringify(rest); }).map((l) => `${l}\n`).join(''));
    for (const name of TABLE_FILES) files.set(`backup/tables/${name}.json`, json(t[name]));
    // The migration level (names only, no run_on: deterministic bytes). import-backup compares it with the target's pgmigrations (BK-8).
    files.set(MIGRATIONS_FILE, json(await migrationNames(trx)));
    return files;
  });
}

export class BackupError extends Error {}

export interface BackupResult { skipped?: boolean; reason?: string; committed?: boolean; commit?: string; files?: number; changed?: number }

const API = 'https://api.github.com';
/** The only branch the job ever writes. Fixed in code, not configurable: no env value can steer a write to main. */
export const BACKUP_BRANCH = 'data-backup';
const enc = encodeURIComponent;

/** git blob sha: sha1("blob <bytes>\0<content>"). */
export const gitBlobSha = (content: string) => {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

interface Log { warn(msg: string): void; info?(msg: string): void }

/**
 * Nightly data-only export to the fixed branch `data-backup` of a separate PRIVATE data repo (config refuses the code repo)
 * through the git data API (blobs, tree, commit, ref). Every run first checks the repo is private.
 */
export class BackupExporter {
  constructor(private readonly deps: { db: Kysely<Database>; config: Pick<Config, 'backup'>; now: () => number; log?: Log }) {}

  private async gh(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.deps.config.backup.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'domain-trading-backup', ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => null);
    // GitHub's git data API answers 409 "Git Repository is empty" on a repo with no commits.
    if (res.status === 409) throw new BackupError('backup repo has no commits; initialize it with a README');
    return { status: res.status, body };
  }

  private async ok(path: string, init?: { method?: string; body?: unknown }) {
    const r = await this.gh(path, init);
    if (r.status < 200 || r.status >= 300) throw new BackupError(`GitHub ${init?.method ?? 'GET'} ${path.split('?')[0]} failed: HTTP ${r.status}`);
    return r.body;
  }

  async runOnce(): Promise<BackupResult> {
    const { token, repo } = this.deps.config.backup;
    if (!token || !repo) {
      const reason = `${!token ? 'GITHUB_BACKUP_TOKEN' : 'GITHUB_BACKUP_REPO'} is not set`;
      // backup.md line 15 / BK-4: always a warning, on every path.
      this.deps.log?.warn('backup export skipped: GITHUB_BACKUP_TOKEN/GITHUB_BACKUP_REPO not set');
      return { skipped: true, reason };
    }
    const base = `/repos/${repo.split('/').map(enc).join('/')}`;
    const meta = await this.gh(base);
    if (meta.status !== 200) throw new BackupError(`cannot read the backup repo (HTTP ${meta.status}); it must exist and the token must reach it`);
    if (meta.body?.private !== true || (meta.body.visibility !== undefined && meta.body.visibility !== 'private')) {
      throw new BackupError('backup repo is not private; refusing to export (the backup holds financial data and the private walk-away)');
    }

    const files = await collectBackupFiles(this.deps.db);
    const shas = new Map([...files].map(([p, c]) => [p, gitBlobSha(c)]));
    const ref = await this.gh(`${base}/git/ref/heads/${enc(BACKUP_BRANCH)}`);
    let parent: string | null = null;
    let baseTree: string | null = null;
    const existing = new Map<string, string>();
    if (ref.status === 200) {
      parent = ref.body.object.sha as string;
      baseTree = (await this.ok(`${base}/git/commits/${enc(parent)}`)).tree.sha as string;
      const tree = await this.ok(`${base}/git/trees/${enc(baseTree)}?recursive=1`);
      if (tree.truncated) throw new BackupError('GitHub returned a truncated tree; refusing to compare against a partial listing');
      for (const e of tree.tree as { path: string; type: string; sha: string }[]) if (e.type === 'blob') existing.set(e.path, e.sha);
    } else if (ref.status !== 404) {
      throw new BackupError(`GitHub GET ref failed: HTTP ${ref.status}`);
    }

    const changed = [...files.keys()].filter((p) => existing.get(p) !== shas.get(p));
    const stale = [...existing.keys()].filter((p) => p.startsWith('backup/') && !files.has(p));
    if (parent && changed.length === 0 && stale.length === 0) return { skipped: true, reason: 'unchanged', committed: false, files: files.size, changed: 0 };

    const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const path of changed) {
      const blob = await this.ok(`${base}/git/blobs`, { method: 'POST', body: { content: Buffer.from(files.get(path)!, 'utf8').toString('base64'), encoding: 'base64' } });
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha as string });
    }
    for (const path of stale) entries.push({ path, mode: '100644', type: 'blob', sha: null }); // deletes a file no longer exported
    const tree = await this.ok(`${base}/git/trees`, { method: 'POST', body: { ...(baseTree ? { base_tree: baseTree } : {}), tree: entries } });
    const commit = await this.ok(`${base}/git/commits`, {
      method: 'POST',
      body: { message: `backup ${new Date(this.deps.now()).toISOString()}`, tree: tree.sha, parents: parent ? [parent] : [] },
    });
    if (parent) await this.ok(`${base}/git/refs/heads/${enc(BACKUP_BRANCH)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    else await this.ok(`${base}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${BACKUP_BRANCH}`, sha: commit.sha } });
    return { committed: true, commit: commit.sha as string, files: files.size, changed: changed.length + stale.length };
  }
}
