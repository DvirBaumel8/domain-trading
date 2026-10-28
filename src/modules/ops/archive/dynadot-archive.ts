// v5.74.0: the archive of the Dynadot aftermarket rows on the host's disk (not the database), written by the datasave retention step before it deletes a day
// from dynadot_rows: one JSON line per stored row, gzip, `<ARCHIVE_DIR>/dynadot/<data_date>-aftermarket.jsonl.gz`. Never deleted by any retention.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';

const BATCH = 20_000;

export const dynadotArchivePath = (archiveRoot: string, dataDate: string): string => join(archiveRoot, 'dynadot', `${dataDate}-aftermarket.jsonl.gz`);

/** Writes the archive file of one aftermarket day unless it exists (`written: false`). Rows are read in id order in batches. Throws on failure; the caller keeps the day. */
export async function archiveAftermarketDay(db: Kysely<Database>, archiveRoot: string, dataDate: string): Promise<{ written: boolean; rows: number }> {
  const final = dynadotArchivePath(archiveRoot, dataDate);
  try { if ((await stat(final)).isFile()) return { written: false, rows: 0 }; } catch { /* not there yet */ }
  await mkdir(join(archiveRoot, 'dynadot'), { recursive: true });
  const tmp = `${final}.tmp`;
  let rows = 0;
  async function* lines(): AsyncGenerator<string> {
    let after = 0;
    for (;;) {
      const part = await db.selectFrom('dynadot_rows').select(['id', 'domain', 'listing_id', 'price_cents', 'bid_count', 'end_time', 'ends_at'])
        .where('kind', '=', 'aftermarket').where('data_date', '=', dataDate).where('id', '>', after).orderBy('id').limit(BATCH).execute();
      if (part.length === 0) return;
      after = Number(part[part.length - 1]!.id);
      rows += part.length;
      yield part.map(({ id: _id, ...r }) => JSON.stringify({ data_date: dataDate, ...r })).join('\n') + '\n';
    }
  }
  try {
    await pipeline(Readable.from(lines()), createGzip(), createWriteStream(tmp));
    await rename(tmp, final);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { written: true, rows };
}
