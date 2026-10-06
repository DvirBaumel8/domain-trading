// Business websites (CAP-12 operator sites; CAP-15 firm pages reuse fetchPage, phraseUse and robotsAllows). Terms and policy:
// docs/internal/sources.md "Business websites". One robots.txt per origin and run, honest User-Agent, every request paced, redirects
// followed by hand, no login / form / CAPTCHA / script execution. Fail closed: a page that answers but cannot be read is `unknown`,
// never "no site". Every scan of hostile text is a forward pass (no backtracking regex over page text).
import { BlockedError, safeFetch } from '../net/safe-fetch.js';
import { USER_AGENT } from '../rdap.js';
import { asciiFold, hiddenSignals, metaRefreshTarget, ogSiteName, titleOf, visibleText } from './html-text.js';
import type { Pacer } from './rdap-batch.js';
import type { SameNameSettings } from './settings.js';
import type { ScreeningDeps } from './types.js';
import { makeMatcher, readCapped } from './wayback.js';

export type FailReason = 'ADDRESS_BLOCKED' | 'HOST_EXCLUDED' | 'URL_NOT_ALLOWED' | 'UNEXPECTED_CONTENT_TYPE' | 'CLIENT_RENDERED' | 'DNS_NXDOMAIN' | 'CONNECTION_REFUSED' | 'HTTP_4XX' | 'TIMEOUT' | 'HTTP_5XX' | 'TLS_ERROR' | 'ROBOTS_DISALLOWED' | 'TOO_MANY_REDIRECTS' | 'TRUNCATED' | 'SOURCE_ERROR';
export type PageFetch =
  | { ok: true; finalUrl: string; status: number; html: string; truncated: boolean }
  | { ok: false; kind: 'no_site' | 'unknown'; reasonCode: FailReason; finalUrl: string | null };
export type SiteState = 'unregistered' | 'registered_no_site' | 'parked_or_for_sale' | 'redirect_off_domain' | 'in_use' | 'unknown';
export type BusinessUse = 'business_name' | 'service_description' | 'product_name' | 'none';
export interface SiteClass { site_state: SiteState; business_use: BusinessUse | null; business_name: string | null; final_url: string | null; reason_code: string | null }
export interface RobotsRule { text: string }
export interface FetchPageOpts {
  timeoutMs: number; maxBytes: number; maxRedirects: number; pace: Pacer; robots: Map<string, RobotsRule>;
  /** Hosts (and their subdomains) that are never fetched (`lead.verify.never_fetch_hosts`, includes linkedin.com). */
  neverFetchHosts: string[];
  /** ms epoch: past it no further request is sent (unknown TIMEOUT); checked between hops. */
  deadline?: number;
  now?: () => number;
  /** Called once per request attempted (robots.txt, page, each hop), for `upstream_calls`. */
  onRequest?: () => void;
}
/** `fetch` is a test injection; production passes none and safeFetch uses undici's own fetch. */
type FetchDeps = { fetch?: typeof fetch; lookupHost?: ScreeningDeps['lookupHost'] };

/** The product token our robots.txt group is named by (the `User-Agent` header carries it as `domain-trading-api/<version>`). */
export const ROBOTS_TOKEN = 'domain-trading-api';
const MAX_TEXT = 200_000;
const MAX_ROBOTS_BYTES = 500_000;
const MAX_ROBOTS_RULES = 2000;
const MAX_MATCH_PATH = 512;

// ---------- robots.txt ----------

