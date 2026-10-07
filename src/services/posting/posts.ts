// v2.12.0 (CR-011 part A through Buffer): validation, the daily allowance, the pause switch, creating and removing a post, and the daily refresh.
// Founder rule 10: only the company's own X account, publish only. This module never replies, quotes, likes, follows or messages anyone.
import { advisoryXactLock } from '../../core/locks.js';
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { toJerusalemIso } from '../../core/dates.js';
import { checkText, type BlockCategory } from '../blocklist.js';
import { idtDay, nextIdtMidnight } from '../../core/dates.js';
import { BufferClient, BufferError, type BufferPart } from './buffer.js';
import { inspectImage, MAX_ALT_CHARS, MAX_IMAGES_PER_PART, type ImageReason, type InspectedImage } from './images.js';
import { X_LIMIT, xWeightedLength } from './x-length.js';

/** Posts allowed per IDT day without a burst (a thread counts as one post). */
export const POSTS_PER_DAY = 1;
/** How long /media/<token> serves an image (Buffer fetches it when it publishes). */
export const MEDIA_TTL_MS = 7 * 24 * 3_600_000;
/** The whole JSON request of POST /posts (images are base64 in it). */
export const POST_BODY_LIMIT = 40 * 1024 * 1024;
export const MAX_THREAD_PARTS = 2;
/** postsRefresh looks at posted rows this young. */
export const REFRESH_WINDOW_MS = 7 * 24 * 3_600_000;

const ImageIn = z.object({ data_base64: z.string().min(1), alt: z.string().optional() }).strict();
const nonBlank = (s: string) => s.trim().length > 0;
const PartIn = z.object({ text: z.string().min(1).refine(nonBlank, 'text must not be blank'), images: z.array(ImageIn).max(20).optional() }).strict();
export const PostBody = z.object({
  text: z.string().min(1).refine(nonBlank, 'text must not be blank'),
  images: z.array(ImageIn).max(20).optional(),
  thread: z.array(PartIn).max(MAX_THREAD_PARTS).optional(),
  dry_run: z.boolean().optional(),
}).strict();
export type PostBodyT = z.infer<typeof PostBody>;

export interface PostingDeps {
  db: Kysely<Database>;
  now: () => number;
  secretValues: string[];
  publicBaseUrl: string;
  /** null = no BUFFER_API_KEY. */
  buffer: BufferClient | null;
}

export interface PartCheck { part: number; length: number; limit: number; ok: boolean; reason?: 'TOO_LONG' | 'TEXT_BLOCKED'; category?: BlockCategory }
export interface ImageCheck { part: number; position: number; ok: boolean; reason?: ImageReason; category?: BlockCategory; width?: number; height?: number; bytes?: number }
export interface Prepared { part: number; position: number; alt: string; image: InspectedImage }
export interface Validation { ok: boolean; parts: PartCheck[]; images: ImageCheck[]; prepared: Prepared[]; texts: string[] }

export async function validatePost(deps: PostingDeps, body: PostBodyT): Promise<Validation> {
  const { db } = deps;
  const parts = [{ text: body.text, images: body.images ?? [] }, ...(body.thread ?? []).map((t) => ({ text: t.text, images: t.images ?? [] }))];
  const out: Validation = { ok: true, parts: [], images: [], prepared: [], texts: parts.map((p) => p.text) };
  for (const [i, p] of parts.entries()) {
    const part = i + 1;
    const length = xWeightedLength(p.text);
    const c: PartCheck = { part, length, limit: X_LIMIT, ok: true };
    if (length > X_LIMIT) { c.ok = false; c.reason = 'TOO_LONG'; }
    else {
      const b = await checkText(db, p.text, { secretValues: deps.secretValues });
      if (!b.ok) { c.ok = false; c.reason = 'TEXT_BLOCKED'; c.category = b.category; }
    }
    out.parts.push(c);
    for (const [j, img] of p.images.entries()) {
      const position = j + 1;
      if (position > MAX_IMAGES_PER_PART) { out.images.push({ part, position, ok: false, reason: 'TOO_MANY_IMAGES' }); continue; }
      const r = inspectImage(img.data_base64);
      const chk: ImageCheck = { part, position, ok: true };
      if (!r.ok) {
        Object.assign(chk, { ok: false, reason: r.reason, width: r.width, height: r.height, bytes: r.bytes });
      } else {
        Object.assign(chk, { width: r.width, height: r.height, bytes: r.data.length });
        const alt = (img.alt ?? '').trim();
        if (alt.length === 0) Object.assign(chk, { ok: false, reason: 'ALT_MISSING' });
        else if ([...img.alt!].length > MAX_ALT_CHARS) Object.assign(chk, { ok: false, reason: 'ALT_TOO_LONG' });
        else {
          const b = await checkText(db, img.alt!, { secretValues: deps.secretValues });
          if (!b.ok) Object.assign(chk, { ok: false, reason: 'ALT_BLOCKED', category: b.category });
          else out.prepared.push({ part, position, alt: img.alt!, image: r });
        }
      }
      out.images.push(chk);
    }
  }
  out.ok = out.parts.every((p) => p.ok) && out.images.every((i) => i.ok);
  return out;
}

