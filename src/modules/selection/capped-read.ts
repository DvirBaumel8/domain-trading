// Bounded body reads and the whole-phrase signature matcher shared by the business-site fetcher (site.ts) and the portfolio lander check.
// (Was wayback.ts until 5.15.0: the Internet Archive path is gone, Dvir 6 and 14 Oct 2026.)


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
function charsetOf(contentType: string | null, head: Buffer): string | null {
  const h = /charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(contentType ?? '');
  if (h) return h[1]!;
  const m = /charset\s*=\s*["']?([A-Za-z0-9_.:-]+)/i.exec(head.subarray(0, 1024).toString('latin1'));
  return m ? m[1]! : null;
}

/** Bytes to text by the declared charset; an unknown or missing charset is UTF-8. */
function decodeBody(bytes: Buffer, contentType: string | null): string {
  const label = charsetOf(contentType, bytes);
  if (label) { try { return new TextDecoder(label).decode(bytes); } catch { /* unknown label: UTF-8 */ } }
  return bytes.toString('utf8');
}

export async function readCapped(res: Response, max: number, contentType: string | null = null): Promise<{ text: string; cut: boolean }> {
  const { bytes, cut } = await readCappedBytes(res, max);
  return { text: decodeBody(bytes, contentType ?? res.headers.get('content-type')), cut };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher for `class:phrase` terms: each phrase as a whole word/phrase, case-insensitive, runs of spaces equal. Compiled once. */
export function makeMatcher(terms: string[]): (text: string) => string[] {
  const compiled = terms.map((t) => ({ t, phrase: t.slice(t.indexOf(':') + 1).trim().toLowerCase() })).filter((x) => x.phrase !== '')
    .map((x) => ({ t: x.t, re: new RegExp(`(?<![a-z0-9])${esc(x.phrase).replace(/\s+/g, '\\s+')}(?![a-z0-9])`) }));
  return (text) => { const hay = text.toLowerCase(); return compiled.filter((c) => c.re.test(hay)).map((c) => c.t); };
}

