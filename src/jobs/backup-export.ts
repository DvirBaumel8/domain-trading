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
  'pricing_evidence', 'offer_imports', 'offers', 'export_runs', 'export_run_domains', 'export_uploads', 'registrar_presence',
] as const;
type Row = Record<string, unknown>;

const PK: Record<string, string> = {
  settings: 'id', deals: 'id', pricing_settings: 'version', export_run_domains: 'export_id, domain', registrar_presence: 'domain_id', audit_log: 'at, id',
};

/** Every row of a table as the database's own JSON (exact timestamp precision), in primary-key order. */
async function dump(trx: Kysely<Database>, table: string): Promise<Row[]> {
  const order = PK[table] ?? 'id';
  const r = await sql<{ j: Row }>`select to_jsonb(t) as j from ${sql.table(table)} t order by ${sql.raw(order)}`.execute(trx);
  return r.rows.map((x) => x.j);
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
    for (const name of [...TABLE_FILES, 'purchases', 'receipts', 'sales', 'payouts', 'audit_log']) t[name] = await dump(trx, name);

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
    files.set('backup/receipts.json', json(t.receipts!.map((r) => ({ ...r, raw: redactInvoice(r.raw) }))));
    files.set('backup/sales.json', json(t.sales));
    files.set('backup/payouts.json', json(t.payouts));
    // Approval text stays (it is the audit trail); client_ip is dropped (personal data).
    files.set('backup/audit.jsonl', t.audit_log!.map((a) => { const { client_ip: _ip, ...rest } = a; return JSON.stringify(rest); }).map((l) => `${l}\n`).join(''));
    for (const name of TABLE_FILES) files.set(`backup/tables/${name}.json`, json(t[name]));
    return files;
  });
}

export class BackupError extends Error {}

export interface BackupResult { skipped?: boolean; reason?: string; committed?: boolean; commit?: string; files?: number; changed?: number }

const API = 'https://api.github.com';
const PROTECTED = new Set(['main', 'master']);

/** git blob sha: sha1("blob <bytes>\0<content>"). */
export const gitBlobSha = (content: string) => {
  const buf = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

interface Log { warn(msg: string): void; info?(msg: string): void }

/** Nightly data-only export to one branch of the repo through the git data API (blobs, tree, commit, ref). */
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
    return { status: res.status, body };
  }

  private async ok(path: string, init?: { method?: string; body?: unknown }) {
    const r = await this.gh(path, init);
    if (r.status < 200 || r.status >= 300) throw new BackupError(`GitHub ${init?.method ?? 'GET'} ${path.split('?')[0]} failed: HTTP ${r.status}`);
    return r.body;
  }

  async runOnce(): Promise<BackupResult> {
    const { token, repo, branch } = this.deps.config.backup;
    if (!token || !repo) {
      const reason = `${!token ? 'GITHUB_BACKUP_TOKEN' : 'GITHUB_BACKUP_REPO'} is not set`;
      this.deps.log?.warn(`backup export skipped: ${reason}`);
      return { skipped: true, reason };
    }
    if (PROTECTED.has(branch.toLowerCase())) throw new BackupError(`refusing to write to branch "${branch}": the backup job only writes to its data branch`);

    const files = await collectBackupFiles(this.deps.db);
    const shas = new Map([...files].map(([p, c]) => [p, gitBlobSha(c)]));
    const base = `/repos/${repo}`;
    const ref = await this.gh(`${base}/git/ref/heads/${branch}`);
    let parent: string | null = null;
    let baseTree: string | null = null;
    const existing = new Map<string, string>();
    if (ref.status === 200) {
      parent = ref.body.object.sha as string;
      baseTree = (await this.ok(`${base}/git/commits/${parent}`)).tree.sha as string;
      const tree = await this.ok(`${base}/git/trees/${baseTree}?recursive=1`);
      for (const e of tree.tree as { path: string; type: string; sha: string }[]) if (e.type === 'blob') existing.set(e.path, e.sha);
    } else if (ref.status !== 404) {
      throw new BackupError(`GitHub GET ref failed: HTTP ${ref.status}`);
    }

    const changed = [...files.keys()].filter((p) => existing.get(p) !== shas.get(p));
    if (parent && changed.length === 0) return { skipped: true, reason: 'unchanged', committed: false, files: files.size, changed: 0 };

    const entries: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const path of changed) {
      const blob = await this.ok(`${base}/git/blobs`, { method: 'POST', body: { content: Buffer.from(files.get(path)!, 'utf8').toString('base64'), encoding: 'base64' } });
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha as string });
    }
    const tree = await this.ok(`${base}/git/trees`, { method: 'POST', body: { ...(baseTree ? { base_tree: baseTree } : {}), tree: entries } });
    const commit = await this.ok(`${base}/git/commits`, {
      method: 'POST',
      body: { message: `backup ${new Date(this.deps.now()).toISOString()}`, tree: tree.sha, parents: parent ? [parent] : [] },
    });
    if (parent) await this.ok(`${base}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    else await this.ok(`${base}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
    return { committed: true, commit: commit.sha as string, files: files.size, changed: changed.length };
  }
}
