import { randomBytes } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditRowInsert, Database } from '../db/types.js';
import { errorBody } from './errors.js';
import { isMutating } from './methods.js';
import { redact } from './redact.js';

declare module 'fastify' {
  interface FastifyRequest {
    auditId: string | null;
    auditSummary: string | null;
  }
}

export interface AuditWriter {
  write(row: AuditRowInsert): Promise<void>;
}

export function newAuditId(): string {
  return `aud_${randomBytes(16).toString('hex')}`;
}

export function dbAuditWriter(db: Kysely<Database>): AuditWriter {
  return {
    async write(row) {
      await db.insertInto('audit_log').values(row).execute();
    },
  };
}

/** onRequest, registered FIRST so even a 401 gets an id. */
export function registerAuditId(app: FastifyInstance): void {
  app.decorateRequest('auditId', null);
  app.decorateRequest('auditSummary', null);
  app.addHook('onRequest', async (req) => {
    if (isMutating(req.method)) req.auditId = newAuditId();
  });
}

function bodyObject(req: FastifyRequest): Record<string, unknown> | null {
  const b = req.body;
  return b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

function extractApproval(body: Record<string, unknown> | null): { text: string | null; at: Date | null } {
  const ref = body?.approval_ref;
  if (ref === null || typeof ref !== 'object') return { text: null, at: null };
  const { text, approved_at } = ref as Record<string, unknown>;
  const at = typeof approved_at === 'string' ? new Date(approved_at) : null;
  return {
    text: typeof text === 'string' ? text : null,
    at: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

function idempotencyKeyOf(req: FastifyRequest): string | null {
  const key = req.headers['idempotency-key'];
  return typeof key === 'string' ? key.slice(0, 255) : null;
}

function summarize(status: number, payload: unknown): string {
  if (status < 400) return 'ok';
  try {
    const code = (JSON.parse(String(payload)) as { error?: { code?: string } }).error?.code;
    return code ?? `HTTP_${status}`;
  } catch {
    return `HTTP_${status}`;
  }
}

/** onSend, registered LAST (after the idempotency store), so it records the final status. */
export function registerAuditWrite(app: FastifyInstance, writer: AuditWriter): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.auditId) return payload;
    const body = bodyObject(req);
    const approval = extractApproval(body);
    const replayed = reply.getHeader('idempotent-replayed') === 'true';
    const summary = req.auditSummary ?? summarize(reply.statusCode, payload);
    try {
      await writer.write({
        id: req.auditId,
        token_id: req.auth?.tokenId ?? null,
        scope: req.auth?.scope ?? null,
        method: req.method,
        path: req.url,
        idempotency_key: idempotencyKeyOf(req),
        approval_text: approval.text,
        approval_at: approval.at,
        request: body ? JSON.stringify(redact(body)) : null,
        status_code: reply.statusCode,
        result_summary: replayed ? `replayed:${summary}` : summary,
        client_ip: req.ip,
      });
      return payload;
    } catch (err) {
      req.log.error({ auditId: req.auditId, errMessage: (err as Error).message }, 'audit write failed');
      reply.code(500);
      reply.removeHeader('idempotent-replayed');
      reply.header('content-type', 'application/json; charset=utf-8');
      return JSON.stringify(
        errorBody(
          'AUDIT_WRITE_FAILED',
          'The request was processed but could not be audited. Retry with the same Idempotency-Key.',
        ),
      );
    }
  });
}

/**
 * Fastify `frameworkErrors` handler. Framework errors (bad URL encoding, param too long) are answered
 * before any hook runs, so this replies with the error envelope and, for mutating methods, writes the
 * audit row itself (token unknown, so null).
 */
export function auditFrameworkError(
  writer: AuditWriter,
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const r = reply as FastifyReply;
  const status = err.statusCode ?? 400;
  const send = (code: number, body: unknown): void => {
    void r.code(code).type('application/json; charset=utf-8').send(JSON.stringify(body));
  };
  const refusal = errorBody('INVALID_REQUEST', err.message);
  if (!isMutating(req.method)) return send(status, refusal);
  const id = newAuditId();
  writer
    .write({
      id,
      token_id: null,
      scope: null,
      method: req.method,
      path: req.url,
      idempotency_key: idempotencyKeyOf(req),
      approval_text: null,
      approval_at: null,
      request: null,
      status_code: status,
      result_summary: 'INVALID_REQUEST',
      client_ip: req.ip,
    })
    .then(
      () => send(status, refusal),
      (e: unknown) => {
        req.log.error({ auditId: id, errMessage: (e as Error).message }, 'audit write failed');
        send(500, errorBody('AUDIT_WRITE_FAILED', 'The request was refused but could not be audited.'));
      },
    );
}
