// v2.12.0 (CR-011 part A through Buffer): posts to the company's own X account. Founder rule 10: publish only; no route here replies,
// quotes, likes, follows or messages anyone. GET /media/:token is the one public (unauthenticated) read besides /health/ping.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireWriteBeforeBody } from '../../../http/auth.js';
import { AppError } from '../../../http/errors.js';
import { keepIdempotencyKey } from '../../../http/idempotency.js';
import { SlidingWindowLimiter } from '../../../http/rate-limit.js';
import { idtDay, isRealDate, nextIdtMidnight, ymd } from '../../../core/dates.js';
import { allowanceNow, createPost, PostBody, postSchemaCheck, schemaCheckInput, POST_BODY_LIMIT, postingState, removePost, throwIfInvalid, validatePost, type PostingDeps } from '../posting/posts.js';
import { toJerusalemIso } from '../../../core/dates.js';
const RemoveBody = z.object({ reason: z.string().trim().min(1).max(300), marked_removed_by_hand: z.boolean().optional() }).strict();
const PauseBody = z.object({ paused: z.boolean(), reason: z.string().trim().min(1).max(300).optional() }).strict();
const BurstBody = z.object({ day: ymd, cap: z.number().int().min(2).max(6) }).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const IdParam = z.string().regex(/^pst_[0-9a-f]{12}$/);

/** GET /media/:token per IP and minute (the route is public). */
export const MEDIA_PER_MINUTE = 120;

const iso = (d: Date | null) => (d ? toJerusalemIso(d) : null);

