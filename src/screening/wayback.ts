// Internet Archive access and capture classification for the history check (CAP-07, HIST-2). Source: the documented Wayback CDX
// server and the archive's own `id_` raw-capture URLs (docs/internal/sources.md). Pure functions over an injected fetch: pacing,
// retries and evidence belong to the check. The classifier is deterministic and data-driven (versioned signature lists, no LLM).
import { USER_AGENT } from '../rdap.js';
import type { ScreeningDeps } from './types.js';

export const CDX_URL = 'https://web.archive.org/cdx/search/cdx';
export const ARCHIVE_WEB = 'https://web.archive.org/web';
const CDX_FIELDS = ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'] as const;
const MAX_CDX_BYTES = 8_000_000;
export const MAX_CAPTURE_BYTES = 512_000;
const PAGE_LIMIT = 2000;
const MAX_PAGES = 5;
const MAX_RETRY_AFTER_MS = 30_000;

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

/** Reads at most `max` bytes of a body (a capture can be megabytes); returns the bytes and whether they were cut. */
export async function readCappedBytes(res: Response, max: number): Promise<{ bytes: Buffer; cut: boolean }> {
  if (!res.body) return { bytes: Buffer.from(await res.arrayBuffer()).subarray(0, max), cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    if (n >= max) { cut = true; void reader.cancel().catch(() => {}); break; }
  }
  return { bytes: Buffer.concat(chunks).subarray(0, max), cut };
}

/** The charset a page declares (Content-Type header, else a `<meta charset>` / `content="...charset=">` in its first 1,024 bytes). */
export function charsetOf(contentType: string | null, head: Buffer): string | null {
  const h = /charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(contentType ?? '');
  if (h) return h[1]!;
  const m = /charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(head.subarray(0, 1024).toString('latin1'));
  return m ? m[1]! : null;
}

/** Bytes to text by the declared charset; an unknown or missing charset is UTF-8. */
export function decodeBody(bytes: Buffer, contentType: string | null): string {
  const label = charsetOf(contentType, bytes);
  if (label) { try { return new TextDecoder(label).decode(bytes); } catch { /* unknown label: UTF-8 */ } }
  return bytes.toString('utf8');
}

export async function readCapped(res: Response, max: number, contentType: string | null = null): Promise<{ text: string; cut: boolean }> {
  const { bytes, cut } = await readCappedBytes(res, max);
  return { text: decodeBody(bytes, contentType ?? res.headers.get('content-type')), cut };
}

export type CdxResult =
  | { ok: true; captures: Capture[]; url: string; body: string; pages: number }
  | { ok: false; reasonCode: FetchReason | 'INDEX_TRUNCATED'; url: string; retryAfterMs?: number | null };

/**
 * A CDX body: JSON array of rows (first row is the header). `[]` is the server's "no captures". With `showResumeKey` the rows end with
 * an empty row and a one-cell row holding the key of the next page. Anything else (an empty body, HTML, wrong columns) is null.
 */
export function parseCdxPage(body: string): { captures: Capture[]; resumeKey: string | null } | null {
  const t = body.trim();
  if (t === '') return null;
  let j: unknown;
  try { j = JSON.parse(t); } catch { return null; }
  if (!Array.isArray(j)) return null;
  if (j.length === 0) return { captures: [], resumeKey: null };
  const header = j[0];
  if (!Array.isArray(header) || !CDX_FIELDS.every((f) => header.includes(f))) return null;
  const idx = Object.fromEntries(CDX_FIELDS.map((f) => [f, header.indexOf(f)])) as Record<(typeof CDX_FIELDS)[number], number>;
  const out: Capture[] = [];
  let resumeKey: string | null = null;
  for (let r = 1; r < j.length; r++) {
    const row = j[r];
    if (!Array.isArray(row)) return null;
    if (row.length === 0) { // the end of the rows: an optional resume key follows
      const k = j[r + 1];
      if (Array.isArray(k) && k.length === 1 && typeof k[0] === 'string') resumeKey = k[0];
      break;
    }
    if (row.some((c) => typeof c !== 'string')) return null;
    out.push({ timestamp: row[idx.timestamp], original: row[idx.original], statuscode: row[idx.statuscode], mimetype: row[idx.mimetype], digest: row[idx.digest] });
  }
  return { captures: out, resumeKey };
}
export const parseCdx = (body: string): Capture[] | null => parseCdxPage(body)?.captures ?? null;

/**
 * The index query for a name. Asset floods (images, fonts, audio, video, style sheets, scripts) are filtered out so the 2,000-row page
 * is spent on pages, redirects and errors; `collapse=digest` drops adjacent duplicates; `showResumeKey` lets the caller page.
 */
export function cdxUrl(domain: string, o: { to?: string; resumeKey?: string } = {}): string {
  const q = new URLSearchParams({ url: domain, matchType: 'domain', output: 'json', fl: CDX_FIELDS.join(','), collapse: 'digest', limit: String(PAGE_LIMIT), showResumeKey: 'true' });
  q.append('filter', '!mimetype:(image|font|audio|video).*');
  q.append('filter', '!mimetype:text/css');
  q.append('filter', '!mimetype:.*javascript.*');
  if (o.to) q.set('to', o.to);
  if (o.resumeKey) q.set('resumeKey', o.resumeKey);
  return `${CDX_URL}?${q.toString()}`;
}

