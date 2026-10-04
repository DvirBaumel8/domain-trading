import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, details } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send(errorBody(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.code(422).send(errorBody('VALIDATION_ERROR', 'Request body is invalid', { issues }));
    }
    const fe = err as FastifyError;
    if (typeof fe.code === 'string' && fe.code.startsWith('FST_ERR_CTP_')) {
      return reply.code(fe.statusCode ?? 400).send(errorBody('INVALID_BODY', fe.message));
    }
    if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode <= 499) {
      req.log.warn({ err }, 'client error');
      const code = fe.code === 'FST_ERR_VALIDATION' ? 'VALIDATION_ERROR' : 'INVALID_REQUEST';
      return reply.code(fe.statusCode).send(errorBody(code, fe.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL', 'Internal error'));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody('NOT_FOUND', 'Route not found')));
}
