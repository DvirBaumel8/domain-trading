// The `datasave` job (v5.21.0, CR-071): the daily data saves. Five steps, each with its own status:
//   godaddyInventory   fetches GoDaddy's official inventory files (metadata.json lists them), records size / sha256 / Last-Modified per file in a
//                      write-once manifest, keeps the raw zip on disk (SNAPSHOT_DIR) and parses ONLY closeout_listings.json into datasave_pool.
//   dynadotCloseouts / dynadotAftermarket   not built: no Dynadot key exists, so they report `not_configured` (never an error, never zero rows).
//   buildPanel         the day diff of the closeouts pool (names gone before their end).
//   snapshotRetention  deletes raw zips past their window (manifest stays) and pool rows past their days.
// It reads only the public inventory host (official files, no scraping) and writes only its own tables and files. Files are keyed by the source's
// Last-Modified date, never the run date. A failed fetch is a manifest with status error and the HTTP status, never rows 0.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../../db/types.js';
import { listZipEntries, openZipEntry } from './zip.js';
import { streamArrayItems } from './json-stream.js';

export const GODADDY_INVENTORY_BASE = 'https://inventory.auctions.godaddy.com';
export const GODADDY_SOURCE = 'godaddy_inventory' as const;
export const POOL_SOURCE = 'godaddy_closeouts';
/** The one file that is parsed into rows; the others are kept raw only. */
export const CLOSEOUTS_FILE = 'closeout_listings.json.zip';
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSERT_BATCH = 5_000;

