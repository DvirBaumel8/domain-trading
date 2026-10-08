// Prior-business guard of the history check (CR-002 Amendment A1): the name a captured business page gives itself, taken
// deterministically from the page's own words: og:site_name, else the <title>, else a "<Name> LLC / Inc / Co" or copyright line.
// The name feeds CAP-02 (brand and big-company lists) and CAP-08 (the manual trademark request). No guessing: a name that is not
// clear (only a text line, or captures that disagree) is null and the check FLAGs for a human. Every scan is linear (token scans,
// no backtracking regex over page text) and reads at most a capped slice of the text.
import { ogSiteName } from './html-text.js';

export interface BusinessCandidate { name: string; source: 'og_site_name' | 'title' | 'text_line'; timestamp: string; nameIsDomain?: boolean }

/** Error, placeholder and navigation phrases that are a page's role, never a business name. */
const GENERIC = new Set([
  'home', 'homepage', 'home page', 'welcome', 'index', 'index page', 'main', 'main page', 'default', 'default page', 'untitled', 'untitled document',
  'under construction', 'coming soon', 'page not found', 'not found', 'loading', 'redirecting', 'just another wordpress site', 'website', 'web site', 'new page',
  'index of', 'index of /', '403', '404', '500', '403 forbidden', '404 not found', '500 internal server error', 'forbidden', 'access denied', 'error', 'error 404',
  'service unavailable', 'bad gateway', 'account suspended', 'suspended', 'this account has been suspended', 'site not found', 'domain not found',
  'hello world', 'hello world!', 'sample page', 'my blog', 'my website', 'blog', 'default web site page', 'apache2 ubuntu default page', 'test page', 'welcome to nginx',
  'contact', 'contact us', 'about', 'about us', 'privacy policy', 'privacy', 'terms of service', 'terms and conditions', 'terms', 'login', 'log in', 'sign in',
  'menu', 'skip to content', 'search', 'sitemap', 'faq', 'services', 'products', 'news', 'welcome to our website', 'welcome to my website', 'domain for sale',
  'domain parked', 'parked domain', 'this domain is for sale', 'maintenance', 'site maintenance',
]);
const GENERIC_PREFIX = /^(?:index of|error \d{3}|\d{3} )/i;
const SEPARATORS = /\s+[|–—\-»•·]\s+|\s*::\s*|\s*\|\s*/;
const SUFFIXES = new Set(['llc', 'l.l.c.', 'inc', 'inc.', 'incorporated', 'co', 'co.', 'company', 'ltd', 'ltd.', 'limited', 'corp', 'corp.', 'corporation', 'group', 'services', 'associates', 'partners', 'studio', 'agency', 'consulting']);
const CAP_TOKEN = /^[A-Z][A-Za-z0-9&'’.-]{0,39}$/;
const MAX_TOKEN = 60;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A usable business name, or null: 2-60 characters with a letter, at most 6 words, not generic. `nameIsDomain`: it is the domain's own name. */
function clean(raw: string, domain: string): { name: string; nameIsDomain: boolean } | null {
  const n = raw.replace(/^\s*welcome\s+to\s+/i, '').replace(/\s+/g, ' ').trim().replace(/^[\s"'“‘]+|[\s"'”’.,;:]+$/g, '');
  if (n.length < 2 || n.length > 60 || !/[a-z]/i.test(n) || n.split(' ').length > 6) return null;
  const low = n.toLowerCase();
  if (GENERIC.has(low) || GENERIC_PREFIX.test(n)) return null;
  const k = norm(n);
  if (k === '') return null;
  const sld = domain.replace(/\.com$/, '');
  return { name: n, nameIsDomain: k === norm(domain) || k === norm(sld) };
}

/** The slice of the text a name is read from: its first and last 2,000 characters, without any token longer than 60 characters. */
export function nameText(text: string): string {
  const cut = text.length <= 4000 ? text : `${text.slice(0, 2000)} ${text.slice(-2000)}`;
  return cut.split(' ').filter((t) => t.length <= MAX_TOKEN).join(' ');
}

/** `<Name> LLC`-style: up to 3 capitalised tokens directly before a company-suffix token. */
function suffixedName(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    if (!SUFFIXES.has(tokens[i]!.toLowerCase().replace(/[,;:]+$/, ''))) continue;
    let s = i;
    while (s > 0 && i - s < 3 && CAP_TOKEN.test(tokens[s - 1]!)) s--;
    if (s < i) return tokens.slice(s, i + 1).join(' ').replace(/[,;:]+$/, '');
  }
  return null;
}

/** The words after a copyright sign: up to 5 capitalised tokens, years skipped, stopping at "All rights" or at punctuation. */
function copyrightName(raw: string[]): string | null {
  const tokens = raw.flatMap((t) => (t.length > 1 && t.startsWith('\u00a9') ? ['\u00a9', t.slice(1)] : [t]));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase();
    if (!(t === '\u00a9' || t === '(c)' || t === 'copyright')) continue;
    let j = i + 1;
    while (j < tokens.length && (['\u00a9', '(c)'].includes(tokens[j]!.toLowerCase()) || /^\d{4}([-\u2013]\d{2,4})?,?$/.test(tokens[j]!))) j++;
    const words: string[] = [];
    while (j < tokens.length && words.length < 5) {
      const w = tokens[j]!;
      if (w.toLowerCase() === 'all' && (tokens[j + 1] ?? '').toLowerCase().startsWith('rights')) break;
      const bare = w.replace(/[|,.;:]+$/, '');
      if (!CAP_TOKEN.test(bare)) break;
      words.push(bare);
      if (bare !== w) break; // punctuation ended the name
      j++;
    }
    if (words.length > 0) return words.join(' ');
  }
  return null;
}

/** The best name one capture gives, and where it came from. */
export function businessNameCandidate(c: { html: string; title: string | null; text: string; timestamp: string }, domain: string): BusinessCandidate | null {
  const site = ogSiteName(c.html);
  const fromSite = site === null ? null : clean(site, domain);
  if (fromSite) return { name: fromSite.name, source: 'og_site_name', timestamp: c.timestamp, nameIsDomain: fromSite.nameIsDomain };
  if (c.title !== null) {
    for (const seg of c.title.slice(0, 300).split(SEPARATORS)) {
      const n = clean(seg, domain);
      if (n) return { name: n.name, source: 'title', timestamp: c.timestamp, nameIsDomain: n.nameIsDomain };
    }
  }
  const tokens = nameText(c.text).split(' ').filter(Boolean);
  for (const raw of [suffixedName(tokens), copyrightName(tokens)]) {
    const n = raw ? clean(raw, domain) : null;
    if (n && !n.nameIsDomain) return { name: n.name, source: 'text_line', timestamp: c.timestamp };
  }
  return null;
}

const RANK = { og_site_name: 3, title: 2, text_line: 1 } as const;
export interface PickedName { name: string | null; confident: boolean; nameIsDomain: boolean; reason: 'ok' | 'none' | 'text_line_only' | 'conflict' }

/**
 * The most frequent name over the captures. Low confidence gives no name (the caller FLAGs): the only evidence is a text line, or the
 * captures disagree (the top name does not hold a strict majority of the captures that gave a name).
 */
export function pickBusinessName(cands: BusinessCandidate[]): PickedName {
  const by = new Map<string, { name: string; n: number; rank: number; ts: string; nameIsDomain: boolean }>();
  for (const c of cands) {
    const k = norm(c.name);
    const cur = by.get(k);
    if (!cur) by.set(k, { name: c.name, n: 1, rank: RANK[c.source], ts: c.timestamp, nameIsDomain: c.nameIsDomain === true });
    else {
      cur.n++;
      if (RANK[c.source] > cur.rank || (RANK[c.source] === cur.rank && c.timestamp > cur.ts)) { cur.rank = RANK[c.source]; cur.ts = c.timestamp; cur.name = c.name; }
    }
  }
  const ranked = [...by.values()].sort((a, b) => b.n - a.n || b.rank - a.rank || b.ts.localeCompare(a.ts));
  const best = ranked[0];
  if (!best) return { name: null, confident: false, nameIsDomain: false, reason: 'none' };
  if (cands.every((c) => c.source === 'text_line')) return { name: null, confident: false, nameIsDomain: false, reason: 'text_line_only' };
  if (ranked.length > 1 && best.n * 2 <= cands.length) return { name: null, confident: false, nameIsDomain: false, reason: 'conflict' };
  return { name: best.name, confident: true, nameIsDomain: best.nameIsDomain, reason: 'ok' };
}

/** Lowercase letters-and-digits words of a name, for the brand and big-company lists. */
export const nameTokens = (name: string): string[] => name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
