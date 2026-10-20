// v5.21.0 (CR-071): the streaming zip reader and JSON array reader of the datasave job (no database).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { priceToCents } from '../../../../src/modules/ops/jobs/datasave/datasave.js';
import { streamArrayItems } from '../../../../src/modules/ops/jobs/datasave/json-stream.js';
import { listZipEntries, openZipEntry } from '../../../../src/modules/ops/jobs/datasave/zip.js';
import { closeoutsJson, makeZip } from '../../../helpers/datasave.js';

const collect = async (r: AsyncIterable<unknown>) => { const out: unknown[] = []; for await (const x of r) out.push(x); return out; };
const text = async (r: Readable) => { const c: Buffer[] = []; for await (const b of r) c.push(b as Buffer); return Buffer.concat(c).toString('utf8'); };

describe('DS521 datasave streaming helpers', () => {
  it('DS521-1 priceToCents: "$1,250" is 125000, "$5" is 500, "$40.50" is 4050, junk is null', () => {
    expect(priceToCents('$1,250')).toBe(125000);
    expect(priceToCents('$5')).toBe(500);
    expect(priceToCents('$40.50')).toBe(4050);
    expect(priceToCents('free')).toBeNull();
    expect(priceToCents(undefined)).toBeNull();
  });

  it('DS521-2 the JSON reader yields the data items, also from 1-byte chunks, with braces, quotes and multibyte text inside strings', async () => {
    const doc = JSON.stringify({ meta: { note: 'has "data": [ and } inside', data: 'x' }, data: [{ a: 'q"}{[\\', n: { deep: [1, { z: 2 }] } }, { a: 'é€漢' }], after: [{ no: 1 }] });
    const bytes = Buffer.from(doc);
    const chunks = Array.from({ length: bytes.length }, (_v, i) => bytes.subarray(i, i + 1));
    const whole = await collect(streamArrayItems(Readable.from([bytes]), 'data'));
    const split = await collect(streamArrayItems(Readable.from(chunks), 'data'));
    expect(whole).toEqual([{ a: 'q"}{[\\', n: { deep: [1, { z: 2 }] } }, { a: 'é€漢' }]);
    expect(split).toEqual(whole);
    await expect(collect(streamArrayItems(Readable.from([Buffer.from('{"data":[{"a":1},{"b"')]), 'data'))).rejects.toThrow(/truncated|JSON/);
  });

  it('DS521-3 the zip reader streams an entry of a zip made by another writer (Python) and of one made in memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt-zip-test-'));
    const foreign = 'tests/fixtures/datasave/closeout_listings.sample.json.zip';
    const entries = await listZipEntries(foreign);
    expect(entries.map((e) => e.name)).toEqual(['closeout_listings.json']);
    const parsed = JSON.parse(await text(await openZipEntry(foreign, entries[0]!)));
    expect(parsed.data).toHaveLength(6);
    const mine = join(dir, 'x.zip');
    await writeFile(mine, makeZip('a/b.json', closeoutsJson([{ domainName: 'a.com', price: '$1', auctionEndTime: '2026-10-21T00:00:00Z' }])));
    const e2 = (await listZipEntries(mine))[0]!;
    expect(e2.name).toBe('a/b.json');
    expect(JSON.parse(await text(await openZipEntry(mine, e2))).data[0].domainName).toBe('a.com');
    await writeFile(join(dir, 'bad.zip'), 'not a zip at all');
    await expect(listZipEntries(join(dir, 'bad.zip'))).rejects.toThrow(/zip/);
  });
});
