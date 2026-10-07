// v2.10.0 (CR-011 part B): review packets, feedback, items, status and cost. The service calls no reviewer: Gavriel does.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { checkText } from '../services/blocklist.js';
import { runReview, skipToError, type ReviewRunDeps } from '../services/review/run.js';
import { ALLOWED_REVIEW_MODELS } from '../services/review/gemini.js';
import { allowedModelsView, currentReviewSettings } from '../services/review/settings.js';
import { toJerusalemIso } from '../time.js';
import { storeFeedback, type FeedbackInput } from '../services/review/feedback.js';
import { buildPacket, insertPacket, latestDocument, monthSpend, newPacketId, REVIEW_MONTHLY_CAP_USD, sha256 } from '../services/review/packet.js';

export interface ReviewsDeps { db: Kysely<Database>; now: () => number; secretValues: string[]; version: string; review: Omit<ReviewRunDeps, 'db' | 'secretValues' | 'version'> }

const PacketBody = z.object({ preview: z.boolean().optional() }).strict();
const PacketQuery = z.object({ preview: z.enum(['true', 'false']).optional() }).strict();
const Item = z.object({
  category: z.string().min(1).max(40).refine((s) => s === s.toLowerCase(), 'category must be lower-case'),
  severity: z.enum(['low', 'medium', 'high']),
  text: z.string().min(1).max(2000),
}).strict();
const Feedback: z.ZodType<FeedbackInput> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), provider: z.string().min(1).max(60), model: z.string().min(1).max(100), cost_usd: z.number().min(0).max(100), items: z.array(Item).max(50) }).strict(),
  z.object({ status: z.literal('unknown'), provider: z.string().min(1).max(60), model: z.string().min(1).max(100).optional(), cost_usd: z.number().min(0).max(100).optional(), reason: z.string().min(1).max(500) }).strict(),
]);
const SettingsBody = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).max(100).optional(),
  tier: z.enum(['free', 'paid']).optional(),
  note: z.string().min(1).max(300).optional(),
}).strict();
const StatusBody = z.object({ status: z.enum(['acted', 'rejected', 'watching']), note: z.string().min(1).max(500) }).strict();
const ItemsQuery = z.object({
  view: z.enum(['new', 'all']).default('new'),
  status: z.enum(['acted', 'rejected', 'watching']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

export function registerReviews(app: FastifyInstance, deps: ReviewsDeps): void {
  const { db } = deps;
  const block = async (text: string) => {
    const r = await checkText(db, text, { secretValues: deps.secretValues });
    if (!r.ok) throw new AppError(422, 'TEXT_BLOCKED', 'The text is refused by the block list', { category: r.category });
  };

  app.post('/reviews/packet', async (req, reply) => {
    const q = PacketQuery.safeParse(req.query ?? {});
    const b = PacketBody.safeParse(req.body ?? {});
    if (!q.success || !b.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request: only preview (boolean) is accepted, as a query parameter or in the body');
    const preview = b.data.preview ?? q.data.preview === 'true';
    const nowMs = deps.now();
    if (!(await latestDocument(db))) throw new AppError(409, 'DOCUMENT_MISSING', 'No company document has been uploaded; POST /company/document first');
    const spend = await monthSpend(db, nowMs);
    if (spend.spentUsd >= REVIEW_MONTHLY_CAP_USD) throw new AppError(409, 'REVIEW_COST_CAP', 'The monthly review cost cap is reached', { spent_usd: spend.spentUsd, cap_usd: REVIEW_MONTHLY_CAP_USD });
    const built = await buildPacket(db, new Date(nowMs), deps.version);
    if (!built) throw new AppError(409, 'DOCUMENT_MISSING', 'No company document has been uploaded; POST /company/document first');
    const text = JSON.stringify(built.content);
    await block(text);
    const hash = sha256(text);
    if (preview) return { preview: true, kind: built.kind, content: built.content, sha256: hash };
    const id = newPacketId();
    await insertPacket(db, { id, createdBy: req.auth!.name, now: new Date(nowMs), built, text, hash });
    return reply.code(201).send({ packet_id: id, kind: built.kind, document_version: built.documentVersion, sha256: hash, content: built.content });
  });

  // v2.11.0: the service's one AI call. WRITE token, Idempotency-Key, audited; 3 per hour per token (src/http/rate-limit.ts).
  app.post('/reviews/run', async (req) => {
    const r = await runReview({ ...deps.review, db, secretValues: deps.secretValues, version: deps.version }, { trigger: 'manual', now: deps.now(), createdBy: req.auth!.name });
    if ('skipped' in r) throw skipToError(r);
    return r;
  });

  const settingsView = async () => {
    const s = await currentReviewSettings(db);
    return {
      enabled: s.enabled, model: s.model, tier: s.tier, allowed_models: allowedModelsView(),
      updated_at: s.updatedAt ? toJerusalemIso(s.updatedAt) : null, updated_by: s.updatedBy,
    };
  };

  // v2.11.2 (CR-011 addendum C): the review's switch, model and tier. History = review_settings_changes (append-only).
  app.get('/reviews/settings', async () => settingsView());

  app.post('/reviews/settings', async (req) => {
    const p = SettingsBody.safeParse(req.body ?? {});
    if (!p.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid request: enabled (boolean), model, tier (free or paid) and note (1..300 characters) are accepted (${p.error.issues.map((i) => i.path.join('.') || i.message).join(', ')})`);
    const b = p.data;
    if (b.enabled === undefined && b.model === undefined && b.tier === undefined) throw new AppError(400, 'VALIDATION_ERROR', 'At least one of enabled, model or tier is required');
    const allowed = allowedModelsView();
    if (b.model !== undefined && !ALLOWED_REVIEW_MODELS.some((m) => m.model === b.model)) {
      throw new AppError(422, 'REVIEW_MODEL_NOT_ALLOWED', 'That model is not on the allowed list', { allowed_models: allowed });
    }
    if (b.tier === 'paid' && b.note === undefined) throw new AppError(422, 'VALIDATION_ERROR', 'Setting tier to paid needs a note that names Dvir\'s approval');
    const cur = await currentReviewSettings(db);
    const next = { enabled: b.enabled ?? cur.enabled, model: b.model ?? cur.model, tier: b.tier ?? cur.tier };
    const entry = ALLOWED_REVIEW_MODELS.find((m) => m.model === next.model);
    if (next.tier === 'free' && entry && !entry.free) {
      throw new AppError(422, 'REVIEW_MODEL_NEEDS_PAID', 'That model has no free tier; set tier to paid first, with a note that names Dvir\'s approval', { model: next.model });
    }
    if (next.enabled === cur.enabled && next.model === cur.model && next.tier === cur.tier) {
      req.auditSummary = 'review settings: unchanged';
      return { changed: false, ...(await settingsView()) };
    }
    if (b.note !== undefined) await block(b.note);
    await db.insertInto('review_settings_changes').values({
      at: new Date(deps.now()), by: req.auth!.name, audit_id: req.auditId, ...next, note: b.note ?? null,
      old: JSON.stringify({ enabled: cur.enabled, model: cur.model, tier: cur.tier }),
    }).execute();
    req.auditSummary = `review settings: enabled ${next.enabled}, model ${next.model}, tier ${next.tier}`;
    return { changed: true, ...(await settingsView()) };
  });

  app.get('/reviews/packets/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = await db.selectFrom('review_packets').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw new AppError(404, 'PACKET_NOT_FOUND', 'No such review packet', { packet_id: id });
    return { packet_id: p.id, created_at: p.created_at, created_by: p.created_by, kind: p.kind, document_version: p.document_version, sha256: p.sha256, content: p.content };
  });

  app.post('/reviews/:packet_id/feedback', async (req, reply) => {
    const b = Feedback.parse(req.body ?? {});
    const packetId = (req.params as { packet_id: string }).packet_id;
    const packet = await db.selectFrom('review_packets').select('id').where('id', '=', packetId).executeTakeFirst();
    if (!packet) throw new AppError(404, 'PACKET_NOT_FOUND', 'No such review packet', { packet_id: packetId });
    const items = b.status === 'ok' ? b.items : [];
    for (const it of items) await block(`${it.category}\n${it.text}`);
    if (b.status === 'unknown') await block(b.reason);
    const result = await storeFeedback(db, { packetId, createdBy: req.auth!.name, now: new Date(deps.now()), input: b });
    return reply.code(201).send(result);
  });

  app.get('/reviews/items', async (req) => {
    const q = ItemsQuery.safeParse(req.query ?? {});
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid query: view is new or all, status is acted, rejected or watching, limit is 1..500 (${q.error.issues.map((i) => i.path.join('.')).join(', ')})`);
    const { view, status, limit } = q.data;
    const r = await sql<{
      id: number; packet_id: string; created_at: Date; kind: string; category: string; severity: string; text: string; novelty: string;
      repeats_item_id: number | null; st_status: string | null; st_note: string | null; st_at: Date | null;
    }>`
      with st as (select distinct on (item_id) item_id, status, note, created_at from review_item_statuses order by item_id, id desc)
      select i.id, i.packet_id, i.created_at, p.kind, i.category, i.severity, i.text, i.novelty, i.repeats_item_id,
             s.status as st_status, s.note as st_note, s.created_at as st_at
      from review_items i join review_packets p on p.id = i.packet_id left join st s on s.item_id = i.id
      where (${status ?? null}::text is null or s.status = ${status ?? null})
        and (${view} = 'all' or i.repeats_item_id is null
             or coalesce((select o.status from st o where o.item_id = i.repeats_item_id), '') <> 'rejected')
      order by i.created_at desc, i.id desc limit ${limit}`.execute(db);
    return {
      items: r.rows.map((x) => ({
        id: x.id, packet_id: x.packet_id, created_at: x.created_at, kind: x.kind, category: x.category, severity: x.severity, text: x.text,
        novelty: x.novelty, repeats_item_id: x.repeats_item_id,
        status: x.st_status === null ? null : { status: x.st_status, note: x.st_note, at: x.st_at },
      })),
    };
  });

  app.post('/reviews/items/:id/status', async (req, reply) => {
    const b = StatusBody.parse(req.body ?? {});
    const raw = (req.params as { id: string }).id;
    const notFound = () => new AppError(404, 'REVIEW_ITEM_NOT_FOUND', 'No such review item', { item_id: raw });
    if (!/^\d{1,9}$/.test(raw)) throw notFound();
    const id = Number(raw);
    if (!(await db.selectFrom('review_items').select('id').where('id', '=', id).executeTakeFirst())) throw notFound();
    await block(b.note);
    const row = await db.insertInto('review_item_statuses').values({
      item_id: id, status: b.status, note: b.note, created_by: req.auth!.name, audit_id: req.auditId, created_at: new Date(deps.now()),
    }).returning(['item_id', 'status', 'note', 'created_at']).executeTakeFirstOrThrow();
    return reply.code(201).send({ item_id: row.item_id, status: row.status, note: row.note, at: row.created_at });
  });

  app.get('/reviews/cost', async () => {
    const s = await monthSpend(db, deps.now());
    const c = await currentReviewSettings(db);
    return { month: s.month, spent_usd: s.spentUsd, cap_usd: REVIEW_MONTHLY_CAP_USD, feedback_n: s.okN, unknown_n: s.unknownN, enabled: c.enabled, model: c.model, tier: c.tier };
  });
}
