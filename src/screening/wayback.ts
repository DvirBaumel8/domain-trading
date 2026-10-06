// Internet Archive access and capture classification for the history check (CAP-07, HIST-2). Source: the documented Wayback CDX
// server and the archive's own `id_` raw-capture URLs (docs/internal/sources.md). Pure functions over an injected fetch: pacing,
// retries and evidence belong to the check. The classifier is deterministic and data-driven (versioned signature lists, no LLM).
import { USER_AGENT } from '../rdap.js';
import type { ScreeningDeps } from './types.js';

export const CDX_URL = 'https://web.archive.org/cdx/search/cdx';
export const ARCHIVE_WEB = 'https://web.archive.org/web';
const CDX_FIELDS = ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'] as const;
const MAX_CDX_BYTES = 8_000_000;
export const MAX_CAPTURE_BYTES = 2_000_000;

export interface Capture { timestamp: string; original: string; statuscode: string; mimetype: string; digest: string }
type Deps = Pick<ScreeningDeps, 'fetch'>;
export type FetchReason = 'TIMEOUT' | 'RATE_LIMITED' | 'SOURCE_ERROR';

/** 14-digit archive timestamp (UTC) -> ms epoch; null when it is not a real date. */
export function timestampMs(ts: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && back.getUTCHours() === h ? t : null;
}
/** ms epoch -> `YYYYMMDDhhmmss` (UTC). */
export const toTimestamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

const reasonOfError = (e: unknown): FetchReason => {
  const n = (e as { name?: string })?.name;
  return n === 'TimeoutError' || n === 'AbortError' ? 'TIMEOUT' : 'SOURCE_ERROR';
};

/** Reads at most `max` bytes of a body (a capture can be megabytes); returns the text and whether it was cut. */
export async function readCapped(res: Response, max: number): Promise<{ text: string; cut: boolean }> {
  if (!res.body) return { text: await res.text(), cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    if (n >= max) { cut = true; await reader.cancel().catch(() => {}); break; }
  }
  return { text: Buffer.concat(chunks).subarray(0, max).toString('utf8'), cut };
}

export type CdxResult =
  | { ok: true; captures: Capture[]; url: string; body: string }
  | { ok: false; reasonCode: FetchReason; url: string };

/** A CDX body: JSON array of rows (first row is the header); an empty 200 body is the server's way of saying "no captures". */
export function parseCdx(body: string): Capture[] | null {
  const t = body.trim();
  if (t === '') return [];
  let j: unknown;
  try { j = JSON.parse(t); } catch { return null; }
  if (!Array.isArray(j)) return null;
  if (j.length === 0) return [];
  const header = j[0];
  if (!Array.isArray(header) || !CDX_FIELDS.every((f) => header.includes(f))) return null;
  const idx = Object.fromEntries(CDX_FIELDS.map((f) => [f, header.indexOf(f)])) as Record<(typeof CDX_FIELDS)[number], number>;
  const out: Capture[] = [];
  for (const row of j.slice(1)) {
    if (!Array.isArray(row) || row.some((c) => typeof c !== 'string')) return null;
    out.push({ timestamp: row[idx.timestamp], original: row[idx.original], statuscode: row[idx.statuscode], mimetype: row[idx.mimetype], digest: row[idx.digest] });
  }
  return out;
}

export function cdxUrl(domain: string, to?: string): string {
  const q = new URLSearchParams({ url: domain, matchType: 'domain', output: 'json', fl: CDX_FIELDS.join(','), collapse: 'digest', limit: '2000' });
  if (to) q.set('to', to);
  return `${CDX_URL}?${q.toString()}`;
}

