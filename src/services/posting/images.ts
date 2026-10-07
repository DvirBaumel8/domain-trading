// v2.12.0 (CR-011 addendum A): image checks and metadata stripping for X posts. No dependency: PNG and JPEG are parsed by hand.
// Limits (documented in the contract): PNG or JPEG by magic bytes, at most 5 MB decoded, 4..8192 px on each side, 0..4 per post part,
// alt text 1..1000 characters (checked against the block list by the caller).
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const MAX_IMAGES_PER_PART = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MIN_DIMENSION = 4;
export const MAX_DIMENSION = 8192;
export const MAX_ALT_CHARS = 1000;

export type ImageReason = 'IMAGE_TYPE' | 'IMAGE_CORRUPT' | 'IMAGE_TOO_LARGE' | 'IMAGE_DIMENSIONS' | 'ALT_MISSING' | 'ALT_TOO_LONG' | 'ALT_BLOCKED' | 'TOO_MANY_IMAGES';

export interface InspectedImage {
  mime: 'image/png' | 'image/jpeg';
  /** The stored bytes: the upload without metadata. */
  data: Buffer;
  width: number;
  height: number;
  sha256: string;
}
export type InspectResult = ({ ok: true } & InspectedImage) | { ok: false; reason: ImageReason; width?: number; height?: number; bytes?: number };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG chunks kept: the critical ones and the display ones that carry no free text. Everything else (tEXt, zTXt, iTXt, eXIf, tIME, ...) is dropped. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'pHYs', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'tRNS']);

class Corrupt extends Error {}

interface Parsed { width: number; height: number; data: Buffer }

function parsePng(buf: Buffer): Parsed {
  const out: Buffer[] = [PNG_SIG];
  let pos = PNG_SIG.length;
  let width = 0;
  let height = 0;
  let first = true;
  let idat = false;
  for (;;) {
    if (pos + 12 > buf.length) throw new Corrupt('truncated PNG');
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > buf.length) throw new Corrupt('bad chunk length');
    if (first && type !== 'IHDR') throw new Corrupt('IHDR must come first');
    const crc = buf.readUInt32BE(end - 4);
    if (crc32(buf.subarray(pos + 4, end - 4)) !== crc) throw new Corrupt('bad chunk CRC');
    if (type === 'IHDR') {
      if (!first || len !== 13) throw new Corrupt('bad IHDR');
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
    }
    first = false;
    if (type === 'IDAT') idat = true;
    if (PNG_KEEP.has(type)) out.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') break; // anything after IEND is dropped
  }
  if (!idat) throw new Corrupt('no image data');
  return { width, height, data: Buffer.concat(out) };
}

const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function parseJpeg(buf: Buffer): Parsed {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let pos = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  for (;;) {
    // find the next marker: 0xFF then a non-0xFF, non-0 byte (fill bytes 0xFF are skipped)
    if (pos >= buf.length) throw new Corrupt('no EOI');
    if (buf[pos] !== 0xff) throw new Corrupt('marker expected');
    while (buf[pos] === 0xff && pos < buf.length) pos++;
    const m = buf[pos++];
    if (m === undefined || m === 0) throw new Corrupt('bad marker');
    if (m === 0xd9) {
      if (!sawScan || width === 0) throw new Corrupt('no image data');
      out.push(Buffer.from([0xff, 0xd9]));
      return { width, height, data: Buffer.concat(out) };
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone markers carry no length
    if (pos + 2 > buf.length) throw new Corrupt('truncated segment');
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) throw new Corrupt('bad segment length');
    const seg = buf.subarray(pos, pos + len);
    if (isSof(m)) {
      if (len < 8) throw new Corrupt('bad SOF');
      height = seg.readUInt16BE(3);
      width = seg.readUInt16BE(5);
    }
    // Drop APP1..APP15 and COM (EXIF, XMP, ICC in APP2, comments, ...). Keep APP0 (JFIF), DQT, DHT, SOF, DRI, SOS ...
    const drop = (m >= 0xe1 && m <= 0xef) || m === 0xfe;
    if (!drop) out.push(Buffer.from([0xff, m]), seg);
    pos += len;
    if (m === 0xda) {
      // entropy-coded data up to the next real marker (byte stuffing 0xFF00 and RSTn stay inside the scan)
      sawScan = true;
      const start = pos;
      while (pos < buf.length) {
        if (buf[pos] === 0xff) {
          const n = buf[pos + 1];
          if (n === undefined) throw new Corrupt('truncated scan');
          if (n === 0 || (n >= 0xd0 && n <= 0xd7)) { pos += 2; continue; }
          if (n === 0xff) { pos += 1; continue; }
          break;
        }
        pos++;
      }
      if (pos >= buf.length) throw new Corrupt('no EOI');
      out.push(buf.subarray(start, pos));
    }
  }
}

/** Checks one decoded-from-base64 upload: size, type, structure, dimensions. Returns the metadata-free bytes. */
export function inspectImageBytes(buf: Buffer): InspectResult {
  if (buf.length === 0) return { ok: false, reason: 'IMAGE_CORRUPT' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'IMAGE_TOO_LARGE', bytes: buf.length };
  let mime: InspectedImage['mime'];
  let parse: (b: Buffer) => Parsed;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) { mime = 'image/png'; parse = parsePng; }
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { mime = 'image/jpeg'; parse = parseJpeg; }
  else return { ok: false, reason: 'IMAGE_TYPE', bytes: buf.length };
  let p: Parsed;
  try {
    p = parse(buf);
  } catch (e) {
    if (e instanceof Corrupt) return { ok: false, reason: 'IMAGE_CORRUPT', bytes: buf.length };
    throw e;
  }
  const bad = p.width < MIN_DIMENSION || p.height < MIN_DIMENSION || p.width > MAX_DIMENSION || p.height > MAX_DIMENSION;
  if (bad) return { ok: false, reason: 'IMAGE_DIMENSIONS', width: p.width, height: p.height, bytes: buf.length };
  return { ok: true, mime, data: p.data, width: p.width, height: p.height, sha256: createHash('sha256').update(p.data).digest('hex') };
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decodes the base64 of one upload (strict alphabet) and inspects it. */
export function inspectImage(dataBase64: string): InspectResult {
  // a decoded size over the limit is refused before decoding: base64 is 4/3 of the bytes
  if (dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) return { ok: false, reason: 'IMAGE_TOO_LARGE' };
  if (dataBase64.length % 4 !== 0 || !B64.test(dataBase64)) return { ok: false, reason: 'IMAGE_CORRUPT' };
  return inspectImageBytes(Buffer.from(dataBase64, 'base64'));
}
