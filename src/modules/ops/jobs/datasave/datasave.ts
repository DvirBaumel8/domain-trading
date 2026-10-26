// The `datasave` job (v5.21.0, CR-071): the daily data saves. Five steps, each with its own status:
//   godaddyInventory   fetches GoDaddy's official inventory files (metadata.json lists them), records size / sha256 / Last-Modified per file in a
//                      write-once manifest, keeps the raw zip on disk (SNAPSHOT_DIR) and parses ONLY closeout_listings.json into datasave_pool.
//   dynadotCloseouts / dynadotAftermarket   not built: no Dynadot key exists, so they report `not_configured` (never an error, never zero rows). Since v5.22.0 they also
//                      say whether a bot upload (POST /snapshots/dynadot, dynadot-upload.ts) for today is sealed.
// v5.22.0 (R-10): the four auction files are also parsed (godaddy_auctions): .com auctions that reached $500, followed until they leave the files.
//   scorePool          (v5.26.0, CR-072) filters and scores the pool and the sealed Dynadot closeouts rows, offline; closeouts/score-pool.ts.
//   buildPanel         the day diff of the closeouts pool (names gone before their end), split by RDAP tag bought / deleted / unknown (v5.34.0, BUG-052).
//   engineFeed         (v5.41.0) free rows for the scoring engine: closeout names that left the list and were deleted (engine_unsold) and GoDaddy auctions that ended with
//                      a bid (engine_sales). Reuses the engine's own upload code (storeUnsold / storeSales), one engine_uploads row per kind per run.
//   auctionShortlist   (v5.45.0, G-127) the daily shortlist of the best live GoDaddy auctions (ops/auctions/shortlist.ts): score, other endings, automatic pre-bid.
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
import { idtDay } from '../../../../core/dates.js';
import { AppError } from '../../../../http/errors.js';
import { guardDbSize, loadRegimeTest, storeSales, storeUnsold, type DbSizeGuard, type RegimeTest } from '../../../engine/index.js';
import { runDqMarket, runEpisodes } from '../../../market/index.js';
import { autoSeal, pickproofLabels } from '../../../pickproof/index.js';
import type { RdapLookupFn } from '../../../../core/rdap.js';
import { goneByTag, tagDisappearances } from '../../closeouts/disappearances.js';
import { checkExpiries } from '../../closeouts/expiries.js';
import { chunks } from '../../../../core/chunks.js';
import { scorePool, type PoolScorer } from '../../closeouts/score-pool.js';
import { runAuctionShortlist } from '../../auctions/shortlist.js';
import type { ScreeningDeps } from '../../../selection/index.js';
import { listZipEntries, openZipEntry } from './zip.js';
import { streamArrayItems } from './json-stream.js';
import { demandFields, mergeDemand, type DemandFields } from './auction-fields.js';