/** One CDX request. Never throws: a timeout, a 429, any other HTTP status or a body that is not CDX JSON is a reason code. */
export async function cdxCaptures(deps: Deps, domain: string, o: { to?: string; timeoutMs: number }): Promise<CdxResult> {
  const url = cdxUrl(domain, o.to);
  let res: Response;
  try {
    res = await deps.fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (e) {
    return { ok: false, reasonCode: reasonOfError(e), url };
  }
  if (res.status === 429) { void res.body?.cancel().catch(() => {}); return { ok: false, reasonCode: 'RATE_LIMITED', url }; }
  if (res.status !== 200) { void res.body?.cancel().catch(() => {}); return { ok: false, reasonCode: 'SOURCE_ERROR', url }; }
  let body: string;
  try { body = (await readCapped(res, MAX_CDX_BYTES)).text; } catch (e) { return { ok: false, reasonCode: reasonOfError(e), url }; }
  const captures = parseCdx(body);
  if (captures === null) return { ok: false, reasonCode: 'SOURCE_ERROR', url };
  return { ok: true, captures, url, body };
}

export const captureUrl = (c: Pick<Capture, 'timestamp' | 'original'>): string => `${ARCHIVE_WEB}/${c.timestamp}id_/${c.original}`;

export type CaptureFetch =
  | { ok: true; status: number; location: string | null; html: string | null; contentType: string | null; url: string; bytes: number }
  | { ok: false; reasonCode: string; url: string };

/**
 * One raw capture (`id_` = the archived bytes, no archive toolbar). Redirects are not followed: a 3xx capture is read from its status
 * and Location. The archive mirrors the archived status, so a status of another class than the index said (a 5xx for a capture the
 * index lists as 200, a 429, a 404) is the archive failing, not the site: `CAPTURE_UNAVAILABLE` (or `TIMEOUT`).
 */
export async function fetchCapture(deps: Deps, c: Capture, o: { timeoutMs: number }): Promise<CaptureFetch> {
  const url = captureUrl(c);
  let res: Response;
  try {
    res = await deps.fetch(url, { redirect: 'manual', headers: { accept: 'text/html,*/*;q=0.5', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (e) {
    return { ok: false, reasonCode: reasonOfError(e) === 'TIMEOUT' ? 'TIMEOUT' : 'CAPTURE_UNAVAILABLE', url };
  }
  const want = Number(c.statuscode[0]);
  const got = Math.floor(res.status / 100);
  if (res.status === 429 || got !== want) { void res.body?.cancel().catch(() => {}); return { ok: false, reasonCode: 'CAPTURE_UNAVAILABLE', url }; }
  if (got === 3) { void res.body?.cancel().catch(() => {}); return { ok: true, status: res.status, location: res.headers.get('location'), html: null, contentType: res.headers.get('content-type'), url, bytes: 0 }; }
  try {
    const { text } = await readCapped(res, MAX_CAPTURE_BYTES);
    return { ok: true, status: res.status, location: null, html: text, contentType: res.headers.get('content-type'), url, bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { ok: false, reasonCode: reasonOfError(e) === 'TIMEOUT' ? 'TIMEOUT' : 'CAPTURE_UNAVAILABLE', url };
  }
}

// ---- decisive captures ----

const hostOf = (original: string): string | null => {
  try { return new URL(original).hostname.toLowerCase(); } catch { return null; }
};
const isRoot = (original: string): boolean => {
  try { const p = new URL(original).pathname; return p === '/' || p === '' || /^\/index\.(html?|php|asp)$/i.test(p); } catch { return false; }
};

/** A capture the classifier needs: a redirect, or an HTML page. Other types (images, PDFs, robots.txt) say nothing about use. */
export const isDecisive = (c: Capture): boolean => /^3\d\d$/.test(c.statuscode) || (/^2\d\d$/.test(c.statuscode) && /^text\/html\b/i.test(c.mimetype));

/**
 * At most `max` decisive captures of the name's own host (`domain` or `www.domain`; the home page when the archive has one, else any page):
 * deduped by digest, earliest, latest, then one per calendar year in between (the first of that year; evenly thinned when the years exceed the cap).
 */
export function pickDecisive(captures: Capture[], domain: string, max: number): Capture[] {
  if (max <= 0) return [];
  const own = captures.filter((c) => isDecisive(c) && [domain, `www.${domain}`].includes(hostOf(c.original) ?? ''));
  const pool = own.some((c) => isRoot(c.original)) ? own.filter((c) => isRoot(c.original)) : own;
  const seen = new Set<string>();
  const sorted = [...pool].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).filter((c) => (seen.has(c.digest) ? false : (seen.add(c.digest), true)));
  if (sorted.length <= max) return sorted;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (max === 1) return [last];
  const byYear = new Map<string, Capture>();
  for (const c of sorted.slice(1, -1)) if (!byYear.has(c.timestamp.slice(0, 4))) byYear.set(c.timestamp.slice(0, 4), c);
  let mid = [...byYear.values()];
  const slots = max - 2;
  if (mid.length > slots) {
    const n = mid.length;
    mid = slots <= 0 ? [] : Array.from({ length: slots }, (_, i) => mid[Math.min(n - 1, Math.max(0, Math.round(((i + 1) * (n + 1)) / (slots + 1)) - 1))]!);
  }
  return [first, ...new Set(mid), last];
}

// ---- classification ----

export type PreCls = 'harmful' | 'redirect_offsite' | 'content' | 'parked' | 'redirect_error_only' | 'none' | 'unknown';
export interface SignatureLists { strong: string[]; weak: string[]; parked: string[]; forsale: string[] }
export type CaptureCls = 'harmful_strong' | 'harmful_weak' | 'redirect_offsite' | 'parked' | 'forsale' | 'content' | 'error';

/** The URL a 3xx capture points at. The archive may rewrite Location to its own `/web/<ts>id_/<url>` form: the embedded URL is the target. */
export function redirectTarget(location: string, base: string): string | null {
  let abs: URL;
  try { abs = new URL(location, base); } catch { return null; }
  const m = /^\/web\/\d{1,14}[a-z_]*\/(.+)$/i.exec(abs.pathname + abs.search);
  if (abs.hostname.endsWith('archive.org') && m) {
    try { return new URL(/^[a-z]+:\/\//i.test(m[1]!) ? m[1]! : `http://${m[1]}`).toString(); } catch { return null; }
  }
  return abs.toString();
}

const isOwnHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Terms (`class:phrase`) found in the text as whole words/phrases, case-insensitive; returned as written in the list. */
export function matchSignatures(text: string, terms: string[]): string[] {
  const hay = text.toLowerCase();
  const hits: string[] = [];
  for (const t of terms) {
    const phrase = t.slice(t.indexOf(':') + 1).trim().toLowerCase();
    if (phrase === '') continue;
    if (new RegExp(`(?<![a-z0-9])${esc(phrase).replace(/\s+/g, '\\s+')}(?![a-z0-9])`).test(hay)) hits.push(t);
  }
  return hits;
}

/**
 * One decisive capture -> class. A 3xx to another site is `redirect_offsite` (or for-sale / parked when the target host is in those lists);
 * a 3xx to the same site is flagged `sameSiteRedirect` and the caller ignores it.
 */
export function classifyCapture(
  x: { status: number; location: string | null; text: string; domain: string }, lists: SignatureLists, minContentChars: number,
): { cls: CaptureCls; matched: string[]; sameSiteRedirect?: boolean } {
  if (x.status >= 300 && x.status < 400) {
    const target = x.location === null ? null : redirectTarget(x.location, `http://${x.domain}/`);
    const host = target === null ? null : new URL(target).hostname.toLowerCase();
    if (host === null) return { cls: 'error', matched: [] }; // no usable Location: cannot say where it went
    if (isOwnHost(host, x.domain)) return { cls: 'content', matched: [], sameSiteRedirect: true };
    // A redirect to a for-sale marketplace or a parking service is for-sale / parked history (positive), not a business moving away.
    const sale = matchSignatures(host, lists.forsale);
    if (sale.length > 0) return { cls: 'forsale', matched: sale };
    const park = matchSignatures(host, lists.parked);
    if (park.length > 0) return { cls: 'parked', matched: park };
    return { cls: 'redirect_offsite', matched: [] };
  }
  if (x.status >= 400) return { cls: 'error', matched: [] };
  const strong = matchSignatures(x.text, lists.strong);
  if (strong.length > 0) return { cls: 'harmful_strong', matched: strong };
  const weak = matchSignatures(x.text, lists.weak);
  if (weak.length > 0) return { cls: 'harmful_weak', matched: weak };
  const forsale = matchSignatures(x.text, lists.forsale);
  if (forsale.length > 0) return { cls: 'forsale', matched: forsale };
  const parked = matchSignatures(x.text, lists.parked);
  if (parked.length > 0) return { cls: 'parked', matched: parked };
  if (x.text.length < minContentChars) return { cls: 'error', matched: [] }; // a near-empty page is not a business
  return { cls: 'content', matched: [] };
}
