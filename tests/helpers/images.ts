// Crafted PNG and JPEG files for the posting tests (no image library).
import { crc32, deflateSync } from 'node:zlib';

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const t = Buffer.from(type, 'latin1');
  return Buffer.concat([u32(data.length), t, data, u32(crc32(Buffer.concat([t, data])))]);
}

/** A solid grey RGB PNG; `extra` chunks go between IHDR and IDAT. */
export function makePng(width = 16, height = 16, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND'),
  ]);
}
export const textChunk = (key: string, value: string) => pngChunk('tEXt', Buffer.from(`${key}\0${value}`, 'latin1'));

const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]), body]);

/** A minimal structurally valid baseline JPEG (headers + a scan of a few bytes); `extra` segments go after APP0. */
export function makeJpeg(width = 16, height = 16, extra: Buffer[] = []): Buffer {
  const sof = Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1')),
    ...extra,
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
export const exifSegment = (text: string) => seg(0xe1, Buffer.from(`Exif\0\0${text}`, 'latin1'));
export const commentSegment = (text: string) => seg(0xfe, Buffer.from(text, 'latin1'));
export const b64 = (b: Buffer) => b.toString('base64');
