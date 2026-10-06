// Evidence store (CR-001 §11 P-4): sha256 of the full response, gzip'd capped text, never raw HTML; append-only.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readEvidence, storeEvidence, truncateUtf8 } from '../../src/screening/evidence.js';
import { testDb as db } from '../helpers/db.js';

const base = { source: 'wayback', url: 'https://web.archive.org/web/2020/https://example.com/', retrievedAt: new Date('2026-10-06T07:00:00Z'), httpStatus: 200, contentType: 'text/html', maxBytes: 32768 };

describe('truncateUtf8', () => {
  it('cuts on a character boundary, never in the middle of a multi-byte character', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(truncateUtf8('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncateUtf8('aéb', 2)).toEqual({ text: 'a', truncated: true }); // é is 2 bytes at 1..2
    expect(truncateUtf8('aéb', 3)).toEqual({ text: 'aé', truncated: true });
    expect(truncateUtf8('€€', 4)).toEqual({ text: '€', truncated: true }); // 3 bytes each
    expect(truncateUtf8('😀😀', 5).text).toBe('😀');
    expect(truncateUtf8('abc', 0)).toEqual({ text: '', truncated: true });
  });
});

describe('evidence store', () => {
  it('keeps the hash of the full body, the gzip text, the status and the time; not the HTML', async () => {
    const body = '<html><script>x()</script><p>Hello café</p></html>';
    const id = await storeEvidence(db, { ...base, body, text: 'Hello café' });
    const e = await readEvidence(db, id);
    expect(e).toMatchObject({
      id, source: 'wayback', url: base.url, http_status: 200, content_type: 'text/html', truncated: false, text: 'Hello café',
      sha256: createHash('sha256').update(body).digest('hex'), text_bytes: Buffer.byteLength('Hello café'),
    });
    expect(e!.retrieved_at.toISOString()).toBe('2026-10-06T07:00:00.000Z');
    const raw = await db.selectFrom('screening_evidence').select('text_gz').where('id', '=', String(id)).executeTakeFirstOrThrow();
    expect(raw.text_gz!.subarray(0, 2).toString('hex')).toBe('1f8b'); // gzip magic
    expect(Buffer.from(raw.text_gz!).includes('<html>')).toBe(false);
  });

  it('caps the text at maxBytes: truncated true, text_bytes is the stored length, the hash still covers the whole body', async () => {
    const text = 'é'.repeat(50);
    const body = `<p>${text}</p>`;
    const id = await storeEvidence(db, { ...base, body, text, maxBytes: 11 });
    const e = (await readEvidence(db, id))!;
    expect([e.truncated, e.text_bytes, e.text]).toEqual([true, 10, 'é'.repeat(5)]);
    expect(e.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('a null status and content type are allowed; an unknown id is null', async () => {
    const id = await storeEvidence(db, { ...base, httpStatus: null, contentType: null, body: '', text: '' });
    expect(await readEvidence(db, id)).toMatchObject({ http_status: null, content_type: null, text: '', text_bytes: 0, truncated: false });
    expect(await readEvidence(db, 999999)).toBeNull();
  });

  it('is append-only', async () => {
    const id = await storeEvidence(db, { ...base, body: 'b', text: 't' });
    await expect(db.updateTable('screening_evidence').set({ truncated: true }).where('id', '=', String(id)).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('screening_evidence').execute()).rejects.toThrow(/append-only/);
  });
});
