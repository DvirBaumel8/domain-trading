// The exact-name web search (issue #76): does a company, product or app with this very name already exist?
// Live source: DuckDuckGo's HTML search, no key, cost zero. Unofficial HTML: it can change or rate-limit, so anything unreadable is an error, never "no hit".
// Only the title, the address and the snippet of each result are read. The search sends nothing but the name.
import { readText, SourceError, type Fetch } from '../sources/client.js';

export interface ExactHit { title: string; url: string }
export type ExactNameResult =
  | { status: 'hit'; hits: ExactHit[] }
  | { status: 'no_hit' }
  | { status: 'error'; reason: string };
export type ExactNameSearchFn = (domain: string) => Promise<ExactNameResult>;

const ENDPOINT = 'https://html.duckduckgo.com/html/';
/** About one request a second. */
const GAP_MS = 1100;
const MAX_FAILURES_IN_A_ROW = 5;

const decode = (s: string): string => s
  .replace(/<[^>]*>/g, '')
  .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const t = e.toLowerCase();
    if (t === 'amp') return '&';
    if (t === 'lt') return '<';
    if (t === 'gt') return '>';
    if (t === 'quot') return '"';
    if (t === 'apos') return "'";
    if (t === 'nbsp') return ' ';
    const n = t.startsWith('#x') ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  })
  .replace(/\s+/g, ' ').trim();

export interface Result { title: string; url: string; snippet: string }

/** The address behind a result link: DuckDuckGo wraps it as `//duckduckgo.com/l/?uddg=<encoded>`. */
function target(href: string): string | null {
  try {
    const u = new URL(href.replace(/&amp;/g, '&'), ENDPOINT);
    const real = u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/' ? u.searchParams.get('uddg') : u.href;
    if (!real) return null;
    const out = new URL(real);
    return out.protocol === 'http:' || out.protocol === 'https:' ? out.href : null;
  } catch { return null; }
}

/** Title, address and snippet of every result. Returns null when the page is not a results page (a block, a challenge, other HTML). */
export function parseResults(html: string): Result[] | null {
  const links = [...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi)];
  if (links.length === 0) return /class="[^"]*\bno-results\b|No results\.?</i.test(html) && /<html/i.test(html) && !/anomaly|captcha|unusual traffic/i.test(html) ? [] : null;
  const out: Result[] = [];
  for (let k = 0; k < links.length; k++) {
    const m = links[k]!;
    const href = /href="([^"]*)"/i.exec(m[0])?.[1];
    const url = href === undefined ? null : target(href);
    if (url === null) return null;
    const between = html.slice(m.index! + m[0].length, links[k + 1]?.index ?? html.length);
    const snip = /<(?:a|div)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(between)?.[1] ?? '';
    out.push({ title: decode(m[0]).slice(0, 200), url: url.slice(0, 200), snippet: decode(snip).slice(0, 300) });
  }
  return out;
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const EXPLAINERS = /(^|\.)(wikipedia|wiktionary|dictionary|merriam-webster|urbandictionary|reddit|youtube|facebook|twitter|x|instagram|linkedin|pinterest|tiktok|github|medium|quora|amazon|ebay|godaddy|afternic|hugedomains|archive)\.(org|com|net|co|com\.au|co\.uk)$/;

/** A result is the same name when its site is the name on another ending (name.net, name.io), or its title starts with the name. The name's own .com does not count. */
export function sameNameHits(sld: string, results: readonly Result[]): ExactHit[] {
  const hits: ExactHit[] = [];
  for (const r of results) {
    let host: string;
    try { host = new URL(r.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
    if (EXPLAINERS.test(host) || host === `${sld}.com`) continue;
    const labels = host.split('.');
    const ownLabel = labels.length > 1 ? labels[labels.length - 2]! : '';
    const siteIsName = letters(ownLabel) === sld;
    const head = letters(r.title.split(/\s[|\-–—:·•]\s|[|:·•]/)[0] ?? '');
    const titleIsName = head === sld;
    if (siteIsName || titleIsName) hits.push({ title: r.title, url: r.url });
  }
  return hits;
}

/** One search per query form: the name, and `"name"`. A hit on either is a hit; an error with no hit is an error. */
export function createExactNameSearch(now: () => number, sleep: (ms: number) => Promise<unknown>, fetchFn: Fetch = fetch): ExactNameSearchFn {
  let next = 0;
  let failures = 0;
  const once = async (q: string): Promise<Result[]> => {
    if (now() < next) await sleep(next - now());
    next = now() + GAP_MS;
    const text = await readText(fetchFn, { source: 'duckduckgo', url: `${ENDPOINT}?q=${encodeURIComponent(q)}`, headers: { accept: 'text/html', 'accept-language': 'en-US,en;q=0.8' }, timeoutMs: 20_000 });
    const parsed = parseResults(text);
    if (parsed === null) throw new SourceError('duckduckgo', 'BAD_RESPONSE', 200);
    return parsed;
  };
  return async (domain) => {
    const sld = domain.replace(/\.com$/, '');
    if (failures >= MAX_FAILURES_IN_A_ROW) return { status: 'error', reason: 'the search stopped answering' };
    const all: Result[] = [];
    let bad: string | null = null;
    for (const q of [sld, `"${sld}"`]) {
      try { all.push(...await once(q)); } catch (e) { bad = e instanceof SourceError ? e.code : 'BAD_RESPONSE'; }
    }
    const hits = sameNameHits(sld, all);
    if (hits.length > 0) { failures = 0; return { status: 'hit', hits: hits.slice(0, 3) }; }
    if (bad !== null) { failures++; return { status: 'error', reason: bad }; }
    failures = 0;
    return { status: 'no_hit' };
  };
}
