// Visible text of an archived page (CAP-07). A tolerant, dependency-free reader: it drops what a visitor never reads (script, style,
// noscript, template, comments), turns every other tag into a space, decodes the common entities and collapses whitespace. It is
// not an HTML parser and never throws: malformed markup yields whatever text is left.

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

/** Removes comments and the blocks a visitor never sees. An unclosed block runs to the end of the document. */
function dropInvisible(html: string): string {
  let h = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  h = h.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, ' ');
  for (const tag of ['script', 'style', 'noscript', 'template']) {
    h = h.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), ' ');
  }
  return h;
}

/** The text of the `<title>` (decoded, collapsed), or null when there is none or it is empty. */
export function titleOf(html: string): string | null {
  const m = /<title\b[^>]*>([\s\S]*?)(?:<\/title\s*>|$)/i.exec(html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' '));
  if (!m) return null;
  const t = collapse(decodeEntities(m[1]!.replace(/<[^>]*>/g, ' ')));
  return t === '' ? null : t;
}

/** `<meta property="og:site_name" content="...">` (either attribute order), decoded; null when absent or empty. */
export function ogSiteName(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\b(?:property|name)\s*=\s*["']og:site_name["']/i.test(tag)) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const v = c ? collapse(decodeEntities(c[1] ?? c[2] ?? '')) : '';
    if (v !== '') return v;
  }
  return null;
}

export function visibleText(html: string): { title: string | null; text: string } {
  const title = titleOf(html);
  let h = dropInvisible(html);
  h = h.replace(/<\/?[a-zA-Z!?][^>]*>/g, ' '); // a tag
  h = h.replace(/<\/?(?:[a-zA-Z!?][^>]*)?$/g, ' '); // a tag cut off at the end of the document
  return { title, text: collapse(decodeEntities(h)) };
}
