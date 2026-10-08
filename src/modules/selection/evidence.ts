// Evidence store (CR-001 §11 P-4): URL, retrieval time, sha256 of the FULL response, and the extracted visible text
// gzip-compressed and capped. The raw body (HTML) is hashed and never stored.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

export interface EvidenceInput {
  source: string; url: string; retrievedAt: Date; httpStatus: number | null; contentType: string | null;
  /** The full response body: only its sha256 is kept. */
  body: string;
  /** Extracted visible text: stored gzip'd, cut to `maxBytes` bytes (never in the middle of a UTF-8 character). */
  text: string;
  maxBytes: number;
}

/** Cuts a UTF-8 string to at most `maxBytes` bytes on a character boundary. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // not a continuation byte: a character starts here
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export async function storeEvidence(db: Kysely<Database>, e: EvidenceInput): Promise<number> {
  const cut = truncateUtf8(e.text, e.maxBytes);
  const bytes = Buffer.from(cut.text, 'utf8');
  const r = await db.insertInto('screening_evidence').values({
    source: e.source, url: e.url, retrieved_at: e.retrievedAt, http_status: e.httpStatus,
    sha256: createHash('sha256').update(e.body, 'utf8').digest('hex'), content_type: e.contentType,
    text_gz: gzipSync(bytes), text_bytes: bytes.length, truncated: cut.truncated,
  }).returning('id').executeTakeFirstOrThrow();
  return Number(r.id);
}

export interface EvidenceRow {
  id: number; source: string; url: string; retrieved_at: Date; http_status: number | null; sha256: string; content_type: string | null;
  truncated: boolean; text_bytes: number; text: string;
}

export async function readEvidence(db: Kysely<Database>, id: number): Promise<EvidenceRow | null> {
  const r = await db.selectFrom('screening_evidence').selectAll().where('id', '=', String(id)).executeTakeFirst();
  if (!r) return null;
  return {
    id: Number(r.id), source: r.source, url: r.url, retrieved_at: r.retrieved_at, http_status: r.http_status, sha256: r.sha256,
    content_type: r.content_type, truncated: r.truncated, text_bytes: r.text_bytes,
    text: r.text_gz ? gunzipSync(r.text_gz).toString('utf8') : '',
  };
}