export interface DatasaveDeps {
  db: Kysely<Database>;
  now: () => number;
  /** SNAPSHOT_DIR (config). */
  snapshotDir: string;
  /** DYNADOT_API_KEY when set; the Dynadot client is not built yet either way. */
  dynadotKey?: string;
  /** Tests may pass a fetch; default is the global one at call time (MSW patches it). */
  fetch?: typeof fetch;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

interface FileResult {
  file: string;
  data_date: string;
  status: 'complete' | 'partial' | 'error';
  bytes: number | null;
  sha256: string | null;
  last_modified: string | null;
  rows: number | null;
  http_status: number | null;
  raw_available: boolean;
  /** `SNAPSHOT_SEALED`: the day's file was already saved and sealed; nothing was fetched or changed. */
  code?: 'SNAPSHOT_SEALED';
  error?: string;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const shortError = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);

/** "$1,250" -> 125000 (integer cents); null when it is not a dollar amount. */
export function priceToCents(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

class HttpFail extends Error {
  constructor(readonly status: number | null, message: string) { super(message); }
}

export class DatasaveJob {
  constructor(private readonly deps: DatasaveDeps) {}

  private get fetchFn(): typeof fetch { return this.deps.fetch ?? globalThis.fetch; }

  private async settings() {
    const s = await this.deps.db.selectFrom('settings').select(['datasave_godaddy_files', 'datasave_pool_max_price_cents', 'datasave_pool_keep_days', 'datasave_raw_keep_days']).executeTakeFirstOrThrow();
    return { files: s.datasave_godaddy_files, maxPriceCents: s.datasave_pool_max_price_cents, poolKeepDays: s.datasave_pool_keep_days, rawKeepDays: s.datasave_raw_keep_days };
  }

  // ---------- godaddyInventory ----------

  async godaddyInventory(): Promise<unknown> {
    const st = await this.settings();
    const runDate = utcDay(this.deps.now());
    let listing: Map<string, { lastModified: string; size: number | null }>;
    try {
      listing = await this.readMetadata();
    } catch (e) {
      const status = e instanceof HttpFail ? e.status : null;
      const results: FileResult[] = [];
      for (const file of st.files) results.push(await this.recordFailure(file, runDate, status, shortError(e), null));
      return this.summary(runDate, results);
    }
    const results: FileResult[] = [];
    for (const file of st.files) {
      const entry = listing.get(file);
      if (!entry) { results.push(await this.recordFailure(file, runDate, null, 'FILE_NOT_LISTED: metadata.json does not list this file', null)); continue; }
      const dataDate = entry.lastModified.slice(0, 10);
      const existing = await this.deps.db.selectFrom('snapshot_manifests').selectAll().where('source', '=', GODADDY_SOURCE).where('data_date', '=', dataDate).where('file_name', '=', file).executeTakeFirst();
      if (existing?.sealed_at) {
        results.push({ file, data_date: dataDate, status: 'complete', bytes: existing.bytes, sha256: existing.sha256, last_modified: existing.last_modified?.toISOString() ?? null, rows: existing.rows, http_status: existing.http_status, raw_available: existing.raw_available, code: 'SNAPSHOT_SEALED' });
        continue;
      }
      results.push(await this.saveFile(file, dataDate, entry.lastModified, st.maxPriceCents));
    }
    return this.summary(results.map((r) => r.data_date).sort().at(-1) ?? runDate, results);
  }

  private summary(dataDate: string, files: FileResult[]) {
    const failed = files.filter((f) => f.status !== 'complete').map((f) => ({ file: f.file, status: f.status, http_status: f.http_status, error: f.error ?? null }));
    return {
      data_date: dataDate, files, complete_n: files.filter((f) => f.status === 'complete' && !f.code).length,
      sealed_n: files.filter((f) => f.code === 'SNAPSHOT_SEALED').length, ...(failed.length ? { failed } : {}),
    };
  }

  private async readMetadata(): Promise<Map<string, { lastModified: string; size: number | null }>> {
    let res: Response;
    try {
      res = await this.fetchFn(`${GODADDY_INVENTORY_BASE}/metadata.json`, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
    } catch (e) {
      throw new HttpFail(null, `metadata.json: ${shortError(e)}`);
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new HttpFail(res.status, `metadata.json: HTTP ${res.status}`); }
    let body: unknown;
    try { body = await res.json(); } catch { throw new HttpFail(res.status, 'metadata.json is not JSON'); }
    if (!Array.isArray(body)) throw new HttpFail(res.status, 'metadata.json is not a list');
    const out = new Map<string, { lastModified: string; size: number | null }>();
    for (const r of body as Array<{ FileName?: unknown; LastModified?: unknown; FileSize?: unknown }>) {
      if (typeof r?.FileName !== 'string' || typeof r.LastModified !== 'string' || Number.isNaN(Date.parse(r.LastModified))) continue;
      out.set(r.FileName, { lastModified: new Date(r.LastModified).toISOString(), size: typeof r.FileSize === 'number' ? r.FileSize : null });
    }
    return out;
  }

  /** Writes (or replaces, while still open) the manifest row. A sealed row is never touched. */
  private async upsertManifest(m: { file: string; dataDate: string; status: 'complete' | 'partial' | 'error'; bytes: number | null; sha256: string | null; lastModified: string | null; rows: number | null; rowsTotal: number | null; httpStatus: number | null; error: string | null; rawPath: string | null; rawAvailable: boolean; rawNote: string | null }): Promise<void> {
    const now = new Date(this.deps.now());
    const values = {
      source: GODADDY_SOURCE, data_date: m.dataDate, file_name: m.file, bytes: m.bytes, sha256: m.sha256, last_modified: m.lastModified, rows: m.rows, rows_total: m.rowsTotal,
      status: m.status, http_status: m.httpStatus, error: m.error, raw_path: m.rawPath, raw_available: m.rawAvailable, raw_note: m.rawNote,
      sealed_at: m.status === 'complete' ? now : null, created_at: now, updated_at: now,
    };
    const { source: _s, data_date: _d, file_name: _f, created_at: _c, ...update } = values;
    await this.deps.db.insertInto('snapshot_manifests').values(values)
      .onConflict((oc) => oc.columns(['source', 'data_date', 'file_name']).doUpdateSet(update).where('snapshot_manifests.sealed_at', 'is', null)).execute();
  }

  private async recordFailure(file: string, dataDate: string, httpStatus: number | null, error: string, lastModified: string | null): Promise<FileResult> {
    await this.upsertManifest({ file, dataDate, status: 'error', bytes: null, sha256: null, lastModified, rows: null, rowsTotal: null, httpStatus, error, rawPath: null, rawAvailable: false, rawNote: null });
    return { file, data_date: dataDate, status: 'error', bytes: null, sha256: null, last_modified: lastModified, rows: null, http_status: httpStatus, raw_available: false, error };
  }

  private async saveFile(file: string, dataDate: string, lastModified: string, maxPriceCents: number): Promise<FileResult> {
    const parse = file === CLOSEOUTS_FILE;
    // where the raw zip goes; if the folder can't be written the job goes on without raw files
    const rawDir = join(this.deps.snapshotDir, GODADDY_SOURCE, dataDate);
    let rawOk = true;
    let rawNote: string | null = null;
    try { await mkdir(rawDir, { recursive: true }); } catch (e) { rawOk = false; rawNote = `snapshot folder not writable: ${shortError(e)}`; }
    const finalPath = join(rawDir, file);
    let tmpDir: string | null = null;
    let writePath: string | null = rawOk ? `${finalPath}.part` : null;
    if (!rawOk && parse) { tmpDir = await mkdtemp(join(tmpdir(), 'dt-datasave-')); writePath = join(tmpDir, file); }
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      let res: Response;
      try {
        res = await this.fetchFn(`${GODADDY_INVENTORY_BASE}/${file}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      } catch (e) {
        throw new HttpFail(null, shortError(e));
      }
      if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); throw new HttpFail(res.status, `HTTP ${res.status}`); }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) { await res.body.cancel().catch(() => {}); throw new HttpFail(res.status, `SIZE_CAP: ${declared} bytes is over ${MAX_FILE_BYTES}`); }
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > MAX_FILE_BYTES) return cb(new HttpFail(res.status, `SIZE_CAP: over ${MAX_FILE_BYTES} bytes`));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const sink = writePath ? createWriteStream(writePath) : new Writable({ write: (_c, _e, cb) => cb() });
      try {
        await pipeline(Readable.fromWeb(res.body as never), meter, sink);
      } catch (e) {
        throw e instanceof HttpFail ? e : new HttpFail(res.status, `download failed: ${shortError(e)}`);
      }
      const sha256 = hash.digest('hex');
      let rows: number | null = null;
      let rowsTotal: number | null = null;
      let status: 'complete' | 'partial' = 'complete';
      let error: string | null = null;
      if (parse && writePath) {
        try {
          const r = await this.parseCloseouts(writePath, dataDate, maxPriceCents);
          rows = r.kept; rowsTotal = r.total;
        } catch (e) {
          status = 'partial';
          error = `parse failed: ${shortError(e)}`;
        }
      }
      let rawPath: string | null = null;
      if (rawOk && writePath) { await rename(writePath, finalPath); rawPath = finalPath; }
      await this.upsertManifest({ file, dataDate, status, bytes, sha256, lastModified, rows, rowsTotal, httpStatus: 200, error, rawPath, rawAvailable: rawPath !== null, rawNote });
      return { file, data_date: dataDate, status, bytes, sha256, last_modified: lastModified, rows, http_status: 200, raw_available: rawPath !== null, ...(error ? { error } : {}) };
    } catch (e) {
      if (rawOk && writePath) await rm(writePath, { force: true }).catch(() => {});
      const status = e instanceof HttpFail ? e.status : null;
      return this.recordFailure(file, dataDate, status, shortError(e), lastModified);
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Streams the closeouts zip into datasave_pool: only .com names up to the price cap that are not adult. Returns the rows kept and the rows seen. */
  async parseCloseouts(zipPath: string, dataDate: string, maxPriceCents: number): Promise<{ kept: number; total: number }> {
    const entries = await listZipEntries(zipPath);
    const entry = entries.find((e) => /closeout_listings\.json$/i.test(e.name)) ?? entries.find((e) => /\.json$/i.test(e.name));
    if (!entry) throw new Error('the zip holds no .json file');
    await this.deps.db.deleteFrom('datasave_pool').where('data_date', '=', dataDate).where('source', '=', POOL_SOURCE).execute();
    let batch: Array<{ data_date: string; source: string; domain: string; price_cents: number; ends_at: Date }> = [];
    let kept = 0;
    let total = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const res = await this.deps.db.insertInto('datasave_pool').values(batch).onConflict((oc) => oc.doNothing()).executeTakeFirst();
      kept += Number(res.numInsertedOrUpdatedRows ?? 0);
      batch = [];
    };
    for await (const raw of streamArrayItems(await openZipEntry(zipPath, entry), 'data')) {
      total++;
      const r = raw as { domainName?: unknown; price?: unknown; auctionEndTime?: unknown; isAdult?: unknown };
      if (typeof r.domainName !== 'string' || r.isAdult === true) continue;
      const domain = r.domainName.trim().toLowerCase();
      if (!domain.endsWith('.com')) continue;
      const cents = priceToCents(r.price);
      if (cents === null || cents > maxPriceCents) continue;
      const ends = typeof r.auctionEndTime === 'string' ? new Date(r.auctionEndTime) : null;
      if (!ends || Number.isNaN(ends.getTime())) continue;
      batch.push({ data_date: dataDate, source: POOL_SOURCE, domain, price_cents: cents, ends_at: ends });
      if (batch.length >= INSERT_BATCH) await flush();
    }
    await flush();
    return { kept, total };
  }

  // ---------- Dynadot (not built) ----------

  async dynadotCloseouts(): Promise<unknown> {
    return this.dynadotStub('dynadot_closeouts');
  }

  async dynadotAftermarket(): Promise<unknown> {
    return this.dynadotStub('dynadot_aftermarket');
  }

  // TODO(CR-071 follow-up): build the read-only Dynadot calls once a key exists (closeouts: all pages, 5 s apart, dedupe, price_cents as given; aftermarket: at most 5 calls, dollars to cents). No guessing at Dynadot's API before then.
  private dynadotStub(source: string) {
    return { source, status: 'not_configured', reason: this.deps.dynadotKey ? 'a Dynadot key is set but the Dynadot client is not built yet' : 'DYNADOT_API_KEY is not set (no Dynadot key exists)' };
  }

  // ---------- buildPanel ----------

  /** The day diff of the closeouts pool: gone_before_end_n = names of the previous parsed day that were still due to end after the latest day began and are absent from the latest day. */
  async buildPanel(): Promise<unknown> {
    const { db } = this.deps;
    const latest = (await db.selectFrom('datasave_pool').select((eb) => eb.fn.max('data_date').as('d')).where('source', '=', POOL_SOURCE).executeTakeFirst())?.d;
    if (!latest) return { status: 'no_pool', data_date: null, previous_date: null, gone_before_end_n: null, reason: 'no parsed closeouts day yet' };
    const prev = (await db.selectFrom('datasave_pool').select((eb) => eb.fn.max('data_date').as('d')).where('source', '=', POOL_SOURCE).where('data_date', '<', latest).executeTakeFirst())?.d;
    const count = async (d: string) => Number((await db.selectFrom('datasave_pool').select((eb) => eb.fn.countAll<string>().as('n')).where('source', '=', POOL_SOURCE).where('data_date', '=', d).executeTakeFirstOrThrow()).n);
    const todayN = await count(latest);
    if (!prev) return { status: 'no_previous_day', data_date: latest, previous_date: null, rows: todayN, gone_before_end_n: null };
    const start = new Date(`${latest}T00:00:00Z`);
    const gone = await sql<{ n: string }>`select count(*)::text as n from datasave_pool p
      where p.source = ${POOL_SOURCE} and p.data_date = ${prev} and p.ends_at > ${start}
        and not exists (select 1 from datasave_pool t where t.source = p.source and t.data_date = ${latest} and t.domain = p.domain)`.execute(db);
    const added = await sql<{ n: string }>`select count(*)::text as n from datasave_pool t
      where t.source = ${POOL_SOURCE} and t.data_date = ${latest}
        and not exists (select 1 from datasave_pool p where p.source = t.source and p.data_date = ${prev} and p.domain = t.domain)`.execute(db);
    return { status: 'ok', data_date: latest, previous_date: prev, rows: todayN, previous_rows: await count(prev), gone_before_end_n: Number(gone.rows[0]!.n), new_n: Number(added.rows[0]!.n) };
  }

  // ---------- snapshotRetention ----------

  /** Raw zips older than datasave.raw_keep_days are deleted (manifest stays, raw_available false, raw_deleted_at set); pool rows older than datasave.pool_keep_days days go. */
  async snapshotRetention(): Promise<unknown> {
    const { db } = this.deps;
    const st = await this.settings();
    const nowMs = this.deps.now();
    const today = utcDay(nowMs);
    const rawCut = utcDay(nowMs - st.rawKeepDays * 86_400_000);
    const poolCut = utcDay(nowMs - (st.poolKeepDays - 1) * 86_400_000);
    const old = await db.selectFrom('snapshot_manifests').select(['id', 'raw_path']).where('raw_available', '=', true).where('data_date', '<', rawCut).execute();
    let rawDeleted = 0;
    for (const m of old) {
      if (m.raw_path) {
        try { await rm(m.raw_path, { force: true }); } catch (e) { this.deps.log?.warn({ err: shortError(e) }, 'datasave: raw file not deleted'); continue; }
        await this.pruneEmptyDirs(m.raw_path);
      }
      await db.updateTable('snapshot_manifests').set({ raw_available: false, raw_deleted_at: new Date(nowMs), raw_path: null }).where('id', '=', m.id).execute();
      rawDeleted++;
    }
    const pool = await db.deleteFrom('datasave_pool').where('data_date', '<', poolCut).executeTakeFirst();
    return { today, raw_cutoff_date: rawCut, raw_deleted: rawDeleted, pool_cutoff_date: poolCut, pool_rows_deleted: Number(pool.numDeletedRows ?? 0) };
  }

  private async pruneEmptyDirs(file: string): Promise<void> {
    const dir = join(file, '..');
    try { if ((await readdir(dir)).length === 0) await rmdir(dir); } catch { /* left in place */ }
  }
}
