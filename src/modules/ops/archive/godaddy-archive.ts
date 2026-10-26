// v5.59.0 (CR-081): the daily archive of the GoDaddy lists on the host's disk (not the database): for `all_biddable_auctions` and `closeout_listings`, one JSON line per
// row whose domain ends in .com and whose price is at most the S8 cap, every field kept, gzip. File name `<data_date>-<file base>.jsonl.gz` in `<ARCHIVE_DIR>/godaddy/`
// (the format DOM wrote by hand for 20-26 Oct 2026). Never deleted by any retention. The replay (ops/replay) reads these files; /health shows the days and the gaps.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { addDays } from '../../../core/dates.js';
import { priceToCents } from '../jobs/datasave/datasave-price.js';
import { streamArrayItems } from '../jobs/datasave/json-stream.js';
import { listZipEntries, openZipEntry } from '../jobs/datasave/zip.js';

/** The two archived files: inventory file name -> archive file base. */
export const ARCHIVE_FILES: Readonly<Record<string, ArchiveKind>> = {
  'all_biddable_auctions.json.zip': 'all_biddable_auctions',
  'closeout_listings.json.zip': 'closeout_listings',
};
export type ArchiveKind = 'all_biddable_auctions' | 'closeout_listings';
export const ARCHIVE_KINDS: readonly ArchiveKind[] = ['all_biddable_auctions', 'closeout_listings'];

export const archiveFolder = (archiveRoot: string): string => join(archiveRoot, 'godaddy');
export const archiveName = (dataDate: string, kind: ArchiveKind): string => `${dataDate}-${kind}.jsonl.gz`;
export const archivePath = (archiveRoot: string, dataDate: string, kind: ArchiveKind): string => join(archiveFolder(archiveRoot), archiveName(dataDate, kind));

export async function archiveExists(archiveRoot: string, dataDate: string, kind: ArchiveKind): Promise<boolean> {
  try { return (await stat(archivePath(archiveRoot, dataDate, kind))).isFile(); } catch { return false; }
}

export interface ArchiveOutcome { written: string[]; skipped: string[]; error?: string }

/** Writes the archive file of one saved zip, unless it exists. Returns the file name and whether it was written (`rows` = lines). Throws on failure (the caller keeps the step alive). */
export async function archiveZip(archiveRoot: string, zipPath: string, file: string, dataDate: string, capCents: number): Promise<{ name: string; written: boolean; rows: number }> {
  const kind = ARCHIVE_FILES[file];
  if (!kind) throw new Error(`${file} is not archived`);
  const name = archiveName(dataDate, kind);
  if (await archiveExists(archiveRoot, dataDate, kind)) return { name, written: false, rows: 0 };
  await mkdir(archiveFolder(archiveRoot), { recursive: true });
  const final = archivePath(archiveRoot, dataDate, kind);
  const part = `${final}.part`;
  let rows = 0;
  try {
    const entries = await listZipEntries(zipPath);
    const entry = entries.find((e) => /\.json$/i.test(e.name));
    if (!entry) throw new Error('the zip holds no .json file');
    async function* lines(): AsyncGenerator<string> {
      for await (const raw of streamArrayItems(await openZipEntry(zipPath, entry!), 'data')) {
        const r = raw as { domainName?: unknown; price?: unknown };
        if (typeof r.domainName !== 'string' || !r.domainName.trim().toLowerCase().endsWith('.com')) continue;
        const cents = priceToCents(r.price);
        if (cents === null || cents > capCents) continue;
        rows++;
        yield `${JSON.stringify(raw)}\n`;
      }
    }
    await pipeline(Readable.from(lines()), createGzip(), createWriteStream(part));
    await rename(part, final);
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    throw e;
  }
  return { name, written: true, rows };
}

/** Streams the rows of one archive file (parsed JSON objects). A missing file yields nothing; `exists` tells the two apart. */
export async function* readArchive(archiveRoot: string, dataDate: string, kind: ArchiveKind): AsyncGenerator<Record<string, unknown>> {
  const src = createReadStream(archivePath(archiveRoot, dataDate, kind));
  const gz = createGunzip();
  src.on('error', (e) => gz.destroy(e));
  src.pipe(gz);
  let rest = '';
  for await (const chunk of gz) {
    rest += (chunk as Buffer).toString('utf8');
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (line.length > 0) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
  if (rest.trim().length > 0) yield JSON.parse(rest) as Record<string, unknown>;
}

/** The days (ascending) that have the file of this kind, whatever the other kind has. */
export async function archivedDays(archiveRoot: string, kind: ArchiveKind): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(archiveFolder(archiveRoot)); } catch { /* none */ }
  return names.map((n) => new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-${kind}\\.jsonl\\.gz$`).exec(n)?.[1]).filter((d): d is string => !!d).sort();
}

export interface ArchiveStatus { days_n: number; first: string | null; last: string | null; missing_days: string[]; days: string[] }

/** The archived days on disk. `days_n` = days with both files; `first`/`last` = the first and last day with any file; `missing_days` = a calendar day between them without both. Never throws. */
export async function archiveStatus(archiveRoot: string): Promise<ArchiveStatus> {
  let names: string[] = [];
  try { names = await readdir(archiveFolder(archiveRoot)); } catch { /* no folder yet */ }
  const have = new Map<string, Set<string>>();
  for (const n of names) {
    const m = /^(\d{4}-\d{2}-\d{2})-(all_biddable_auctions|closeout_listings)\.jsonl\.gz$/.exec(n);
    if (!m) continue;
    const set = have.get(m[1]!) ?? new Set<string>();
    set.add(m[2]!);
    have.set(m[1]!, set);
  }
  const all = [...have.keys()].sort();
  if (all.length === 0) return { days_n: 0, first: null, last: null, missing_days: [], days: [] };
  const first = all[0]!;
  const last = all[all.length - 1]!;
  const missing: string[] = [];
  const full: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if ((have.get(d)?.size ?? 0) === ARCHIVE_KINDS.length) full.push(d); else missing.push(d);
  }
  return { days_n: full.length, first, last, missing_days: missing, days: full };
}
