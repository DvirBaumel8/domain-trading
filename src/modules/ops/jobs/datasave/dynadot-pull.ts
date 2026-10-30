// v5.62.0 (CR-080 item 3): the datasave job reads Dynadot itself, read-only, so the bots stop being the primary source.
// Dynadot RESTful v2 (legacy API3 refuses the restricted key, DOM live check 27 Oct 2026): GET https://api.dynadot.com/restful/v2/...
//   Headers: Authorization: Bearer <key>, X-Request-ID: <uuid v4>, Accept: application/json,
//   X-Signature: base64(HMAC-SHA256(secret, key + "\n" + pathAndQuery + "\n" + requestId + "\n" + body)) (body is empty for GET).
//   - aftermarket `/restful/v2/aftermarket/listings?page=<from 1>&page_size=<n>&currency=USD` -> {code:200, message:"Success", data:{total, listing_item_list:[{listing_id, domain, price "28000.00" dollars, type, ...}]}}
//   - closeouts   path UNKNOWN (DYNADOT_CLOSEOUTS_PATH, empty by default = `not_configured`); when set it is read the same way and mapped defensively.
// Regular accounts: 1 thread, 60 calls a minute. Rows go through the SAME store-and-seal code as POST /snapshots/dynadot (`uploadDynadot`, origin `server`). Key and secret are never logged or returned.
// Dual-runner rule: a sealed (source, day) is a no-op (`SNAPSHOT_SEALED`, no Dynadot call); once the server seals, a bot upload gets the existing 409.
// R-8 / R-8v2 (docs/bot-logic/02): a collapsed aftermarket total or empty deep pages is a GAP (manifest status `gap`, nothing stored); the freeze needs 2 consecutive small-total days.
import { createHmac, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../../../db/types.js';
import { addDays } from '../../../../core/dates.js';
import { advisoryXactLock } from '../../../../core/locks.js';
import { coverageRatio, DYNADOT_MIN_COVERAGE, isLowCoverage } from '../../../../core/snapshot-coverage.js';
import { AppError } from '../../../../http/errors.js';
import { priceToCents } from './datasave-price.js';
import { AFTERMARKET_MIN_CENTS, appendToSealedDay, BOT_UPLOAD_FILE, DYNADOT_MAX_PRICE_CENTS, DYNADOT_MAX_ROWS, dynadotSource, uploadDynadot, type DynadotBody, type DynadotKind } from './dynadot-upload.js';

export const DYNADOT_API_URL = 'https://api.dynadot.com';
export const DYNADOT_LISTINGS_PATH = '/restful/v2/aftermarket/listings';
/** Documented limit for a regular account is 60 calls a minute, one at a time; the datasave rule since v5.21.0 is at least 5 s between calls. Overridable (`DatasaveDeps.dynadotSpacingMs`). */
export const DYNADOT_CALL_SPACING_MS = 5_000;
/** Rows per page. The documented maximum of the REST v2 listings call was not found (27 Oct 2026), so a conservative constant. */
export const DYNADOT_PAGE_SIZE = 1_000;
/** Pages read at most in one run (1,000 rows each; about 470 pages for the whole aftermarket); more is sealed as partial coverage, never skipped silently. */
export const DYNADOT_MAX_PAGES = 500;
/** R-8: a total under 1/10 of the last complete day's total is a collapse. */
export const AFTERMARKET_COLLAPSE_RATIO = 10;
const CALL_TIMEOUT_MS = 120_000;
/** v5.80.0 (CR-099): a sweep over the pages stops after this many failures in a row (with a growing pause between them); the pages left go to the retry sweep. */
export const MAX_CONSECUTIVE_FAILURES = 5;
/** Pause after the n-th failure in a row: 15 s, 30 s, 60 s, then 120 s, each with ±20% jitter; and 120 s before the retry sweep. */
export const RETRY_BASE_MS = 15_000;
export const RETRY_MAX_MS = 120_000;
/** Time a pull may spend reading pages, from its start; the step timeouts are 60 min (aftermarket) and 30 min (closeouts), so storing always has time left. */
export const PULL_BUDGET_MS: Record<'aftermarket' | 'closeouts', number> = { aftermarket: 50 * 60_000, closeouts: 25 * 60_000 };
const FILE = BOT_UPLOAD_FILE;

export interface PullDeps {
  db: Kysely<Database>;
  now: () => number;
  key: string;
  secret: string;
  /** REST v2 path of the expired closeouts (DYNADOT_CLOSEOUTS_PATH); required for pullCloseouts. */
  closeoutsPath?: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  baseUrl?: string;
  spacingMs?: number;
  /** Jitter source (tests pass a constant). */
  random?: () => number;
  log?: { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
}

export interface PullSummary {
  source: string;
  status: 'sealed' | 'partial' | 'gap' | 'error' | 'SNAPSHOT_SEALED';
  origin: 'server';
  data_date: string;
  pages_n: number;
  rows_n: number;
  sealed: boolean;
  gap?: { reason: string; total_listings: number | null; baseline_total: number | null; small_total: boolean };
  r8v2?: { small_total_days: number; frozen: boolean };
  calls_n: number;
  elapsed_ms: number;
  [k: string]: unknown;
}

class CallFail extends Error {
  constructor(readonly code: 'ERROR' | 'UNKNOWN', readonly httpStatus: number | null, message: string) { super(message); }
}

interface Page<T> { items: T[]; total: number | null }
type Closeout = { domain: string; price_cents: number; ends_at?: string };
type Listing = { domain: string; listing_id: string; price_cents: number };

/** X-Signature of a Dynadot REST v2 call: base64(HMAC-SHA256(secret, key \n pathAndQuery \n requestId \n body)). */
export function dynadotSignature(secret: string, key: string, pathAndQuery: string, requestId: string, body = ''): string {
  return createHmac('sha256', secret).update(`${key}\n${pathAndQuery}\n${requestId}\n${body}`).digest('base64');
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

class Client {
  calls = 0;
  private last = 0;
  constructor(private readonly d: PullDeps) {}

  /** One call, spaced from the previous one. Throws CallFail (never a silent empty result). `path` is the REST path without a query. */
  async call(label: string, path: string, pageNo: number): Promise<Record<string, unknown>> {
    const spacing = this.d.spacingMs ?? DYNADOT_CALL_SPACING_MS;
    if (this.calls > 0) {
      const wait = this.last + spacing - this.d.now();
      if (wait > 0) await this.d.sleep(wait);
    }
    this.calls++;
    const started = this.d.now();
    const query = `page=${pageNo}&page_size=${DYNADOT_PAGE_SIZE}&currency=USD`;
    const pathAndQuery = `${path}${path.includes('?') ? '&' : '?'}${query}`;
    const requestId = randomUUID();
    const url = `${this.d.baseUrl ?? DYNADOT_API_URL}${pathAndQuery}`;
    const safe = (s: string) => s.split(this.d.key).join('[key]').split(this.d.secret).join('[secret]').slice(0, 300);
    const record = (ok: boolean, extra: Record<string, unknown>) => {
      this.last = this.d.now();
      this.d.log?.info?.({ dynadot_call: label, page_index: pageNo, ok, ms: this.last - started, ...extra }, 'dynadot call');
      if (!ok) this.d.log?.warn({ dynadot_call: label, page_index: pageNo, ok, ...extra }, 'dynadot call failed');
    };
    let res: Response;
    try {
      res = await this.d.fetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${this.d.key}`, 'x-request-id': requestId, 'x-signature': dynadotSignature(this.d.secret, this.d.key, pathAndQuery, requestId) },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      const msg = safe(e instanceof Error ? e.message : String(e));
      record(false, { status: null, error: msg });
      throw new CallFail('UNKNOWN', null, `network: ${msg}`);
    }
    if (!res.ok) {
      record(false, { status: res.status });
      throw new CallFail('ERROR', res.status, `HTTP ${res.status}`);
    }
    let body: unknown;
    try { body = await res.json(); } catch { record(false, { status: res.status, error: 'not JSON' }); throw new CallFail('UNKNOWN', res.status, 'response is not JSON'); }
    const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    if (!root) { record(false, { status: res.status, error: 'unexpected shape' }); throw new CallFail('UNKNOWN', res.status, 'unexpected response shape'); }
    if (String(root.code ?? '') !== '200') {
      const err = safe(str(root.message) ?? `code ${String(root.code ?? '?')}`);
      record(false, { status: res.status, error: err });
      throw new CallFail('ERROR', res.status, `Dynadot said: ${err}`);
    }
    const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : null;
    if (!data) { record(false, { status: res.status, error: 'no data' }); throw new CallFail('UNKNOWN', res.status, 'unexpected response shape'); }
    record(true, { status: res.status });
    return data;
  }
}

/** Closeouts: `GET /restful/v2/aftermarket/get_expired_closeout_domains` (path from Gavriel's connector, checked live 27 Oct 2026). Rows are
 * `data.closeout_item_list[]` with `domain_name`, `current_price` **in cents** (a string: "1500" = $15.00, unlike the listings' dollars) and
 * `end_time_stamp` in ms. */
export const DYNADOT_CLOSEOUTS_DEFAULT_PATH = '/restful/v2/aftermarket/get_expired_closeout_domains';
function parseCloseouts(data: Record<string, unknown>, invalid: { n: number }): Page<Closeout> & { raw_n: number } {
  const arr = Array.isArray(data.closeout_item_list) ? data.closeout_item_list : [];
  const items: Closeout[] = [];
  for (const raw of arr) {
    const it = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
    const domain = str(it?.domain_name)?.trim().toLowerCase().replace(/\.$/, '');
    const centsRaw = str(it?.current_price)?.trim();
    const price = centsRaw !== undefined && /^\d+$/.test(centsRaw) ? Number(centsRaw) : null;
    if (!domain || !/^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(domain) || price === null || price > DYNADOT_MAX_PRICE_CENTS) { invalid.n++; continue; }
    const end = Number(it?.end_time_stamp);
    items.push({ domain, price_cents: price, ...(Number.isFinite(end) && end > 0 ? { ends_at: new Date(end).toISOString() } : {}) });
  }
  const t = Number(data.total);
  return { items, total: Number.isFinite(t) && t >= 0 ? Math.floor(t) : null, raw_n: arr.length };
}

function parseListings(data: Record<string, unknown>, invalid: { n: number }): Page<Listing> & { raw_n: number } {
  const list = Array.isArray(data.listing_item_list) ? data.listing_item_list : [];
  const items: Listing[] = [];
  for (const raw of list) {
    const it = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
    const domain = str(it?.domain)?.trim().toLowerCase().replace(/\.$/, '');
    const id = str(it?.listing_id)?.trim();
    const price = priceToCents(it?.price);
    if (!domain || !id || id.length > 100 || !/^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(domain) || price === null || price > DYNADOT_MAX_PRICE_CENTS) { invalid.n++; continue; }
    items.push({ domain, listing_id: id, price_cents: price });
  }
  const t = Number(data.total);
  return { items, total: Number.isFinite(t) && t >= 0 ? Math.floor(t) : null, raw_n: list.length };
}

const shortErr = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);

async function existingManifest(db: Kysely<Database>, kind: DynadotKind, dataDate: string) {
  return db.selectFrom('snapshot_manifests').select(['status', 'origin', 'sealed_at', 'sha256', 'rows', 'coverage']).where('source', '=', dynadotSource(kind)).where('data_date', '=', dataDate).where('file_name', '=', FILE).executeTakeFirst();
}

/** Writes (or refreshes) an unsealed marker manifest (`gap` or `error`) unless the day is sealed. An `error` never replaces an existing open row. */
async function markManifest(db: Kysely<Database>, kind: DynadotKind, dataDate: string, nowMs: number, v: { status: 'gap' | 'error'; error: string; httpStatus?: number | null; rowsTotal?: number | null; coverage?: Record<string, unknown> }): Promise<void> {
  const now = new Date(nowMs);
  const source = dynadotSource(kind);
  await db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, `dynadot_upload:${source}:${dataDate}`);
    const values = {
      source, data_date: dataDate, file_name: FILE, bytes: null, sha256: null, last_modified: now, rows: null, rows_total: v.rowsTotal ?? null, status: v.status, http_status: v.httpStatus ?? null,
      error: v.error, raw_path: null, raw_available: false, raw_note: 'read by the server from Dynadot; nothing stored', sealed_at: null, created_at: now, updated_at: now, origin: 'server' as const,
      coverage: v.coverage ? JSON.stringify(v.coverage) : null,
    };
    const ins = trx.insertInto('snapshot_manifests').values(values);
    if (v.status === 'error') await ins.onConflict((oc) => oc.columns(['source', 'data_date', 'file_name']).doNothing()).execute();
    else await ins.onConflict((oc) => oc.columns(['source', 'data_date', 'file_name']).doUpdateSet({ status: 'gap', error: v.error, rows: null, rows_total: values.rows_total, last_modified: now, updated_at: now, origin: 'server', coverage: values.coverage, http_status: null, sha256: null }).where('snapshot_manifests.sealed_at', 'is', null)).execute();
  });
}

/**
 * v5.73.0 (BUG-061): a pull step that ended failed without writing its own marker (crash, lock expired, timeout, a thrown error) leaves an `error` manifest
 * for the day it started on, so GET /snapshots shows the hole. Never over a sealed day or an existing open row (a `gap` stays a gap); a later run can still seal.
 */
export async function markPullFailed(db: Kysely<Database>, kind: DynadotKind, startedAtMs: number, nowMs: number, error: string): Promise<void> {
  await markManifest(db, kind, new Date(startedAtMs).toISOString().slice(0, 10), nowMs, { status: 'error', error: `STEP_FAILED: ${error}` });
}

/** Stores the rows in parts of at most DYNADOT_MAX_ROWS and seals with the last (same code as the bot upload route). */
async function storeAndSeal(d: PullDeps, kind: DynadotKind, dataDate: string, rows: Array<Closeout | Listing>, coverage: Record<string, unknown>) {
  let result;
  for (let i = 0; i < rows.length; i += DYNADOT_MAX_ROWS) {
    const last = i + DYNADOT_MAX_ROWS >= rows.length;
    const body = { kind, data_date: dataDate, rows: rows.slice(i, i + DYNADOT_MAX_ROWS), ...(last ? { final: true } : {}) } as DynadotBody;
    result = await uploadDynadot(d.db, body, d.now(), { origin: 'server', rawNote: 'read by the server from Dynadot (REST v2); no raw file', ...(last ? { coverage } : {}) });
  }
  return result!;
}

function summary(kind: DynadotKind, dataDate: string, started: number, d: PullDeps, c: Client, p: Partial<PullSummary> & Pick<PullSummary, 'status'>): PullSummary {
  return { source: dynadotSource(kind), origin: 'server', data_date: dataDate, pages_n: 0, rows_n: 0, sealed: false, calls_n: c.calls, elapsed_ms: d.now() - started, ...p };
}

/** Wraps the store step: a day sealed meanwhile by a bot (409) is the no-op, never an error. */
async function sealOrNoop(d: PullDeps, kind: DynadotKind, dataDate: string, rows: Array<Closeout | Listing>, coverage: Record<string, unknown>) {
  try { return await storeAndSeal(d, kind, dataDate, rows, coverage); } catch (e) {
    if (e instanceof AppError && e.code === 'SNAPSHOT_SEALED') return 'sealed_meanwhile' as const;
    throw e;
  }
}

type StopReason = 'time_cap' | 'consecutive_failures' | null;
interface PageRead<T> { ok: number[]; failed: number[]; items: T[]; raw_n: number; empty: number[]; stopped_by: StopReason; retried: number[]; firstError: CallFail | null }

/**
 * v5.80.0 (CR-099): reads the named pages one at a time (the client keeps the spacing). A failed page waits a growing pause with jitter and the sweep goes on;
 * MAX_CONSECUTIVE_FAILURES in a row end the sweep. The pages not read then get one retry sweep after RETRY_MAX_MS, while the time budget lasts.
 * `failed` is every planned page not read (failed or never reached); `stopped_by` says why the reading ended early, if it did.
 */
async function readPages<T>(c: Client, d: PullDeps, label: string, path: string, pages: number[], parse: (data: Record<string, unknown>) => { items: T[]; raw_n: number }, deadline: number): Promise<PageRead<T>> {
  const out: PageRead<T> = { ok: [], failed: [], items: [], raw_n: 0, empty: [], stopped_by: null, retried: [], firstError: null };
  const rnd = d.random ?? Math.random;
  const pause = (n: number) => Math.round(Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS) * (0.8 + 0.4 * rnd()));
  const sweep = async (list: number[]): Promise<number[]> => {
    const left: number[] = [];
    let consecutive = 0;
    for (let i = 0; i < list.length; i++) {
      const page = list[i]!;
      if (d.now() >= deadline) { out.stopped_by = 'time_cap'; left.push(...list.slice(i)); break; }
      try {
        const p = parse(await c.call(label, path, page));
        consecutive = 0;
        out.ok.push(page); out.raw_n += p.raw_n; out.items.push(...p.items);
        if (p.raw_n === 0) out.empty.push(page);
      } catch (e) {
        out.firstError ??= e instanceof CallFail ? e : new CallFail('UNKNOWN', null, shortErr(e));
        left.push(page);
        consecutive++;
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) { out.stopped_by = 'consecutive_failures'; left.push(...list.slice(i + 1)); break; }
        await d.sleep(pause(consecutive));
      }
    }
    return left;
  };
  let left = await sweep(pages);
  if (left.length > 0 && out.stopped_by !== 'time_cap') {
    await d.sleep(RETRY_MAX_MS);
    out.retried = [...left];
    const first = out.stopped_by;
    out.stopped_by = null;
    left = await sweep(left);
    if (left.length > 0 && out.stopped_by === null) out.stopped_by = first;
  }
  out.ok.sort((a, b) => a - b);
  out.failed = left.sort((a, b) => a - b);
  return out;
}

/** The coverage keys every server pull adds (CR-099): the share of planned pages read, LOW_COVERAGE under DYNADOT_MIN_COVERAGE, and why the reading stopped. */
function coverageVerdict(planned: number[], ok: number[], stoppedBy: StopReason, retried: number[]) {
  const ratio = coverageRatio({ pages_planned: planned, pages_ok: ok }) ?? 0;
  return { coverage_ratio: Math.round(ratio * 1000) / 1000, coverage_status: ratio < DYNADOT_MIN_COVERAGE ? 'LOW_COVERAGE' as const : 'OK' as const, min_coverage: DYNADOT_MIN_COVERAGE, stopped_by: stoppedBy, retried_pages_n: retried.length };
}

type Existing = NonNullable<Awaited<ReturnType<typeof existingManifest>>>;

/**
 * v5.80.0 (CR-099): today's day was sealed by the server with LOW_COVERAGE. Read only the planned pages not read yet and add their rows to the same day
 * (`appendToSealedDay`: new rows only, sha256 and coverage recomputed). A full-coverage day is never touched.
 */
async function topUp<T extends Closeout | Listing>(d: PullDeps, kind: DynadotKind, dataDate: string, started: number, c: Client, ex: Existing, label: string, path: string,
  parse: (data: Record<string, unknown>) => { items: T[]; raw_n: number }): Promise<PullSummary> {
  const prev = ex.coverage as Record<string, unknown>;
  const planned = (prev.pages_planned as number[]).slice();
  const prevOk = new Set(prev.pages_ok as number[]);
  const want = planned.filter((p) => !prevOk.has(p));
  const r = await readPages(c, d, label, path, want, parse, started + PULL_BUDGET_MS[kind === 'aftermarket' ? 'aftermarket' : 'closeouts']);
  const rows = kind === 'aftermarket' ? (r.items as Listing[]).filter((x) => x.price_cents >= AFTERMARKET_MIN_CENTS) : r.items;
  const ok = [...prevOk, ...r.ok].sort((a, b) => a - b);
  const verdict = coverageVerdict(planned, ok, r.stopped_by, r.retried);
  const num = (k: string) => (typeof prev[k] === 'number' ? (prev[k] as number) : 0);
  const coverage: Record<string, unknown> = {
    ...prev, ...verdict, partial: r.failed.length > 0, pages_ok: ok, pages_failed: r.failed, calls_n: num('calls_n') + c.calls, rows_received_n: num('rows_received_n') + rows.length,
    ...(kind === 'aftermarket' ? { listings_read_n: num('listings_read_n') + r.raw_n } : {}),
    top_ups: [...(Array.isArray(prev.top_ups) ? prev.top_ups : []), { at: new Date(d.now()).toISOString(), pages_tried_n: want.length, pages_ok_n: r.ok.length, stopped_by: r.stopped_by }],
  };
  const res = await appendToSealedDay(d.db, kind, dataDate, rows as never, coverage, d.now());
  return summary(kind, dataDate, started, d, c, {
    status: r.failed.length > 0 ? 'partial' : 'sealed', top_up: true, pages_n: r.ok.length, rows_n: res.rows_stored_n, added_n: res.accepted_n, sealed: true, sha256: res.sha256, coverage,
    coverage_status: verdict.coverage_status, ...(r.firstError ? { error: `${r.firstError.code}: ${r.firstError.message}` } : {}),
  });
}

/** A day the server sealed with LOW_COVERAGE and page lists can be topped up; any other sealed day is frozen. */
const canTopUp = (ex: Existing | undefined): boolean => Boolean(ex?.sealed_at && ex.origin === 'server' && isLowCoverage(ex.coverage as never) && Array.isArray((ex.coverage as { pages_planned?: unknown } | null)?.pages_planned));

export async function pullCloseouts(d: PullDeps): Promise<PullSummary> {
  const started = d.now();
  const dataDate = new Date(started).toISOString().slice(0, 10);
  const kind: DynadotKind = 'closeouts';
  if (!d.closeoutsPath) throw new Error('closeouts REST path unknown');
  const path = d.closeoutsPath;
  const c = new Client(d);
  const invalid = { n: 0 };
  let total: number | null = null;
  let perPage = 0;
  const parse = (data: Record<string, unknown>) => { const p = parseCloseouts(data, invalid); return { items: p.items, raw_n: p.raw_n }; };
  const ex = await existingManifest(d.db, kind, dataDate);
  if (canTopUp(ex)) return topUp(d, kind, dataDate, started, c, ex!, 'closeouts', path, parse);
  if (ex?.sealed_at) return summary(kind, dataDate, started, d, c, { status: 'SNAPSHOT_SEALED', sealed: true, sealed_origin: ex.origin, rows_n: ex.rows ?? 0 });
  const deadline = started + PULL_BUDGET_MS.closeouts;
  const r1 = await readPages(c, d, 'closeouts', path, [1], (data) => { const p = parseCloseouts(data, invalid); total = p.total; perPage = p.raw_n; return { items: p.items, raw_n: p.raw_n }; }, deadline);
  const all: Closeout[] = [...r1.items];
  const ok = [...r1.ok];
  const failed = [...r1.failed];
  const retried = [...r1.retried];
  let stoppedBy = r1.stopped_by;
  let firstError = r1.firstError;
  let dataPages = r1.items.length > 0 ? 1 : 0;
  let planned: number[];
  if (ok.length === 1 && total !== null) {
    // v5.80.0 (CR-099 d): with a total the pages are planned from it, so the pages past the end (Dynadot answers them with HTTP 500, seen 29 and 30 Oct) are never asked
    planned = Array.from({ length: Math.min(Math.max(Math.ceil(total / Math.max(perPage, 1)), 1), DYNADOT_MAX_PAGES) }, (_, i) => i + 1);
    const r = await readPages(c, d, 'closeouts', path, planned.slice(1), parse, deadline);
    ok.push(...r.ok); failed.push(...r.failed); retried.push(...r.retried); all.push(...r.items);
    stoppedBy = r.stopped_by; firstError ??= r.firstError; dataPages += r.ok.length - r.empty.length;
  } else {
    // no total on the page (or page 1 never came back): read on until the first empty page, as before 5.80.0
    planned = [1];
    const seen = new Set(all.map((x) => x.domain));
    let consecutive = failed.length;
    for (let page = 2; page <= DYNADOT_MAX_PAGES; page++) {
      if (d.now() >= deadline) { stoppedBy = 'time_cap'; break; }
      planned.push(page);
      let items: Closeout[];
      try { items = parse(await c.call('closeouts', path, page)).items; } catch (e) {
        failed.push(page); firstError ??= e instanceof CallFail ? e : new CallFail('UNKNOWN', null, shortErr(e)); consecutive++;
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) { stoppedBy = 'consecutive_failures'; break; }
        continue;
      }
      consecutive = 0;
      ok.push(page);
      if (items.length === 0) break; // the first empty page is the end of the list
      const fresh = items.filter((x) => !seen.has(x.domain));
      if (fresh.length === 0) break; // Dynadot repeated a page: stop, never loop
      dataPages++;
      for (const x of fresh) { seen.add(x.domain); all.push(x); }
    }
  }
  const seen = new Set<string>();
  const rows = all.filter((x) => (seen.has(x.domain) ? false : (seen.add(x.domain), true)));
  if (rows.length === 0) {
    const err = firstError ? `${firstError.code}: ${firstError.message}` : 'EMPTY_RESULT: Dynadot returned no closeout rows';
    await markManifest(d.db, kind, dataDate, d.now(), { status: 'error', error: err, httpStatus: firstError?.httpStatus ?? null });
    return summary(kind, dataDate, started, d, c, { status: 'error', pages_n: dataPages, error: err, code: firstError?.code ?? 'ERROR', http_status: firstError?.httpStatus ?? null });
  }
  ok.sort((a, b) => a - b);
  failed.sort((a, b) => a - b);
  const capHit = planned.length >= DYNADOT_MAX_PAGES && total === null;
  const verdict = coverageVerdict(planned, ok, stoppedBy, retried);
  const coverage = { partial: failed.length > 0 || capHit, calls_n: c.calls, pages_planned: planned, pages_ok: ok, pages_failed: failed, rows_received_n: rows.length, server: true, invalid_n: invalid.n, total_listings: total, ...verdict };
  const stored = await sealOrNoop(d, kind, dataDate, rows, coverage);
  if (stored === 'sealed_meanwhile') return summary(kind, dataDate, started, d, c, { status: 'SNAPSHOT_SEALED', sealed: true });
  return summary(kind, dataDate, started, d, c, { status: coverage.partial ? 'partial' : 'sealed', pages_n: dataPages, rows_n: stored.rows_stored_n, sealed: stored.sealed, sha256: stored.sha256, coverage, coverage_status: verdict.coverage_status, invalid_n: invalid.n, duplicate_n: stored.duplicate_n, ...(firstError ? { error: `${firstError.code}: ${firstError.message}` } : {}) });
}

/** Last complete aftermarket day before `dataDate` with a stored listing total (server-sealed days only: the bots' totals are counted after the $500 floor, not comparable). */
async function baselineTotal(db: Kysely<Database>, dataDate: string): Promise<number | null> {
  const m = await db.selectFrom('snapshot_manifests').select('coverage').where('source', '=', 'dynadot_aftermarket').where('file_name', '=', FILE).where('status', '=', 'complete').where('data_date', '<', dataDate).orderBy('data_date', 'desc').limit(30).execute();
  for (const r of m) {
    const t = (r.coverage as { total_listings?: unknown } | null)?.total_listings;
    if (typeof t === 'number' && t > 0) return t;
  }
  return null;
}

/** Consecutive earlier days (back from dataDate - 1) already recorded as small-total GAP days. */
async function priorSmallDays(db: Kysely<Database>, dataDate: string): Promise<number> {
  const rows = await db.selectFrom('snapshot_manifests').select(['data_date', 'status', 'coverage']).where('source', '=', 'dynadot_aftermarket').where('file_name', '=', FILE).where('data_date', '<', dataDate).where('data_date', '>=', addDays(dataDate, -14)).execute();
  const byDay = new Map(rows.map((r) => [r.data_date as unknown as string, r]));
  let n = 0;
  for (let day = addDays(dataDate, -1); ; day = addDays(day, -1)) {
    const r = byDay.get(day);
    if (r?.status === 'gap' && (r.coverage as { small_total?: unknown } | null)?.small_total === true) n++; else break;
  }
  return n;
}

export async function pullAftermarket(d: PullDeps): Promise<PullSummary> {
  const started = d.now();
  const dataDate = new Date(started).toISOString().slice(0, 10);
  const kind: DynadotKind = 'aftermarket';
  const c = new Client(d);
  const invalid = { n: 0 };
  const parse = (data: Record<string, unknown>) => parseListings(data, invalid);
  const ex = await existingManifest(d.db, kind, dataDate);
  if (canTopUp(ex)) return topUp(d, kind, dataDate, started, c, ex!, 'listings', DYNADOT_LISTINGS_PATH, parse);
  if (ex?.sealed_at) return summary(kind, dataDate, started, d, c, { status: 'SNAPSHOT_SEALED', sealed: true, sealed_origin: ex.origin, rows_n: ex.rows ?? 0 });
  const fail = async (e: unknown, pages: number) => {
    const f = e instanceof CallFail ? e : new CallFail('UNKNOWN', null, shortErr(e));
    const err = `${f.code}: ${f.message}`;
    await markManifest(d.db, kind, dataDate, d.now(), { status: 'error', error: err, httpStatus: f.httpStatus });
    return summary(kind, dataDate, started, d, c, { status: 'error', pages_n: pages, error: err, code: f.code, http_status: f.httpStatus });
  };
  let first: ReturnType<typeof parseListings>;
  try { first = parseListings(await c.call('listings', DYNADOT_LISTINGS_PATH, 1), invalid); } catch (e) { return fail(e, 0); }
  const total = first.total;
  const baseline = await baselineTotal(d.db, dataDate);
  const gap = async (reason: string, smallTotal: boolean) => {
    const prior = smallTotal ? await priorSmallDays(d.db, dataDate) : 0;
    const days = smallTotal ? prior + 1 : 0;
    const info = { reason, total_listings: total, baseline_total: baseline, small_total: smallTotal };
    await markManifest(d.db, kind, dataDate, d.now(), { status: 'gap', error: `GAP: ${reason}`, rowsTotal: total, coverage: { gap: true, ...info, small_total_days: days, r8v2_frozen: days >= 2, calls_n: c.calls, server: true } });
    return summary(kind, dataDate, started, d, c, { status: 'gap', pages_n: 1, gap: info, r8v2: { small_total_days: days, frozen: days >= 2 } });
  };
  // R-8: a collapsed total (order of magnitude under the last complete day, or nothing) is never sealed as a full panel
  if (total === 0 || (total !== null && baseline !== null && total * AFTERMARKET_COLLAPSE_RATIO < baseline)) return gap(total === 0 ? 'total_zero' : 'total_collapsed', true);
  if (total !== null && total > 0 && first.raw_n === 0) return gap('deep_pages_empty', false);
  const perPage = Math.max(first.raw_n, 1);
  const plannedN = total !== null ? Math.max(Math.ceil(total / perPage), 1) : 1;
  const capHit = plannedN > DYNADOT_MAX_PAGES;
  const planned = Array.from({ length: Math.min(plannedN, DYNADOT_MAX_PAGES) }, (_, i) => i + 1);
  // v5.80.0 (CR-099 b): failed pages wait and are retried inside the step while the time budget lasts (readPages)
  const r = await readPages(c, d, 'listings', DYNADOT_LISTINGS_PATH, planned.slice(1), parse, started + PULL_BUDGET_MS.aftermarket);
  const ok = [1, ...r.ok];
  const all: Listing[] = [...first.items, ...r.items];
  const rawSeen = first.raw_n + r.raw_n;
  const rows = all.filter((x) => x.price_cents >= AFTERMARKET_MIN_CENTS);
  const droppedUnderFloor = all.length - rows.length;
  if (rows.length === 0) return gap(r.empty.length > 0 ? 'deep_pages_empty' : 'no_rows_over_floor', false);
  const verdict = coverageVerdict(planned, ok, r.stopped_by, r.retried);
  const coverage = { partial: r.failed.length > 0 || capHit || r.empty.length > 0, calls_n: c.calls, pages_planned: planned, pages_ok: ok, pages_failed: r.failed, pages_empty: r.empty.length > 0 ? r.empty : undefined, rows_received_n: rows.length, server: true, total_listings: total, listings_read_n: rawSeen, invalid_n: invalid.n, ...verdict };
  const stored = await sealOrNoop(d, kind, dataDate, rows, coverage);
  if (stored === 'sealed_meanwhile') return summary(kind, dataDate, started, d, c, { status: 'SNAPSHOT_SEALED', sealed: true });
  return summary(kind, dataDate, started, d, c, {
    status: coverage.partial ? 'partial' : 'sealed', pages_n: ok.length, rows_n: stored.rows_stored_n, sealed: stored.sealed, sha256: stored.sha256, coverage, coverage_status: verdict.coverage_status, total_listings: total, baseline_total: baseline,
    dropped_under_500_n: droppedUnderFloor, invalid_n: invalid.n, duplicate_n: stored.duplicate_n, ...(r.firstError ? { error: `${r.firstError.code}: ${r.firstError.message}` } : {}),
  });
}
