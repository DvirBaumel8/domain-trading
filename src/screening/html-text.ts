// Visible text of an archived page (CAP-07). A tolerant, dependency-free reader: it drops what a visitor never reads (script, style,
// noscript, template, comments), turns every other tag into a space, decodes the common entities and collapses whitespace. It is
// not an HTML parser and never throws: malformed markup yields whatever text is left. Every scan is a single forward pass built on
// indexOf (no backtracking regex over the document), so hostile input costs time linear in its size.

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
const isNameChar = (c: string | undefined) => c !== undefined && /[a-z0-9]/i.test(c);
const isTagStart = (c: string | undefined) => c !== undefined && /[a-zA-Z\/!?]/.test(c);

/** Removes comments, CDATA and the blocks a visitor never sees (an unclosed one runs to the end). One forward pass. */
function dropInvisible(html: string, blocks: readonly string[] = ['script', 'style', 'noscript', 'template']): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const j = html.indexOf('<', i);
    if (j < 0) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, j));
    if (lower.startsWith('<!--', j)) { const k = html.indexOf('-->', j + 4); out.push(' '); i = k < 0 ? n : k + 3; continue; }
    if (lower.startsWith('<![cdata[', j)) { const k = html.indexOf(']]>', j + 9); out.push(' '); i = k < 0 ? n : k + 3; continue; }
    const name = blocks.find((b) => lower.startsWith(`<${b}`, j) && !isNameChar(lower[j + 1 + b.length]));
    if (name) {
      const open = html.indexOf('>', j);
      if (open < 0) { out.push(' '); break; }
      const close = lower.indexOf(`</${name}`, open);
      if (close < 0) { out.push(' '); break; }
      const end = html.indexOf('>', close);
      out.push(' ');
      i = end < 0 ? n : end + 1;
      continue;
    }
    out.push('<');
    i = j + 1;
  }
  return out.join('');
}

/** Replaces every tag by a space; a tag cut off at the end of the document is dropped. A `<` that does not start a tag stays text. */
function stripTags(h: string): string {
  const out: string[] = [];
  let i = 0;
  const n = h.length;
  while (i < n) {
    const j = h.indexOf('<', i);
    if (j < 0) { out.push(h.slice(i)); break; }
    out.push(h.slice(i, j));
    if (j + 1 >= n) { i = n; break; } // a lone '<' at the very end
    if (!isTagStart(h[j + 1])) { out.push('<'); i = j + 1; continue; }
    const k = h.indexOf('>', j + 1);
    out.push(' ');
    if (k < 0) { i = n; break; }
    i = k + 1;
  }
  return out.join('');
}

/** The text of the `<title>` (decoded, collapsed), or null when there is none or it is empty. */
export function titleOf(html: string): string | null {
  const h = dropInvisible(html, []);
  const lower = h.toLowerCase();
  let at = lower.indexOf('<title');
  while (at >= 0 && isNameChar(lower[at + 6])) at = lower.indexOf('<title', at + 6);
  if (at < 0) return null;
  const open = h.indexOf('>', at);
  if (open < 0) return null;
  const close = lower.indexOf('</title', open);
  const t = collapse(decodeEntities(stripTags(h.slice(open + 1, close < 0 ? undefined : close))));
  return t === '' ? null : t;
}

/** Every `<meta ...>` tag (at most 2,000 characters each), found by forward scanning. */
function metaTags(html: string): string[] {
  const lower = html.toLowerCase();
  const tags: string[] = [];
  let i = lower.indexOf('<meta');
  while (i >= 0 && tags.length < 500) {
    if (!isNameChar(lower[i + 5])) {
      const k = html.indexOf('>', i);
      if (k < 0) break;
      if (k - i <= 2000) tags.push(html.slice(i, k + 1));
    }
    i = lower.indexOf('<meta', i + 5);
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

/** `<meta http-equiv="refresh" content="N;url=...">` with a delay of at most 5 s: the target URL as written, else null. */
export function metaRefreshTarget(html: string): string | null {
  for (const tag of metaTags(html)) {
    if ((attr(tag, 'http-equiv') ?? '').toLowerCase() !== 'refresh') continue;
    const m = /^\s*(\d{1,3})\s*[;,]\s*(?:url\s*=\s*)?['"]?([^'"\s][^'"]*?)['"]?\s*$/i.exec(decodeEntities(attr(tag, 'content') ?? ''));
    if (m && Number(m[1]) <= 5) return m[2]!;
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
  const lower = html.toLowerCase();
  let i = lower.indexOf('<img');
  let count = 0;
  while (i >= 0 && count < 500) {
    const k = html.indexOf('>', i);
    if (k < 0) break;
    if (k - i <= 2000) { const a = attr(html.slice(i, k + 1), 'alt'); if (a) parts.push(a); }
    count++;
    i = lower.indexOf('<img', i + 4);
  }
  return collapse(decodeEntities(parts.join(' '))).slice(0, 4000);
}

export function visibleText(html: string): { title: string | null; text: string } {
  const title = titleOf(html);
  return { title, text: collapse(decodeEntities(stripTags(dropInvisible(html)))) };
}