/** Real posts: the first failing part decides the error (length, then block list), then every failing image together. */
export function throwIfInvalid(v: Validation): void {
  const long = v.parts.find((p) => p.reason === 'TOO_LONG');
  if (long) throw new AppError(422, 'POST_TOO_LONG', 'The post is longer than X allows', { length: long.length, limit: long.limit, part: long.part });
  const blocked = v.parts.find((p) => p.reason === 'TEXT_BLOCKED');
  if (blocked) throw new AppError(422, 'TEXT_BLOCKED', 'The text is refused by the block list', { category: blocked.category, part: blocked.part });
  const bad = v.images.filter((i) => !i.ok);
  if (bad.length > 0) {
    throw new AppError(422, 'POST_INVALID', 'One or more images are refused', {
      images: bad.map((i) => ({ part: i.part, position: i.position, reason: i.reason, ...(i.category ? { category: i.category } : {}) })),
    });
  }
}

export interface Allowance { today_cap: number; used_today: number; remaining: number }

export async function allowanceNow(db: Kysely<Database>, nowMs: number): Promise<Allowance> {
  const day = idtDay(nowMs);
  const burst = await db.selectFrom('posting_bursts').select('cap').where('day', '=', day).orderBy('id', 'desc').limit(1).executeTakeFirst();
  const cap = burst?.cap ?? POSTS_PER_DAY;
  const used = await db.selectFrom('posts').select((e) => e.fn.countAll().as('n')).where('idt_day', '=', day).where('status', 'in', ['pending', 'posted', 'removed', 'unknown']).executeTakeFirstOrThrow();
  const n = Number(used.n);
  return { today_cap: cap, used_today: n, remaining: Math.max(0, cap - n) };
}

export interface PostingState { paused: boolean; reason: string | null; since: Date | null; by: string | null }

export async function postingState(db: Kysely<Database>): Promise<PostingState> {
  const r = await db.selectFrom('posting_switches').select(['paused', 'reason', 'at', 'by']).orderBy('id', 'desc').limit(1).executeTakeFirst();
  return r ? { paused: r.paused, reason: r.reason, since: r.at, by: r.by } : { paused: false, reason: null, since: null, by: null };
}

export const newPostId = () => `pst_${randomBytes(6).toString('hex')}`;

const failText = (e: BufferError) => `${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message}`.slice(0, 500);

export interface CreateResult {
  post_id: string; buffer_post_id: string; status: 'posted'; external_link: string | null; sent_at: Date | null;
  images: { part: number; position: number; sha256: string }[]; allowance: Allowance;
}

/** The pending row is inserted under the 'posts_cap' advisory lock together with the cap and pause checks (one Render instance or many). */
/** A pending row older than this lost its process before Buffer answered: postsRefresh turns it into 'unknown'. */
export const PENDING_STALE_MS = 15 * 60_000;

/** Did Buffer perhaps publish despite the error? Only a lost or garbled answer (no status, or 5xx) leaves that open; a 4xx, a refusal or a 429 is a definite no. */
export function outcomeIsUnknown(e: BufferError): boolean {
  if (e.kind === 'refused' || e.kind === 'rate_limited' || e.kind === 'channel_unknown') return false;
  return e.status === undefined || e.status >= 500;
}