/** Glob match of a robots path pattern (`*` any run, trailing `$` anchors) at the start of `s`. Iterative, no recursion or backtracking regex. */
function globMatch(pattern: string, s: string): boolean {
  let pat = pattern.slice(0, 500);
  const path = s.slice(0, MAX_MATCH_PATH);
  const anchored = pat.endsWith('$');
  if (anchored) pat = pat.slice(0, -1);
  if (!anchored) pat += '*';
  let p = 0, i = 0, star = -1, mark = 0;
  while (i < path.length) {
    if (p < pat.length && pat[p] === '*') { star = p++; mark = i; }
    else if (p < pat.length && pat[p] === path[i]) { p++; i++; }
    else if (star >= 0) { p = star + 1; i = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

interface Group { agents: string[]; rules: { allow: boolean; pattern: string }[] }

/** Whether robots.txt lets `userAgentToken` fetch `path` (path plus query). The group naming our token wins over `*`; the longest matching rule wins, Allow on a tie; no file or no match allows. */
export function robotsAllows(robotsTxt: string, userAgentToken: string, path: string): boolean {
  path = path.slice(0, MAX_MATCH_PATH);
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  const lines = robotsTxt.slice(0, MAX_ROBOTS_BYTES).split('\n', 20_000);
  for (const raw of lines) {
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = asciiFold(line.slice(0, colon).trim());
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(asciiFold(value));
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (cur && cur.rules.length < MAX_ROBOTS_RULES) cur.rules.push({ allow: field === 'allow', pattern: value });
    } else lastWasAgent = false;
  }
  const token = asciiFold(userAgentToken);
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && a === token)); // RFC 9309: the product token, case-insensitive, never a substring
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  let best: { len: number; allow: boolean } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (r.pattern === '' || !globMatch(r.pattern, path)) continue;
      const len = r.pattern.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

// ---------- fetching ----------

const failure = (kind: 'no_site' | 'unknown', reasonCode: FailReason, finalUrl: string | null = null): Extract<PageFetch, { ok: false }> => ({ ok: false, kind, reasonCode, finalUrl });

function causeChain(e: unknown): { codes: string[] } {
  const codes: string[] = [];
  let x: unknown = e;
  for (let d = 0; d < 5 && x && typeof x === 'object'; d++) {
    const o = x as { code?: unknown; cause?: unknown };
    if (typeof o.code === 'string') codes.push(o.code.toLowerCase());
    x = o.cause;
  }
  return { codes };
}

/** Maps a thrown fetch error to a determinate "no site" (the name does not resolve, or nothing listens) or an unknown. Branches on error codes, not messages, except for TLS. */
function failOf(e: unknown): Extract<PageFetch, { ok: false }> {
  if (e instanceof BlockedError) return failure('unknown', e.code);
  const name = (e as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return failure('unknown', 'TIMEOUT');
  const { codes } = causeChain(e);
  if (codes.includes('enotfound')) return failure('no_site', 'DNS_NXDOMAIN'); // a temporary resolver failure (eai_again) stays unknown
  if (codes.includes('econnrefused')) return failure('no_site', 'CONNECTION_REFUSED');
  const tls = codes.some((c) => c.startsWith('cert_') || c.startsWith('err_tls') || c.startsWith('err_ssl') || c.startsWith('unable_to_') || c.startsWith('depth_zero') || c.startsWith('self_signed') || c.startsWith('hostname_mismatch'));
  return failure('unknown', tls ? 'TLS_ERROR' : 'SOURCE_ERROR');
}

const late = (o: FetchPageOpts) => o.deadline !== undefined && (o.now ?? Date.now)() > o.deadline;
const timeoutError = () => new DOMException('The run deadline passed', 'TimeoutError');

async function once(deps: FetchDeps, url: string, o: FetchPageOpts, accept: string): Promise<{ res: Response } | { err: Extract<PageFetch, { ok: false }> }> {
  try {
    const res = await o.pace.run(async () => {
      if (late(o)) throw timeoutError(); // checked again after the wait in the pacer queue
      o.onRequest?.();
      return safeFetch(deps, url, { redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept }, signal: AbortSignal.timeout(o.timeoutMs) }, { neverFetchHosts: o.neverFetchHosts, lookupTimeoutMs: o.deadline === undefined ? o.timeoutMs : Math.min(o.timeoutMs, (o.deadline - (o.now ?? Date.now)())) });
    });
    return { res };
  } catch (e) {
    return { err: failOf(e) };
  }
}

const drop = (res: Response) => { void res.body?.cancel().catch(() => {}); };
const isRedirect = (s: number) => s >= 300 && s < 400;
const hostKey = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, '');

