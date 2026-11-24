// USPTO TSDR: the status of one trademark by its serial number. It cannot search words (no official API does), so it clears nothing.
import { readText, SourceError, type Fetch } from './client.js';

const SOURCE = 'uspto_tsdr';

/** The first element of that name, whatever its namespace prefix. Plain text only. */
function element(xml: string, name: string): string | null {
  const v = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</`).exec(xml)?.[1]?.trim();
  return v ? v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
}

export async function trademarkStatus(serial: string, key: string | null, fetchFn: Fetch = fetch) {
  if (key === null) throw new SourceError(SOURCE, 'KEY_MISSING');
  const xml = await readText(fetchFn, { source: SOURCE, url: `https://tsdrapi.uspto.gov/ts/cd/casestatus/sn${serial}/info.xml`, headers: { 'uspto-api-key': key, accept: 'application/xml' } });
  const status = element(xml, 'MarkCurrentStatusExternalDescriptionText');
  if (element(xml, 'ApplicationNumberText') !== serial || status === null) throw new SourceError(SOURCE, 'BAD_RESPONSE', 200);
  return { serial, mark: element(xml, 'MarkVerbalElementText'), status, status_date: element(xml, 'MarkCurrentStatusDate')?.slice(0, 10) ?? null };
}