export function registerPosts(app: FastifyInstance, deps: PostingDeps): void {
  const { db } = deps;

  // onRequest (after the auth hook, before the body is read): a token that cannot write is refused without parsing up to 40 MB. A body over 40 MB is refused 413 INVALID_BODY by the body limit.
  app.post('/posts', { config: { openapiBody: PostBody }, bodyLimit: POST_BODY_LIMIT, onRequest: requireWriteBeforeBody }, async (req, reply) => {
    const b = PostBody.parse(req.body ?? {});
    const v = await validatePost(deps, b);
    if (b.dry_run) {
      const al = await allowanceNow(db, deps.now());
      return {
        dry_run: true, ok: v.ok,
        parts: v.parts.map((p) => ({ part: p.part, length: p.length, limit: p.limit, ok: p.ok, ...(p.reason ? { reason: p.reason } : {}), ...(p.category ? { category: p.category } : {}) })),
        images: v.images.map((i) => ({ part: i.part, position: i.position, ok: i.ok, ...(i.reason ? { reason: i.reason } : {}), ...(i.category ? { category: i.category } : {}), width: i.width ?? null, height: i.height ?? null, bytes: i.bytes ?? null })),
        allowance: al,
      };
    }
    throwIfInvalid(v);
    const r = await createPost(deps, {
      body: b, validation: v, by: req.auth!.name, auditId: req.auditId,
      idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, 255) : null,
      // From the moment the row exists a failure is never released for a retry under the same key: the post may be live.
      onPending: () => keepIdempotencyKey(req),
    });
    req.auditSummary = `posted ${r.post_id}`;
    return reply.code(201).send({
      post_id: r.post_id, buffer_post_id: r.buffer_post_id, status: r.status, external_link: r.external_link, sent_at: iso(r.sent_at), images: r.images, allowance: r.allowance,
    });
  });

  // v3.2.0 (CR-017): WRITE (the global scope rule for POST), Idempotency-Key, audited. Reads Buffer's type definitions (introspection) and validates the post shape; publishes nothing.
  // v3.3.0 (CR-022 F-2): the same body as POST /posts (same 40 MB limit and validation); the check runs on the input DOM would build for THAT post, with placeholder /media URLs.
  // An empty body checks the fixed sample. Nothing is stored and nothing is published.
  app.post('/posts/schema-check', { config: { openapiBody: PostBody }, bodyLimit: POST_BODY_LIMIT, onRequest: requireWriteBeforeBody }, async (req) => {
    const raw = req.body;
    const empty = raw === undefined || raw === null || (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0);
    let input: Record<string, unknown> | undefined;
    if (!empty) {
      const b = PostBody.parse(raw);
      const v = await validatePost(deps, b);
      throwIfInvalid(v);
      input = schemaCheckInput(deps, v);
    }
    const r = await postSchemaCheck(deps, input);
    req.auditSummary = r.ok ? 'schema ok' : `schema: ${r.problems.length} problem(s)`;
    return { ok: r.ok, problems: r.problems, checked_types: r.checked_types, types: r.types, checked: empty ? 'sample' : 'post' };
  });

  app.get('/posts', async (req) => {
    const q = ListQuery.parse(req.query ?? {});
    const rows = await db.selectFrom('posts').selectAll().orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit).execute();
    const imgs = rows.length === 0 ? [] : await db.selectFrom('post_images')
      .select(['post_id', 'part', 'position', 'mime', 'bytes', 'width', 'height', 'sha256', 'alt', 'media_expires_at', (e) => e.eb('data', 'is not', null).as('stored')])
      .where('post_id', 'in', rows.map((r) => r.id)).orderBy('part').orderBy('position').execute();
    const sw = await postingState(db);
    return {
      posting: { paused: sw.paused, reason: sw.reason, since: iso(sw.since), by: sw.by },
      allowance: await allowanceNow(db, deps.now()),
      posts: rows.map((r) => ({
        id: r.id, created_at: iso(r.created_at), created_by: r.created_by, text: r.text, thread: r.thread, status: r.status,
        buffer_post_id: r.buffer_post_id, external_link: r.external_link, sent_at: iso(r.sent_at), error: r.error,
        removed_at: iso(r.removed_at), removed_reason: r.removed_reason,
        images: imgs.filter((i) => i.post_id === r.id).map((i) => ({
          part: i.part, position: i.position, mime: i.mime, bytes: i.bytes, width: i.width, height: i.height, sha256: i.sha256, alt: i.alt, stored: Boolean(i.stored),
        })),
      })),
    };
  });

  app.get('/posts/:id/images/:part/:position', async (req, reply) => {
    const p = req.params as { id: string; part: string; position: string };
    if (!IdParam.safeParse(p.id).success || !/^[1-3]$/.test(p.part) || !/^[1-4]$/.test(p.position)) throw new AppError(404, 'NOT_FOUND', 'No such image');
    const row = await db.selectFrom('post_images').select(['mime', 'data']).where('post_id', '=', p.id).where('part', '=', Number(p.part)).where('position', '=', Number(p.position)).executeTakeFirst();
    if (!row) throw new AppError(404, 'NOT_FOUND', 'No such image');
    if (!row.data) throw new AppError(404, 'NOT_FOUND', 'The image bytes are not stored (the record was restored from a backup, which leaves them out)');
    return reply.header('content-type', row.mime).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').send(row.data);
  });

  app.post('/posts/:id/remove', { config: { openapiBody: RemoveBody } }, async (req) => {
    const id = (req.params as { id: string }).id;
    if (!IdParam.safeParse(id).success) throw new AppError(404, 'NOT_FOUND', 'No such post');
    const b = RemoveBody.parse(req.body ?? {});
    const r = await removePost(deps, { id, reason: b.reason, byHand: b.marked_removed_by_hand ?? false, by: req.auth!.name });
    req.auditSummary = `removed ${id}`;
    return { post_id: r.post_id, status: r.status, removed_at: iso(r.removed_at), removed_reason: r.removed_reason, deleted_on_buffer: r.deleted_on_buffer };
  });

  app.post('/posts/pause', { config: { openapiBody: PauseBody } }, async (req) => {
    const b = PauseBody.parse(req.body ?? {});
    const at = new Date(deps.now());
    await db.insertInto('posting_switches').values({ at, by: req.auth!.name, audit_id: req.auditId, paused: b.paused, reason: b.reason ?? null }).execute();
    req.auditSummary = b.paused ? 'posting paused' : 'posting resumed';
    return { paused: b.paused, reason: b.reason ?? null, since: iso(at), by: req.auth!.name };
  });

  app.post('/posts/burst', { config: { openapiBody: BurstBody } }, async (req, reply) => {
    const b = BurstBody.parse(req.body ?? {});
    if (!isRealDate(b.day)) throw new AppError(422, 'VALIDATION_ERROR', 'day must be a real calendar date (YYYY-MM-DD)');
    const today = idtDay(deps.now());
    if (b.day < today) throw new AppError(422, 'VALIDATION_ERROR', 'day must be today or later (IDT)', { today });
    const at = new Date(deps.now());
    await db.insertInto('posting_bursts').values({ day: b.day, cap: b.cap, at, by: req.auth!.name, audit_id: req.auditId }).execute();
    req.auditSummary = `burst ${b.day} cap ${b.cap}`;
    return reply.code(201).send({ day: b.day, cap: b.cap, set_at: iso(at), set_by: req.auth!.name, ends_at: iso(nextIdtMidnight(new Date(`${b.day}T12:00:00Z`))) });
  });

  // The one public read (founder rules unchanged: nothing is written, no audit, no idempotency). Buffer fetches the images from here.
  const mediaLimiter = new SlidingWindowLimiter(MEDIA_PER_MINUTE, 60_000, deps.now);
  app.get('/media/:token', async (req, reply) => {
    const wait = mediaLimiter.take(req.ip);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      reply.header('retry-after', String(seconds));
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests', { retry_after_seconds: seconds });
    }
    const token = (req.params as { token: string }).token;
    const row = /^[0-9a-f]{32}$/.test(token)
      ? await db.selectFrom('post_images').select(['mime', 'data', 'media_expires_at']).where('media_token', '=', token).executeTakeFirst()
      : undefined;
    if (!row || !row.data || row.media_expires_at.getTime() <= deps.now()) throw new AppError(404, 'NOT_FOUND', 'Not found');
    return reply.header('content-type', row.mime).header('cache-control', `public, max-age=${Math.max(0, Math.min(3600, Math.floor((row.media_expires_at.getTime() - deps.now()) / 1000)))}`).header('x-content-type-options', 'nosniff').send(row.data);
  });
}