/** The robots.txt of an origin, once per run (kept in `o.robots`). 404, 410 and other 4xx allow everything; an unreadable file is a failure (no page is fetched). A robots redirect must stay on the same host, else the file is unreadable (fail closed). */
async function robotsFor(deps: FetchDeps, origin: string, o: FetchPageOpts): Promise<{ ok: true; text: string } | Extract<PageFetch, { ok: false }>> {
  const hit = o.robots.get(origin);
  if (hit) return { ok: true, text: hit.text };
  let url = `${origin}/robots.txt`;
  for (let hop = 0; ; hop++) {
    const r = await once(deps, url, o, 'text/plain,*/*;q=0.5');
    if ('err' in r) return r.err.reasonCode === 'TIMEOUT' && !late(o) ? failure('unknown', 'SOURCE_ERROR') : r.err;
    const { res } = r;
    if (isRedirect(res.status)) {
      drop(res);
      const loc = res.headers.get('location');
      let next: URL | null = null;
      try { next = loc ? new URL(loc, url) : null; } catch { next = null; }
      if (!next || !/^https?:$/.test(next.protocol) || hop >= o.maxRedirects || hostKey(next.toString()) !== hostKey(url)) return failure('unknown', 'SOURCE_ERROR');
      url = next.toString();
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      try {
        const body = await readCapped(res, Math.min(o.maxBytes, MAX_ROBOTS_BYTES));
        o.robots.set(origin, { text: body.text });
        return { ok: true, text: body.text };
      } catch (e) {
        const f = failOf(e);
        return f.reasonCode === 'TIMEOUT' ? failure('unknown', 'SOURCE_ERROR') : f;
      }
    }
    drop(res);
    if (res.status >= 400 && res.status < 500 && res.status !== 429) { o.robots.set(origin, { text: '' }); return { ok: true, text: '' }; }
    return failure('unknown', 'SOURCE_ERROR');
  }
}

