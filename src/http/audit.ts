import { createHash, randomBytes } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { AuditRowInsert, Database } from '../db/types.js';
import { isJobRoute } from './auth.js';
import { errorBody } from './errors.js';
import { isMutating } from './methods.js';
import { redact, redactFreeText } from '../core/redact.js';

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

/**
 * The audit row of a job, queue run or CLI call (scope `job`): what ran, the outcome code and a one-line summary. `request` is stored as JSON when given.
 * Returns the audit id. Pass the transaction when the row must commit with other work.
 */
export async function writeJobAudit(db: Kysely<Database>, o: {
  path: string; summary: string; request?: unknown; status?: number; method?: 'JOB' | 'QUEUE' | 'CLI'; at?: Date; id?: string;
}): Promise<string> {
  const id = o.id ?? newAuditId();
  await db.insertInto('audit_log').values({
    id, ...(o.at && { at: o.at }), scope: 'job', method: o.method ?? 'JOB', path: o.path,
    ...(o.request !== undefined && { request: JSON.stringify(o.request) }), status_code: o.status ?? 200, result_summary: o.summary,
  }).execute();
  return id;
}

export function dbAuditWriter(db: Kysely<Database>): AuditWriter {
  return {
    async write(row) {
      await db.insertInto('audit_log').values(row).execute();
    },
  };
}

/**
 * v5.18.0 (CR-068): POST routes that are not written to audit_log, one row per call being the bloat: POST /visits/hit (a counter hit from the visit-counter Worker,
 * every redirected visitor). It still needs a visits token and an Idempotency-Key; the visit_daily row is the record, and nothing but the three counted fields is sent.
 */
const UNAUDITED_POSTS: ReadonlySet<string> = new Set(['/visits/hit']);

/** onRequest, registered FIRST so even a 401 gets an id. */
export function registerAuditId(app: FastifyInstance): void {
  app.decorateRequest('auditId', null);
  app.decorateRequest('auditSummary', null);
  app.addHook('onRequest', async (req) => {
    if (isMutating(req.method, req.routeOptions?.url) && !(req.method === 'POST' && UNAUDITED_POSTS.has(req.routeOptions?.url ?? ''))) req.auditId = newAuditId();
  });
}

/** A base64 file upload (POST /demand/keywords) is recorded by its size, not its bytes: the audit log stays small. */
function elideFile(b: Record<string, unknown> | null): Record<string, unknown> | null {
  if (b === null || typeof b.file_base64 !== 'string' || b.file_base64.length <= 200) return b;
  return { ...b, file_base64: `[base64, ${b.file_base64.length} characters]` };
}

/** An engine upload (up to 20,000 rows) is recorded by its row count: the rows live in engine_sales / engine_unsold, the counts in engine_uploads. */
function elideRows(b: Record<string, unknown> | null, url: string): Record<string, unknown> | null {
  if (b === null || !(url.startsWith('/engine/') || url.startsWith('/data/')) || !Array.isArray(b.rows) || b.rows.length <= 20) return b;
  return { ...b, rows: `[${b.rows.length} rows]` };
}

const AUDIT_ARRAY_MAX = 50;

/** v5.14.0 (D2): any array longer than 50 items (drop-list rows, test-set names, labelled names, intake lists, ...) is recorded as its count and a sha256 of its JSON, so the audit stays small but can still prove what was sent. */
function elideArrays(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (value.length > AUDIT_ARRAY_MAX) return `[${value.length} items, sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}]`;
    return depth < 6 ? value.map((v) => elideArrays(v, depth + 1)) : value;
  }
  if (value !== null && typeof value === 'object' && depth < 6) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, elideArrays(v, depth + 1)]));
  }
  return value;
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

/** v5.20.0 (CR-069): the optional X-Bot-Name header, trimmed, at most 40 characters of [A-Za-z0-9 _.-]; anything else is ignored. Logged, not a security check. */
export function botNameOf(req: FastifyRequest): string | null {
  const h = req.headers['x-bot-name'];
  const v = typeof h === 'string' ? h.trim() : '';
  return v.length >= 1 && v.length <= 40 && /^[A-Za-z0-9 _.-]+$/.test(v) ? v : null;
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
    // Bots only (Dvir, 6 Oct 2026): a request that never authenticated writes nothing.
    if (!req.auditId || (!req.auth && !req.jobAuth)) return payload;
    const body = elideArrays(elideRows(elideFile(bodyObject(req)), req.url)) as Record<string, unknown> | null;
    const approval = extractApproval(body);
    const replayed = reply.getHeader('idempotent-replayed') === 'true';
    const summary = req.auditSummary ?? summarize(reply.statusCode, payload);
    try {
      await writer.write({
        id: req.auditId,
        token_id: req.auth?.tokenId ?? null,
        scope: req.auth?.scope ?? (isJobRoute(req) ? 'job' : null),
        method: req.method,
        path: req.url,
        idempotency_key: idempotencyKeyOf(req),
        approval_text: approval.text,
        approval_at: approval.at,
        request: body ? JSON.stringify(redact(/^\/(company|reviews)\//.test(req.url) ? redactFreeText(body) : body)) : null,
        status_code: reply.statusCode,
        result_summary: replayed ? `replayed:${summary}` : summary,
        client_ip: req.ip,
        bot_name: botNameOf(req),
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
 * before any hook runs, so the caller is not authenticated: reply with the error envelope and write
 * nothing (bots-only access, Dvir 6 Oct 2026).
 */
export function auditFrameworkError(err: FastifyError, _req: FastifyRequest, reply: FastifyReply): void {
  // BUG-6 (CR-005): a malformed percent-encoding must never reach the proxy as an unparseable reply (Cloudflare showed 520).
  // The body is plain ASCII and never echoes the raw path; the connection is closed so no half-read request is reused.
  const body = JSON.stringify(errorBody('INVALID_REQUEST', 'The request path or query is malformed (invalid percent-encoding or URL component)'));
  void reply
    .code(err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 400)
    .header('connection', 'close')
    .type('application/json; charset=utf-8')
    .send(body);
}
