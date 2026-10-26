import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';

export const INVENTORY = 'https://inventory.auctions.godaddy.com';
export const FILES = ['closeout_listings.json.zip', 'all_expiring_auctions.json.zip', 'all_biddable_auctions.json.zip', 'all_listings_ending_today.json.zip', 'auctions_ending_today.json.zip'];

const crc32 = (buf: Buffer): number => {
  let c: number; let crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
};

/** A one-entry zip (deflate) built in memory, for the synthetic test files. */
export function makeZip(name: string, content: string | Buffer): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const comp = deflateRawSync(data);
  const nm = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOffset = 30 + nm.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nm.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nm, comp, cd, nm, eocd]);
}

export interface CloseoutRow { domainName: string; price: string; auctionEndTime: string; isAdult?: boolean }
export const closeoutsJson = (rows: CloseoutRow[]): string => JSON.stringify({ meta: { lastBuildDate: '2026-10-20T14:06:12Z' }, data: rows.map((r) => ({ link: 'https://x.example', auctionType: 'BuyNow', numberOfBids: 0, domainAge: 1, pageviews: 0, valuation: '$0', isAdult: false, ...r })) });

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export interface InventoryOpts {
  /** LastModified per file name (ISO); default 2026-10-20T14:41:59Z for every file. */
  lastModified?: Record<string, string>;
  /** Body per file name; default a tiny synthetic zip. */
  bodies?: Record<string, Buffer>;
  /** HTTP status per file name or `metadata` (a non-200 answers that status). */
  status?: Record<string, number>;
  files?: string[];
  hits?: string[];
}

/** MSW handlers for the official inventory host: metadata.json plus each file. */
export function inventoryHandlers(o: InventoryOpts = {}) {
  const files = o.files ?? FILES;
  const lm = (f: string) => o.lastModified?.[f] ?? '2026-10-20T14:41:59Z';
  const body = (f: string) => o.bodies?.[f] ?? makeZip(f.replace(/\.zip$/, ''), `{"meta":{},"data":[]}`);
  return [
    http.get(`${INVENTORY}/metadata.json`, () => {
      o.hits?.push('metadata.json');
      if (o.status?.metadata) return new HttpResponse(null, { status: o.status.metadata });
      return HttpResponse.json(files.map((f) => ({ FileName: f, FileSize: body(f).length, FileType: '.zip', LastModified: lm(f) })));
    }),
    http.get(`${INVENTORY}/:file`, ({ params }) => {
      const f = String(params.file);
      o.hits?.push(f);
      if (o.status?.[f]) return new HttpResponse(null, { status: o.status[f] });
      return new HttpResponse(body(f), { headers: { 'content-type': 'application/zip' } });
    }),
  ];
}

export interface AuctionRow { domainName: string; price: string; auctionEndTime: string; numberOfBids?: number; auctionType?: string; isAdult?: boolean; domainAge?: number; valuation?: string; pageviews?: number; exactMatchTlds?: unknown; developedTlds?: unknown; keywordRegistrations?: unknown; semrushSearchVolume?: unknown; semrushCpc?: unknown }
/** v5.22.0: an auction file in the real shape (same envelope as the closeouts file). */
export const auctionsJson = (rows: AuctionRow[]): string => JSON.stringify({ meta: { lastBuildDate: '2026-10-20T14:06:12Z' }, data: rows.map((r) => ({ link: 'https://x.example', auctionType: 'Bid', numberOfBids: 0, domainAge: 1, pageviews: 0, valuation: '$0', isAdult: false, ...r })) });