const retryAfterOf = (res: Response): number | null => {
  const v = res.headers.get('retry-after');
  const n = v !== null && /^\d{1,4}$/.test(v.trim()) ? Number(v) * 1000 : null;
  return n;
};

/**
 * The whole index of a name, paged by resume key (at most 5 pages of 2,000). Never throws: a timeout, a 429, any other HTTP status or a
 * body that is not CDX JSON (an empty body included) is a reason code. A page that is full with no resume key, or a resume key after the
 * last allowed page, is `INDEX_TRUNCATED`: part of the history was never seen, so it is never "no history" or "clean".
 */
export async function cdxCaptures(deps: Deps, domain: string, o: { to?: string; timeoutMs: number; pace?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<CdxResult> {
  const all: Capture[] = [];
  const bodies: string[] = [];
  let resumeKey: string | undefined;
  let url = cdxUrl(domain, { to: o.to });
  for (let page = 1; page <= MAX_PAGES; page++) {
    url = cdxUrl(domain, { to: o.to, resumeKey });
    const one = async (): Promise<{ ok: true; body: string } | { ok: false; reasonCode: FetchReason; retryAfterMs?: number | null }> => {
      let res: Response;
      try {
        res = await deps.fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(o.timeoutMs) });
      } catch (e) {
        return { ok: false, reasonCode: reasonOfError(e) };
      }
      if (res.status === 429) { const ra = retryAfterOf(res); void res.body?.cancel().catch(() => {}); return { ok: false, reasonCode: 'RATE_LIMITED', retryAfterMs: ra }; }
      if (res.status !== 200) { void res.body?.cancel().catch(() => {}); return { ok: false, reasonCode: 'SOURCE_ERROR' }; }
      try { return { ok: true, body: (await readCapped(res, MAX_CDX_BYTES)).text }; } catch (e) { return { ok: false, reasonCode: reasonOfError(e) }; }
    };
    const r = await (o.pace ? o.pace(one) : one());
    if (!r.ok) return { ok: false, reasonCode: r.reasonCode, url, retryAfterMs: r.retryAfterMs };
    const parsed = parseCdxPage(r.body);
    if (parsed === null) return { ok: false, reasonCode: 'SOURCE_ERROR', url };
    all.push(...parsed.captures);
    bodies.push(r.body);
    if (parsed.resumeKey === null) {
      if (parsed.captures.length >= PAGE_LIMIT) return { ok: false, reasonCode: 'INDEX_TRUNCATED', url };
      return { ok: true, captures: all, url: cdxUrl(domain, { to: o.to }), body: bodies.length === 1 ? bodies[0]! : `[${bodies.join(',')}]`, pages: page };
    }
    resumeKey = parsed.resumeKey;
  }
  return { ok: false, reasonCode: 'INDEX_TRUNCATED', url };
}

export const captureUrl = (c: Pick<Capture, 'timestamp' | 'original'>): string => `${ARCHIVE_WEB}/${c.timestamp}id_/${c.original}`;

export type CaptureFetch =
  | { ok: true; status: number; location: string | null; html: string | null; contentType: string | null; url: string; bytes: number; truncated: boolean }
  | { ok: false; reasonCode: string; url: string; retryAfterMs?: number | null };

