// Visible text of an archived page (CAP-07). A tolerant, dependency-free reader built on one real tag scanner: it skips quoted
// attribute values when it looks for the end of a tag, takes script / style / noscript / template as a block only at a real tag
// start, drops comments (`<!-->` is an empty one), turns every other tag into a space, decodes the common entities and collapses
// whitespace. It never throws, and every scan is a single forward pass (case folding is ASCII-only and length-preserving, so
// offsets found in the folded copy are valid in the original). A script or style block that never closes is reported
// (`truncatedMarkup`): the text after it is unknown, which is not the same as empty.

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' };

/** One pass, so `&amp;lt;` becomes the text `&lt;` and is not decoded twice. Unknown or out-of-range references stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? whole;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
    return cp === 0xa0 ? ' ' : String.fromCodePoint(cp);
  });
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
/** ASCII-only lowercase: same length as the input (`toLowerCase` can change the length: `İ` becomes two code units). */
export const asciiFold = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const isNameChar = (c: string | undefined) => c !== undefined && /[a-z0-9]/i.test(c);
const isTagStart = (c: string | undefined) => c !== undefined && /[a-zA-Z\/!?]/.test(c);
const BLOCKS = ['script', 'style', 'noscript', 'template'] as const;

/** The index of the `>` that ends the tag starting at `from` (a `<`), skipping quoted attribute values; -1 when it never ends (or after `max` characters). */
function tagEnd(html: string, from: number, max = Infinity): number {
  let q = '';
  const stop = Math.min(html.length, max === Infinity ? html.length : from + max);
  for (let i = from + 1; i < stop; i++) {
    const c = html[i]!;
    if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') return i;
  }
  return -1;
}

interface Scanned { title: string | null; text: string; truncatedMarkup: boolean }

function scan(html: string): Scanned {
  const fold = asciiFold(html);
  const out: string[] = [];
  let title: string | null = null;
  let truncatedMarkup = false;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const j = html.indexOf('<', i);
    if (j < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, j));
    const next = html[j + 1];
    if (html.startsWith('<!--', j)) { // `<!-->` and `<!--->` are empty comments
      if (html.startsWith('<!-->', j)) { out.push(' '); i = j + 5; continue; }
      if (html.startsWith('<!--->', j)) { out.push(' '); i = j + 6; continue; }
      const k = html.indexOf('-->', j + 4);
      out.push(' ');
      i = k < 0 ? n : k + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', j)) { const k = html.indexOf(']]>', j + 9); out.push(' '); i = k < 0 ? n : k + 3; continue; }
    if (!isTagStart(next)) { out.push('<'); i = j + 1; continue; } // a `<` that does not start a tag is text
    const end = tagEnd(html, j);
    out.push(' ');
    if (end < 0) { i = n; break; } // a tag cut off at the end of the document
    if (next !== '/' && next !== '!' && next !== '?') {
      let k = j + 1;
      while (k < end && isNameChar(fold[k])) k++;
      const name = fold.slice(j + 1, k);
      if (name === 'title' && title === null) {
        const close = fold.indexOf('</title', end);
        const raw = html.slice(end + 1, close < 0 ? undefined : close);
        const t = collapse(decodeEntities(raw.replace(/<[^<>]*>/g, ' ')));
        if (t !== '') title = t;
      }
      if ((BLOCKS as readonly string[]).includes(name) && fold[end - 1] !== '/') {
        let c = fold.indexOf(`</${name}`, end);
        while (c >= 0 && isNameChar(fold[c + 2 + name.length])) c = fold.indexOf(`</${name}`, c + 2);
        if (c < 0) { if (name === 'script' || name === 'style') truncatedMarkup = true; break; } // never closes: the rest is not text
        const ce = tagEnd(html, c);
        i = ce < 0 ? n : ce + 1;
        continue;
      }
    }
    i = end + 1;
  }
  return { title, text: collapse(decodeEntities(out.join(''))), truncatedMarkup };
}

/** The text of the `<title>` (decoded, collapsed), or null when there is none or it is empty. */
export const titleOf = (html: string): string | null => scan(html).title;

/** Every `<meta ...>` tag (at most 2,000 characters each, at most 2,000 tried), found by forward scanning. */
function metaTags(html: string): string[] {
  const fold = asciiFold(html);
  const tags: string[] = [];
  let i = fold.indexOf('<meta');
  for (let tried = 0; i >= 0 && tried < 2000 && tags.length < 500; tried++) {
    if (!isNameChar(fold[i + 5])) {
      const k = tagEnd(html, i, 2000);
      if (k > 0) tags.push(html.slice(i, k + 1));
    }
    i = fold.indexOf('<meta', i + 5);
  }
  return tags;
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : null;
};

/** `<meta property="og:site_name" content="...">` (either attribute order), decoded; null when absent or empty. */
export function ogSiteName(html: string): string | null {
  for (const tag of metaTags(html)) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (key !== 'og:site_name') continue;
    const v = collapse(decodeEntities(attr(tag, 'content') ?? ''));
    if (v !== '') return v;
  }
  return null;
}

/** `<meta http-equiv="refresh" content="N;url=...">` with a delay of at most 5 s: the target URL as written, else null. Parsed by position, never by regex. */
export function metaRefreshTarget(html: string): string | null {
  for (const tag of metaTags(html)) {
    if ((attr(tag, 'http-equiv') ?? '').toLowerCase() !== 'refresh') continue;
    const content = decodeEntities((attr(tag, 'content') ?? '').slice(0, 300)).trim();
    const cut = content.search(/[;,]/);
    if (cut < 1) continue;
    const delay = content.slice(0, cut).trim();
    if (!/^\d{1,3}$/.test(delay) || Number(delay) > 5) continue;
    let rest = content.slice(cut + 1).trim();
    if (rest.slice(0, 4).toLowerCase() === 'url=') rest = rest.slice(4).trim();
    if (rest.length > 0 && (rest[0] === '"' || rest[0] === "'")) rest = rest.slice(1);
    if (rest.length > 0 && (rest.at(-1) === '"' || rest.at(-1) === "'")) rest = rest.slice(0, -1);
    rest = rest.trim();
    if (rest !== '') return rest;
  }
  return null;
}

/**
 * Words a visitor does not read on the page but a crawler does: the meta description and keywords and the `alt` text of images.
 * They feed only the WEAK signature lists (never a strong match, never a name): they are easy to stuff and easy to leave stale.
 */
export function hiddenSignals(html: string): string {
  const parts: string[] = [];
  for (const tag of metaTags(html)) {
    const key = (attr(tag, 'name') ?? attr(tag, 'property') ?? '').toLowerCase();
    if (key === 'description' || key === 'keywords' || key === 'og:description') parts.push(attr(tag, 'content') ?? '');
  }
  const fold = asciiFold(html);
  let i = fold.indexOf('<img');
  for (let tried = 0; i >= 0 && tried < 2000 && parts.length < 600; tried++) {
    if (!isNameChar(fold[i + 4])) {
      const k = tagEnd(html, i, 2000);
      if (k > 0) { const a = attr(html.slice(i, k + 1), 'alt'); if (a) parts.push(a); }
    }
    i = fold.indexOf('<img', i + 4);
  }
  return collapse(decodeEntities(parts.join(' '))).slice(0, 4000);
}

export function visibleText(html: string): { title: string | null; text: string; truncatedMarkup: boolean } {
  return scan(html);
}
