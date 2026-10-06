// Prior-business guard of the history check (CR-002 Amendment A1): the name a captured business page gives itself, taken
// deterministically from the page's own words: og:site_name, else the <title> (generic words and the domain itself dropped), else a
// copyright or "<Name> LLC / Inc / Co" line. The name feeds CAP-02 (brand and big-company lists) and CAP-08 (the manual trademark
// request). No guessing: when no name is clear the result is null and the check FLAGs for a human.
import { ogSiteName } from './html-text.js';

export interface BusinessCandidate { name: string; source: 'og_site_name' | 'title' | 'text_line'; timestamp: string }

const GENERIC = new Set([
  'home', 'homepage', 'home page', 'welcome', 'index', 'index page', 'main', 'main page', 'default', 'default page', 'untitled', 'untitled document',
  'under construction', 'coming soon', 'page not found', 'not found', 'loading', 'redirecting', 'just another wordpress site', 'website', 'web site', 'new page',
]);
const SEPARATORS = /\s+[|–—\-»•·]\s+|\s*::\s*|\s*\|\s*/;
const SUFFIX = 'LLC|L\\.L\\.C\\.|Inc\\.?|Incorporated|Co\\.?|Company|Ltd\\.?|Limited|Corp\\.?|Corporation|Group|Services|Associates|Partners|Studio|Agency|Consulting';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A usable business name, or null: 2-60 characters with a letter, at most 6 words, not generic, not the domain itself. */
function clean(raw: string, domain: string): string | null {
  let n = raw.replace(/^\s*welcome\s+to\s+/i, '').replace(/\s+/g, ' ').trim().replace(/^[\s"'“‘]+|[\s"'”’.,;:]+$/g, '');
  if (n.length < 2 || n.length > 60 || !/[a-z]/i.test(n) || n.split(' ').length > 6) return null;
  if (GENERIC.has(n.toLowerCase())) return null;
  const k = norm(n);
  const sld = domain.replace(/\.com$/, '');
  if (k === '' || k === norm(domain) || k === norm(sld) || n.toLowerCase().includes(domain)) return null;
  return n;
}

/** The best name one capture gives, and where it came from. */
export function businessNameCandidate(c: { html: string; title: string | null; text: string; timestamp: string }, domain: string): BusinessCandidate | null {
  const site = ogSiteName(c.html);
  const fromSite = site === null ? null : clean(site, domain);
  if (fromSite) return { name: fromSite, source: 'og_site_name', timestamp: c.timestamp };
  if (c.title !== null) {
    for (const seg of c.title.split(SEPARATORS)) {
      const n = clean(seg, domain);
      if (n) return { name: n, source: 'title', timestamp: c.timestamp };
    }
  }
  const copy = new RegExp(`(?:\\u00a9|\\(c\\)|copyright)\\s*(?:\\d{4}(?:\\s*[-\\u2013]\\s*\\d{4})?)?\\s*((?:[A-Z][A-Za-z0-9&'\\u2019.-]*\\s?){1,5}?)(?=\\s+all\\s+rights|\\s*[|,.]|\\s{2,}|$)`).exec(c.text);
  const suffixed = new RegExp(`\\b((?:[A-Z][A-Za-z0-9&'\\u2019-]+\\s){1,3}(?:${SUFFIX}))(?![A-Za-z])`).exec(c.text);
  for (const m of [suffixed, copy]) {
    const n = m ? clean(m[1]!, domain) : null;
    if (n) return { name: n, source: 'text_line', timestamp: c.timestamp };
  }
  return null;
}

const RANK = { og_site_name: 3, title: 2, text_line: 1 } as const;

/** The most frequent name over the captures; a tie goes to the more explicit source, then to the later capture. */
export function pickBusinessName(cands: BusinessCandidate[]): string | null {
  const by = new Map<string, { name: string; n: number; rank: number; ts: string }>();
  for (const c of cands) {
    const k = norm(c.name);
    const cur = by.get(k);
    if (!cur) by.set(k, { name: c.name, n: 1, rank: RANK[c.source], ts: c.timestamp });
    else {
      cur.n++;
      if (RANK[c.source] > cur.rank || (RANK[c.source] === cur.rank && c.timestamp > cur.ts)) { cur.rank = RANK[c.source]; cur.ts = c.timestamp; cur.name = c.name; }
    }
  }
  const best = [...by.values()].sort((a, b) => b.n - a.n || b.rank - a.rank || b.ts.localeCompare(a.ts))[0];
  return best ? best.name : null;
}

/** Lowercase letters-and-digits words of a name, for the brand and big-company lists. */
export const nameTokens = (name: string): string[] => name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