/**
 * One raw capture (`id_` = the archived bytes, no archive toolbar). Redirects are not followed: a 3xx capture is read from its status
 * and Location. The archive mirrors the archived status, so a status of another class than the index said (a 5xx for a capture the
 * index lists as 200, a 429, a 404) is the archive failing, not the site: `CAPTURE_UNAVAILABLE` (or `TIMEOUT`); so is a 3xx with no
 * Location (where it went is unknown). The body is decoded by its declared charset.
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
  if (res.status === 429 || got !== want) { const ra = retryAfterOf(res); void res.body?.cancel().catch(() => {}); return { ok: false, reasonCode: 'CAPTURE_UNAVAILABLE', url, retryAfterMs: ra }; }
  if (got === 3) {
    void res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    if (!location) return { ok: false, reasonCode: 'CAPTURE_UNAVAILABLE', url };
    return { ok: true, status: res.status, location, html: null, contentType: res.headers.get('content-type'), url, bytes: 0, truncated: false };
  }
  try {
    const { text, cut } = await readCapped(res, MAX_CAPTURE_BYTES);
    return { ok: true, status: res.status, location: null, html: text, contentType: res.headers.get('content-type'), url, bytes: Buffer.byteLength(text), truncated: cut };
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
  // Every capture left after the digest dedupe is a content change. Over the cap: one change per calendar year in between first
  // (the years the content moved in), thinned evenly when the years exceed the slots; slots still free are then filled with the other
  // changes, evenly spread, rather than left unused.
  const inner = sorted.slice(1, -1);
  const slots = max - 2;
  const byYear = new Map<string, Capture>();
  for (const c of inner) if (!byYear.has(c.timestamp.slice(0, 4))) byYear.set(c.timestamp.slice(0, 4), c);
  const spread = <T,>(xs: T[], k: number): T[] => (k <= 0 ? [] : xs.length <= k ? xs : Array.from({ length: k }, (_, i) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(((i + 1) * (xs.length + 1)) / (k + 1)) - 1))]!));
  let mid = spread([...byYear.values()], slots);
  if (mid.length < slots) {
    const chosen = new Set(mid);
    mid = [...mid, ...spread(inner.filter((c) => !chosen.has(c)), slots - mid.length)];
  }
  const midSet = new Set(mid);
  return [first, ...inner.filter((c) => midSet.has(c)), last];
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

/** A matcher for `class:phrase` terms: each phrase as a whole word/phrase, case-insensitive, runs of spaces equal. Compiled once. */
export function makeMatcher(terms: string[]): (text: string) => string[] {
  const compiled = terms.map((t) => ({ t, phrase: t.slice(t.indexOf(':') + 1).trim().toLowerCase() })).filter((x) => x.phrase !== '')
    .map((x) => ({ t: x.t, re: new RegExp(`(?<![a-z0-9])${esc(x.phrase).replace(/\s+/g, '\\s+')}(?![a-z0-9])`) }));
  return (text) => { const hay = text.toLowerCase(); return compiled.filter((c) => c.re.test(hay)).map((c) => c.t); };
}

/** Terms (`class:phrase`) found in the text as whole words/phrases, case-insensitive; returned as written in the list. */
export function matchSignatures(text: string, terms: string[]): string[] {
  return makeMatcher(terms)(text);
}

export interface PathHit { timestamp: string; url: string; matched: string[] }

/**
 * A no-fetch scan of the archived URLs (subdomain labels and path words) against the strong and weak signature phrases and the
 * settings' URL terms. Only reads what the index already holds; a hit says "look at this name", never rejects (the caller FLAGs).
 */
export function scanPaths(captures: Capture[], domain: string, lists: Pick<SignatureLists, 'strong' | 'weak'>, urlTerms: string[]): PathHit[] {
  const match = makeMatcher([...lists.strong, ...lists.weak, ...urlTerms.map((t) => `url:${t}`)]);
  const hits: PathHit[] = [];
  for (const c of captures) {
    let u: URL;
    try { u = new URL(c.original); } catch { continue; }
    const host = u.hostname.toLowerCase();
    const sub = host === domain || host === `www.${domain}` ? '' : host.endsWith(`.${domain}`) ? host.slice(0, -(domain.length + 1)).replace(/^www\./, '') : '';
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep as is */ }
    const words = `${sub} ${path}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (words === '') continue;
    const m = match(words);
    if (m.length > 0) { hits.push({ timestamp: c.timestamp, url: c.original, matched: m }); if (hits.length >= 20) break; }
  }
  return hits;
}

/**
 * One decisive capture -> class. A 3xx to another site is `redirect_offsite` (or for-sale / parked when the target host is in those lists);
 * a 3xx to the same site is flagged `sameSiteRedirect` and the caller ignores it.
 *
 * Parked and for-sale come BEFORE harmful, but only for a THIN page (at most `parkedMaxChars` of visible text): a parking placeholder is
 * full of sponsored links, and its advertising is not the name's use. A `sig_parked` or `sig_forsale` match on a thin page is parked /
 * for-sale and any strong harmful words on it are `adMatches` (the caller FLAGs, never FAILs). A long page with a harmful match is
 * judged on its content even if it contains a parking phrase.
 * `extra` (meta description and keywords, image alt text) feeds only the weak list.
 */
export function classifyCapture(
  x: { status: number; location: string | null; text: string; domain: string; extra?: string }, lists: SignatureLists, minContentChars: number, parkedMaxChars = 1500,
): { cls: CaptureCls; matched: string[]; sameSiteRedirect?: boolean; adMatches?: string[] } {
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
  const forsale = matchSignatures(x.text, lists.forsale);
  const parked = matchSignatures(x.text, lists.parked);
  const thin = x.text.length <= parkedMaxChars;
  if (thin && (parked.length > 0 || forsale.length > 0)) {
    const ad = strong.length > 0 ? { adMatches: strong } : {};
    return forsale.length > 0 ? { cls: 'forsale', matched: forsale, ...ad } : { cls: 'parked', matched: parked, ...ad };
  }
  if (strong.length > 0) return { cls: 'harmful_strong', matched: strong };
  const weak = matchSignatures(`${x.text} ${x.extra ?? ''}`, lists.weak);
  if (weak.length > 0) return { cls: 'harmful_weak', matched: weak };
  if (forsale.length > 0) return { cls: 'forsale', matched: forsale };
  if (x.text.length < minContentChars) return { cls: 'error', matched: [] }; // a near-empty page is not a business
  return { cls: 'content', matched: [] };
}