export const GODADDY_INVENTORY_BASE = 'https://inventory.auctions.godaddy.com';
export const GODADDY_SOURCE = 'godaddy_inventory' as const;
export const POOL_SOURCE = 'godaddy_closeouts';
/** The one file that is parsed into rows; the others are kept raw only. */
export const CLOSEOUTS_FILE = 'closeout_listings.json.zip';
/** v5.22.0 (CR-071 R-10): the auction files whose rows are followed in godaddy_auctions (when configured). */
export const AUCTION_FILES: ReadonlySet<string> = new Set(['all_expiring_auctions.json.zip', 'all_biddable_auctions.json.zip', 'all_listings_ending_today.json.zip', 'auctions_ending_today.json.zip']);
/** v5.50.0 (P6): the bands of engine_auction_ends: opening = final price at most $1, low = under $25, mid = the rest up to the sold line. */
export const AUCTION_END_OPENING_MAX_CENTS = 100;
export const AUCTION_END_LOW_MAX_CENTS = 2500;
/** v5.41.0: where the official ended-auction rows of engineFeed point (the inventory host's file list). */
export const AUCTION_SOURCE = 'godaddy_auctions_file';
/** Rough size of one engine row for the database size guard. */
const ENGINE_ROW_BYTES = 300;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const INSERT_BATCH = 5_000;
const INT4_MAX = 2_147_483_647;

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
  /** v5.41.0: the database size guard for engineFeed (same limit as the engine uploads). Without it the step skips the guard. */
  dbSize?: DbSizeGuard;
  /** v5.45.0 (G-127): the outside-call deps of the screening code (RDAP, DNS, site fetch) for the `auctionShortlist` endings and automatic pre-bid; without it both are skipped. */
  screening?: ScreeningDeps;
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
  /** `SNAPSHOT_SEALED`: the day's file was already saved and sealed; nothing was fetched or changed. `SNAPSHOT_SEALED_REPARSED` (v5.54.0): sealed, and its auction rows were parsed again from the kept raw file to add fields the first parse did not have. */
  code?: 'SNAPSHOT_SEALED' | 'SNAPSHOT_SEALED_REPARSED';
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
    const s = await this.deps.db.selectFrom('settings').select(['datasave_godaddy_files', 'datasave_pool_max_price_cents', 'datasave_pool_keep_days', 'datasave_raw_keep_days', 'datasave_dynadot_keep_days', 'datasave_auction_keep_days', 'datasave_auction_live_keep_days', 'datasave_auction_min_cents', 'shortlist_keep_days']).executeTakeFirstOrThrow();
    return { files: s.datasave_godaddy_files, maxPriceCents: s.datasave_pool_max_price_cents, poolKeepDays: s.datasave_pool_keep_days, rawKeepDays: s.datasave_raw_keep_days, dynadotKeepDays: s.datasave_dynadot_keep_days, auctionKeepDays: s.datasave_auction_keep_days, liveKeepDays: s.datasave_auction_live_keep_days, auctionMinCents: s.datasave_auction_min_cents, shortlistKeepDays: s.shortlist_keep_days };
  }

  // ---------- godaddyInventory ----------

  async godaddyInventory(): Promise<unknown> {
    const st = await this.settings();
    this.auctionsRead = 0;
    this.liveKept = 0;
    this.liveBandMax = null;
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
        // v5.54.0: a sealed auction file whose day has live rows but none with the demand fields (added in v5.49.0 after the day was saved) is parsed again from the kept raw
        // zip, so the shortlist of that day gets them. The parse is the same merge as a first parse (coalesce keeps known values); the sealed manifest is not touched.
        let code: 'SNAPSHOT_SEALED' | 'SNAPSHOT_SEALED_REPARSED' = 'SNAPSHOT_SEALED';
        if (AUCTION_FILES.has(file) && existing.raw_available && existing.raw_path && await this.liveRowsLackDemand(dataDate)) {
          try { await this.parseAuctions(existing.raw_path, dataDate, st.auctionMinCents); code = 'SNAPSHOT_SEALED_REPARSED'; } catch (e) { this.deps.log?.warn({ file, err: shortError(e) }, 'datasave: sealed auction file not parsed again'); }
        }
        results.push({ file, data_date: dataDate, status: 'complete', bytes: existing.bytes, sha256: existing.sha256, last_modified: existing.last_modified?.toISOString() ?? null, rows: existing.rows, http_status: existing.http_status, raw_available: existing.raw_available, code });
        continue;
      }
      results.push(await this.saveFile(file, dataDate, entry.lastModified, st.maxPriceCents, st.auctionMinCents));
    }
    const dataDate = results.map((r) => r.data_date).sort().at(-1) ?? runDate;
    return { ...this.summary(dataDate, results), ...(await this.auctionSummary(st.files, results)) };
  }

  /** v5.54.0: true when the day has live auction rows and none of them carries a demand field (the day was parsed before v5.49.0). */
  private async liveRowsLackDemand(dataDate: string): Promise<boolean> {
    const r = await sql<{ n: string; k: string }>`select count(*) as n, count(*) filter (where developed_tlds is not null or exact_match_tlds is not null) as k from godaddy_auctions_live where data_date = ${dataDate}::date`.execute(this.deps.db);
    const row = r.rows[0];
    return row !== undefined && Number(row.n) > 0 && Number(row.k) === 0;
  }

  private summary(dataDate: string, files: FileResult[]) {
    const failed = files.filter((f) => f.status !== 'complete').map((f) => ({ file: f.file, status: f.status, http_status: f.http_status, error: f.error ?? null }));
    return {
      data_date: dataDate, files, complete_n: files.filter((f) => f.status === 'complete' && !f.code).length,
      sealed_n: files.filter((f) => f.code === 'SNAPSHOT_SEALED' || f.code === 'SNAPSHOT_SEALED_REPARSED').length, reparsed_n: files.filter((f) => f.code === 'SNAPSHOT_SEALED_REPARSED').length, ...(failed.length ? { failed } : {}),
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

  private async saveFile(file: string, dataDate: string, lastModified: string, maxPriceCents: number, auctionMinCents: number): Promise<FileResult> {
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
          const r = parseKind === 'auctions' ? await this.parseAuctions(writePath, dataDate, auctionMinCents) : await this.parseCloseouts(writePath, dataDate, maxPriceCents);
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
   * Streams one auction file into godaddy_auctions: only .com, not adult, valid end time, and either a price of settings.datasave_auction_min_cents or more now (default $100 since 5.41.0; was $500) or a domain that is
   * already followed (once a name reached $500 it is followed to its end). A domain in several files merges (max bid count, max price, latest end time).
   * Returns the rows kept (upserted) and the rows read.
   */
  async parseAuctions(zipPath: string, dataDate: string, minCents?: number): Promise<{ kept: number; total: number }> {
    const { db } = this.deps;
    const trackMin = minCents ?? (await this.settings()).auctionMinCents; // v5.41.0: settings.datasave_auction_min_cents (was the fixed $500)
    const tracked = new Set((await db.selectFrom('godaddy_auctions').select('domain').where('ended', '=', false).execute()).map((r) => r.domain));
    const entries = await listZipEntries(zipPath);
    const entry = entries.find((e) => /\.json$/i.test(e.name));
    if (!entry) throw new Error('the zip holds no .json file');
    const seen = new Map<string, { end: number; type: string | null; price: number; bids: number }>();
    // v5.37.0: the in-range band (price <= the S8 cap, at least min bids) is read at run time, so it follows the cap
    const band = await db.selectFrom('settings').select(['s8_max_price_cents', 'datasave_auction_live_min_bids']).executeTakeFirstOrThrow();
    type Live = { end: number; type: string | null; price: number; bids: number; age: number | null; valuation: number | null; views: number | null; demand: DemandFields };
    const live = new Map<string, Live>();
    const nonNegInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= INT4_MAX ? v : null);
    const cap4 = (v: number | null): number | null => (v !== null && v <= INT4_MAX ? v : null);
    let total = 0;
    for await (const raw of streamArrayItems(await openZipEntry(zipPath, entry), 'data')) {
      total++;
      const r = raw as { domainName?: unknown; auctionType?: unknown; auctionEndTime?: unknown; price?: unknown; numberOfBids?: unknown; isAdult?: unknown; domainAge?: unknown; valuation?: unknown; pageviews?: unknown; exactMatchTlds?: unknown; developedTlds?: unknown; keywordRegistrations?: unknown; semrushSearchVolume?: unknown; semrushCpc?: unknown };
      if (typeof r.domainName !== 'string' || r.isAdult === true) continue;
      const domain = r.domainName.trim().toLowerCase();
      if (!domain.endsWith('.com')) continue;
      const price = priceToCents(r.price);
      const end = typeof r.auctionEndTime === 'string' ? Date.parse(r.auctionEndTime) : NaN;
      const bids = nonNegInt(r.numberOfBids) ?? 0;
      if (!Number.isNaN(end) && price !== null && bids >= band.datasave_auction_live_min_bids && price <= band.s8_max_price_cents) {
        const pl = live.get(domain);
        const type = typeof r.auctionType === 'string' ? r.auctionType.slice(0, 40) : null;
        live.set(domain, {
          end: pl ? Math.max(pl.end, end) : end, type: pl?.type ?? type, price: Math.max(pl?.price ?? 0, price), bids: Math.max(pl?.bids ?? 0, bids),
          age: pl?.age ?? nonNegInt(r.domainAge), valuation: pl?.valuation ?? cap4(priceToCents(r.valuation)), views: pl?.views ?? nonNegInt(r.pageviews), demand: mergeDemand(pl?.demand, demandFields(r)),
        });
      }
      const isTracked = tracked.has(domain);
      if (!isTracked && (price === null || price < trackMin)) continue;
      if (Number.isNaN(end)) continue;
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
    const liveAll = [...live.entries()];
    for (let i = 0; i < liveAll.length; i += INSERT_BATCH) {
      const b = liveAll.slice(i, i + INSERT_BATCH);
      // the four files are parsed one after the other for the same data date: merge, never replace
      await sql`insert into godaddy_auctions_live (data_date, domain, end_time, auction_type, price_cents, bid_count, domain_age, valuation_cents, pageviews, exact_match_tlds, developed_tlds, keyword_registrations, search_volume, cpc_cents)
        select ${dataDate}::date, d, e::timestamptz, t, p, n, a, v, w, x1, x2, x3, x4, x5
        from unnest(${b.map(([d]) => d)}::text[], ${b.map(([, x]) => new Date(x.end).toISOString())}::text[], ${b.map(([, x]) => x.type)}::text[], ${b.map(([, x]) => x.price)}::int[], ${b.map(([, x]) => x.bids)}::int[], ${b.map(([, x]) => x.age)}::int[], ${b.map(([, x]) => x.valuation)}::int[], ${b.map(([, x]) => x.views)}::int[], ${b.map(([, x]) => x.demand.exact_match_tlds)}::int[], ${b.map(([, x]) => x.demand.developed_tlds)}::int[], ${b.map(([, x]) => x.demand.keyword_registrations)}::int[], ${b.map(([, x]) => x.demand.search_volume)}::int[], ${b.map(([, x]) => x.demand.cpc_cents)}::int[]) as u(d, e, t, p, n, a, v, w, x1, x2, x3, x4, x5)
        on conflict (data_date, domain) do update set
          end_time = greatest(godaddy_auctions_live.end_time, excluded.end_time),
          auction_type = coalesce(godaddy_auctions_live.auction_type, excluded.auction_type),
          price_cents = greatest(godaddy_auctions_live.price_cents, excluded.price_cents),
          bid_count = greatest(godaddy_auctions_live.bid_count, excluded.bid_count),
          domain_age = coalesce(godaddy_auctions_live.domain_age, excluded.domain_age),
          valuation_cents = coalesce(godaddy_auctions_live.valuation_cents, excluded.valuation_cents),
          pageviews = coalesce(godaddy_auctions_live.pageviews, excluded.pageviews),
          exact_match_tlds = coalesce(godaddy_auctions_live.exact_match_tlds, excluded.exact_match_tlds),
          developed_tlds = coalesce(godaddy_auctions_live.developed_tlds, excluded.developed_tlds),
          keyword_registrations = coalesce(godaddy_auctions_live.keyword_registrations, excluded.keyword_registrations),
          search_volume = coalesce(godaddy_auctions_live.search_volume, excluded.search_volume),
          cpc_cents = coalesce(godaddy_auctions_live.cpc_cents, excluded.cpc_cents)`.execute(db);
    }
    this.liveKept += liveAll.length;
    this.liveBandMax = band.s8_max_price_cents;
    this.auctionsRead += total;
    return { kept: all.length, total };
  }

  private auctionsRead = 0;
  private liveKept = 0;
  private liveBandMax: number | null = null;

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
    const liveKept = this.liveKept;
    const liveBandMax = this.liveBandMax;
    this.liveKept = 0;
    this.liveBandMax = null;
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
    return { auctions_seen_n: read, live_kept_n: liveKept, live_band_max_cents: liveBandMax, tracked_n: trackedN, ended_today_n: endedToday, ended_now_n: endedNow, auction_end_detection: detection };
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

  // ---------- pickproofSeal (v5.35.0) ----------

  /** Freezes and seals every pick day before today that no bot sealed (pickproof/store.ts autoSeal). Runs before snapshotRetention, while the rows of D-1 exist. */
  async pickproofSeal(): Promise<unknown> {
    return autoSeal(this.deps.db, this.deps.now());
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
    let regime: RegimeTest | undefined;
    // v5.47.0: the expiry collector needs the regime test (no test = nothing collected), so a failed load is tried once more
    for (let attempt = 0; attempt < 2 && !regime; attempt++) {
      try { regime = await loadRegimeTest(db); } catch (e) { this.deps.log?.warn({ err: shortError(e), attempt }, 'datasave: regime test not loaded, tags keep the plain order'); }
    }
    const tags = await tagDisappearances({ db, now: this.deps.now, rdap: this.deps.rdap, sleep: this.deps.sleep, regime });
    const expiries = await checkExpiries({ db, now: this.deps.now, rdap: this.deps.rdap, sleep: this.deps.sleep, regime, capLeft: Math.max(0, tags.cap - tags.lookups_n) });
    const dynadot = await this.dynadotPanel();
    const latest = (await db.selectFrom('datasave_pool').select((eb) => eb.fn.max('data_date').as('d')).where('source', '=', POOL_SOURCE).executeTakeFirst())?.d;
    if (!latest) return { status: 'no_pool', data_date: null, previous_date: null, gone_before_end_n: null, reason: 'no parsed closeouts day yet', dynadot, tags, expiries };
    const prev = (await db.selectFrom('datasave_pool').select((eb) => eb.fn.max('data_date').as('d')).where('source', '=', POOL_SOURCE).where('data_date', '<', latest).executeTakeFirst())?.d;
    const count = async (d: string) => Number((await db.selectFrom('datasave_pool').select((eb) => eb.fn.countAll<string>().as('n')).where('source', '=', POOL_SOURCE).where('data_date', '=', d).executeTakeFirstOrThrow()).n);
    const todayN = await count(latest);
    if (!prev) return { status: 'no_previous_day', data_date: latest, previous_date: null, rows: todayN, gone_before_end_n: null, dynadot, tags, expiries };
    const start = new Date(`${latest}T00:00:00Z`);
    const gone = await sql<{ n: string }>`select count(*)::text as n from datasave_pool p
      where p.source = ${POOL_SOURCE} and p.data_date = ${prev} and p.ends_at > ${start}
        and not exists (select 1 from datasave_pool t where t.source = p.source and t.data_date = ${latest} and t.domain = p.domain)`.execute(db);
    const added = await sql<{ n: string }>`select count(*)::text as n from datasave_pool t
      where t.source = ${POOL_SOURCE} and t.data_date = ${latest}
        and not exists (select 1 from datasave_pool p where p.source = t.source and p.data_date = ${prev} and p.domain = t.domain)`.execute(db);
    return {
      status: 'ok', data_date: latest, previous_date: prev, rows: todayN, previous_rows: await count(prev), gone_before_end_n: Number(gone.rows[0]!.n),
      ...(await goneByTag(db, 'godaddy_closeouts', latest)), new_n: Number(added.rows[0]!.n), dynadot, tags, expiries,
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

  // ---------- engineFeed (v5.41.0) ----------

  /**
   * Free rows for the scoring engine. Rules: docs/internal/datasave.md "Engine feed".
   *  unsold: godaddy_closeouts disappearances tagged `deleted` (the name left the list before its end and the registry says it is gone) -> engine_unsold,
   *          type dropped_after_held, observation_date = gone_date, caught_by_catcher true when the tag is RE_REGISTERED, false when NOT_REGISTERED, else null.
   *  sales:  GoDaddy auctions that ended with >= 1 bid and a final price >= settings.datasave_auction_min_cents, with no engine_sales row for the name within 20 days
   *          of the end day -> engine_sales (venue godaddy, source godaddy_auctions_file). Mostly investor-to-investor sales: the source marks them.
   * Both go through the engine's own upload code (one engine_uploads row per kind per run, by 'datasave', multi-row inserts, its duplicate rules).
   */
  async engineFeed(): Promise<unknown> {
    const { db } = this.deps;
    const nowMs = this.deps.now();
    const out = { status: 'ok' as 'ok' | 'db_size_high', unsold_inserted_n: 0, expired_unsold_candidates_n: 0, expired_unsold_inserted_n: 0, sales_inserted_n: 0, skipped_dup_n: 0, regime_n: 0, unsold_candidates_n: 0, sales_candidates_n: 0, rejected_n: 0, unsold_upload_id: null as number | null, sales_upload_id: null as number | null, auction_ends_candidates_n: 0, auction_ends_inserted_n: 0, auction_min_cents: 0, db_bytes_before: null as number | null };
    const minCents = (await this.settings()).auctionMinCents;
    out.auction_min_cents = minCents;
    const regime = await loadRegimeTest(db).catch(() => null);
    const ctx = { by: 'datasave', auditId: null, now: nowMs };
    const guard = async (n: number): Promise<boolean> => {
      if (!this.deps.dbSize) return true;
      try { out.db_bytes_before = await guardDbSize(db, this.deps.dbSize, n * ENGINE_ROW_BYTES); return true; } catch (e) {
        if (e instanceof AppError && e.code === 'DB_SIZE_HIGH') { out.status = 'db_size_high'; return false; }
        throw e;
      }
    };

    // ---- unsold
    const gone = (await sql<{ domain: string; gone_date: string; tag_reason: string }>`select d.domain, d.gone_date::text as gone_date, d.tag_reason from disappearances d
      where d.source = 'godaddy_closeouts' and d.tag = 'deleted' and d.domain like '%.com'
        and not exists (select 1 from engine_unsold u where u.domain = d.domain and u.observation_date = d.gone_date)
      order by d.gone_date, d.domain limit 20000`.execute(db)).rows;
    out.unsold_candidates_n = gone.length;
    const deletedTotal = Number((await sql<{ n: string }>`select count(*)::text as n from disappearances where source = 'godaddy_closeouts' and tag = 'deleted' and domain like '%.com'`.execute(db)).rows[0]!.n);
    out.skipped_dup_n += Math.max(0, deletedTotal - gone.length); // already in engine_unsold for that (domain, day)
    if (gone.length > 0 && await guard(gone.length)) {
      const rows = gone.map((g) => ({ domain: g.domain, type: 'dropped_after_held', observation_date: g.gone_date, caught_by_catcher: g.tag_reason === 'RE_REGISTERED' ? true : g.tag_reason === 'NOT_REGISTERED' ? false : null }));
      const r = await storeUnsold(db, rows, ctx);
      out.unsold_inserted_n = r.accepted_n; out.skipped_dup_n += r.duplicate_n; out.rejected_n += r.rejected_n; out.unsold_upload_id = r.upload_id;
      if (regime) out.regime_n = gone.filter((g) => regime(g.domain)).length;
    }

    // ---- unsold, second source (v5.46.0): closeout names that stayed to their end date and dropped (closeout_expiries, tag dropped); observation_date = the end day (IDT)
    if (out.status === 'ok') {
      const ex = (await sql<{ domain: string; ends_on: string; caught: boolean | null }>`select e.domain, e.ends_on::text as ends_on, e.caught from closeout_expiries e
        where e.tag = 'dropped' and e.fed_at is null and e.domain like '%.com' order by e.ends_on, e.domain limit 20000`.execute(db)).rows;
      out.expired_unsold_candidates_n = ex.length;
      if (ex.length > 0 && await guard(ex.length)) {
        const r = await storeUnsold(db, ex.map((g) => ({ domain: g.domain, type: 'dropped_after_held', observation_date: g.ends_on, caught_by_catcher: g.caught })), ctx);
        out.expired_unsold_inserted_n = r.accepted_n; out.skipped_dup_n += r.duplicate_n; out.rejected_n += r.rejected_n;
        out.unsold_upload_id ??= r.upload_id;
        if (regime) out.regime_n += ex.filter((g) => regime(g.domain)).length;
        // fed once stored (a row the engine already had counts as stored: its duplicate rule); a rejected row stays unfed and is offered again
        if (r.rejected_n === 0) for (const part of chunks(ex, 5_000)) await sql`update closeout_expiries t set fed_at = ${new Date(nowMs)} from unnest(${part.map((x) => x.domain)}::text[], ${part.map((x) => x.ends_on)}::date[]) as u(domain, ends_on)
          where t.domain = u.domain and t.ends_on = u.ends_on and t.tag = 'dropped' and t.fed_at is null`.execute(db);
      }
    }

    // ---- sales
    if (out.status === 'ok') {
      const ended = (await sql<{ domain: string; end_time: Date; price: number }>`select a.domain, a.end_time, a.last_price_cents as price from godaddy_auctions a
        where a.ended and a.last_bid_count >= 1 and a.last_price_cents >= ${minCents} and a.domain like '%.com'
          and not exists (select 1 from engine_sales s where s.domain = a.domain and abs(s.sale_date - (a.end_time at time zone 'Asia/Jerusalem')::date) <= 20)
        order by a.end_time, a.domain limit 20000`.execute(db)).rows;
      out.sales_candidates_n = ended.length;
      const endedTotal = Number((await sql<{ n: string }>`select count(*)::text as n from godaddy_auctions where ended and last_bid_count >= 1 and last_price_cents >= ${minCents} and domain like '%.com'`.execute(db)).rows[0]!.n);
      out.skipped_dup_n += Math.max(0, endedTotal - ended.length); // already in engine_sales within 20 days
      if (ended.length > 0 && await guard(ended.length)) {
        const url = `${GODADDY_INVENTORY_BASE}/metadata.json`;
        const rows = ended.map((a) => ({ domain: a.domain, price_usd: a.price / 100, sale_date: idtDay(new Date(a.end_time).getTime()), venue: 'godaddy', source: AUCTION_SOURCE, source_url: url }));
        const r = await storeSales(db, rows, ctx);
        out.sales_inserted_n = r.accepted_n; out.skipped_dup_n += r.duplicate_n; out.rejected_n += r.rejected_n; out.sales_upload_id = r.upload_id;
        if (regime) out.regime_n += ended.filter((a) => regime(a.domain)).length;
      }
    }

    // ---- auction ends (v5.50.0, P6): the middle class. An in-range GoDaddy auction that ended under the sold line (minCents) with >= 1 bid has no engine_sales row; its last
    // godaddy_auctions_live snapshot (price, bids) is stored in engine_auction_ends by band. The price is the last one seen before the end (the final minutes can add a bid).
    // A name that did reach the sold line (godaddy_auctions says so) or already has an engine_sales row within 20 days is left to engine_sales. engine_sales / engine_unsold are untouched.
    if (out.status === 'ok') {
      const ends = (await sql<{ domain: string; end_time: Date; price: number; bids: number }>`select l.domain, l.end_time, l.price_cents as price, l.bid_count as bids from (
          select distinct on (domain) domain, end_time, price_cents, bid_count from godaddy_auctions_live
          where end_time < ${new Date(nowMs)} and bid_count >= 1 and price_cents < ${minCents} and domain like '%.com' order by domain, data_date desc, end_time desc) l
        where not exists (select 1 from godaddy_auctions a where a.domain = l.domain and a.ended and a.last_price_cents >= ${minCents})
          and not exists (select 1 from engine_sales s where s.domain = l.domain and abs(s.sale_date - (l.end_time at time zone 'Asia/Jerusalem')::date) <= 20)
          and not exists (select 1 from engine_auction_ends e where e.domain = l.domain and e.end_date = (l.end_time at time zone 'Asia/Jerusalem')::date)
        order by l.end_time, l.domain limit 20000`.execute(db)).rows;
      out.auction_ends_candidates_n = ends.length;
      if (ends.length > 0 && await guard(ends.length)) {
        for (const part of chunks(ends, 5_000)) {
          const res = await sql`insert into engine_auction_ends (domain, end_date, final_price_cents, bids, band)
            select d, e, p, n, case when p <= ${AUCTION_END_OPENING_MAX_CENTS} then 'opening' when p < ${AUCTION_END_LOW_MAX_CENTS} then 'low' else 'mid' end
            from unnest(${part.map((x) => x.domain)}::text[], ${part.map((x) => idtDay(new Date(x.end_time).getTime()))}::date[], ${part.map((x) => x.price)}::int[], ${part.map((x) => x.bids)}::int[]) as u(d, e, p, n)
            on conflict (domain, end_date) do nothing`.execute(db);
          out.auction_ends_inserted_n += Number(res.numAffectedRows ?? 0);
        }
      }
    }
    return out;
  }

  // ---------- auctionShortlist (v5.45.0, G-127) ----------

  /** The daily shortlist of the best live GoDaddy auctions in our range, with the other endings and an automatic pre-bid for the top names. Rules: docs/internal/auctions.md "Shortlist". */
  async auctionShortlist(): Promise<unknown> {
    return runAuctionShortlist({ db: this.deps.db, now: this.deps.now, screening: this.deps.screening, log: this.deps.log });
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
    // v5.37.0: in-range auctions with bids are kept datasave.auction_live_keep_days (today and the days before it); not append-only
    const liveCut = utcDay(nowMs - st.liveKeepDays * 86_400_000);
    const live = await db.deleteFrom('godaddy_auctions_live').where('data_date', '<', liveCut).executeTakeFirst();
    // v5.45.0: the daily shortlists are kept settings.shortlist_keep_days (not append-only)
    const shortlistCut = utcDay(nowMs - st.shortlistKeepDays * 86_400_000);
    const shortlist = await db.deleteFrom('auction_shortlist').where('data_date', '<', shortlistCut).executeTakeFirst();
    return {
      shortlist_cutoff_date: shortlistCut, shortlist_rows_deleted: Number(shortlist.numDeletedRows ?? 0),
      today, auctions_live_cutoff_date: liveCut, auctions_live_deleted: Number(live.numDeletedRows ?? 0), raw_cutoff_date: rawCut, raw_deleted: rawDeleted, pool_cutoff_date: poolCut, pool_rows_deleted: Number(pool.numDeletedRows ?? 0),
      dynadot_closeouts_deleted: Number(closeoutRows.numDeletedRows ?? 0), dynadot_rows_deleted: Number(otherRows.numDeletedRows ?? 0), dynadot_cutoff_date: dynadotCut,
      auctions_cutoff_date: auctionCut, auctions_deleted: Number(auctions.numDeletedRows ?? 0),
    };
  }

  private async pruneEmptyDirs(file: string): Promise<void> {
    const dir = join(file, '..');
    try { if ((await readdir(dir)).length === 0) await rmdir(dir); } catch { /* left in place */ }
  }
}
