// A minimal zip reader (CR-071): finds one entry in the central directory and streams it out, inflating on the fly, without loading the file.
// Supports stored (0) and deflate (8) entries and no zip64 (GoDaddy's files are far below 4 GB). Dependency-free on purpose.
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; localOffset: number }

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** The entries of the zip at `path`. Throws on a file that is not a zip or needs zip64. */
export async function listZipEntries(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD_SIG) { e = i; break; }
    if (e < 0) throw new Error('not a zip file (no end-of-central-directory record)');
    const total = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOffset = tail.readUInt32LE(e + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < total; n++) {
      if (cd.readUInt32LE(p) !== CD_SIG) throw new Error('corrupt zip central directory');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      out.push({
        name: cd.toString('utf8', p + 46, p + 46 + nameLen), method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), localOffset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** The uncompressed bytes of `entry` as a stream. */
export async function openZipEntry(path: string, entry: ZipEntry): Promise<Readable> {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`zip entry ${entry.name}: compression method ${entry.method} is not supported`);
  const fh = await open(path, 'r');
  let start: number;
  try {
    const h = Buffer.alloc(30);
    await fh.read(h, 0, 30, entry.localOffset);
    if (h.readUInt32LE(0) !== LOCAL_SIG) throw new Error('corrupt zip local header');
    start = entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  if (entry.compressedSize === 0) return Readable.from([]);
  const raw = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  const inflate = createInflateRaw();
  raw.on('error', (e) => inflate.destroy(e));
  return raw.pipe(inflate);
}
