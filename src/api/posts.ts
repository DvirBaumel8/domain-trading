// v2.12.0 (CR-011 part A through Buffer): posts to the company's own X account. Founder rule 10: publish only; no route here replies,
// quotes, likes, follows or messages anyone. GET /media/:token is the one public (unauthenticated) read besides /health/ping.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { idtDay } from '../services/review/packet.js';
import { allowanceNow, createPost, nextMidnightIdt, PostBody, POST_BODY_LIMIT, postingState, removePost, throwIfInvalid, validatePost, type PostingDeps } from '../services/posting/posts.js';
import { toJerusalemIso } from '../time.js';

const RemoveBody = z.object({ reason: z.string().trim().min(1).max(300), marked_removed_by_hand: z.boolean().optional() }).strict();
const PauseBody = z.object({ paused: z.boolean(), reason: z.string().trim().min(1).max(300).optional() }).strict();
const BurstBody = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), cap: z.number().int().min(2).max(5) }).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const IdParam = z.string().regex(/^pst_[0-9a-f]{12}$/);

const iso = (d: Date | null) => (d ? toJerusalemIso(d) : null);

export function registerPosts(app: FastifyInstance, deps: PostingDeps): void {
  const { db } = deps;

  app.post('/posts', { bodyLimit: POST_BODY_LIMIT }, async (req, reply) => {
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
    });
    req.auditSummary = `posted ${r.post_id}`;
    return reply.code(201).send({
      post_id: r.post_id, buffer_post_id: r.buffer_post_id, status: r.status, external_link: r.external_link, sent_at: iso(r.sent_at), images: r.images, allowance: r.allowance,
    });
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

  app.post('/posts/:id/remove', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!IdParam.safeParse(id).success) throw new AppError(404, 'NOT_FOUND', 'No such post');
    const b = RemoveBody.parse(req.body ?? {});
    const r = await removePost(deps, { id, reason: b.reason, byHand: b.marked_removed_by_hand ?? false, by: req.auth!.name });
    req.auditSummary = `removed ${id}`;
    return { post_id: r.post_id, status: r.status, removed_at: iso(r.removed_at), removed_reason: r.removed_reason, deleted_on_buffer: r.deleted_on_buffer };
  });

  app.post('/posts/pause', async (req) => {
    const b = PauseBody.parse(req.body ?? {});
    const at = new Date(deps.now());
    await db.insertInto('posting_switches').values({ at, by: req.auth!.name, audit_id: req.auditId, paused: b.paused, reason: b.reason ?? null }).execute();
    req.auditSummary = b.paused ? 'posting paused' : 'posting resumed';
    return { paused: b.paused, reason: b.reason ?? null, since: iso(at), by: req.auth!.name };
  });

  app.post('/posts/burst', async (req, reply) => {
    const b = BurstBody.parse(req.body ?? {});
    if (Number.isNaN(Date.parse(`${b.day}T00:00:00Z`)) || new Date(`${b.day}T00:00:00Z`).toISOString().slice(0, 10) !== b.day) throw new AppError(422, 'VALIDATION_ERROR', 'day must be a real calendar date (YYYY-MM-DD)');
    const today = idtDay(deps.now());
    if (b.day < today) throw new AppError(422, 'VALIDATION_ERROR', 'day must be today or later (IDT)', { today });
    const at = new Date(deps.now());
    await db.insertInto('posting_bursts').values({ day: b.day, cap: b.cap, at, by: req.auth!.name, audit_id: req.auditId }).execute();
    req.auditSummary = `burst ${b.day} cap ${b.cap}`;
    return reply.code(201).send({ day: b.day, cap: b.cap, set_at: iso(at), set_by: req.auth!.name, ends_at: iso(await nextMidnightIdt(db, new Date(`${b.day}T12:00:00Z`).getTime())) });
  });

  // The one public read (founder rules unchanged: nothing is written, no audit, no idempotency). Buffer fetches the images from here.
  app.get('/media/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const row = /^[0-9a-f]{32}$/.test(token)
      ? await db.selectFrom('post_images').select(['mime', 'data', 'media_expires_at']).where('media_token', '=', token).executeTakeFirst()
      : undefined;
    if (!row || !row.data || row.media_expires_at.getTime() <= deps.now()) throw new AppError(404, 'NOT_FOUND', 'Not found');
    return reply.header('content-type', row.mime).header('cache-control', 'public, max-age=3600').header('x-content-type-options', 'nosniff').send(row.data);
  });
}