export async function createPost(
  deps: PostingDeps,
  a: { body: PostBodyT; validation: Validation; by: string; auditId: string | null; idempotencyKey: string | null; onPending?: () => void },
): Promise<CreateResult> {
  const { db } = deps;
  if ((await postingState(db)).paused) {
    const s = await postingState(db);
    throw new AppError(409, 'POSTING_PAUSED', 'Posting is paused', { reason: s.reason, since: s.since ? toJerusalemIso(s.since) : null });
  }
  if (!deps.buffer) throw new AppError(503, 'POSTING_NOT_CONFIGURED', 'Posting is not configured on this server (no Buffer key)');
  const buffer = deps.buffer;
  const nowMs = deps.now();
  const id = newPostId();
  const now = new Date(nowMs);
  const expires = new Date(nowMs + MEDIA_TTL_MS);
  const stored = a.validation.prepared.map((p) => ({ ...p, token: randomBytes(16).toString('hex') }));
  const base = {
    id, created_at: now, created_by: a.by, audit_id: a.auditId, idempotency_key: a.idempotencyKey, text: a.body.text,
    thread: JSON.stringify((a.body.thread ?? []).map((t) => ({ text: t.text }))), idt_day: idtDay(nowMs),
  };
  // Cap check, pause check and the 'pending' row are one step under an advisory lock: two requests can never both pass the cap, and the row
  // exists before Buffer is called, so no later failure (or restart) can lead to a second post.
  const al = await db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'posts_cap');
    const st = await postingState(trx);
    if (st.paused) throw new AppError(409, 'POSTING_PAUSED', 'Posting is paused', { reason: st.reason, since: st.since ? toJerusalemIso(st.since) : null });
    const cur = await allowanceNow(trx, nowMs);
    if (cur.remaining <= 0) {
      throw new AppError(409, 'POST_DAILY_CAP', 'The daily post allowance is used up', { ...cur, next_allowed_at: toJerusalemIso(nextIdtMidnight(nowMs)) });
    }
    await trx.insertInto('posts').values({ ...base, status: 'pending', buffer_post_id: null }).execute();
    if (stored.length > 0) {
      await trx.insertInto('post_images').values(stored.map((p) => ({
        post_id: id, part: p.part, position: p.position, mime: p.image.mime, bytes: p.image.data.length, width: p.image.width, height: p.image.height,
        sha256: p.image.sha256, alt: p.alt, data: p.image.data, media_token: p.token, media_expires_at: expires, created_at: now,
      }))).execute();
    }
    return cur;
  });
  a.onPending?.();
  const partsOf = (part: number, text: string): BufferPart => ({
    text,
    images: stored.filter((s) => s.part === part).sort((x, y) => x.position - y.position).map((s) => ({ url: `${deps.publicBaseUrl}/media/${s.token}`, altText: s.alt })),
  });
  const parts = a.validation.texts.map((t, i) => partsOf(i + 1, t));
  let step: 'channel' | 'create' = 'channel';
  let post: Awaited<ReturnType<BufferClient['createPost']>>;
  try {
    const channel = await buffer.resolveChannel();
    step = 'create';
    post = await buffer.createPost(channel, parts[0]!, parts.slice(1));
  } catch (e) {
    if (!(e instanceof BufferError)) {
      // Not a Buffer answer (a bug): the send may or may not have happened, so the row stays counted.
      await db.updateTable('posts').set({ status: 'unknown', error: `${step}: unexpected error`.slice(0, 500) }).where('id', '=', id).where('status', '=', 'pending').execute().catch(() => undefined);
      throw e;
    }
    const unknown = step === 'create' && outcomeIsUnknown(e);
    const error = `${step}: ${failText(e)}`;
    await db.updateTable('posts').set({ status: unknown ? 'unknown' : 'failed', error }).where('id', '=', id).where('status', '=', 'pending').execute().catch(() => undefined);
    throw new AppError(502, 'POST_FAILED', unknown ? 'Buffer did not answer clearly; the post may be live' : 'Buffer did not publish the post', {
      step, kind: e.kind, outcome: unknown ? 'unknown' : 'failed', ...(unknown ? { post_id: id } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}), message: e.message, ...(e.retryAfter !== undefined ? { retry_after: e.retryAfter } : {}),
    });
  }
  await db.updateTable('posts').set({ status: 'posted', buffer_post_id: post.id, external_link: post.externalLink, sent_at: post.sentAt }).where('id', '=', id).where('status', '=', 'pending').execute();
  return {
    post_id: id, buffer_post_id: post.id, status: 'posted' as const, external_link: post.externalLink, sent_at: post.sentAt,
    images: stored.map((s) => ({ part: s.part, position: s.position, sha256: s.image.sha256 })),
    allowance: { today_cap: al.today_cap, used_today: al.used_today + 1, remaining: Math.max(0, al.remaining - 1) },
  };
}

export async function removePost(
  deps: PostingDeps,
  a: { id: string; reason: string; byHand: boolean; by: string },
): Promise<{ post_id: string; status: 'removed'; removed_at: Date; removed_reason: string; deleted_on_buffer: boolean }> {
  const { db } = deps;
  const row = await db.selectFrom('posts').select(['id', 'status', 'buffer_post_id']).where('id', '=', a.id).executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'No such post');
  if (row.status !== 'posted') throw new AppError(409, 'POST_NOT_REMOVABLE', `Only a posted post can be removed (this one is ${row.status})`, { status: row.status });
  let deleted = false;
  if (deps.buffer && row.buffer_post_id) {
    try {
      await deps.buffer.deletePost(row.buffer_post_id);
      deleted = true;
    } catch (e) {
      if (!(e instanceof BufferError)) throw e;
      if (!a.byHand) {
        throw new AppError(409, 'POST_DELETE_UNSUPPORTED', 'Buffer would not delete the post; if you removed it on X by hand, repeat with marked_removed_by_hand: true', {
          kind: e.kind, ...(e.status !== undefined ? { status: e.status } : {}), message: e.message, ...(e.retryAfter !== undefined ? { retry_after: e.retryAfter } : {}),
        });
      }
    }
  } else if (!a.byHand) {
    throw new AppError(503, 'POSTING_NOT_CONFIGURED', 'Posting is not configured on this server (no Buffer key); if you removed the post on X by hand, repeat with marked_removed_by_hand: true');
  }
  const at = new Date(deps.now());
  const r = await db.updateTable('posts').set({ status: 'removed', removed_at: at, removed_reason: a.reason }).where('id', '=', a.id).where('status', '=', 'posted').executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw new AppError(409, 'POST_NOT_REMOVABLE', 'The post was changed meanwhile', {});
  return { post_id: a.id, status: 'removed', removed_at: at, removed_reason: a.reason, deleted_on_buffer: deleted };
}

