import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { canonicalJson } from './canonical-json.js';
import { AppError } from './errors.js';
import { isMutating } from './methods.js';
import { toJerusalemIso } from '../core/dates.js';
declare module 'fastify' {
  interface FastifyRequest {
    idem: { key: string; claimed: boolean } | null;
  }
}

/** An in_progress key this old probably belongs to a request that died (the caller is told so, the key is still not re-run). */
export const STALE_IN_PROGRESS_MS = 15 * 60_000;
/** Completed keys older than this are deleted (lazily, at most once a day). */
export const KEY_RETENTION_MS = 30 * 86_400_000;
const PRUNE_EVERY_MS = 86_400_000;

/** Responses that must stay the final answer for their key even when they are 5xx (the work may have happened: POST /posts after the row is written). */
const keepKey = new WeakSet<object>();
export const keepIdempotencyKey = (req: object): void => { keepKey.add(req); };

export async function pruneIdempotencyKeys(db: Kysely<Database>, nowMs: number = Date.now()): Promise<number> {
  const r = await db.deleteFrom('idempotency_keys').where('state', '=', 'completed').where('completed_at', '<', new Date(nowMs - KEY_RETENTION_MS)).executeTakeFirst();
  return Number(r.numDeletedRows);
}

const KEY = /^[\x21-\x7e]{1,255}$/; // visible ASCII, 1–255 chars

export function requestHash(method: string, url: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${url}\n${canonicalJson(body ?? null)}`).digest('hex');
}

/**
 * preHandler (runs after auth + scope): claim the key, or replay / refuse.
 * onSend (runs before the audit write): store the final response, or release the key on 5xx.
 */
export function registerIdempotency(app: FastifyInstance, db: Kysely<Database>): void {
  app.decorateRequest('idem', null);
  let lastPrune = 0;

  app.addHook('preHandler', async (req, reply) => {
    if (!isMutating(req.method)) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY.test(key)) {
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'An Idempotency-Key header (1–255 visible ASCII characters) is required on every POST',
      );
    }
    if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = Date.now();
      void pruneIdempotencyKeys(db).catch((err) => req.log.error({ errMessage: (err as Error).message }, 'idempotency prune failed'));
    }
    const hash = requestHash(req.method, req.url, req.body);
    const inserted = await db
      .insertInto('idempotency_keys')
      .values({
        key,
        request_hash: hash,
        method: req.method,
        path: req.url,
        token_id: req.auth?.tokenId ?? null,
        state: 'in_progress',
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .returning('key')
      .executeTakeFirst();
    if (inserted) {
      req.idem = { key, claimed: true };
      return;
    }
    const existing = await db.selectFrom('idempotency_keys').selectAll().where('key', '=', key).executeTakeFirst();
    if (existing && existing.request_hash !== hash) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_MISMATCH', 'This Idempotency-Key was used with a different request');
    }
    if (!existing || existing.state !== 'completed' || existing.status_code === null) {
      const stale = existing?.state === 'in_progress' && Date.now() - existing.created_at.getTime() > STALE_IN_PROGRESS_MS;
      throw new AppError(409, 'IDEMPOTENCY_KEY_IN_USE', 'A request with this Idempotency-Key is still in progress', stale ? { stale: true, started_at: toJerusalemIso(existing.created_at) } : undefined);
    }
    // A stored 202 on POST /buy is "purchase state unknown": the reconciler may have booked it since, so the
    // handler must run again (BuyService.priorOutcome never re-registers) and its answer replaces the stored one.
    if (existing.status_code === 202 && req.routeOptions.url === '/buy') {
      const reopened = await db
        .updateTable('idempotency_keys')
        .set({ state: 'in_progress', completed_at: null })
        .where('key', '=', key)
        .where('state', '=', 'completed')
        .where('status_code', '=', 202)
        .returning('key')
        .executeTakeFirst();
      if (!reopened) throw new AppError(409, 'IDEMPOTENCY_KEY_IN_USE', 'A request with this Idempotency-Key is still in progress');
      req.idem = { key, claimed: true };
      return;
    }
    reply
      .code(existing.status_code)
      .header('idempotent-replayed', 'true')
      .type(existing.response_content_type ?? 'application/json; charset=utf-8');
    return reply.send(existing.response_body ?? '');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idem;
    if (!idem?.claimed) return payload;
    idem.claimed = false;
    try {
      if (reply.statusCode >= 500 && !keepKey.has(req)) {
        await db.deleteFrom('idempotency_keys').where('key', '=', idem.key).where('state', '=', 'in_progress').execute();
      } else {
        const ct = reply.getHeader('content-type');
        await db
          .updateTable('idempotency_keys')
          .set({
            state: 'completed',
            status_code: reply.statusCode,
            response_body: typeof payload === 'string' ? payload : payload == null ? '' : String(payload),
            response_content_type: typeof ct === 'string' ? ct : null,
            completed_at: new Date(),
          })
          .where('key', '=', idem.key)
          .execute();
      }
    } catch (err) {
      // Leave the client's response untouched; the key stays in_progress (retries get IN_USE, never a re-run).
      req.log.error({ key: idem.key, errMessage: (err as Error).message }, 'idempotency store failed');
    }
    return payload;
  });
}
