// The `datasave` job (v5.21.0, CR-071): the daily data saves. Five steps, each with its own status:
//   godaddyInventory   fetches GoDaddy's official inventory files (metadata.json lists them), records size / sha256 / Last-Modified per file in a
//                      write-once manifest, keeps the raw zip on disk (SNAPSHOT_DIR) and parses ONLY closeout_listings.json into datasave_pool.
//   dynadotCloseouts / dynadotAftermarket   not built: no Dynadot key exists, so they report `not_configured` (never an error, never zero rows). Since v5.22.0 they also
//                      say whether a bot upload (POST /snapshots/dynadot, dynadot-upload.ts) for today is sealed.
// v5.22.0 (R-10): the four auction files are also parsed (godaddy_auctions): .com auctions that reached $500, followed until they leave the files.
//   scorePool          (v5.26.0, CR-072) filters and scores the pool and the sealed Dynadot closeouts rows, offline; closeouts/score-pool.ts.
//   buildPanel         the day diff of the closeouts pool (names gone before their end), split by RDAP tag bought / deleted / unknown (v5.34.0, BUG-052).
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
import { runDqMarket, runEpisodes } from '../../../market/index.js';
import { pickproofLabels } from '../../../pickproof/index.js';
import type { RdapLookupFn } from '../../../../core/rdap.js';
import { goneByTag, tagDisappearances } from '../../closeouts/disappearances.js';
import { scorePool, type PoolScorer } from '../../closeouts/score-pool.js';
import { listZipEntries, openZipEntry } from './zip.js';
import { streamArrayItems } from './json-stream.js';