export interface RefreshSummary { skipped?: true; reason?: string; checked?: number; updated?: number; errors?: string[] }

/** Daily step: posted rows of the last 7 days that miss external_link or sent_at ask Buffer for them (a few calls a day). */
export async function postsRefresh(deps: PostingDeps): Promise<RefreshSummary> {
  if (!deps.buffer) return { skipped: true, reason: 'NO_KEY' };
  const { db } = deps;
  const since = new Date(deps.now() - REFRESH_WINDOW_MS);
  // A pending row whose process died before Buffer answered: the post may be live, so it becomes 'unknown' (still counted).
  await db.updateTable('posts').set({ status: 'unknown', error: 'pending: the server ended before Buffer answered; the post may be live' })
    .where('status', '=', 'pending').where('created_at', '<', new Date(deps.now() - PENDING_STALE_MS)).execute();
  // An unknown row that has a Buffer id is looked up: found = posted.
  const unknownRows = await db.selectFrom('posts').select(['id', 'buffer_post_id']).where('status', '=', 'unknown').where('buffer_post_id', 'is not', null).orderBy('created_at').execute();
  const rows = await db.selectFrom('posts').select(['id', 'buffer_post_id', 'external_link', 'sent_at', 'error', 'status']).where('status', '=', 'posted')
    .where('created_at', '>=', since).where((e) => e.or([e('external_link', 'is', null), e('sent_at', 'is', null)])).orderBy('created_at').execute();
  let updated = 0;
  const errors: string[] = [];
  for (const r of unknownRows) {
    try {
      const p = await deps.buffer.getPost(r.buffer_post_id!);
      if (!p) continue;
      await db.updateTable('posts').set({ status: 'posted', external_link: p.externalLink, sent_at: p.sentAt }).where('id', '=', r.id).where('status', '=', 'unknown').execute();
      updated += 1;
    } catch (e) {
      if (!(e instanceof BufferError)) throw e;
      errors.push(`${r.id}: ${failText(e)}`);
      if (e.kind === 'rate_limited') return { checked: unknownRows.length, updated, errors };
    }
  }
  for (const r of rows) {
    if (!r.buffer_post_id) continue;
    try {
      const p = await deps.buffer.getPost(r.buffer_post_id);
      if (!p) { errors.push(`${r.id}: Buffer returned no post`); continue; }
      const set: { external_link?: string; sent_at?: Date; error?: string } = {};
      if (!r.external_link && p.externalLink) set.external_link = p.externalLink;
      if (!r.sent_at && p.sentAt) set.sent_at = p.sentAt;
      if (!r.error && p.status === 'error') set.error = 'Buffer reports that the post failed to send';
      if (Object.keys(set).length === 0) continue;
      await db.updateTable('posts').set(set).where('id', '=', r.id).where('status', '=', 'posted').execute();
      updated += 1;
    } catch (e) {
      if (!(e instanceof BufferError)) throw e;
      errors.push(`${r.id}: ${failText(e)}`);
      if (e.kind === 'rate_limited') break;
    }
  }
  return { checked: rows.length + unknownRows.length, updated, ...(errors.length > 0 ? { errors } : {}) };
}

/** /health: ok | paused | not_configured | failed, with the reason. */
export async function postingHealth(deps: Pick<PostingDeps, 'db' | 'buffer'>): Promise<{ posting: 'ok' | 'paused' | 'not_configured' | 'failed'; posting_reason: string | null }> {
  try {
    const s = await postingState(deps.db);
    if (s.paused) return { posting: 'paused', posting_reason: s.reason };
    if (!deps.buffer) return { posting: 'not_configured', posting_reason: null };
    const last = await deps.db.selectFrom('posts').select(['status', 'error']).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (last?.status === 'failed' || last?.status === 'unknown') return { posting: 'failed', posting_reason: last.error };
    return { posting: 'ok', posting_reason: null };
  } catch {
    return { posting: 'failed', posting_reason: 'the posting state could not be read' };
  }
}