async function chain(deps: FetchDeps, startUrl: string, o: FetchPageOpts): Promise<PageFetch> {
  let url = startUrl;
  let expect: string;
  try { expect = hostKey(startUrl); } catch { return failure('unknown', 'URL_NOT_ALLOWED', startUrl); }
  for (let hop = 0; ; hop++) {
    if (late(o)) return failure('unknown', 'TIMEOUT', url);
    const u = new URL(url);
    const rb = await robotsFor(deps, u.origin, o);
    if (!rb.ok) return rb;
    if (!robotsAllows(rb.text, ROBOTS_TOKEN, u.pathname + u.search)) return failure('unknown', 'ROBOTS_DISALLOWED', url);
    if (late(o)) return failure('unknown', 'TIMEOUT', url);
    const r = await once(deps, url, o, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
    if ('err' in r) return r.err;
    const { res } = r;
    const s = res.status;
    if (isRedirect(s)) {
      drop(res);
      const loc = res.headers.get('location');
      let next: URL | null = null;
      try { next = loc ? new URL(loc, url) : null; } catch { next = null; }
      if (!next || !/^https?:$/.test(next.protocol)) return failure('unknown', 'SOURCE_ERROR', url);
      if (hop >= o.maxRedirects) return failure('unknown', 'TOO_MANY_REDIRECTS', url);
      // A redirect to another site is recorded and not followed: the page of a third party is not ours to read.
      if (hostKey(next.toString()) !== expect) return { ok: true, finalUrl: next.toString(), status: s, html: '', truncated: false };
      url = next.toString();
      continue;
    }
    if (s >= 200 && s < 300) {
      const ct = res.headers.get('content-type');
      const lc = ct?.toLowerCase() ?? null;
      if (lc !== null && !lc.includes('text/') && !lc.includes('xml')) { drop(res); return failure('unknown', 'UNEXPECTED_CONTENT_TYPE', url); }
      try {
        const body = await readCapped(res, o.maxBytes, ct);
        if (body.cut) return failure('unknown', 'TRUNCATED', url);
        return { ok: true, finalUrl: url, status: s, html: body.text, truncated: false };
      } catch (e) {
        return { ...failOf(e), finalUrl: url };
      }
    }
    drop(res);
    if (s === 401 || s === 403) return failure('unknown', 'HTTP_4XX', url); // a login wall or bot block: we do not go around it
    if (s >= 400 && s < 500 && s !== 429) return failure('no_site', 'HTTP_4XX', url);
    return failure('unknown', 'HTTP_5XX', url);
  }
}

/**
 * GET one page politely and safely: every request (robots.txt, each hop, the http fallback) goes through the SSRF guard
 * (`src/net/safe-fetch.ts`), is paced and checks the run deadline. robots.txt first, redirects by hand (at most `maxRedirects`; a
 * redirect to another site is returned without being followed), body capped (a cut body is `unknown TRUNCATED`). https first; http once,
 * only after a refused connection or TLS error. A TLS error is never turned into "no site" by a refused http port.
 */
export async function fetchPage(deps: FetchDeps, url: string, o: FetchPageOpts): Promise<PageFetch> {
  const r = await chain(deps, url, o);
  if (!r.ok && (r.reasonCode === 'CONNECTION_REFUSED' || r.reasonCode === 'TLS_ERROR') && url.startsWith('https://')) {
    const h = await chain(deps, `http://${url.slice(8)}`, o);
    return r.reasonCode === 'TLS_ERROR' && !h.ok && h.kind === 'no_site' ? failure('unknown', 'TLS_ERROR') : h;
  }
  return r;
}

// ---------- classification ----------

const isAlnum = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
const isUpper = (c: string | undefined) => c !== undefined && c >= 'A' && c <= 'Z';

/**
 * How a page uses the phrase (whole words, case-insensitive; the tokens joined by one space or by nothing). An occurrence is
 * product-style when every word is capitalised in the text or a product marker (TM, R) follows within 3 characters. Any other
 * occurrence makes it a `service_description`; only product-style occurrences make it a `product_name`. Linear, first 200,000 characters.
 */
export function phraseUse(text: string, phraseTokens: string[], productMarkers: string[]): 'service_description' | 'product_name' | 'none' {
  const tokens = phraseTokens.map((t) => asciiFold(t)).filter((t) => t !== '');
  if (tokens.length === 0) return 'none';
  const src = text.slice(0, MAX_TEXT).replace(/\s+/g, ' ');
  const fold = asciiFold(src);
  const markers = productMarkers.map((m) => asciiFold(m)).filter((m) => m !== '');
  const maxMarker = markers.reduce((n, m) => Math.max(n, m.length), 0);
  let plain = 0, product = 0;
  for (const phrase of new Set([tokens.join(' '), tokens.join('')])) {
    const spaced = phrase.includes(' ');
    let from = 0;
    for (;;) {
      const i = fold.indexOf(phrase, from);
      if (i < 0) break;
      from = i + phrase.length;
      if (isAlnum(fold[i - 1]) || isAlnum(fold[i + phrase.length])) continue; // whole words only
      const end = i + phrase.length;
      let style = false;
      if (spaced ? src.slice(i, end).split(' ').every((w) => isUpper(w[0])) : isUpper(src[i])) style = true;
      if (!style) {
        const window = fold.slice(end, end + 3 + maxMarker);
        style = markers.some((m) => { const k = window.indexOf(m); return k >= 0 && k <= 3; });
      }
      if (style) product++; else plain++;
    }
  }
  return plain > 0 ? 'service_description' : product > 0 ? 'product_name' : 'none';
}

const unknownClass = (reason: string | null, finalUrl: string | null): SiteClass => ({ site_state: 'unknown', business_use: null, business_name: null, final_url: finalUrl, reason_code: reason });

const LEGAL_SUFFIXES = new Set(['llc', 'inc', 'ltd', 'co', 'corp', 'gmbh', 'sa', 'bv', 'pty', 'plc', 'llp', 'srl', 'ab', 'oy', 'as']);
const SEGMENT_SPLIT = /\s+[|\u2013\u2014\-\u00bb\u2022\u00b7]\s+|\s*::\s*|\s*\|\s*/;
const alnum = (x: string) => asciiFold(x).replace(/[^a-z0-9]+/g, '');
/** A page name without its legal-form suffix and without a leading "Welcome to", reduced to letters and digits. */
function nameKey(raw: string): string {
  const words = raw.slice(0, 300).replace(/^\s*welcome\s+to\s+/i, '').replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(asciiFold(words[words.length - 1]!))) words.pop();
  return alnum(words.join(' '));
}
/** The page's own name when one of its og:site_name or title segments (legal suffix ignored) is our exact name; else null. */
function ownNameOnPage(html: string, ourCom: string): string | null {
  const ours = new Set([alnum(ourCom.replace(/\.com$/, '')), alnum(ourCom)]);
  const candidates: string[] = [];
  const og = ogSiteName(html);
  if (og) candidates.push(og);
  const title = titleOf(html);
  if (title) candidates.push(...title.slice(0, 300).split(SEGMENT_SPLIT));
  for (const c of candidates) {
    const k = nameKey(c);
    if (k !== '' && ours.has(k)) return c.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** The site's state and, for a site in use, how it uses our name. `expectHost` is the other-extension host; `ourCom` our own domain (`<sld>.com`). */
export function classifySite(
  page: PageFetch, expectHost: string, ourCom: string, phraseTokens: string[], lists: { parked: string[]; forsale: string[] }, s: SameNameSettings,
): SiteClass {
  if (!page.ok) {
    return page.kind === 'no_site'
      ? { site_state: 'registered_no_site', business_use: null, business_name: null, final_url: page.finalUrl, reason_code: page.reasonCode }
      : unknownClass(page.reasonCode, page.finalUrl);
  }
  const finalUrl = page.finalUrl;
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  const off = (u: string) => { try { return strip(new URL(u).hostname) !== strip(expectHost); } catch { return true; } };
  const result = (site_state: SiteState, business_use: BusinessUse | null = null, business_name: string | null = null, reason_code: string | null = null): SiteClass => ({ site_state, business_use, business_name, final_url: finalUrl, reason_code });
  if (off(finalUrl)) return result('redirect_off_domain');
  const target = metaRefreshTarget(page.html);
  if (target !== null) {
    let abs: string | null = null;
    try { abs = new URL(target, finalUrl).toString(); } catch { abs = null; }
    if (abs !== null && /^https?:/.test(abs) && off(abs)) return { ...result('redirect_off_domain'), final_url: abs };
  }
  const vt = visibleText(page.html);
  const text = vt.text.slice(0, MAX_TEXT);
  // Parked and for-sale signatures count only on a thin page (a real site may mention a marketplace).
  if (text.length <= s.parked_max_text_chars && makeMatcher([...lists.parked, ...lists.forsale])(`${vt.title ?? ''} ${text} ${hiddenSignals(page.html)}`).length > 0) return result('parked_or_for_sale');
  const own = ownNameOnPage(page.html, ourCom);
  if (own !== null) return result('in_use', 'business_name', own);
  if (text.length < s.min_visible_chars) {
    // A page with scripts and almost no text may be drawn by the browser: its content is unknown, not absent.
    return asciiFold(page.html).includes('<script') ? unknownClass('CLIENT_RENDERED', finalUrl) : result('registered_no_site');
  }
  return result('in_use', phraseUse(text, phraseTokens, s.product_markers));
}