export const GODADDY_INVENTORY_BASE = 'https://inventory.auctions.godaddy.com';
export const GODADDY_SOURCE = 'godaddy_inventory' as const;
export const POOL_SOURCE = 'godaddy_closeouts';
/** The one file that is parsed into rows; the others are kept raw only. */
export const CLOSEOUTS_FILE = 'closeout_listings.json.zip';
/** v5.22.0 (CR-071 R-10): the auction files whose rows are followed in godaddy_auctions (when configured). */
export const AUCTION_FILES: ReadonlySet<string> = new Set(['all_expiring_auctions.json.zip', 'all_biddable_auctions.json.zip', 'all_listings_ending_today.json.zip', 'auctions_ending_today.json.zip']);
/** An auction is followed once its price reached $500. */
export const AUCTION_TRACK_MIN_CENTS = 50_000;
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
  /** v5.26.0 (CR-072): the engine scorer for the `scorePool` step; without it every row gets score null, NO_ACTIVE_MODEL. */
  scorer?: PoolScorer;
  /** Tests may pass a fetch; default is the global one at call time (MSW patches it). */
  fetch?: typeof fetch;
  log?: { warn: (obj: unknown, msg?: string) => void };
  /** v5.34.0 (BUG-052): tests pass an RDAP stub and a no-op sleep for the disappearance tags; default the Verisign lookup. */
  rdap?: RdapLookupFn;
  sleep?: (ms: number) => Promise<void>;
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
    const s = await this.deps.db.selectFrom('settings').select(['datasave_godaddy_files', 'datasave_pool_max_price_cents', 'datasave_pool_keep_days', 'datasave_raw_keep_days', 'datasave_dynadot_keep_days', 'datasave_auction_keep_days']).executeTakeFirstOrThrow();
    return { files: s.datasave_godaddy_files, maxPriceCents: s.datasave_pool_max_price_cents, poolKeepDays: s.datasave_pool_keep_days, rawKeepDays: s.datasave_raw_keep_days, dynadotKeepDays: s.datasave_dynadot_keep_days, auctionKeepDays: s.datasave_auction_keep_days };
  }

  // ---------- godaddyInventory ----------

  async godaddyInventory(): Promise<unknown> {
    const st = await this.settings();
    this.auctionsRead = 0;
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
    const dataDate = results.map((r) => r.data_date).sort().at(-1) ?? runDate;
    return { ...this.summary(dataDate, results), ...(await this.auctionSummary(st.files, results)) };
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
    const parseKind: 'closeouts' | 'auctions' | null = file === CLOSEOUTS_FILE ? 'closeouts' : AUCTION_FILES.has(file) ? 'auctions' : null;
    const parse = parseKind !== null;
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
          const r = parseKind === 'auctions' ? await this.parseAuctions(writePath, dataDate) : await this.parseCloseouts(writePath, dataDate, maxPriceCents);
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

  // ---------- GoDaddy auctions (v5.22.0, CR-071 R-10) ----------

  /**
   * Streams one auction file into godaddy_auctions: only .com, not adult, valid end time, and either a price of $500 or more now or a domain that is
   * already followed (once a name reached $500 it is followed to its end). A domain in several files merges (max bid count, max price, latest end time).
   * Returns the rows kept (upserted) and the rows read.
   */
  async parseAuctions(zipPath: string, dataDate: string): Promise<{ kept: number; total: number }> {
    const { db } = this.deps;
    const tracked = new Set((await db.selectFrom('godaddy_auctions').select('domain').where('ended', '=', false).execute()).map((r) => r.domain));
    const entries = await listZipEntries(zipPath);
    const entry = entries.find((e) => /\.json$/i.test(e.name));
    if (!entry) throw new Error('the zip holds no .json file');
    const seen = new Map<string, { end: number; type: string | null; price: number; bids: number }>();
    let total = 0;
    for await (const raw of streamArrayItems(await openZipEntry(zipPath, entry), 'data')) {
      total++;
      const r = raw as { domainName?: unknown; auctionType?: unknown; auctionEndTime?: unknown; price?: unknown; numberOfBids?: unknown; isAdult?: unknown };
      if (typeof r.domainName !== 'string' || r.isAdult === true) continue;
      const domain = r.domainName.trim().toLowerCase();
      if (!domain.endsWith('.com')) continue;
      const price = priceToCents(r.price);
      const isTracked = tracked.has(domain);
      if (!isTracked && (price === null || price < AUCTION_TRACK_MIN_CENTS)) continue;
      const end = typeof r.auctionEndTime === 'string' ? Date.parse(r.auctionEndTime) : NaN;
      if (Number.isNaN(end)) continue;
      const bids = typeof r.numberOfBids === 'number' && Number.isInteger(r.numberOfBids) && r.numberOfBids >= 0 ? r.numberOfBids : 0;
      const prev = seen.get(domain);
      seen.set(domain, {
        end: prev ? Math.max(prev.end, end) : end, type: typeof r.auctionType === 'string' ? r.auctionType.slice(0, 40) : (prev?.type ?? null),
        price: Math.max(prev?.price ?? 0, price ?? 0), bids: Math.max(prev?.bids ?? 0, bids),
      });
    }
    const all = [...seen.entries()];
    for (let i = 0; i < all.length; i += INSERT_BATCH) {
      const b = all.slice(i, i + INSERT_BATCH);
      await sql`insert into godaddy_auctions (domain, end_time, auction_type, first_seen, last_seen, last_price_cents, max_price_cents, last_bid_count)
        select d, e::timestamptz, t, ${dataDate}::date, ${dataDate}::date, p, p, n
        from unnest(${b.map(([d]) => d)}::text[], ${b.map(([, v]) => new Date(v.end).toISOString())}::text[], ${b.map(([, v]) => v.type)}::text[], ${b.map(([, v]) => v.price)}::int[], ${b.map(([, v]) => v.bids)}::int[]) as u(d, e, t, p, n)
        on conflict (domain) where not ended do update set
          end_time = case when godaddy_auctions.last_seen = excluded.last_seen then greatest(godaddy_auctions.end_time, excluded.end_time) else excluded.end_time end,
          auction_type = coalesce(excluded.auction_type, godaddy_auctions.auction_type),
          last_seen = excluded.last_seen,
          last_price_cents = case when godaddy_auctions.last_seen = excluded.last_seen then greatest(godaddy_auctions.last_price_cents, excluded.last_price_cents) else excluded.last_price_cents end,
          max_price_cents = greatest(godaddy_auctions.max_price_cents, excluded.max_price_cents),
          last_bid_count = case when godaddy_auctions.last_seen = excluded.last_seen then greatest(godaddy_auctions.last_bid_count, excluded.last_bid_count) else excluded.last_bid_count end`.execute(db);
    }
    this.auctionsRead += total;
    return { kept: all.length, total };
  }

  private auctionsRead = 0;

  /**
   * When every configured auction file of the data date is saved (complete), a followed auction that was not seen on that date and whose end time has
   * passed (at or before the files' Last-Modified) has ended: its last bid count and price stay as the final state (0 bids = unsold, for CR-075).
   * With a missing or failed file nothing ends (absence would prove nothing). Returns the step's auction fields.
   */
  private async auctionSummary(configured: string[], results: FileResult[]): Promise<Record<string, unknown>> {
    const { db } = this.deps;
    const files = configured.filter((f) => AUCTION_FILES.has(f));
    if (files.length === 0) return {};
    const dataDate = results.filter((r) => AUCTION_FILES.has(r.file)).map((r) => r.data_date).sort().at(-1);
    const read = this.auctionsRead;
    this.auctionsRead = 0;
    let detection: string;
    let endedNow = 0;
    if (!dataDate) {
      detection = 'skipped: no auction file was listed';
    } else {
      const done = await db.selectFrom('snapshot_manifests').select(['file_name', 'last_modified']).where('source', '=', GODADDY_SOURCE).where('data_date', '=', dataDate).where('status', '=', 'complete').where('file_name', 'in', files).execute();
      if (done.length < files.length) {
        detection = `skipped: ${files.length - done.length} auction file(s) not complete for ${dataDate}`;
      } else {
        const lastMod = new Date(Math.max(...done.map((d) => d.last_modified?.getTime() ?? 0)));
        const res = await db.updateTable('godaddy_auctions').set({ ended: true, final_state_at: dataDate })
          .where('ended', '=', false).where('last_seen', '<', dataDate).where('end_time', '<=', lastMod).executeTakeFirst();
        endedNow = Number(res.numUpdatedRows ?? 0);
        detection = 'ran';
      }
    }
    const count = async (q: ReturnType<typeof db.selectFrom<'godaddy_auctions'>>) => Number((await q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    const trackedN = await count(db.selectFrom('godaddy_auctions').where('ended', '=', false));
    const endedToday = dataDate ? await count(db.selectFrom('godaddy_auctions').where('ended', '=', true).where('final_state_at', '=', dataDate)) : 0;
    return { auctions_seen_n: read, tracked_n: trackedN, ended_today_n: endedToday, ended_now_n: endedNow, auction_end_detection: detection };
  }

  // ---------- Dynadot (the server has no key; the bots upload, v5.22.0) ----------

  async dynadotCloseouts(): Promise<unknown> {
    return this.dynadotStub('dynadot_closeouts');
  }

  async dynadotAftermarket(): Promise<unknown> {
    return this.dynadotStub('dynadot_aftermarket');
  }

  /** Is the bot upload of today's UTC data date sealed for this source? */
  private async botUpload(source: string) {
    const dataDate = utcDay(this.deps.now());
    const m = await this.deps.db.selectFrom('snapshot_manifests').select(['status', 'rows', 'sha256', 'sealed_at']).where('source', '=', source as never).where('data_date', '=', dataDate).where('file_name', '=', 'bot_upload').executeTakeFirst();
    return { data_date: dataDate, sealed: Boolean(m?.sealed_at), status: m?.status ?? 'none', rows: m?.rows ?? null, sha256: m?.sha256 ?? null };
  }

  // TODO(CR-071 follow-up): build the read-only Dynadot calls once a key exists (closeouts: all pages, 5 s apart, dedupe, price_cents as given; aftermarket: at most 5 calls, dollars to cents). No guessing at Dynadot's API before then.
  private async dynadotStub(source: string) {
    return {
      source, status: 'not_configured', reason: this.deps.dynadotKey ? 'a Dynadot key is set but the Dynadot client is not built yet' : 'DYNADOT_API_KEY is not set (no Dynadot key exists)',
      bot_upload: await this.botUpload(source),
    };
  }

  // ---------- scorePool (v5.26.0, CR-072) ----------

  /** Filters and scores the closeouts pool and the sealed Dynadot closeouts rows, offline (no registry or other outside call); see closeouts/score-pool.ts. */
  async scorePool(): Promise<unknown> {
    return scorePool({ db: this.deps.db, now: this.deps.now, scorer: this.deps.scorer, log: this.deps.log });
  }

  // ---------- episodes, dqMarket (v5.23.0, CR-075) ----------

  /** Merges every sealed source and the reported sales into market_names and labels the episodes (R-1, R-2). Idempotent: the retry run and the next day derive the same rows again. */
  async episodes(): Promise<unknown> {
    return runEpisodes(this.deps.db, this.deps.now());
  }

  /** The market data-quality checks (R-3); a failed check sets /health.dq_market to alert and /report DQ_MARKET_FAIL. A failed check is data, not a failed step. */
  async dqMarket(): Promise<unknown> {
    const r = await runDqMarket(this.deps.db, this.deps.now());
    return { status: r.status, failed_checks: r.failed_checks, checks_n: r.results.length };
  }

  // ---------- pickproofLabels (v5.28.0, CR-073) ----------

  /** T30 labels of the pick-proof arm names (30 days after the pick day), RDAP only, at most settings.pickproof_labels_max_per_run lookups; also prunes old pool rows. See pickproof/labels.ts. */
  async pickproofLabels(): Promise<unknown> {
    return pickproofLabels({ db: this.deps.db, now: this.deps.now, log: this.deps.log });
  }

  // ---------- buildPanel ----------

  /**
   * The day diff of the closeouts pool: gone_before_end_n = names of the previous parsed day that were still due to end after the latest day began and are absent from the latest day.
   * v5.34.0 (BUG-052): first tags every gone closeout name and DISAPPEARED episode by RDAP (closeouts/disappearances.ts), then splits gone_before_end_n by tag
   * (gone_bought_n + gone_deleted_n + gone_unknown_n), adds the same for the sealed Dynadot closeouts uploads (`dynadot`), and the tagging run (`tags`).
   */
  async buildPanel(): Promise<unknown> {
    const { db } = this.deps;
    const tags = await tagDisappearances({ db, now: this.deps.now, rdap: this.deps.rdap, sleep: this.deps.sleep });
    const dynadot = await this.dynadotPanel();
    const latest = (await db.selectFrom('datasave_pool').select((eb) => eb.fn.max('data_date').as('d')).where('source', '=', POOL_SOURCE).executeTakeFirst())?.d;
    if (!latest) return { status: 'no_pool', data_date: null, previous_date: null, gone_before_end_n: null, reason: 'no parsed closeouts day yet', dynadot, tags };
    const prev = (await db.selectFrom('datasave_pool').select((eb) => eb.fn.max('data_date').as('d')).where('source', '=', POOL_SOURCE).where('data_date', '<', latest).executeTakeFirst())?.d;
    const count = async (d: string) => Number((await db.selectFrom('datasave_pool').select((eb) => eb.fn.countAll<string>().as('n')).where('source', '=', POOL_SOURCE).where('data_date', '=', d).executeTakeFirstOrThrow()).n);
    const todayN = await count(latest);
    if (!prev) return { status: 'no_previous_day', data_date: latest, previous_date: null, rows: todayN, gone_before_end_n: null, dynadot, tags };
    const start = new Date(`${latest}T00:00:00Z`);
    const gone = await sql<{ n: string }>`select count(*)::text as n from datasave_pool p
      where p.source = ${POOL_SOURCE} and p.data_date = ${prev} and p.ends_at > ${start}
        and not exists (select 1 from datasave_pool t where t.source = p.source and t.data_date = ${latest} and t.domain = p.domain)`.execute(db);
    const added = await sql<{ n: string }>`select count(*)::text as n from datasave_pool t
      where t.source = ${POOL_SOURCE} and t.data_date = ${latest}
        and not exists (select 1 from datasave_pool p where p.source = t.source and p.data_date = ${prev} and p.domain = t.domain)`.execute(db);
    return {
      status: 'ok', data_date: latest, previous_date: prev, rows: todayN, previous_rows: await count(prev), gone_before_end_n: Number(gone.rows[0]!.n),
      ...(await goneByTag(db, 'godaddy_closeouts', latest)), new_n: Number(added.rows[0]!.n), dynadot, tags,
    };
  }

  /** BUG-052 R-6: the same diff for the two latest sealed Dynadot closeouts uploads; null until two exist. */
  private async dynadotPanel(): Promise<unknown> {
    const { db } = this.deps;
    const days = (await sql<{ d: string }>`select distinct r.data_date::text as d from dynadot_rows r
      where r.kind = 'closeouts' and exists (select 1 from snapshot_manifests m where m.source = 'dynadot_closeouts' and m.file_name = 'bot_upload' and m.sealed_at is not null and m.data_date = r.data_date)
      order by 1 desc limit 2`.execute(db)).rows.map((r) => r.d);
    if (days.length < 2) return null;
    const [latest, prev] = days as [string, string];
    const gone = await sql<{ n: string }>`select count(distinct p.domain)::text as n from dynadot_rows p where p.kind = 'closeouts' and p.data_date = ${prev}::date and p.ends_at > ${new Date(`${latest}T00:00:00Z`)}
      and not exists (select 1 from dynadot_rows t where t.kind = 'closeouts' and t.data_date = ${latest}::date and t.domain = p.domain)`.execute(db);
    return { data_date: latest, previous_date: prev, gone_before_end_n: Number(gone.rows[0]!.n), ...(await goneByTag(db, 'dynadot_closeouts', latest)) };
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
    // v5.22.0: bot-uploaded closeouts follow the pool days; aftermarket and closed-auction rows are kept datasave.dynadot_keep_days (they feed CR-075); manifests stay
    const dynadotCut = utcDay(nowMs - (st.dynadotKeepDays - 1) * 86_400_000);
    const closeoutRows = await db.deleteFrom('dynadot_rows').where('kind', '=', 'closeouts').where('data_date', '<', poolCut).executeTakeFirst();
    const otherRows = await db.deleteFrom('dynadot_rows').where('kind', '<>', 'closeouts').where('data_date', '<', dynadotCut).executeTakeFirst();
    // ended GoDaddy auctions are kept datasave.auction_keep_days; an open one not seen for that long is dropped too
    const auctionCut = utcDay(nowMs - st.auctionKeepDays * 86_400_000);
    const auctions = await db.deleteFrom('godaddy_auctions').where((eb) => eb.or([eb.and([eb('ended', '=', true), eb('final_state_at', '<', auctionCut)]), eb.and([eb('ended', '=', false), eb('last_seen', '<', auctionCut)])])).executeTakeFirst();
    return {
      today, raw_cutoff_date: rawCut, raw_deleted: rawDeleted, pool_cutoff_date: poolCut, pool_rows_deleted: Number(pool.numDeletedRows ?? 0),
      dynadot_closeouts_deleted: Number(closeoutRows.numDeletedRows ?? 0), dynadot_rows_deleted: Number(otherRows.numDeletedRows ?? 0), dynadot_cutoff_date: dynadotCut,
      auctions_cutoff_date: auctionCut, auctions_deleted: Number(auctions.numDeletedRows ?? 0),
    };
  }

  private async pruneEmptyDirs(file: string): Promise<void> {
    const dir = join(file, '..');
    try { if ((await readdir(dir)).length === 0) await rmdir(dir); } catch { /* left in place */ }
  }
}
